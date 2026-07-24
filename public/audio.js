/**
 * Audio setup screen — device enumeration, record & play back, tone, VU meter.
 *
 * Everything proxies through the orchestrator to the satellite image's
 * control API (only satellites with hasControlApi appear here):
 *   GET  /api/satellites/:id/devices   → {capture:[...], playback:[...]}
 *   POST /api/satellites/:id/record    → WAV blob
 *   POST /api/satellites/:id/play      → {type:'tone'|'wav', ...}
 *   GET  /api/satellites/:id/vu        → SSE {rms, peak}
 *
 * Device SELECTION cannot be written from here in v1 — plugin configuration
 * stays in the Signal K plugin config UI (spec §4.4). The dropdowns exist to
 * discover the ALSA device string to paste into the config.
 */

import {
  BASE,
  apiGet,
  apiPost,
  apiPostBlob,
  el,
  clear,
  friendlyError,
} from "./app.js";

export function initAudio(root) {
  const satPicker = el("select");
  const captureSelect = el("select");
  const playbackSelect = el("select");
  const deviceString = el("input", {
    type: "text",
    readonly: "",
    class: "mono",
    size: 40,
    onfocus: (event) => event.target.select(),
  });
  const devicesResult = el("div", { class: "result" });
  const recordResult = el("div", { class: "result" });
  const audioBox = el("div");
  const toneResult = el("div", { class: "result" });
  const vuCanvas = el("canvas", { class: "vu", width: 600, height: 34 });
  const vuResult = el("div", { class: "result" });
  const vuStart = el("button", {}, "Start VU meter");
  const vuStop = el("button", { disabled: "" }, "Stop");

  let vuSource = null;

  const recordButton = el(
    "button",
    { class: "primary" },
    "Record 3 s & play back",
  );
  const toneButton = el("button", {}, "Play tone on speaker");
  const refreshButton = el("button", {}, "Refresh devices");

  root.append(
    el(
      "div",
      { class: "card" },
      el("h2", {}, "Satellite"),
      el(
        "div",
        { class: "row" },
        el(
          "div",
          { class: "field" },
          el("span", {}, "Satellite (with control API)"),
          satPicker,
        ),
        refreshButton,
      ),
      el(
        "p",
        { class: "hint" },
        "Only satellites running the ghcr.io/hoeken/wyoming-satellite image ",
        "expose the control API used by this screen. Recording and the VU ",
        "meter briefly pause the satellite (~2 s gap) to free the mic device.",
      ),
      devicesResult,
    ),
    el(
      "div",
      { class: "card" },
      el("h2", {}, "Devices"),
      el(
        "div",
        { class: "row" },
        el(
          "div",
          { class: "field" },
          el("span", {}, "Microphones (arecord -l)"),
          captureSelect,
        ),
        el(
          "div",
          { class: "field" },
          el("span", {}, "Speakers (aplay -l)"),
          playbackSelect,
        ),
      ),
      el(
        "div",
        { class: "row" },
        el(
          "div",
          { class: "field" },
          el("span", {}, "ALSA device string (copy into plugin config)"),
          deviceString,
        ),
      ),
      el(
        "p",
        { class: "hint" },
        "This webapp cannot write plugin configuration (v1). Pick a device to ",
        "see its ALSA string, then paste it into micDevice / sndDevice in ",
        "Server → Plugin Config → Voice (Wyoming).",
      ),
    ),
    el(
      "div",
      { class: "card" },
      el("h2", {}, "Microphone test"),
      el("div", { class: "row" }, recordButton),
      recordResult,
      audioBox,
    ),
    el(
      "div",
      { class: "card" },
      el("h2", {}, "Speaker test"),
      el("div", { class: "row" }, toneButton),
      toneResult,
    ),
    el(
      "div",
      { class: "card" },
      el("h2", {}, "VU meter (mic level)"),
      el("div", { class: "row" }, vuStart, vuStop),
      vuCanvas,
      vuResult,
    ),
  );

  const selectedSatellite = () => satPicker.value;

  // --- satellite picker -------------------------------------------------------

  async function loadSatellites() {
    clear(satPicker);
    let satellites;
    try {
      satellites = await apiGet("/api/satellites");
    } catch (err) {
      devicesResult.className = "result err";
      devicesResult.textContent = friendlyError(err);
      return;
    }
    const capable = satellites.filter((sat) => sat.hasControlApi);
    if (capable.length === 0) {
      satPicker.append(
        el("option", { value: "" }, "no control-API satellites"),
      );
      devicesResult.className = "result";
      devicesResult.textContent =
        "No satellite with a control API is configured. Enable the local " +
        "satellite or point a remote satellite at our image to use this screen.";
      return;
    }
    devicesResult.textContent = "";
    for (const sat of capable) {
      satPicker.append(
        el("option", { value: sat.id }, `${sat.name} (${sat.id})`),
      );
    }
    loadDevices();
  }

  // --- devices ---------------------------------------------------------------

  function fillDevices(select, devices, emptyLabel) {
    clear(select);
    if (!Array.isArray(devices) || devices.length === 0) {
      select.append(el("option", { value: "" }, emptyLabel));
      return;
    }
    for (const device of devices) {
      select.append(el("option", { value: device.id }, device.name));
    }
  }

  async function loadDevices() {
    const id = selectedSatellite();
    if (!id) return;
    fillDevices(captureSelect, [], "loading…");
    fillDevices(playbackSelect, [], "loading…");
    try {
      const devices = await apiGet(`/api/satellites/${id}/devices`);
      fillDevices(captureSelect, devices.capture, "no capture devices");
      fillDevices(playbackSelect, devices.playback, "no playback devices");
      updateDeviceString();
      if (
        (devices.capture ?? []).length === 0 &&
        (devices.playback ?? []).length === 0
      ) {
        devicesResult.className = "result";
        devicesResult.textContent =
          "No audio devices visible to this satellite. For the local " +
          "satellite this usually means /dev/snd passthrough is not yet " +
          "supported by your signalk-container version.";
      } else {
        devicesResult.textContent = "";
      }
    } catch (err) {
      fillDevices(captureSelect, [], "unavailable");
      fillDevices(playbackSelect, [], "unavailable");
      devicesResult.className = "result err";
      devicesResult.textContent = friendlyError(err);
    }
  }

  function updateDeviceString() {
    deviceString.value = captureSelect.value || playbackSelect.value || "";
  }

  captureSelect.addEventListener("change", () => {
    deviceString.value = captureSelect.value;
  });
  playbackSelect.addEventListener("change", () => {
    deviceString.value = playbackSelect.value;
  });
  satPicker.addEventListener("change", () => {
    stopVu();
    loadDevices();
  });
  refreshButton.addEventListener("click", loadDevices);

  // --- record & play back ------------------------------------------------------

  recordButton.addEventListener("click", async () => {
    const id = selectedSatellite();
    if (!id) return;
    recordButton.disabled = true;
    recordResult.className = "result";
    recordResult.textContent = "recording 3 s…";
    clear(audioBox);
    try {
      const wav = await apiPostBlob(`/api/satellites/${id}/record`, {
        seconds: 3,
      });
      recordResult.textContent = `recorded ${(wav.size / 1024).toFixed(1)} kB`;
      const url = URL.createObjectURL(wav);
      const player = el("audio", { controls: "", src: url });
      player.addEventListener("ended", () => URL.revokeObjectURL(url));
      audioBox.append(player);
      player.play().catch(() => {
        /* autoplay blocked — user can press play */
      });
    } catch (err) {
      recordResult.className = "result err";
      recordResult.textContent = friendlyError(err);
    } finally {
      recordButton.disabled = false;
    }
  });

  // --- tone ---------------------------------------------------------------------

  toneButton.addEventListener("click", async () => {
    const id = selectedSatellite();
    if (!id) return;
    toneButton.disabled = true;
    toneResult.className = "result";
    toneResult.textContent = "playing tone…";
    try {
      await apiPost(`/api/satellites/${id}/play`, {
        type: "tone",
        frequency: 440,
        durationMs: 2000,
      });
      toneResult.className = "result ok";
      toneResult.textContent = "tone sent";
    } catch (err) {
      toneResult.className = "result err";
      toneResult.textContent = friendlyError(err);
    } finally {
      toneButton.disabled = false;
    }
  });

  // --- VU meter -------------------------------------------------------------------

  function drawVu(rms, peak) {
    const ctx = vuCanvas.getContext("2d");
    const { width, height } = vuCanvas;
    ctx.clearRect(0, 0, width, height);
    // Levels arrive normalized 0..1 (control API RMS/peak of 16-bit PCM).
    const rmsWidth = Math.min(1, rms) * width;
    const peakX = Math.min(1, peak) * width;
    ctx.fillStyle = rms > 0.7 ? "#c02f2f" : rms > 0.4 ? "#b57708" : "#1d8a4a";
    ctx.fillRect(0, 0, rmsWidth, height);
    ctx.fillStyle = "#888";
    ctx.fillRect(peakX - 2, 0, 2, height);
  }

  function stopVu() {
    if (vuSource !== null) {
      vuSource.close();
      vuSource = null;
    }
    vuStart.disabled = false;
    vuStop.disabled = true;
  }

  vuStart.addEventListener("click", () => {
    const id = selectedSatellite();
    if (!id) return;
    stopVu();
    vuResult.className = "result";
    vuResult.textContent = "listening… speak into the microphone";
    vuSource = new EventSource(`${BASE}/api/satellites/${id}/vu`);
    vuSource.addEventListener("message", (event) => {
      try {
        const levels = JSON.parse(event.data);
        drawVu(levels.rms ?? 0, levels.peak ?? 0);
      } catch {
        /* malformed frame */
      }
    });
    vuSource.addEventListener("error", () => {
      // The stream is finite server-side; do NOT let EventSource auto-retry,
      // each connection pauses the satellite to grab the mic.
      stopVu();
      vuResult.textContent = "VU stream ended";
    });
    vuStart.disabled = true;
    vuStop.disabled = false;
  });

  vuStop.addEventListener("click", () => {
    stopVu();
    vuResult.textContent = "";
  });

  loadSatellites();
}
