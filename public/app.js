/**
 * signalk-wyoming webapp — shell: tab routing, API helper, SSE event bus.
 *
 * Vanilla ES modules, no build step. All REST paths live under the plugin
 * router base and are validated against src/api.ts (the contract).
 */

import { initStatus } from "./status.js";
import { initAudio } from "./audio.js";
import { initTest } from "./test.js";

export const BASE = "/plugins/signalk-wyoming";

// ---------------------------------------------------------------------------
// Tiny DOM helpers (shared by every screen module)
// ---------------------------------------------------------------------------

/** Create an element with attributes and children. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value);
    } else if (value !== undefined && value !== null) {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(
      child instanceof Node ? child : document.createTextNode(String(child)),
    );
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function fmtTime(epochMs) {
  return new Date(epochMs).toLocaleTimeString([], { hour12: false });
}

// ---------------------------------------------------------------------------
// API helper — graceful 401/403 (login hint), 501/503 (degraded), errors
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(BASE + path, {
      credentials: "same-origin",
      ...options,
    });
  } catch (err) {
    throw new ApiError(0, `network error: ${err.message}`);
  }
  if (response.status === 401 || response.status === 403) {
    showBanner(
      "Not authorized — log in via the Signal K admin UI (this webapp rides the Signal K session).",
    );
    throw new ApiError(response.status, "not authorized");
  }
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body && typeof body.error === "string") message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(response.status, message);
  }
  return response;
}

/** GET returning parsed JSON. */
export async function apiGet(path) {
  return (await request(path)).json();
}

/** POST JSON returning parsed JSON (also used for 202 results). */
export async function apiPost(path, body) {
  const response = await request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  try {
    return await response.json();
  } catch {
    return {};
  }
}

/** POST returning a binary Blob (e.g. /api/satellites/:id/record → WAV). */
export async function apiPostBlob(path, body) {
  const response = await request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return response.blob();
}

/**
 * Render an ApiError into a per-widget hint. 503/501 are expected degraded
 * modes (service not installed yet / plugin stopped) — phrased as guidance,
 * not failure.
 */
export function friendlyError(err) {
  if (!(err instanceof ApiError)) return String(err.message ?? err);
  if (err.status === 503 || err.status === 501) return err.message;
  if (err.status === 401 || err.status === 403) {
    return "not authorized — log in via the Signal K admin UI";
  }
  return err.message;
}

// ---------------------------------------------------------------------------
// Banner (auth / plugin-stopped notices)
// ---------------------------------------------------------------------------

const banner = document.getElementById("banner");
let bannerTimer = null;

export function showBanner(text) {
  banner.textContent = text;
  banner.classList.remove("hidden");
  if (bannerTimer !== null) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => banner.classList.add("hidden"), 15000);
}

// ---------------------------------------------------------------------------
// SSE event bus — one EventSource for the whole app (GET /api/events)
// ---------------------------------------------------------------------------

const SSE_KINDS = [
  "state",
  "command",
  "announcement",
  "detection",
  "service",
  "error",
];

const listeners = new Map(); // kind -> Set<fn>

/** Subscribe to a hub event kind ('state' | 'command' | ... | '*'). */
export function onEvent(kind, fn) {
  if (!listeners.has(kind)) listeners.set(kind, new Set());
  listeners.get(kind).add(fn);
  return () => listeners.get(kind).delete(fn);
}

function dispatch(kind, event) {
  let parsed;
  try {
    parsed = JSON.parse(event.data); // {at, data} per src/events.ts formatSse
  } catch {
    return;
  }
  for (const fn of listeners.get(kind) ?? []) fn(parsed.data, parsed.at);
  for (const fn of listeners.get("*") ?? []) fn(kind, parsed.data, parsed.at);
}

function connectSse() {
  const dot = document.getElementById("sse-dot");
  let retryMs = 3000;
  const open = () => {
    const source = new EventSource(`${BASE}/api/events`);
    for (const kind of SSE_KINDS) {
      source.addEventListener(kind, (event) => dispatch(kind, event));
    }
    source.addEventListener("open", () => {
      retryMs = 3000;
      dot.className = "dot dot-ok";
      dot.title = "live event stream connected";
    });
    source.addEventListener("error", () => {
      dot.className = "dot dot-err";
      dot.title = "live event stream disconnected — retrying";
      // EventSource auto-reconnects only for established-then-dropped
      // streams. A non-200 response — the 503 while the plugin is
      // stopped/restarting (config save!), or a 401 after logout — FAILS the
      // connection permanently (readyState CLOSED, no further retries), so
      // re-create the source ourselves with backoff.
      if (source.readyState === EventSource.CLOSED) {
        source.close();
        setTimeout(open, retryMs);
        retryMs = Math.min(retryMs * 2, 30000);
      }
    });
  };
  open();
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function initTabs() {
  const tabs = document.querySelectorAll("#tabs [role=tab]");
  const activate = (name) => {
    for (const tab of tabs) {
      tab.setAttribute("aria-selected", String(tab.dataset.screen === name));
    }
    for (const section of document.querySelectorAll(".screen")) {
      section.classList.toggle("hidden", section.id !== `screen-${name}`);
    }
    if (location.hash !== `#${name}`)
      history.replaceState(null, "", `#${name}`);
  };
  for (const tab of tabs) {
    tab.addEventListener("click", () => activate(tab.dataset.screen));
  }
  const initial = location.hash.replace("#", "");
  activate(["status", "audio", "test"].includes(initial) ? initial : "status");
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

initTabs();
connectSse();
initStatus(document.getElementById("screen-status"));
initAudio(document.getElementById("screen-audio"));
initTest(document.getElementById("screen-test"));
