/**
 * Test screen — type-and-say, mute toggle, record-and-transcribe (D10
 * latency display), wake-word test with live detection feed.
 *
 * Endpoints (src/api.ts): POST /api/say, POST /api/mute, GET /api/voices,
 * GET /api/satellites, POST /api/transcribe; live events via SSE.
 */

import {
  apiGet,
  apiPost,
  el,
  clear,
  fmtTime,
  friendlyError,
  onEvent,
} from "./app.js";

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
    for (const sat of satellites) {
      targetsSelect.append(
        el("option", { value: sat.id }, `${sat.name} (${sat.id})`),
      );
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
    // Satellite list membership doesn't change at runtime; connection state
    // does not affect the pickers.
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
  loadVoices();
  loadMuteState();
  // Voices appear once piper is discovered/started — refresh occasionally.
  onEvent("service", (data) => {
    if (data && data.type === "tts") loadVoices();
    if (data && data.type === "asr") loadSatellites();
  });
}
