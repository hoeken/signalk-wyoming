/**
 * Wave G end-to-end: the full plugin against mock satellite + asr + tts
 * roles — wake → mic stream → endpoint → whisper → transcript relayed +
 * voice.command; dedup; urgent cancellation; barge-in; pipeline timeout;
 * wake-service warning; /api/transcribe.
 */

import { afterEach, describe, expect, it } from "vitest";
import plugin, { type OrchestratorApp } from "../src/index.js";
import { MockWyomingServer } from "../src/mock/server.js";
import type { ApiHandler, ApiRouter } from "../src/api.js";
import type { PutHandler } from "../src/paths.js";
import { until } from "./helpers.js";

type Plugin = ReturnType<typeof plugin>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Fast endpointing for tests: the mock's constant mic PCM hits the cap. */
const FAST_ADVANCED = {
  maxUtteranceMs: 320,
  silenceMs: 100,
  minUtteranceMs: 50,
};

interface Delta {
  updates: {
    $source?: string;
    values?: { path: string; value: unknown }[];
    meta?: { path: string; value: unknown }[];
  }[];
}

function makeApp() {
  const calls: string[] = [];
  const deltas: Delta[] = [];
  const putHandlers = new Map<string, PutHandler>();
  const propertyValues: { name: string; value: unknown }[] = [];
  const propertySubs = new Map<string, ((history: unknown[]) => void)[]>();
  const app: OrchestratorApp = {
    debug: (msg) => calls.push(`debug:${msg}`),
    error: (msg) => calls.push(`error:${msg}`),
    setPluginStatus: (msg) => calls.push(`status:${msg}`),
    setPluginError: (msg) => calls.push(`pluginError:${msg}`),
    handleMessage: (_id, delta) => deltas.push(delta as unknown as Delta),
    registerPutHandler: (_context, path, handler) => {
      putHandlers.set(path, handler);
    },
    emitPropertyValue: (name, value) => propertyValues.push({ name, value }),
    onPropertyValues: (name, cb) => {
      const list = propertySubs.get(name) ?? [];
      list.push(cb);
      propertySubs.set(name, list);
      cb([undefined]);
      return () => {};
    },
  };
  const pathValues = (path: string) =>
    deltas
      .flatMap((d) => d.updates.flatMap((u) => u.values ?? []))
      .filter((v) => v.path === path)
      .map((v) => v.value);
  const sourceOf = (path: string) =>
    deltas
      .flatMap((d) => d.updates)
      .filter((u) => (u.values ?? []).some((v) => v.path === path))
      .map((u) => u.$source);
  return {
    app,
    calls,
    deltas,
    putHandlers,
    propertyValues,
    propertySubs,
    pathValues,
    sourceOf,
  };
}

function makeRouter() {
  const routes = new Map<string, ApiHandler>();
  const add = (method: string) => (path: string, handler: ApiHandler) => {
    routes.set(`${method} ${path}`, handler);
  };
  const router: ApiRouter = {
    get: add("get"),
    post: add("post"),
    access: () => ({ get: add("get"), post: add("post") }),
  };
  return { router, routes };
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(b: unknown) {
      res.body = b;
    },
    send(b: unknown) {
      res.body = b;
    },
    writeHead() {},
    write() {},
    end() {},
  };
  return res;
}

let servers: MockWyomingServer[] = [];
let plugins: Plugin[] = [];

async function startServer(
  options: ConstructorParameters<typeof MockWyomingServer>[0],
): Promise<MockWyomingServer> {
  const server = new MockWyomingServer(options);
  await server.listen();
  servers.push(server);
  return server;
}

function construct(app: OrchestratorApp): Plugin {
  const p = plugin(app);
  plugins.push(p);
  return p;
}

/** Wait until the orchestrator's connection has claimed the mock satellite. */
async function awaitClaimed(sat: MockWyomingServer): Promise<void> {
  await until(() => sat.claimedBy !== null);
}

