/**
 * REST API (DESIGN.md "Orchestrator REST contract"), mounted on the plugin's
 * Signal K router at /plugins/signalk-wyoming.
 *
 * - `router.access('readwrite'|'readonly')` is feature-detected; without it
 *   every route stays admin-only (logged once).
 * - Routes are registered ONCE per server process (registerWithRouter is
 *   never re-run), so every handler reads live state through accessor
 *   functions and guards on the running flag.
 * - /api/transcribe (D10): record via the satellite control API → feed the
 *   WAV's PCM through a fresh whisper session → {text, latencyMs}. Makes STT
 *   testable before any wake word exists; latencyMs (feed + transcription)
 *   is the real-hardware benchmark for choosing a whisper model.
 */

import { randomUUID } from "node:crypto";
import {
  TranscribeSession,
  wavToPcm,
  type TranscribeSessionLike,
} from "./asr.js";
import { fetchSatelliteVersions } from "./local-satellite.js";
import { probeWyoming } from "./protocol/client.js";
import type { Info, TtsVoice } from "./protocol/events.js";
import type { ServiceDirectory } from "./discovery.js";
import type { EventHub } from "./events.js";
import type { AnnouncementQueue } from "./queue.js";
import type { RemoteSatellite } from "./satellite.js";
import type { BufferedAudio } from "./types.js";

// ---------------------------------------------------------------------------
// Structural router/req/res types (kept minimal so tests use plain fakes)
// ---------------------------------------------------------------------------

export interface ApiRequest {
  body?: unknown;
  params?: Record<string, string>;
  on?(event: "close", listener: () => void): unknown;
}

export interface ApiResponse {
  status(code: number): ApiResponse;
  json(body: unknown): unknown;
  send(body: unknown): unknown;
  setHeader?(name: string, value: string): unknown;
  writeHead(statusCode: number, headers: Record<string, string>): unknown;
  write(chunk: string | Buffer): unknown;
  end(): unknown;
}

export type ApiHandler = (
  req: ApiRequest,
  res: ApiResponse,
) => void | Promise<void>;

export interface ApiRouter {
  get(path: string, handler: ApiHandler): unknown;
  post(path: string, handler: ApiHandler): unknown;
  /** Signal K PluginRouter permission registrar (feature-detected). */
  access?(level: "readwrite" | "readonly"): ApiRouter;
}

// ---------------------------------------------------------------------------
// Deps — accessors return the CURRENT start()'s objects (null when stopped)
// ---------------------------------------------------------------------------

export interface SatelliteEntry {
  satellite: RemoteSatellite;
  queue: AnnouncementQueue;
}

export interface UpdateCapableContainer {
  checkForUpdate(): Promise<unknown>;
  applyUpdate(tag: string): Promise<{ tag: string }>;
  lastStartedTag: string | undefined;
}

export interface ApiDeps {
  running(): boolean;
  say(opts: Record<string, unknown>): Promise<unknown>;
  directory(): ServiceDirectory | null;
  satellites(): Map<string, SatelliteEntry>;
  hub(): EventHub | null;
  getMuted(): boolean;
  setMuted(muted: boolean): void;
  localContainer(): UpdateCapableContainer | null;
  log(msg: string): void;
  error(msg: string): void;
  fetchImpl?: typeof fetch;
  /** Test injection; defaults to probeWyoming (live describe). */
  probe?: (uri: string) => Promise<Info>;
  now?: () => number;
  /** Default language for /api/transcribe (config defaults.language). */
  language?: () => string;
  /** Test injection; defaults to TranscribeSession.open. */
  asrOpen?: (
    uri: string,
    opts: { language?: string },
  ) => Promise<TranscribeSessionLike>;
}

// ---------------------------------------------------------------------------
// Tone generator (for /api/satellites/:id/test)
// ---------------------------------------------------------------------------

/**
 * A square-ish 440 Hz test tone: a soft-clipped sine reads clearly on small
 * boat speakers. 22050 Hz / 16-bit / mono, 1 s, in 2048-byte chunks.
 */
export function generateTone(
  opts: { frequencyHz?: number; durationMs?: number } = {},
): BufferedAudio {
  const frequencyHz = opts.frequencyHz ?? 440;
  const durationMs = opts.durationMs ?? 1000;
  const format = { rate: 22050, width: 2, channels: 1 };
  const totalSamples = Math.round((format.rate * durationMs) / 1000);
  const pcm = Buffer.alloc(totalSamples * 2);
  for (let i = 0; i < totalSamples; i++) {
    const t = i / format.rate;
    const sine = Math.sin(2 * Math.PI * frequencyHz * t);
    // Soft clip toward a square-ish wave, at moderate volume.
    const sample = Math.tanh(3 * sine) * 0.35;
    pcm.writeInt16LE(Math.round(sample * 32767), i * 2);
  }
  const chunks: Buffer[] = [];
  for (let off = 0; off < pcm.length; off += 2048) {
    chunks.push(pcm.subarray(off, Math.min(off + 2048, pcm.length)));
  }
  return { format, chunks };
}

