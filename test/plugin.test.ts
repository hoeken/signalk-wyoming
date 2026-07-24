import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, {
  type OrchestratorApp,
  type PluginOverrides,
} from "../src/index.js";
import type {
  LocalSatelliteDeps,
  LocalSatelliteHandle,
} from "../src/local-satellite.js";
import { MockWyomingServer } from "../src/mock/server.js";
import type { ApiHandler, ApiRouter } from "../src/api.js";
import type { PutHandler } from "../src/paths.js";
import type { SayResult } from "../src/types.js";
import { until } from "./helpers.js";

type Plugin = ReturnType<typeof plugin>;

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
      cb([undefined]); // replay-on-subscribe with the seed undefined
      return () => {
        propertySubs.set(
          name,
          (propertySubs.get(name) ?? []).filter((c) => c !== cb),
        );
      };
    },
  };
  const pathValues = (path: string) =>
    deltas
      .flatMap((d) => d.updates.flatMap((u) => u.values ?? []))
      .filter((v) => v.path === path)
      .map((v) => v.value);
  return {
    app,
    calls,
    deltas,
    putHandlers,
    propertyValues,
    propertySubs,
    pathValues,
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

afterEach(async () => {
  for (const p of plugins) await p.stop();
  plugins = [];
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

function construct(app: OrchestratorApp, overrides?: PluginOverrides): Plugin {
  const p = plugin(app, overrides);
  plugins.push(p);
  return p;
}

describe("plugin shape", () => {
  it("default-exports a side-effect-free factory", () => {
    const h = makeApp();
    const p = construct(h.app);
    expect(p.id).toBe("signalk-wyoming");
    expect(typeof p.start).toBe("function");
    expect(typeof p.stop).toBe("function");
    expect(typeof p.registerWithRouter).toBe("function");
    const schema = p.schema() as { type: string };
    expect(schema.type).toBe("object");
    expect(h.calls).toEqual([]); // construction touched nothing
  });

  it("statusMessage is undefined while stopped", () => {
    const p = construct(makeApp().app);
    expect(p.statusMessage()).toBeUndefined();
  });
});

describe("start/stop lifecycle", () => {
  it("invalid config → setPluginError, stays stopped", () => {
    const h = makeApp();
    const p = construct(h.app);
    p.start({ satellites: [{ id: "bad id!", host: "h" }] });
    expect(
      h.calls.some((c) => c.startsWith("pluginError:invalid configuration")),
    ).toBe(true);
    expect(p.statusMessage()).toBeUndefined();
  });

  it("starts empty, emits the PropertyValues API facade, resets muted", () => {
    const h = makeApp();
    const p = construct(h.app);
    p.start({});
    expect(h.propertyValues).toHaveLength(1);
    expect(h.propertyValues[0]?.name).toBe("signalk-wyoming.api");
    const api = h.propertyValues[0]?.value as { version: number; say: unknown };
    expect(api.version).toBe(1);
    expect(typeof api.say).toBe("function");
    expect(h.pathValues("voice.muted")).toEqual([false]);
    expect(p.statusMessage()).toMatch(/0\/0 satellites/);
  });

  it("re-emits the facade on every start; a stale handle fails safely after stop", async () => {
    const h = makeApp();
    const p = construct(h.app);
    p.start({});
    const api = h.propertyValues[0]?.value as {
      say: (opts: { text: string }) => Promise<SayResult>;
    };
    await p.stop();
    await expect(api.say({ text: "hi" })).rejects.toThrow(
      "signalk-wyoming is stopped",
    );
    p.start({});
    expect(h.propertyValues).toHaveLength(2);
  });

  it("facade rejects sensibly while running with no satellites", async () => {
    const h = makeApp();
    const p = construct(h.app);
    p.start({});
    const api = h.propertyValues[0]?.value as {
      say: (opts: { text: string }) => Promise<SayResult>;
    };
    await expect(api.say({ text: "hi" })).rejects.toThrow(
      /no satellites configured/,
    );
  });
});

describe("orchestration end-to-end (mock tts + mock satellite)", () => {
  it("connects satellites, publishes paths, says through the whole stack", async () => {
    const tts = await startServer({ role: "tts" });
    const sat = await startServer({ role: "satellite" });
    const h = makeApp();
    const p = construct(h.app);
    const { router, routes } = makeRouter();
    p.registerWithRouter(router);

    p.start({
      satellites: [{ id: "cockpit", host: "127.0.0.1", port: sat.port }],
      services: { tts: `tcp://127.0.0.1:${tts.port}` },
    });

    // Satellite connects (describe → pause-satellite: no wakeWords) and the
    // connected/state paths appear.
    await until(() =>
      h.pathValues("voice.satellites.cockpit.connected").includes(true),
    );
    expect(h.pathValues("voice.satellites.cockpit.state")).toContain("idle");
    // The mock records pause-satellite a beat after we flip connected.
    await sat.waitForEvent((e) => e.event.type === "pause-satellite");
    expect(sat.log.map((e) => e.event.type).slice(0, 2)).toEqual([
      "describe",
      "pause-satellite",
    ]);

    // REST say → synthesize via mock tts → queue → satellite playback.
    const res = makeRes();
    const sayRoute = routes.get("post /api/say");
    expect(sayRoute).toBeDefined();
    await sayRoute?.({ body: { text: "anchor alarm" } }, res);
    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({ ok: true, queued: ["cockpit"] });
    const synth = tts.log.find((e) => e.event.type === "synthesize");
    expect(synth?.event.data?.text).toBe("anchor alarm");
    await sat.waitForEvent((e) => e.event.type === "audio-stop", {
      timeoutMs: 5000,
    });
    // Playback surfaced the speaking state.
    await until(() =>
      h.pathValues("voice.satellites.cockpit.state").includes("speaking"),
    );

    // Activity is visible in the log ring.
    const logRes = makeRes();
    await routes.get("get /api/log")?.({}, logRes);
    const kinds = (logRes.body as { kind: string }[]).map((e) => e.kind);
    expect(kinds).toContain("announcement");

    // stop(): satellite closed, claim released, routes answer 503.
    await p.stop();
    await until(() => sat.claimedBy === null);
    const stopped = makeRes();
    await routes.get("get /api/satellites")?.({}, stopped);
    expect(stopped.statusCode).toBe(503);
  });

  it("PUT voice.say drives the same say() core", async () => {
    const tts = await startServer({ role: "tts" });
    const sat = await startServer({ role: "satellite" });
    const h = makeApp();
    const p = construct(h.app);
    p.start({
      satellites: [{ id: "s1", host: "127.0.0.1", port: sat.port }],
      services: { tts: `tcp://127.0.0.1:${tts.port}` },
    });
    await until(() =>
      h.pathValues("voice.satellites.s1.connected").includes(true),
    );
    const handler = h.putHandlers.get("voice.say");
    expect(handler).toBeDefined();
    const result = await handler?.(
      "vessels.self",
      "voice.say",
      "hello boat",
      () => {},
    );
    expect(result).toEqual({ state: "COMPLETED", statusCode: 202 });
    await sat.waitForEvent((e) => e.event.type === "audio-stop", {
      timeoutMs: 5000,
    });
  });

  it("voice.muted PUT suppresses normal announcements", async () => {
    const tts = await startServer({ role: "tts" });
    const sat = await startServer({ role: "satellite" });
    const h = makeApp();
    const p = construct(h.app);
    p.start({
      satellites: [{ id: "s1", host: "127.0.0.1", port: sat.port }],
      services: { tts: `tcp://127.0.0.1:${tts.port}` },
    });
    await until(() =>
      h.pathValues("voice.satellites.s1.connected").includes(true),
    );
    const muteHandler = h.putHandlers.get("voice.muted");
    expect(
      muteHandler?.("vessels.self", "voice.muted", true, () => {}),
    ).toMatchObject({
      statusCode: 200,
    });
    const api = h.propertyValues[0]?.value as {
      say: (opts: { text: string }) => Promise<SayResult>;
    };
    await expect(api.say({ text: "quiet please" })).resolves.toEqual({
      ok: false,
      queued: [],
      suppressed: "muted",
    });
  });

  it("wake events without an ASR service get a silent error back", async () => {
    const tts = await startServer({ role: "tts" });
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
      services: { tts: `tcp://127.0.0.1:${tts.port}` },
    });
    await until(() =>
      h.pathValues("voice.satellites.s1.connected").includes(true),
    );
    // wake mode → run-satellite (not pause) claims the mock a beat later
    await until(() => sat.claimedBy !== null);
    expect(sat.log.map((e) => e.event.type)).toContain("run-satellite");
    sat.wake("okay_nabu");
    await sat.waitForEvent((e) => e.event.type === "error", {
      timeoutMs: 3000,
    });
    await until(() => !sat.streaming);
    // Nothing published to voice.command in wave F.
    expect(h.pathValues("voice.command")).toEqual([]);
  });

  it("discovery-driven services resolve through onPropertyValues", async () => {
    const tts = await startServer({ role: "tts" });
    const sat = await startServer({ role: "satellite" });
    const h = makeApp();
    const p = construct(h.app);
    const { router, routes } = makeRouter();
    p.registerWithRouter(router);
    p.start({
      satellites: [{ id: "s1", host: "127.0.0.1", port: sat.port }],
      // services default to 'auto' — resolved via discovery
    });
    await until(() =>
      h.pathValues("voice.satellites.s1.connected").includes(true),
    );

    // No tts yet → say rejects with 503
    const before = makeRes();
    await routes.get("post /api/say")?.({ body: { text: "hi" } }, before);
    expect(before.statusCode).toBe(503);

    // signalk-piper announces itself
    const subs = h.propertySubs.get("wyoming-service") ?? [];
    expect(subs.length).toBeGreaterThan(0);
    subs.forEach((cb) =>
      cb([
        undefined,
        {
          value: {
            plugin: "signalk-piper",
            type: "tts",
            uri: `tcp://127.0.0.1:${tts.port}`,
            status: "ready",
          },
        },
      ]),
    );
    const services = makeRes();
    await routes.get("get /api/services")?.({}, services);
    expect((services.body as { tts: { status: string } }).tts).toMatchObject({
      uri: `tcp://127.0.0.1:${tts.port}`,
      status: "ready",
      source: "auto",
      plugin: "signalk-piper",
    });

    const after = makeRes();
    await routes.get("post /api/say")?.({ body: { text: "hi" } }, after);
    expect(after.statusCode).toBe(202);
  });

  it("degrades without optional app APIs (CI lifecycle harness)", async () => {
    const minimal = {
      debug: vi.fn(),
      error: vi.fn(),
      setPluginStatus: vi.fn(),
      setPluginError: vi.fn(),
      handleMessage: vi.fn(),
    } as unknown as OrchestratorApp;
    const p = construct(minimal);
    expect(() => p.start({})).not.toThrow();
    await p.stop();
  });

  it("POST /api/mute publishes the voice.muted delta (same switch as the PUT)", async () => {
    const h = makeApp();
    const p = construct(h.app);
    const { router, routes } = makeRouter();
    p.registerWithRouter(router);
    p.start({});
    expect(h.pathValues("voice.muted")).toEqual([false]);
    const res = makeRes();
    await routes.get("post /api/mute")?.({ body: { muted: true } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ muted: true });
    // The Signal K path tracks the actual suppression state (spec §4.1).
    expect(h.pathValues("voice.muted")).toEqual([false, true]);
    // The PUT drives the same switch — and publishes exactly once.
    const handler = h.putHandlers.get("voice.muted");
    await handler?.("vessels.self", "voice.muted", false, () => {});
    expect(h.pathValues("voice.muted")).toEqual([false, true, false]);
  });
});

describe("local satellite lifecycle", () => {
  interface FakeLocal {
    handle: LocalSatelliteHandle;
    calls: string[];
    starts: (string | null)[];
    deps: () => LocalSatelliteDeps;
  }

  function makeFakeLocal(
    opts: { gate?: Promise<void> } = {},
  ): FakeLocal & { overrides: PluginOverrides } {
    const calls: string[] = [];
    const starts: (string | null)[] = [];
    let deps: LocalSatelliteDeps | null = null;
    let startedWake: string | null | undefined;
    const handle: LocalSatelliteHandle = {
      container: {} as never,
      async start() {
        calls.push("start");
        if (opts.gate !== undefined) await opts.gate;
        startedWake = deps?.wakeUri() ?? null;
        starts.push(startedWake);
        return {
          host: "127.0.0.1",
          port: 10701,
          controlHost: "127.0.0.1",
          controlPort: 10801,
        };
      },
      async stop() {
        calls.push("stop");
      },
      needsRestart: () =>
        startedWake !== undefined && startedWake !== (deps?.wakeUri() ?? null),
      checkAudioDevices: async () => null,
    };
    return {
      handle,
      calls,
      starts,
      deps: () => {
        if (deps === null) throw new Error("createLocalSatellite not called");
        return deps;
      },
      overrides: {
        createLocalSatellite: (d) => {
          deps = d;
          return handle;
        },
      },
    };
  }

  it("stop() during an in-flight container start still stops the container (spec §4.3)", async () => {
    const h = makeApp();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fake = makeFakeLocal({ gate });
    const p = construct(h.app, fake.overrides);
    p.start({ localSatellite: { enabled: true } });
    expect(fake.calls).toEqual(["start"]);

    // Disable the plugin while the (potentially minutes-long first-pull)
    // container start is still in flight.
    const stopping = p.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // stop() waits for the in-flight start instead of racing it…
    expect(stopped).toBe(false);
    release();
    await stopping;
    // …and the freshly-started container was stopped, not orphaned with an
    // open microphone.
    expect(fake.calls[0]).toBe("start");
    expect(fake.calls.filter((c) => c === "stop").length).toBeGreaterThan(0);
    // No satellite was wired for the dead plugin instance.
    expect(h.pathValues("voice.satellites.local.connected")).toEqual([]);
  });

  it("re-wires the container when the wake service appears after start (§3.1 start order)", async () => {
    const h = makeApp();
    const fake = makeFakeLocal();
    const p = construct(h.app, fake.overrides);
    p.start({
      localSatellite: { enabled: true, wakeWords: ["okay_nabu"] },
    });
    await until(() => fake.starts.length === 1);
    // Orchestrator started before signalk-openwakeword: no WAKE_URI yet,
    // and the §4.3 degraded-mode alarm is raised.
    expect(fake.starts).toEqual([null]);
    await until(() => h.pathValues("notifications.voice.wake").length >= 1);

    // The wake service announces itself late (§3.1: start order never
    // matters) → the container is restarted with the rebuilt env.
    const subs = h.propertySubs.get("wyoming-service") ?? [];
    subs.forEach((cb) =>
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
      ]),
    );
    await until(() => fake.starts.length === 2, 5000);
    expect(fake.starts[1]).toBe("tcp://127.0.0.1:10400");
    // Clearing the alarm is now truthful: the container really is wake-wired.
    const wakeStates = h
      .pathValues("notifications.voice.wake")
      .map((v) => (v as { state: string }).state);
    expect(wakeStates).toEqual(["alarm", "normal"]);
    // A status flap without a URI change must NOT restart the container.
    subs.forEach((cb) =>
      cb([
        undefined,
        {
          value: {
            plugin: "signalk-openwakeword",
            type: "wake",
            uri: "tcp://127.0.0.1:10400",
            status: "error",
          },
        },
      ]),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.starts.length).toBe(2);
  });
});