afterEach(async () => {
  for (const p of plugins) await p.stop();
  plugins = [];
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

describe("full pipeline e2e (mock satellite + asr)", () => {
  it("wake → stream → endpoint → transcript relayed + voice.command published", async () => {
    const asr = await startServer({
      role: "asr",
      transcripts: ["anchor light on"],
    });
    const sat = await startServer({
      role: "satellite",
      streamChunkIntervalMs: 5,
    });
    const h = makeApp();
    const p = construct(h.app);
    const { router, routes } = makeRouter();
    p.registerWithRouter(router);
    p.start({
      satellites: [
        {
          id: "s1",
          host: "127.0.0.1",
          port: sat.port,
          wakeWords: ["okay_nabu"],
        },
      ],
      services: { asr: `tcp://127.0.0.1:${asr.port}` },
      advanced: FAST_ADVANCED,
    });
    await until(() =>
      h.pathValues("voice.satellites.s1.connected").includes(true),
    );

    await awaitClaimed(sat);
    sat.wake("okay_nabu");
    const transcript = await sat.waitForEvent(
      (e) => e.event.type === "transcript",
      { timeoutMs: 5000 },
    );
    expect(transcript.event.data?.text).toBe("anchor light on");
    await until(() => !sat.streaming);

    // voice.command delta: shape + $source (spec §4.1)
    await until(() => h.pathValues("voice.command").length > 0);
    const cmd = h.pathValues("voice.command")[0] as Record<string, unknown>;
    expect(cmd).toMatchObject({
      text: "anchor light on",
      satellite: "s1",
      language: "en",
      wakeWord: "okay_nabu",
    });
    expect(cmd.id).toMatch(UUID_RE);
    expect(cmd.durationMs).toBeGreaterThanOrEqual(0);
    expect(h.sourceOf("voice.command")).toEqual(["signalk-wyoming.s1"]);

    // Satellite state walked listening → transcribing → idle
    const states = h.pathValues("voice.satellites.s1.state");
    expect(states).toContain("listening");
    expect(states).toContain("transcribing");
    expect(states[states.length - 1]).toBe("idle");

    // whisper got the full session: transcribe → audio-start → chunks → stop
    const asrTypes = asr.log.map((e) => e.event.type);
    expect(asrTypes[0]).toBe("transcribe");
    expect(asrTypes[1]).toBe("audio-start");
    expect(asrTypes).toContain("audio-chunk");
    expect(asrTypes).toContain("audio-stop");
    expect(asr.log[0]?.event.data?.language).toBe("en");

    // SSE hub saw detection + command events
    const logRes = makeRes();
    await routes.get("get /api/log")?.({}, logRes);
    const kinds = (logRes.body as { kind: string }[]).map((e) => e.kind);
    expect(kinds).toContain("detection");
    expect(kinds).toContain("command");
  });

  it("wake dedup: first detection wins, the loser gets a silent error", async () => {
    const asr = await startServer({
      role: "asr",
      transcripts: ["only the winner"],
    });
    const sat1 = await startServer({
      role: "satellite",
      streamChunkIntervalMs: 5,
    });
    const sat2 = await startServer({
      role: "satellite",
      streamChunkIntervalMs: 5,
    });
    const h = makeApp();
    const p = construct(h.app);
    p.start({
      satellites: [
        {
          id: "s1",
          host: "127.0.0.1",
          port: sat1.port,
          wakeWords: ["okay_nabu"],
        },
        {
          id: "s2",
          host: "127.0.0.1",
          port: sat2.port,
          wakeWords: ["okay_nabu"],
        },
      ],
      services: { asr: `tcp://127.0.0.1:${asr.port}` },
      advanced: FAST_ADVANCED, // wakeDedupMs stays at its 2000 default
    });
    await until(
      () =>
        h.pathValues("voice.satellites.s1.connected").includes(true) &&
        h.pathValues("voice.satellites.s2.connected").includes(true),
    );

    // Open companionway: both hear it, s1 first.
    await awaitClaimed(sat1);
    sat1.wake("okay_nabu");
    await until(() =>
      h.pathValues("voice.satellites.s1.state").includes("listening"),
    );
    await awaitClaimed(sat2);
    sat2.wake("okay_nabu");

    const loserError = await sat2.waitForEvent(
      (e) => e.event.type === "error",
      { timeoutMs: 3000 },
    );
    expect(loserError.event.data?.code).toBe("wake-dedup");
    await until(() => !sat2.streaming);

    await sat1.waitForEvent((e) => e.event.type === "transcript", {
      timeoutMs: 5000,
    });
    await until(() => h.pathValues("voice.command").length > 0);
    const commands = h.pathValues("voice.command") as { satellite: string }[];
    expect(commands).toHaveLength(1);
    expect(commands[0]?.satellite).toBe("s1");
  });

  it("urgent say mid-pipeline cancels it: satellite gets error, nothing published, urgent plays", async () => {
    const asr = await startServer({
      role: "asr",
      transcripts: ["should never appear"],
    });
    const tts = await startServer({ role: "tts" });
    const sat = await startServer({
      role: "satellite",
      streamChunkIntervalMs: 5,
    });
    const h = makeApp();
    const p = construct(h.app);
    const { router, routes } = makeRouter();
    p.registerWithRouter(router);
    p.start({
      satellites: [
        {
          id: "s1",
          host: "127.0.0.1",
          port: sat.port,
          wakeWords: ["okay_nabu"],
        },
      ],
      services: {
        asr: `tcp://127.0.0.1:${asr.port}`,
        tts: `tcp://127.0.0.1:${tts.port}`,
      },
      // default maxUtteranceMs (10 s) — the pipeline stays live while we say()
    });
    await until(() =>
      h.pathValues("voice.satellites.s1.connected").includes(true),
    );

    await awaitClaimed(sat);
    sat.wake("okay_nabu");
    await until(() =>
      h.pathValues("voice.satellites.s1.state").includes("listening"),
    );

    const res = makeRes();
    await routes.get("post /api/say")?.(
      { body: { text: "abandon ship", priority: "urgent" } },
      res,
    );
    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ ok: true, queued: ["s1"] });

    // Pipeline aborted silently...
    const err = await sat.waitForEvent((e) => e.event.type === "error", {
      timeoutMs: 3000,
    });
    expect(err.event.data?.code).toBe("cancelled");
    await until(() => !sat.streaming);
    // ...and the urgent announcement played AFTER the abort.
    await sat.waitForEvent((e) => e.event.type === "audio-stop", {
      timeoutMs: 5000,
    });
    const types = sat.log.map((e) => e.event.type);
    expect(types.indexOf("error")).toBeLessThan(types.indexOf("audio-start"));
    // Nothing published, no done sound (no transcript event).
    expect(h.pathValues("voice.command")).toEqual([]);
    expect(types).not.toContain("transcript");
  });

  it("wake during normal playback barges in: playback cancelled, pipeline completes", async () => {
    const asr = await startServer({
      role: "asr",
      transcripts: ["barge in worked"],
    });
    const tts = await startServer({ role: "tts" });
    const sat = await startServer({
      role: "satellite",
      streamChunkIntervalMs: 5,
      playedDelayMs: 2000, // keeps the satellite 'speaking' while we wake it
    });
    const h = makeApp();
    const p = construct(h.app);
    const { router, routes } = makeRouter();
    p.registerWithRouter(router);
    p.start({
      satellites: [
        {
          id: "s1",
          host: "127.0.0.1",
          port: sat.port,
          wakeWords: ["okay_nabu"],
        },
      ],
      services: {
        asr: `tcp://127.0.0.1:${asr.port}`,
        tts: `tcp://127.0.0.1:${tts.port}`,
      },
      advanced: FAST_ADVANCED,
    });
    await until(() =>
      h.pathValues("voice.satellites.s1.connected").includes(true),
    );

    const res = makeRes();
    await routes.get("post /api/say")?.(
      { body: { text: "a long normal announcement" } },
      res,
    );
    expect(res.statusCode).toBe(202);
    await until(() =>
      h.pathValues("voice.satellites.s1.state").includes("speaking"),
    );

    await awaitClaimed(sat);
    sat.wake("okay_nabu");
    const transcript = await sat.waitForEvent(
      (e) => e.event.type === "transcript",
      { timeoutMs: 5000 },
    );
    expect(transcript.event.data?.text).toBe("barge in worked");
    await until(() => h.pathValues("voice.command").length > 0);
    expect(
      (h.pathValues("voice.command")[0] as { satellite: string }).satellite,
    ).toBe("s1");
    // Playback was cancelled for the pipeline (remainder dropped), state
    // walked speaking → listening without waiting for `played`.
    const states = h.pathValues("voice.satellites.s1.state");
    expect(states.indexOf("speaking")).toBeLessThan(
      states.indexOf("listening"),
    );
  });

  it("pipeline timeout on a hung ASR: error to satellite, alarm notification, nothing published", async () => {
    const asr = await startServer({ role: "asr", hang: true });
    const sat = await startServer({
      role: "satellite",
      streamChunkIntervalMs: 5,
    });
    const h = makeApp();
    const p = construct(h.app);
    p.start({
      satellites: [
        {
          id: "s1",
          host: "127.0.0.1",
          port: sat.port,
          wakeWords: ["okay_nabu"],
        },
      ],
      services: { asr: `tcp://127.0.0.1:${asr.port}` },
      advanced: { ...FAST_ADVANCED, pipelineTimeoutMs: 400 },
    });
    await until(() =>
      h.pathValues("voice.satellites.s1.connected").includes(true),
    );

    await awaitClaimed(sat);
    sat.wake("okay_nabu");
    const err = await sat.waitForEvent((e) => e.event.type === "error", {
      timeoutMs: 3000,
    });
    expect(err.event.data?.code).toBe("timeout");
    await until(() => !sat.streaming);
    expect(h.pathValues("voice.command")).toEqual([]);
    const alarms = h.pathValues("notifications.voice.asr");
    expect(alarms[0]).toMatchObject({ state: "alarm", method: ["visual"] });
    const states = h.pathValues("voice.satellites.s1.state");
    expect(states[states.length - 1]).toBe("idle");
  });

  it("wake without an ASR service: silent error + notifications.voice.asr alarm", async () => {
    const sat = await startServer({
      role: "satellite",
      streamChunkIntervalMs: 5,
    });
    const h = makeApp();
    const p = construct(h.app);
    p.start({
      satellites: [
        {
          id: "s1",
          host: "127.0.0.1",
          port: sat.port,
          wakeWords: ["okay_nabu"],
        },
      ],
    });
    await until(() =>
      h.pathValues("voice.satellites.s1.connected").includes(true),
    );
    await awaitClaimed(sat);
    sat.wake("okay_nabu");
    const err = await sat.waitForEvent((e) => e.event.type === "error", {
      timeoutMs: 3000,
    });
    expect(err.event.data?.code).toBe("no-asr");
    await until(() => !sat.streaming);
    expect(h.pathValues("voice.command")).toEqual([]);
    expect(h.pathValues("notifications.voice.asr")[0]).toMatchObject({
      state: "alarm",
    });
  });
});