/**
 * The satellite control API validates `seconds` as 1..10 (server.py
 * `_validated_number`; its README documents "up to 10 seconds") — anything
 * longer would bounce with an opaque 400→502, so clamp on our side.
 */
export const MAX_RECORD_SECONDS = 10;

function clampRecordSeconds(seconds: number): number {
  return Math.min(MAX_RECORD_SECONDS, Math.max(1, seconds));
}

// ---------------------------------------------------------------------------
// Router registration
// ---------------------------------------------------------------------------

export function registerApiRoutes(router: ApiRouter, deps: ApiDeps): void {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const probe = deps.probe ?? ((uri: string) => probeWyoming(uri));
  const asrOpen =
    deps.asrOpen ??
    ((uri: string, opts: { language?: string }) =>
      TranscribeSession.open(uri, opts));

  let accessWarned = false;
  const access = (level: "readwrite" | "readonly"): ApiRouter => {
    if (typeof router.access === "function") return router.access(level);
    if (!accessWarned) {
      accessWarned = true;
      deps.log(
        "router.access() unavailable on this Signal K server — API routes are admin-only",
      );
    }
    return router;
  };

  /** Wrap a handler with the running-flag guard and an error trap. */
  const guarded =
    (handler: ApiHandler): ApiHandler =>
    async (req, res) => {
      if (!deps.running()) {
        res.status(503).json({ error: "signalk-wyoming is stopped" });
        return;
      }
      try {
        await handler(req, res);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.error(`api error: ${message}`);
        try {
          res.status(500).json({ error: message });
        } catch {
          /* headers already sent (streaming route) */
        }
      }
    };

  const findSatellite = (
    req: ApiRequest,
    res: ApiResponse,
  ): SatelliteEntry | null => {
    const id = req.params?.id ?? "";
    const entry = deps.satellites().get(id);
    if (entry === undefined) {
      res.status(404).json({ error: `unknown satellite "${id}"` });
      return null;
    }
    return entry;
  };

  const requireControlApi = (
    req: ApiRequest,
    res: ApiResponse,
  ): { entry: SatelliteEntry; base: string } | null => {
    const entry = findSatellite(req, res);
    if (entry === null) return null;
    const { satellite } = entry;
    if (!satellite.hasControlApi || satellite.controlPort === undefined) {
      res.status(404).json({
        error: `satellite "${satellite.id}" has no control API`,
      });
      return null;
    }
    return {
      entry,
      base: `http://${satellite.host}:${satellite.controlPort}`,
    };
  };

  // --- say ----------------------------------------------------------------

  access("readwrite").post(
    "/api/say",
    guarded(async (req, res) => {
      const body =
        req.body !== null && typeof req.body === "object"
          ? (req.body as Record<string, unknown>)
          : {};
      try {
        const result = await deps.say(body);
        res.status(202).json(result);
      } catch (err) {
        res.status(503).json({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );

  // --- status -------------------------------------------------------------

  access("readonly").get(
    "/api/satellites",
    guarded((_req, res) => {
      const list = [...deps.satellites().values()].map(
        ({ satellite, queue }) => ({
          id: satellite.id,
          name: satellite.name,
          connected: satellite.connected,
          state: satellite.state,
          host: satellite.host,
          port: satellite.port,
          hasControlApi: satellite.hasControlApi,
          queueDepth: queue.depth,
        }),
      );
      res.status(200).json(list);
    }),
  );

  access("readonly").get(
    "/api/services",
    guarded(async (_req, res) => {
      const directory = deps.directory();
      if (directory === null) {
        res.status(503).json({ error: "service directory unavailable" });
        return;
      }
      const snapshot = directory.snapshot() as unknown as Record<
        string,
        Record<string, unknown>
      >;
      // Wake info for the webapp/config UI: the available wake-word model
      // names from the wake service's own `info` response.
      const wake = snapshot.wake;
      if (
        wake !== undefined &&
        typeof wake.uri === "string" &&
        wake.status === "ready"
      ) {
        try {
          const info = await probe(wake.uri);
          wake.models = info.wake.flatMap((program) =>
            (program.models ?? []).map((model) => model.name),
          );
        } catch {
          /* wake service unreachable — models stay absent */
        }
      }
      res.status(200).json(snapshot);
    }),
  );

  access("readonly").get(
    "/api/voices",
    guarded(async (_req, res) => {
      const tts = deps.directory()?.get("tts") ?? null;
      if (tts === null) {
        res.status(503).json({ error: "TTS unavailable" });
        return;
      }
      let info: Info;
      try {
        info = await probe(tts.uri);
      } catch (err) {
        res.status(502).json({
          error: `TTS describe failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
      const voices = info.tts.flatMap((program) =>
        (program.voices ?? []).map((voice: TtsVoice) => ({
          name: voice.name,
          languages: voice.languages ?? [],
          description: voice.description ?? null,
        })),
      );
      res.status(200).json(voices);
    }),
  );

  // --- satellite test tone --------------------------------------------------

  access("readwrite").post(
    "/api/satellites/:id/test",
    guarded((req, res) => {
      const entry = findSatellite(req, res);
      if (entry === null) return;
      if (!entry.satellite.connected) {
        res.status(503).json({
          error: `satellite "${entry.satellite.id}" is not connected`,
        });
        return;
      }
      const item = {
        id: randomUUID(),
        audio: generateTone(),
        priority: "normal" as const,
        text: "[test tone]",
        enqueuedAt: (deps.now ?? Date.now)(),
      };
      try {
        entry.queue.enqueue(item);
      } catch (err) {
        res.status(503).json({
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      deps.hub()?.emit("announcement", {
        satellite: entry.satellite.id,
        text: item.text,
        priority: item.priority,
      });
      res.status(202).json({ ok: true, queued: [entry.satellite.id] });
    }),
  );

  // --- control-API proxies --------------------------------------------------

  access("readonly").get(
    "/api/satellites/:id/devices",
    guarded(async (req, res) => {
      const target = requireControlApi(req, res);
      if (target === null) return;
      const upstream = await fetchImpl(`${target.base}/devices`, {
        signal: AbortSignal.timeout(10000),
      });
      const body = await upstream.json();
      res.status(upstream.status).json(body);
    }),
  );

  access("readwrite").post(
    "/api/satellites/:id/record",
    guarded(async (req, res) => {
      const target = requireControlApi(req, res);
      if (target === null) return;
      const body =
        req.body !== null && typeof req.body === "object" ? req.body : {};
      const rawSeconds = (body as Record<string, unknown>).seconds;
      const seconds =
        typeof rawSeconds === "number" && Number.isFinite(rawSeconds)
          ? clampRecordSeconds(rawSeconds)
          : 3;
      const upstream = await fetchImpl(`${target.base}/test/record`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seconds }),
        signal: AbortSignal.timeout(seconds * 1000 + 15000),
      });
      if (!upstream.ok) {
        res.status(upstream.status).json({
          error: `control API record failed (${upstream.status})`,
        });
        return;
      }
      const wav = Buffer.from(await upstream.arrayBuffer());
      res.setHeader?.("Content-Type", "audio/wav");
      res.status(200).send(wav);
    }),
  );

  access("readwrite").post(
    "/api/satellites/:id/play",
    guarded(async (req, res) => {
      const target = requireControlApi(req, res);
      if (target === null) return;
      const upstream = await fetchImpl(`${target.base}/test/play`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body ?? { type: "tone" }),
        signal: AbortSignal.timeout(30000),
      });
      const body = await upstream.json().catch(() => ({}));
      res.status(upstream.status).json(body);
    }),
  );

  access("readonly").get(
    "/api/satellites/:id/vu",
    guarded(async (req, res) => {
      const target = requireControlApi(req, res);
      if (target === null) return;
      const controller = new AbortController();
      req.on?.("close", () => controller.abort());
      let upstream: Response;
      try {
        upstream = await fetchImpl(`${target.base}/vu`, {
          signal: controller.signal,
        });
      } catch (err) {
        res.status(502).json({
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (!upstream.ok || upstream.body === null) {
        res.status(502).json({ error: "control API VU stream unavailable" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      try {
        for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
          res.write(Buffer.from(chunk));
        }
      } catch {
        /* client or upstream went away — normal for SSE */
      } finally {
        controller.abort();
        res.end();
      }
    }),
  );

  // --- transcribe (record → whisper, D10) -----------------------------------

  access("readwrite").post(
    "/api/transcribe",
    guarded(async (req, res) => {
      const body =
        req.body !== null && typeof req.body === "object"
          ? (req.body as Record<string, unknown>)
          : {};
      const satelliteId =
        typeof body.satellite === "string" ? body.satellite : "";
      if (satelliteId === "") {
        res.status(400).json({
          error: "body must be {satellite: string, seconds?: number}",
        });
        return;
      }
      const asr = deps.directory()?.get("asr") ?? null;
      if (asr === null) {
        res.status(503).json({
          error:
            "ASR unavailable — no speech-to-text service (signalk-whisper) is discovered",
        });
        return;
      }
      const entry = deps.satellites().get(satelliteId);
      if (entry === undefined) {
        res.status(404).json({ error: `unknown satellite "${satelliteId}"` });
        return;
      }
      const { satellite } = entry;
      if (!satellite.hasControlApi || satellite.controlPort === undefined) {
        res.status(404).json({
          error: `satellite "${satellite.id}" has no control API`,
        });
        return;
      }
      const seconds =
        typeof body.seconds === "number" && Number.isFinite(body.seconds)
          ? clampRecordSeconds(body.seconds)
          : 3;
      const upstream = await fetchImpl(
        `http://${satellite.host}:${satellite.controlPort}/test/record`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ seconds }),
          signal: AbortSignal.timeout(seconds * 1000 + 15000),
        },
      );
      if (!upstream.ok) {
        res.status(502).json({
          error: `control API record failed (${upstream.status})`,
        });
        return;
      }
      const wav = Buffer.from(await upstream.arrayBuffer());
      let pcm: ReturnType<typeof wavToPcm>;
      try {
        pcm = wavToPcm(wav);
      } catch (err) {
        res.status(502).json({
          error: `invalid WAV from control API: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
      // Latency (D10): everything after the recording is in hand — session
      // open + PCM feed + whisper transcription.
      const now = deps.now ?? Date.now;
      const startedAt = now();
      const session = await asrOpen(asr.uri, { language: deps.language?.() });
      let text: string;
      try {
        for (let off = 0; off < pcm.pcm.length; off += 2048) {
          session.feed(
            pcm.pcm.subarray(off, Math.min(off + 2048, pcm.pcm.length)),
            pcm.format,
          );
        }
        ({ text } = await session.finish(60000));
      } catch (err) {
        session.abort();
        res.status(502).json({
          error: `transcription failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
      res.status(200).json({ text, latencyMs: Math.round(now() - startedAt) });
    }),
  );

  // --- mute -------------------------------------------------------------------

  access("readwrite").post(
    "/api/mute",
    guarded((req, res) => {
      const body =
        req.body !== null && typeof req.body === "object"
          ? (req.body as Record<string, unknown>)
          : {};
      if (typeof body.muted !== "boolean") {
        res.status(400).json({ error: "body must be {muted: boolean}" });
        return;
      }
      deps.setMuted(body.muted);
      res.status(200).json({ muted: deps.getMuted() });
    }),
  );

  // --- events / log -------------------------------------------------------------

  access("readonly").get(
    "/api/log",
    guarded((_req, res) => {
      const hub = deps.hub();
      res.status(200).json(hub === null ? [] : hub.ring());
    }),
  );

  access("readonly").get(
    "/api/events",
    guarded((req, res) => {
      const hub = deps.hub();
      if (hub === null) {
        res.status(503).json({ error: "event hub unavailable" });
        return;
      }
      hub.addClient(
        { on: (event, listener) => req.on?.(event, listener) },
        res,
      );
    }),
  );

  // --- local satellite image versions (config-panel dropdown) --------------
  // Deliberately NOT guarded by the running flag: the operator picks a tag
  // while the plugin is still disabled, and the route only reaches out to
  // GitHub on demand.

  access("readonly").get("/api/versions", async (_req, res) => {
    try {
      const versions = await fetchSatelliteVersions(fetchImpl);
      res.status(200).json({ versions });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // --- local satellite image updates (admin-only: no access() wrapper) ----------
  // Thin delegation to the helper's update surface: the ManagedContainer is
  // created per-start, but routes register once, so we can't call
  // registerUpdateRoutes() directly on it.

  router.get(
    "/api/update/check",
    guarded(async (_req, res) => {
      const container = deps.localContainer();
      if (container === null) {
        res.status(503).json({ error: "local satellite is not enabled" });
        return;
      }
      res.status(200).json(await container.checkForUpdate());
    }),
  );

  router.post(
    "/api/update/apply",
    guarded(async (req, res) => {
      const container = deps.localContainer();
      if (container === null) {
        res.status(503).json({ error: "local satellite is not enabled" });
        return;
      }
      const body =
        req.body !== null && typeof req.body === "object"
          ? (req.body as Record<string, unknown>)
          : {};
      const tag =
        typeof body.tag === "string" && body.tag !== ""
          ? body.tag
          : (container.lastStartedTag ?? "auto");
      try {
        const applied = await container.applyUpdate(tag);
        res.status(200).json({ success: true, tag: applied.tag });
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
}
