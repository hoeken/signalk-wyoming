/**
 * Test screen — type-and-say, mute toggle, record-and-transcribe (D10
 * latency display), wake-word test with live detection feed.
 *
 * Endpoints (src/api.ts): POST /api/say, POST /api/mute, GET /api/voices,
 * GET /api/satellites, POST /api/transcribe; live events via SSE.
 */

import {
  apiDelete,
  apiGet,
  apiPost,
  el,
  clear,
  fmtTime,
  friendlyError,
  onEvent,
} from "./app.js";

const SOUND_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_SOUND_BYTES = 5 * 1024 * 1024;
const TERMINAL_ANNOUNCEMENT_STATES = new Set([
  "played",
  "suppressed",
  "cancelled",
  "interrupted",
  "failed",
  "unknown",
  "partial",
]);

function formatDuration(milliseconds) {
  const seconds = milliseconds / 1000;
  return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KiB`;
}

function formatAudio(sound) {
  const channels =
    sound.channels === 1
      ? "mono"
      : sound.channels === 2
        ? "stereo"
        : `${sound.channels} ch`;
  return `${sound.rate} Hz · ${sound.width * 8}-bit · ${channels}`;
}

function stateBadge(state) {
  return el("span", { class: `state state-${state}` }, state);
}

function fileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      if (comma < 0) reject(new Error("could not read the WAV file"));
      else resolve(result.slice(comma + 1));
    });
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("could not read the WAV file")),
    );
    reader.readAsDataURL(file);
  });
}

export function initTest(root) {
  // --- type-and-say ------------------------------------------------------------

  const sayText = el("textarea", {
    rows: 2,
    maxlength: 500,
    placeholder: "Anchor alarm: drag detected",
  });
  const targetsSelect = el("select", { multiple: "", size: 3 });
  const voiceSelect = el("select");
  const urgentCheck = el("input", { type: "checkbox" });
  const sayButton = el("button", { class: "primary" }, "Say it");
  const sayResult = el("div", { class: "result" });
  const muteButton = el("button", {}, "Mute");
  const muteState = el("span", { class: "dim" }, "");

  // --- notification sounds ----------------------------------------------------

  const soundTargets = el("select", { multiple: "", size: 3 });
  const soundsBody = el("tbody");
  const soundsStatus = el(
    "div",
    { class: "result", "aria-live": "polite" },
    "Loading sounds…",
  );
  const announcementResult = el("div", {
    class: "announcement-result",
    "aria-live": "polite",
  });
  const soundId = el("input", {
    type: "text",
    maxlength: 64,
    placeholder: "bilge-alarm",
    autocapitalize: "none",
    spellcheck: "false",
  });
  const soundFile = el("input", {
    type: "file",
    accept: ".wav,audio/wav,audio/x-wav,audio/wave",
  });
  const uploadButton = el("button", { class: "primary" }, "Upload WAV");
  const uploadResult = el("div", {
    class: "result",
    "aria-live": "polite",
  });

  // --- record-and-transcribe ------------------------------------------------------

  const sttSatellite = el("select");
  // The satellite control API caps recordings at 10 s (its server validates
  // seconds as 1..10) — mirror that limit here instead of advertising a
  // range that always errors.
  const sttSeconds = el("input", {
    type: "number",
    value: 3,
    min: 1,
    max: 10,
    size: 4,
  });
  const sttButton = el("button", { class: "primary" }, "Record & transcribe");
  const sttResult = el("div", { class: "result" });
  const transcriptBox = el(
    "div",
    { class: "transcript dim" },
    "transcript appears here",
  );
  const latencyBox = el("div", { class: "hint" }, "");

  // --- wake test -------------------------------------------------------------------

  const wakeFeed = el(
    "div",
    { class: "log" },
    el("div", { class: "dim" }, "waiting for wake words…"),
  );

  root.append(
    el(
      "div",
      { class: "card" },
      el("h2", {}, "Type and say"),
      sayText,
      el(
        "div",
        { class: "row" },
        el(
          "div",
          { class: "field" },
          el("span", {}, "Targets (none selected = all)"),
          targetsSelect,
        ),
        el("div", { class: "field" }, el("span", {}, "Voice"), voiceSelect),
        el("label", {}, urgentCheck, "urgent (jumps queue, bypasses mute)"),
        sayButton,
      ),
      sayResult,
      el("div", { class: "row" }, muteButton, muteState),
    ),
    el(
      "div",
      { class: "card" },
      el("h2", {}, "Notification sounds"),
      el(
        "p",
        { class: "hint" },
        "Play a built-in or uploaded sound without Piper. With no target selected, ",
        "the sound plays on every connected satellite.",
      ),
      el(
        "div",
        { class: "row sound-controls" },
        el(
          "div",
          { class: "field" },
          el("span", {}, "Targets (none selected = all connected)"),
          soundTargets,
        ),
      ),
      soundsStatus,
      el(
        "div",
        { class: "table-scroll" },
        el(
          "table",
          { class: "responsive-table sound-table" },
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              el("th", {}, "Sound"),
              el("th", {}, "Type"),
              el("th", {}, "Duration"),
              el("th", {}, "Audio format"),
              el("th", {}, "Size"),
              el("th", { class: "actions" }, "Actions"),
            ),
          ),
          soundsBody,
        ),
      ),
      announcementResult,
      el(
        "p",
        { class: "hint" },
        "Played confirms that the satellite process accepted the complete audio stream; ",
        "it cannot confirm that an amplifier or physical speaker was audible.",
      ),
      el("h3", {}, "Upload a custom sound"),
      el(
        "div",
        { class: "row upload-sound" },
        el("div", { class: "field" }, el("span", {}, "Sound ID"), soundId),
        el(
          "div",
          { class: "field file-field" },
          el("span", {}, "Uncompressed PCM WAV (max 5 MB, 30 seconds)"),
          soundFile,
        ),
        uploadButton,
      ),
      uploadResult,
    ),
    el(
      "div",
      { class: "card" },
      el("h2", {}, "Record and transcribe (STT test)"),
      el(
        "div",
        { class: "row" },
        el(
          "div",
          { class: "field" },
          el("span", {}, "Satellite (with control API)"),
          sttSatellite,
        ),
        el("div", { class: "field" }, el("span", {}, "Seconds"), sttSeconds),
        sttButton,
      ),
      transcriptBox,
      latencyBox,
      sttResult,
      el(
        "p",
        { class: "hint" },
        "Records via the satellite control API and runs the audio through ",
        "whisper — no wake word needed. The latency shown is the real-hardware ",
        "benchmark for choosing a whisper model.",
      ),
    ),
    el(
      "div",
      { class: "card" },
      el("h2", {}, "Wake word test"),
      el(
        "p",
        { class: "hint" },
        "Say a configured wake word (e.g. “okay nabu”) at any ",
        "wake-enabled satellite; detections and transcribed commands appear ",
        "here live.",
      ),
      wakeFeed,
    ),
  );

  // --- pickers -----------------------------------------------------------------

  async function loadSatellites() {
    let satellites = [];
    try {
      satellites = await apiGet("/api/satellites");
    } catch {
      /* plugin stopped — banners handle it */
    }
    clear(targetsSelect);
    clear(soundTargets);
    connectedSatelliteIds = [];
    satelliteNames = new Map(
      satellites.map((satellite) => [satellite.id, satellite.name]),
    );
    satelliteConnections = new Map(
      satellites.map((satellite) => [satellite.id, satellite.connected]),
    );
    for (const sat of satellites) {
      targetsSelect.append(
        el("option", { value: sat.id }, `${sat.name} (${sat.id})`),
      );
      soundTargets.append(
        el(
          "option",
          { value: sat.id, disabled: sat.connected ? undefined : "" },
          `${sat.name} (${sat.id})${sat.connected ? "" : " — disconnected"}`,
        ),
      );
      if (sat.connected) connectedSatelliteIds.push(sat.id);
    }
    clear(sttSatellite);
    const capable = satellites.filter((sat) => sat.hasControlApi);
    if (capable.length === 0) {
      sttSatellite.append(
        el("option", { value: "" }, "no control-API satellites"),
      );
      sttButton.disabled = true;
    } else {
      sttButton.disabled = false;
      for (const sat of capable) {
        sttSatellite.append(
          el("option", { value: sat.id }, `${sat.name} (${sat.id})`),
        );
      }
    }
  }

  // --- notification sounds ----------------------------------------------------

  let connectedSatelliteIds = [];
  let satelliteNames = new Map();
  let satelliteConnections = new Map();
  let trackedAnnouncementId = null;
  let announcementPoll = null;

  function renderAnnouncement(snapshot) {
    clear(announcementResult);
    const targetRows = Object.entries(snapshot.targets ?? {}).map(
      ([satellite, target]) =>
        el(
          "tr",
          {},
          el(
            "td",
            { "data-label": "Satellite" },
            satelliteNames.get(satellite) ?? satellite,
          ),
          el("td", { "data-label": "State" }, stateBadge(target.state)),
          el("td", { "data-label": "Details" }, target.error ?? "—"),
        ),
    );
    announcementResult.append(
      el(
        "div",
        { class: "announcement-summary" },
        el("strong", {}, "Playback result"),
        stateBadge(snapshot.state),
      ),
      el(
        "div",
        { class: "table-scroll" },
        el(
          "table",
          { class: "responsive-table result-table" },
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              el("th", {}, "Satellite"),
              el("th", {}, "State"),
              el("th", {}, "Details"),
            ),
          ),
          el("tbody", {}, ...targetRows),
        ),
      ),
    );
  }

  async function refreshAnnouncement(id) {
    if (id !== trackedAnnouncementId) return;
    try {
      const snapshot = await apiGet(
        `/api/announcements/${encodeURIComponent(id)}`,
      );
      if (id !== trackedAnnouncementId) return;
      renderAnnouncement(snapshot);
      if (!TERMINAL_ANNOUNCEMENT_STATES.has(snapshot.state)) {
        clearTimeout(announcementPoll);
        announcementPoll = setTimeout(() => refreshAnnouncement(id), 1000);
      }
    } catch (err) {
      if (id !== trackedAnnouncementId) return;
      announcementResult.append(
        el(
          "div",
          { class: "result err" },
          `Could not refresh playback status: ${friendlyError(err)}`,
        ),
      );
      clearTimeout(announcementPoll);
      announcementPoll = setTimeout(() => refreshAnnouncement(id), 2000);
    }
  }

  async function playSound(sound, button) {
    const selected = [...soundTargets.selectedOptions].map(
      (option) => option.value,
    );
    const targets = selected.length > 0 ? selected : connectedSatelliteIds;
    if (targets.length === 0) {
      clear(announcementResult);
      announcementResult.append(
        el("div", { class: "result err" }, "No satellites are connected."),
      );
      return;
    }
    button.disabled = true;
    clearTimeout(announcementPoll);
    trackedAnnouncementId = null;
    clear(announcementResult);
    announcementResult.append(
      el("div", { class: "result" }, `Queueing ${sound.id}…`),
    );
    try {
      const snapshot = await apiPost("/api/announcements", {
        content: { kind: "sound", soundId: sound.id },
        targets,
      });
      trackedAnnouncementId = snapshot.id;
      renderAnnouncement(snapshot);
      if (!TERMINAL_ANNOUNCEMENT_STATES.has(snapshot.state)) {
        announcementPoll = setTimeout(
          () => refreshAnnouncement(snapshot.id),
          700,
        );
      }
    } catch (err) {
      clear(announcementResult);
      announcementResult.append(
        el("div", { class: "result err" }, friendlyError(err)),
      );
    } finally {
      button.disabled = false;
    }
  }

  function renderSounds(sounds) {
    clear(soundsBody);
    soundsStatus.textContent = "";
    if (sounds.length === 0) {
      soundsStatus.textContent = "No sounds are available.";
      return;
    }
    for (const sound of sounds) {
      const playButton = el("button", {}, "Play");
      playButton.addEventListener("click", () => playSound(sound, playButton));
      const actions = el("div", { class: "row row-compact" }, playButton);
      if (!sound.builtIn) {
        const deleteButton = el("button", { class: "danger" }, "Delete");
        deleteButton.addEventListener("click", async () => {
          if (!confirm(`Delete custom sound "${sound.id}"?`)) return;
          deleteButton.disabled = true;
          try {
            await apiDelete(`/api/sounds/${encodeURIComponent(sound.id)}`);
            await loadSounds();
          } catch (err) {
            soundsStatus.className = "result err";
            soundsStatus.textContent = `Could not delete ${sound.id}: ${friendlyError(err)}`;
            deleteButton.disabled = false;
          }
        });
        actions.append(deleteButton);
      }
      soundsBody.append(
        el(
          "tr",
          {},
          el("td", { "data-label": "Sound", class: "mono" }, sound.id),
          el(
            "td",
            { "data-label": "Type" },
            el(
              "span",
              { class: `sound-kind ${sound.builtIn ? "built-in" : "custom"}` },
              sound.builtIn ? "built-in" : "custom",
            ),
          ),
          el(
            "td",
            { "data-label": "Duration" },
            formatDuration(sound.durationMs),
          ),
          el("td", { "data-label": "Audio format" }, formatAudio(sound)),
          el("td", { "data-label": "Size" }, formatBytes(sound.bytes)),
          el("td", { "data-label": "Actions", class: "actions" }, actions),
        ),
      );
    }
  }

  async function loadSounds() {
    soundsStatus.className = "result";
    soundsStatus.textContent = "Loading sounds…";
    clear(soundsBody);
    try {
      renderSounds(await apiGet("/api/sounds"));
    } catch (err) {
      soundsStatus.className = "result err";
      soundsStatus.textContent = `Could not load sounds: ${friendlyError(err)}`;
    }
  }

  uploadButton.addEventListener("click", async () => {
    const id = soundId.value.trim();
    const file = soundFile.files?.[0];
    let validationError = "";
    if (!SOUND_ID.test(id)) {
      validationError =
        "ID must start with a lowercase letter or number and contain only lowercase letters, numbers, _ or - (max 64 characters).";
    } else if (!file) validationError = "Choose a WAV file first.";
    else if (!file.name.toLowerCase().endsWith(".wav")) {
      validationError = "The selected file must have a .wav extension.";
    } else if (
      file.type &&
      !["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"].includes(
        file.type.toLowerCase(),
      )
    ) {
      validationError = `The selected file type (${file.type}) is not WAV audio.`;
    } else if (file.size === 0) validationError = "The selected file is empty.";
    else if (file.size > MAX_SOUND_BYTES) {
      validationError = "The selected file is larger than 5 MB.";
    }
    if (validationError) {
      uploadResult.className = "result err";
      uploadResult.textContent = validationError;
      return;
    }

    uploadButton.disabled = true;
    uploadResult.className = "result";
    uploadResult.textContent = "Reading and uploading WAV…";
    try {
      const wavBase64 = await fileAsBase64(file);
      await apiPost("/api/sounds", { id, wavBase64 });
      uploadResult.className = "result ok";
      uploadResult.textContent = `Uploaded ${id}.`;
      soundId.value = "";
      soundFile.value = "";
      await loadSounds();
    } catch (err) {
      uploadResult.className = "result err";
      uploadResult.textContent = friendlyError(err);
    } finally {
      uploadButton.disabled = false;
    }
  });

  onEvent("delivery", (data) => {
    if (data?.announcementId === trackedAnnouncementId) {
      refreshAnnouncement(trackedAnnouncementId);
    }
  });

  async function loadVoices() {
    clear(voiceSelect);
    voiceSelect.append(el("option", { value: "" }, "default voice"));
    try {
      const voices = await apiGet("/api/voices");
      for (const voice of voices) {
        voiceSelect.append(
          el(
            "option",
            { value: voice.name },
            voice.description
              ? `${voice.name} — ${voice.description}`
              : voice.name,
          ),
        );
      }
    } catch (err) {
      // TTS not up (yet) — the say button will surface the same 503.
      voiceSelect.append(
        el("option", { value: "", disabled: "" }, friendlyError(err)),
      );
    }
  }

  // --- say ------------------------------------------------------------------------

  sayButton.addEventListener("click", async () => {
    const text = sayText.value.trim();
    if (text === "") {
      sayResult.className = "result err";
      sayResult.textContent = "enter some text first";
      return;
    }
    const targets = [...targetsSelect.selectedOptions].map((o) => o.value);
    const body = { text };
    if (targets.length > 0) body.targets = targets;
    if (voiceSelect.value !== "") body.voice = voiceSelect.value;
    if (urgentCheck.checked) body.priority = "urgent";
    sayButton.disabled = true;
    sayResult.className = "result";
    sayResult.textContent = "synthesizing…";
    try {
      const result = await apiPost("/api/say", body);
      if (result.suppressed === "muted") {
        sayResult.className = "result";
        sayResult.textContent =
          "suppressed: voice.muted is on (urgent bypasses mute)";
      } else {
        const errors = (result.errors ?? [])
          .map((e) => `${e.satellite}: ${e.error}`)
          .join("; ");
        sayResult.className = result.ok ? "result ok" : "result err";
        sayResult.textContent =
          `queued to ${result.queued.length > 0 ? result.queued.join(", ") : "nobody"}` +
          (errors ? ` — errors: ${errors}` : "");
      }
    } catch (err) {
      sayResult.className = "result err";
      sayResult.textContent = friendlyError(err);
    } finally {
      sayButton.disabled = false;
    }
  });

  // --- mute -------------------------------------------------------------------------

  let muted = false;

  function renderMute() {
    muteButton.textContent = muted ? "Unmute" : "Mute";
    muteState.textContent = muted
      ? "voice.muted is ON — normal announcements are suppressed"
      : "voice.muted is off";
  }

  muteButton.addEventListener("click", async () => {
    try {
      const result = await apiPost("/api/mute", { muted: !muted });
      muted = result.muted === true;
      renderMute();
    } catch (err) {
      sayResult.className = "result err";
      sayResult.textContent = friendlyError(err);
    }
  });

  onEvent("state", (data) => {
    if (data && typeof data.muted === "boolean") {
      muted = data.muted;
      renderMute();
    }
    if (
      data &&
      typeof data.satellite === "string" &&
      typeof data.connected === "boolean" &&
      satelliteConnections.get(data.satellite) !== data.connected
    ) {
      loadSatellites();
    }
  });

  async function loadMuteState() {
    // No GET /api/mute exists; the latest 'state' log entry carrying `muted`
    // (if any) is authoritative — voice.muted defaults to false on start.
    try {
      const entries = await apiGet("/api/log");
      for (const entry of entries) {
        if (
          entry.kind === "state" &&
          entry.data &&
          typeof entry.data.muted === "boolean"
        ) {
          muted = entry.data.muted;
        }
      }
    } catch {
      /* default false */
    }
    renderMute();
  }

  // --- transcribe -------------------------------------------------------------------

  sttButton.addEventListener("click", async () => {
    const satellite = sttSatellite.value;
    if (!satellite) return;
    const seconds = Math.min(10, Math.max(1, Number(sttSeconds.value) || 3));
    sttButton.disabled = true;
    sttResult.className = "result";
    sttResult.textContent = `recording ${seconds} s, then transcribing…`;
    transcriptBox.className = "transcript dim";
    transcriptBox.textContent = "…";
    latencyBox.textContent = "";
    try {
      const result = await apiPost("/api/transcribe", { satellite, seconds });
      transcriptBox.className = "transcript";
      transcriptBox.textContent =
        result.text.trim() === "" ? "(empty transcript)" : result.text;
      latencyBox.textContent = `transcription latency: ${result.latencyMs} ms`;
      sttResult.textContent = "";
    } catch (err) {
      transcriptBox.className = "transcript dim";
      transcriptBox.textContent = "transcript appears here";
      sttResult.className = "result err";
      sttResult.textContent =
        friendlyError(err) +
        (err.status === 503
          ? " — install/enable signalk-whisper to test speech-to-text"
          : "");
    } finally {
      sttButton.disabled = false;
    }
  });

  // --- wake feed --------------------------------------------------------------------

  let wakeEmpty = true;

  function appendWake(text, at, kind) {
    if (wakeEmpty) {
      clear(wakeFeed);
      wakeEmpty = false;
    }
    wakeFeed.prepend(
      el(
        "div",
        { class: "log-entry" },
        el("span", { class: "log-time" }, fmtTime(at)),
        el("span", { class: `log-kind ${kind}` }, kind),
        el("span", { class: "log-text" }, text),
      ),
    );
    while (wakeFeed.childElementCount > 50) wakeFeed.lastChild.remove();
  }

  onEvent("detection", (data, at) => {
    appendWake(
      `wake word ${data.name ?? "?"} detected on ${data.satellite}`,
      at,
      "detection",
    );
  });

  onEvent("command", (data, at) => {
    appendWake(
      `"${data.text}" from ${data.satellite}` +
        (typeof data.durationMs === "number" ? ` (${data.durationMs} ms)` : ""),
      at,
      "command",
    );
  });

  loadSatellites();
  loadSounds();
  loadVoices();
  loadMuteState();
  // Voices appear once piper is discovered/started — refresh occasionally.
  onEvent("service", (data) => {
    if (data && data.type === "tts") loadVoices();
    if (data && data.type === "asr") loadSatellites();
  });
}