describe("wake service warning (spec §4.3 degraded mode)", () => {
  it("wake words without a wake service → status warning + notifications.voice.wake alarm; clears on discovery", () => {
    const h = makeApp();
    const p = construct(h.app);
    p.start({
      satellites: [
        { id: "s1", host: "127.0.0.1", port: 1, wakeWords: ["okay_nabu"] },
      ],
    });
    expect(p.statusMessage()).toMatch(/WARNING: wake words configured/);
    expect(h.pathValues("notifications.voice.wake")[0]).toMatchObject({
      state: "alarm",
      method: ["visual"],
    });

    // openwakeword announces itself → warning clears, alarm → normal
    for (const cb of h.propertySubs.get("wyoming-service") ?? []) {
      cb([
        undefined,
        {
          value: {
            plugin: "signalk-openwakeword",
            type: "wake",
            uri: "tcp://127.0.0.1:10400",
            status: "ready",
          },
        },
      ]);
    }
    expect(p.statusMessage()).not.toMatch(/WARNING/);
    expect(h.pathValues("notifications.voice.wake")[1]).toMatchObject({
      state: "normal",
    });
  });

  it("no warning when no satellite has wake words", () => {
    const h = makeApp();
    const p = construct(h.app);
    p.start({ satellites: [{ id: "s1", host: "127.0.0.1", port: 1 }] });
    expect(p.statusMessage()).not.toMatch(/WARNING/);
    expect(h.pathValues("notifications.voice.wake")).toEqual([]);
  });
});

