/**
 * Status screen — services health, satellites, recent activity log.
 *
 * Data: GET /api/services, GET /api/satellites, GET /api/log; live updates
 * ride the shared /api/events SSE stream (kinds per src/events.ts).
 */

import {
  apiGet,
  apiPost,
  el,
  clear,
  fmtTime,
  friendlyError,
  onEvent,
  showBanner,
} from "./app.js";

const SERVICE_LABELS = {
  tts: "Text-to-speech (piper)",
  asr: "Speech-to-text (whisper)",
  wake: "Wake word (openwakeword)",
};

function statusDot(status) {
  const cls =
    status === "ready"
      ? "dot-ok"
      : status === "starting"
        ? "dot-warn"
        : status === "error"
          ? "dot-err"
          : "dot-unknown";
  return el("span", { class: `dot ${cls}`, title: status ?? "not discovered" });
}

export function initStatus(root) {
  const servicesBody = el("tbody");
  const satellitesBody = el("tbody");
  const logBox = el("div", { class: "log" });

  root.append(
    el(
      "div",
      { class: "card" },
      el("h2", {}, "Services"),
      el(
        "table",
        {},
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            el("th", {}, ""),
            el("th", {}, "Service"),
            el("th", {}, "Status"),
            el("th", {}, "URI"),
            el("th", {}, "Source"),
            el("th", {}, "Details"),
          ),
        ),
        servicesBody,
      ),
      el(
        "p",
        { class: "hint" },
        "Services are discovered from the signalk-piper / signalk-whisper / ",
        "signalk-openwakeword plugins, or set manually in the plugin config.",
      ),
    ),
    el(
      "div",
      { class: "card" },
      el("h2", {}, "Satellites"),
      el(
        "table",
        {},
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            el("th", {}, ""),
            el("th", {}, "Satellite"),
            el("th", {}, "State"),
            el("th", {}, "Address"),
            el("th", {}, "Queue"),
            el("th", {}, ""),
          ),
        ),
        satellitesBody,
      ),
      el(
        "p",
        { class: "hint" },
        "No satellites? Add remote satellites or enable the local satellite ",
        "in the plugin config.",
      ),
    ),
    el("div", { class: "card" }, el("h2", {}, "Recent activity"), logBox),
  );

  // --- services ------------------------------------------------------------

  async function renderServices() {
    let services;
    try {
      services = await apiGet("/api/services");
    } catch (err) {
      clear(servicesBody);
      servicesBody.append(
        el(
          "tr",
          {},
          el("td", { colspan: 6, class: "dim" }, friendlyError(err)),
        ),
      );
      return;
    }
    clear(servicesBody);
    for (const type of ["tts", "asr", "wake"]) {
      const entry = services[type] ?? {};
      const details = [];
      if (entry.plugin) details.push(entry.plugin);
      if (Array.isArray(entry.models) && entry.models.length > 0) {
        details.push(`models: ${entry.models.join(", ")}`);
      }
      servicesBody.append(
        el(
          "tr",
          {},
          el("td", {}, statusDot(entry.status)),
          el("td", {}, SERVICE_LABELS[type] ?? type),
          el("td", {}, entry.status ?? "not discovered"),
          el("td", { class: "mono" }, entry.uri ?? "—"),
          el("td", {}, entry.source ?? "—"),
          el("td", { class: "dim" }, details.join(" · ")),
        ),
      );
    }
  }

  // --- satellites ------------------------------------------------------------

  async function renderSatellites() {
    let satellites;
    try {
      satellites = await apiGet("/api/satellites");
    } catch (err) {
      clear(satellitesBody);
      satellitesBody.append(
        el(
          "tr",
          {},
          el("td", { colspan: 6, class: "dim" }, friendlyError(err)),
        ),
      );
      return;
    }
    clear(satellitesBody);
    if (satellites.length === 0) {
      satellitesBody.append(
        el(
          "tr",
          {},
          el("td", { colspan: 6, class: "dim" }, "no satellites configured"),
        ),
      );
      return;
    }
    for (const sat of satellites) {
      const toneButton = el(
        "button",
        {
          onclick: async () => {
            toneButton.disabled = true;
            try {
              await apiPost(`/api/satellites/${sat.id}/test`, {});
            } catch (err) {
              showBanner(`test tone (${sat.id}): ${friendlyError(err)}`);
            } finally {
              toneButton.disabled = false;
            }
          },
        },
        "Test tone",
      );
      if (!sat.connected) toneButton.disabled = true;
      satellitesBody.append(
        el(
          "tr",
          {},
          el(
            "td",
            {},
            el("span", {
              class: `dot ${sat.connected ? "dot-ok" : "dot-err"}`,
              title: sat.connected ? "connected" : "disconnected",
            }),
          ),
          el(
            "td",
            {},
            `${sat.name} `,
            el("span", { class: "dim mono" }, sat.id),
          ),
          el("td", {}, sat.state),
          el("td", { class: "mono" }, `${sat.host}:${sat.port}`),
          el("td", {}, String(sat.queueDepth)),
          el("td", {}, toneButton),
        ),
      );
    }
  }

  // --- activity log ------------------------------------------------------------

  function describeEvent(kind, data) {
    const d = data ?? {};
    switch (kind) {
      case "command":
        return (
          `"${d.text}" from ${d.satellite}` +
          (d.wakeWord ? ` (${d.wakeWord})` : "")
        );
      case "detection":
        return `wake word ${d.name ?? "?"} on ${d.satellite}`;
      case "announcement":
        if (d.suppressed) return `suppressed (${d.suppressed}): "${d.text}"`;
        return (
          `"${d.text}"` +
          (d.priority === "urgent" ? " [urgent]" : "") +
          (Array.isArray(d.queued) && d.queued.length > 0
            ? ` → ${d.queued.join(", ")}`
            : d.satellite
              ? ` → ${d.satellite}`
              : "")
        );
      case "state":
        if (typeof d.muted === "boolean") {
          return d.muted ? "muted" : "unmuted";
        }
        return `${d.satellite}: ${d.state}${d.connected ? "" : " (disconnected)"}`;
      case "service":
        return `${d.type}: ${d.service ? `${d.service.status} at ${d.service.uri}` : "gone"}`;
      case "error":
        return `${d.satellite ? `${d.satellite}: ` : ""}${d.error ?? ""}`;
      default:
        return JSON.stringify(d);
    }
  }

  function appendLog(kind, data, at) {
    logBox.prepend(
      el(
        "div",
        { class: "log-entry" },
        el("span", { class: "log-time" }, fmtTime(at)),
        el("span", { class: `log-kind ${kind}` }, kind),
        el("span", { class: "log-text" }, describeEvent(kind, data)),
      ),
    );
    while (logBox.childElementCount > 200) logBox.lastChild.remove();
  }

  async function renderLog() {
    let entries;
    try {
      entries = await apiGet("/api/log");
    } catch (err) {
      logBox.append(el("div", { class: "dim" }, friendlyError(err)));
      return;
    }
    clear(logBox);
    for (const entry of entries) appendLog(entry.kind, entry.data, entry.at);
    if (entries.length === 0) {
      logBox.append(el("div", { class: "dim" }, "no activity yet"));
    }
  }

  // --- live updates ------------------------------------------------------------

  onEvent("*", (kind, data, at) => {
    appendLog(kind, data, at);
    if (kind === "service") renderServices();
    // Satellite state / queue depth changes ride 'state' and 'announcement'.
    if (kind === "state" || kind === "announcement" || kind === "error") {
      renderSatellites();
    }
  });

  renderServices();
  renderSatellites();
  renderLog();
  // Queue depth drains without an SSE kind of its own — refresh slowly.
  setInterval(renderSatellites, 10000);
}