describe("POST /api/transcribe (record → whisper, real TranscribeSession)", () => {
  it("records via the control API, strips the WAV header, transcribes, reports latency", async () => {
    const asr = await startServer({ role: "asr", transcripts: ["hello sea"] });
    const sat = await startServer({ role: "satellite" });
    const h = makeApp();
    const p = construct(h.app);
    const { router, routes } = makeRouter();
    p.registerWithRouter(router);
    p.start({
      satellites: [{ id: "s1", host: "127.0.0.1", port: sat.port }],
      services: { asr: `tcp://127.0.0.1:${asr.port}` },
    });
    await until(() =>
      h.pathValues("voice.satellites.s1.connected").includes(true),
    );

    // The registered route uses global fetch for the control API — but this
    // satellite has no control API configured, so it answers 404 honestly.
    const res = makeRes();
    await routes.get("post /api/transcribe")?.(
      { body: { satellite: "s1" } },
      res,
    );
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: string }).error).toMatch(/no control API/);

    // Without an ASR service it answers 503 before touching anything.
    const noAsr = makeRes();
    await plugins[0]?.stop();
    plugins[0]?.start({
      satellites: [{ id: "s1", host: "127.0.0.1", port: sat.port }],
    });
    await routes.get("post /api/transcribe")?.(
      { body: { satellite: "s1" } },
      noAsr,
    );
    expect(noAsr.statusCode).toBe(503);
    expect((noAsr.body as { error: string }).error).toMatch(/ASR unavailable/);
  });
});
