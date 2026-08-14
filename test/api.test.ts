import { describe, expect, it, vi } from "vitest";
import {
  generateTone,
  registerApiRoutes,
  type ApiDeps,
  type ApiHandler,
  type ApiRouter,
  type SatelliteEntry,
} from "../src/api.js";
import { EventHub } from "../src/events.js";
import type { AudioFormat, Info } from "../src/protocol/events.js";
import type { ServiceDirectory } from "../src/discovery.js";
import { buildWav, sinePcm } from "./pcm.js";

interface RouteRecord {
  method: string;
  path: string;
  access: "readwrite" | "readonly" | "admin";
  handler: ApiHandler;
}

function makeRouter() {
  const routes = new Map<string, RouteRecord>();
  const add =
    (access: RouteRecord["access"], method: string) =>
    (path: string, handler: ApiHandler) => {
      routes.set(`${method} ${path}`, { method, path, access, handler });
    };
  const router: ApiRouter = {
    get: add("admin", "get"),
    post: add("admin", "post"),
    access: (level) => ({
      get: add(level, "get"),
      post: add(level, "post"),
    }),
  };
  return { router, routes };
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    written: [] as (string | Buffer)[],
    ended: false,
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
    setHeader(n: string, v: string) {
      res.headers[n] = v;
    },
    writeHead(code: number, headers: Record<string, string>) {
      res.statusCode = code;
      Object.assign(res.headers, headers);
    },
    write(c: string | Buffer) {
      res.written.push(c);
    },
    end() {
      res.ended = true;
    },
  };
  return res;
}

function fakeSatellite(
  id: string,
  opts: Partial<{
    connected: boolean;
    hasControlApi: boolean;
    controlPort: number;
    enqueue: (item: unknown) => number;
  }> = {},
): SatelliteEntry {
  const enqueued: unknown[] = [];
  return {
    satellite: {
      id,
      name: id,
      connected: opts.connected ?? true,
      state: "idle",
      host: "127.0.0.1",
      port: 10700,
      hasControlApi: opts.hasControlApi ?? false,
      controlPort: opts.controlPort,
    },
    queue: {
      depth: enqueued.length,
      enqueue:
        opts.enqueue ??
        ((item: unknown) => {
          enqueued.push(item);
          return 0;
        }),
    },
  } as unknown as SatelliteEntry;
}

function makeDeps(overrides: Partial<ApiDeps> = {}) {
  const satellites = new Map<string, SatelliteEntry>();
  const hub = new EventHub();
  let running = true;
  let muted = false;
  const deps: ApiDeps = {
    running: () => running,
    say: vi.fn(async () => ({ ok: true, queued: ["a"] })),
    directory: () =>
      ({
        snapshot: () => ({
          asr: { uri: null, status: null, source: null },
          tts: {
            uri: "tcp://127.0.0.1:10200",
            status: "ready",
            source: "auto",
          },
          wake: { uri: null, status: null, source: null },
        }),
        get: (type: string) =>
          type === "tts"
            ? { uri: "tcp://127.0.0.1:10200", status: "ready", source: "auto" }
            : null,
      }) as unknown as ServiceDirectory,
    satellites: () => satellites,
    hub: () => hub,
    getMuted: () => muted,
    setMuted: (m) => {
      muted = m;
    },
    localContainer: () => null,
    log: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };
  return {
    deps,
    satellites,
    hub,
    setRunning: (r: boolean) => {
      running = r;
    },
  };
}

async function call(
  routes: Map<string, RouteRecord>,
  key: string,
  req: { body?: unknown; params?: Record<string, string> } = {},
) {
  const route = routes.get(key);
  if (route === undefined) throw new Error(`route not registered: ${key}`);
  const res = makeRes();
  await route.handler({ ...req, on: () => {} }, res);
  return res;
}

describe("route registration + access levels", () => {
  it("registers every DESIGN.md endpoint with the right access level", () => {
    const { router, routes } = makeRouter();
    registerApiRoutes(router, makeDeps().deps);
    const expectAccess = (key: string, access: string) => {
      expect(routes.get(key)?.access, key).toBe(access);
    };
    expectAccess("post /api/say", "readwrite");
    expectAccess("get /api/satellites", "readonly");
    expectAccess("get /api/services", "readonly");
    expectAccess("get /api/voices", "readonly");
    expectAccess("post /api/satellites/:id/test", "readwrite");
    expectAccess("get /api/satellites/:id/devices", "readonly");
    expectAccess("post /api/satellites/:id/record", "readwrite");
    expectAccess("post /api/satellites/:id/play", "readwrite");
    expectAccess("get /api/satellites/:id/vu", "readonly");
    expectAccess("post /api/transcribe", "readwrite");
    expectAccess("post /api/mute", "readwrite");
    expectAccess("get /api/events", "readonly");
    expectAccess("get /api/log", "readonly");
    expectAccess("get /api/versions", "readonly");
    expectAccess("get /api/update/check", "admin");
    expectAccess("post /api/update/apply", "admin");
  });

  it("falls back to admin-only (with a single log line) without router.access", () => {
    const routes = new Map<string, RouteRecord>();
    const add = (method: string) => (path: string, handler: ApiHandler) =>
      routes.set(`${method} ${path}`, {
        method,
        path,
        access: "admin",
        handler,
      });
    const router: ApiRouter = { get: add("get"), post: add("post") };
    const { deps } = makeDeps();
    registerApiRoutes(router, deps);
    expect(routes.has("post /api/say")).toBe(true);
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining("admin-only"),
    );
    expect(
      (deps.log as ReturnType<typeof vi.fn>).mock.calls.filter(([m]) =>
        String(m).includes("admin-only"),
      ),
    ).toHaveLength(1);
  });
});

describe("running-flag guard", () => {
  it("answers 503 on every route while stopped", async () => {
    const { router, routes } = makeRouter();
    const h = makeDeps();
    registerApiRoutes(router, h.deps);
    h.setRunning(false);
    for (const key of [
      "post /api/say",
      "get /api/satellites",
      "get /api/log",
    ]) {
      const res = await call(routes, key, { body: {} });
      expect(res.statusCode, key).toBe(503);
      expect((res.body as { error: string }).error).toMatch(/stopped/);
    }
  });
});

describe("GET /api/versions", () => {
  const githubTags = (names: string[]) =>
    (async () => ({
      ok: true,
      status: 200,
      json: async () => names.map((name) => ({ name })),
    })) as unknown as typeof fetch;

  it("serves sorted satellite image tags, even while stopped (unguarded)", async () => {
    const { router, routes } = makeRouter();
    const h = makeDeps({
      fetchImpl: githubTags(["v0.1.0", "v0.2.0-rc1", "v0.1.1", "junk"]),
    });
    registerApiRoutes(router, h.deps);
    h.setRunning(false); // config-panel dropdown works pre-enable
    const res = await call(routes, "get /api/versions");
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      versions: [
        { tag: "0.2.0-rc1", prerelease: true },
        { tag: "0.1.1" },
        { tag: "0.1.0" },
      ],
    });
  });

  it("502 {error} when GitHub is unreachable or rate-limited", async () => {
    const { router, routes } = makeRouter();
    const h = makeDeps({
      fetchImpl: (async () => ({
        ok: false,
        status: 403,
      })) as unknown as typeof fetch,
    });
    registerApiRoutes(router, h.deps);
    const res = await call(routes, "get /api/versions");
    expect(res.statusCode).toBe(502);
    expect((res.body as { error: string }).error).toMatch(/403/);
  });
});

describe("POST /api/say", () => {
  it("200 + result on success", async () => {
    const { router, routes } = makeRouter();
    const h = makeDeps();
    registerApiRoutes(router, h.deps);
    const res = await call(routes, "post /api/say", { body: { text: "hi" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, queued: ["a"] });
    expect(h.deps.say).toHaveBeenCalledWith({ text: "hi" });
  });

  it("503 {ok:false,error} when say rejects", async () => {
    const { router, routes } = makeRouter();
    const h = makeDeps({
      say: vi.fn(async () => Promise.reject(new Error("say: TTS unavailable"))),
    });
    registerApiRoutes(router, h.deps);
    const res = await call(routes, "post /api/say", { body: { text: "hi" } });
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ ok: false, error: "say: TTS unavailable" });
  });
});

describe("status endpoints", () => {
  it("GET /api/satellites lists id/name/connected/state/host/port/hasControlApi/queueDepth", async () => {
    const { router, routes } = makeRouter();
    const h = makeDeps();
    h.satellites.set(
      "cockpit",
      fakeSatellite("cockpit", { hasControlApi: true, controlPort: 10800 }),
    );
    registerApiRoutes(router, h.deps);
    const res = await call(routes, "get /api/satellites");
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([
      {
        id: "cockpit",
        name: "cockpit",
        connected: true,
        state: "idle",
        host: "127.0.0.1",
        port: 10700,
        hasControlApi: true,
        queueDepth: 0,
      },
    ]);
  });

  it("GET /api/services returns the directory snapshot", async () => {
    const { router, routes } = makeRouter();
    registerApiRoutes(router, makeDeps().deps);
    const res = await call(routes, "get /api/services");
    expect(res.statusCode).toBe(200);
    expect((res.body as Record<string, unknown>).tts).toMatchObject({
      uri: "tcp://127.0.0.1:10200",
      status: "ready",
    });
  });

  it("GET /api/services attaches wake model names from the wake service info", async () => {
    const { router, routes } = makeRouter();
    const wakeInfo: Info = {
      asr: [],
      tts: [],
      handle: [],
      intent: [],
      mic: [],
      snd: [],
      wake: [
        {
          name: "openwakeword",
          models: [{ name: "okay_nabu" }, { name: "hey_jarvis" }],
        },
      ],
    };
    const probe = vi.fn(async (uri: string) => {
      expect(uri).toBe("tcp://127.0.0.1:10400");
      return wakeInfo;
    });
    const directory = () =>
      ({
        snapshot: () => ({
          asr: { uri: null, status: null, source: null },
          tts: { uri: null, status: null, source: null },
          wake: {
            uri: "tcp://127.0.0.1:10400",
            status: "ready",
            source: "auto",
          },
        }),
        get: () => null,
      }) as unknown as ServiceDirectory;
    registerApiRoutes(router, { ...makeDeps().deps, directory, probe });
    const res = await call(routes, "get /api/services");
    expect(res.statusCode).toBe(200);
    expect((res.body as { wake: { models: string[] } }).wake.models).toEqual([
      "okay_nabu",
      "hey_jarvis",
    ]);
  });

  it("GET /api/services tolerates a wake probe failure (models absent)", async () => {
    const { router, routes } = makeRouter();
    const directory = () =>
      ({
        snapshot: () => ({
          asr: { uri: null, status: null, source: null },
          tts: { uri: null, status: null, source: null },
          wake: {
            uri: "tcp://127.0.0.1:10400",
            status: "ready",
            source: "auto",
          },
        }),
        get: () => null,
      }) as unknown as ServiceDirectory;
    registerApiRoutes(router, {
      ...makeDeps().deps,
      directory,
      probe: vi.fn(async () => Promise.reject(new Error("unreachable"))),
    });
    const res = await call(routes, "get /api/services");
    expect(res.statusCode).toBe(200);
    const wake = (res.body as { wake: Record<string, unknown> }).wake;
    expect(wake.uri).toBe("tcp://127.0.0.1:10400");
    expect("models" in wake).toBe(false);
  });

  it("GET /api/voices probes the TTS service info", async () => {
    const { router, routes } = makeRouter();
    const info: Info = {
      asr: [],
      handle: [],
      intent: [],
      wake: [],
      mic: [],
      snd: [],
      tts: [
        {
          name: "piper",
          voices: [
            {
              name: "en_US-lessac-medium",
              languages: ["en_US"],
              description: null,
            },
          ],
        },
      ],
    };
    const probe = vi.fn(async (uri: string) => {
      expect(uri).toBe("tcp://127.0.0.1:10200");
      return info;
    });
    registerApiRoutes(router, { ...makeDeps().deps, probe });
    const res = await call(routes, "get /api/voices");
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([
      { name: "en_US-lessac-medium", languages: ["en_US"], description: null },
    ]);
  });

  it("GET /api/voices → 503 without TTS, 502 on probe failure", async () => {
    const { router, routes } = makeRouter();
    const noTts = makeDeps({
      directory: () =>
        ({
          snapshot: () => ({}),
          get: () => null,
        }) as unknown as ServiceDirectory,
    });
    registerApiRoutes(router, noTts.deps);
    expect((await call(routes, "get /api/voices")).statusCode).toBe(503);

    const failing = makeRouter();
    registerApiRoutes(failing.router, {
      ...makeDeps().deps,
      probe: vi.fn(async () => Promise.reject(new Error("nope"))),
    });
    expect((await call(failing.routes, "get /api/voices")).statusCode).toBe(
      502,
    );
  });
});

describe("POST /api/satellites/:id/test", () => {
  it("404 unknown id, 503 disconnected, 200 + tone enqueued", async () => {
    const { router, routes } = makeRouter();
    const h = makeDeps();
    const enqueued: {
      audio: { chunks: Buffer[] };
      priority: string;
      text: string;
    }[] = [];
    h.satellites.set(
      "a",
      fakeSatellite("a", {
        enqueue: (item) => (enqueued.push(item as never), 0),
      }),
    );
    h.satellites.set("dead", fakeSatellite("dead", { connected: false }));
    registerApiRoutes(router, h.deps);

    expect(
      (
        await call(routes, "post /api/satellites/:id/test", {
          params: { id: "ghost" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call(routes, "post /api/satellites/:id/test", {
          params: { id: "dead" },
        })
      ).statusCode,
    ).toBe(503);
    const res = await call(routes, "post /api/satellites/:id/test", {
      params: { id: "a" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, queued: ["a"] });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.priority).toBe("normal");
    expect(enqueued[0]?.text).toBe("[test tone]");
    expect(enqueued[0]?.audio.chunks.length).toBeGreaterThan(0);
  });
});

describe("control API proxies", () => {
  it("GET devices proxies to http://host:controlPort/devices", async () => {
    const { router, routes } = makeRouter();
    const h = makeDeps({
      fetchImpl: vi.fn(async (url: string | URL | Request) => {
        expect(String(url)).toBe("http://127.0.0.1:10800/devices");
        return new Response(
          JSON.stringify({ capture: ["hw:1,0"], playback: [] }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }) as unknown as typeof fetch,
    });
    h.satellites.set(
      "a",
      fakeSatellite("a", { hasControlApi: true, controlPort: 10800 }),
    );
    registerApiRoutes(router, h.deps);
    const res = await call(routes, "get /api/satellites/:id/devices", {
      params: { id: "a" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ capture: ["hw:1,0"], playback: [] });
  });

  it("404 when the satellite has no control API", async () => {
    const { router, routes } = makeRouter();
    const h = makeDeps();
    h.satellites.set("a", fakeSatellite("a", { hasControlApi: false }));
    registerApiRoutes(router, h.deps);
    const res = await call(routes, "get /api/satellites/:id/devices", {
      params: { id: "a" },
    });
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: string }).error).toMatch(/no control API/);
  });

  it("POST record returns WAV bytes with audio/wav content type", async () => {
    const wav = Buffer.from("RIFF....WAVEdata");
    const { router, routes } = makeRouter();
    const h = makeDeps({
      fetchImpl: vi.fn(
        async (url: string | URL | Request, init?: RequestInit) => {
          expect(String(url)).toBe("http://127.0.0.1:10800/test/record");
          expect(JSON.parse(String(init?.body))).toEqual({ seconds: 5 });
          return new Response(wav, { status: 200 });
        },
      ) as unknown as typeof fetch,
    });
    h.satellites.set(
      "a",
      fakeSatellite("a", { hasControlApi: true, controlPort: 10800 }),
    );
    registerApiRoutes(router, h.deps);
    const res = await call(routes, "post /api/satellites/:id/record", {
      params: { id: "a" },
      body: { seconds: 5 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("audio/wav");
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect((res.body as Buffer).equals(wav)).toBe(true);
  });

  it("POST record clamps seconds to the control API's 1..10 range", async () => {
    // The control API rejects seconds outside 1..10 with a 400 — the proxy
    // must never forward a value that always errors.
    const seen: number[] = [];
    const { router, routes } = makeRouter();
    const h = makeDeps({
      fetchImpl: vi.fn(
        async (_url: string | URL | Request, init?: RequestInit) => {
          seen.push(JSON.parse(String(init?.body)).seconds as number);
          return new Response(Buffer.from("RIFF....WAVEdata"), {
            status: 200,
          });
        },
      ) as unknown as typeof fetch,
    });
    h.satellites.set(
      "a",
      fakeSatellite("a", { hasControlApi: true, controlPort: 10800 }),
    );
    registerApiRoutes(router, h.deps);
    for (const seconds of [30, 0.2, 7]) {
      const res = await call(routes, "post /api/satellites/:id/record", {
        params: { id: "a" },
        body: { seconds },
      });
      expect(res.statusCode).toBe(200);
    }
    expect(seen).toEqual([10, 1, 7]);
  });

  it("POST play passes the body through", async () => {
    const { router, routes } = makeRouter();
    const h = makeDeps({
      fetchImpl: vi.fn(
        async (url: string | URL | Request, init?: RequestInit) => {
          expect(String(url)).toBe("http://127.0.0.1:10800/test/play");
          expect(JSON.parse(String(init?.body))).toEqual({
            type: "tone",
            frequency: 880,
          });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      ) as unknown as typeof fetch,
    });
    h.satellites.set(
      "a",
      fakeSatellite("a", { hasControlApi: true, controlPort: 10800 }),
    );
    registerApiRoutes(router, h.deps);
    const res = await call(routes, "post /api/satellites/:id/play", {
      params: { id: "a" },
      body: { type: "tone", frequency: 880 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("GET vu streams the upstream SSE body through", async () => {
    const { router, routes } = makeRouter();
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"rms":0.5}\n\n'));
          controller.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
    const h = makeDeps({
      fetchImpl: vi.fn(async () => upstream) as unknown as typeof fetch,
    });
    h.satellites.set(
      "a",
      fakeSatellite("a", { hasControlApi: true, controlPort: 10800 }),
    );
    registerApiRoutes(router, h.deps);
    const res = await call(routes, "get /api/satellites/:id/vu", {
      params: { id: "a" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/event-stream");
    expect(
      Buffer.concat(res.written.map((w) => Buffer.from(w))).toString(),
    ).toBe('data: {"rms":0.5}\n\n');
    expect(res.ended).toBe(true);
  });
});

describe("POST /api/transcribe", () => {
  const asrDirectory = () =>
    ({
      snapshot: () => ({}),
      get: (type: string) =>
        type === "asr"
          ? { uri: "tcp://127.0.0.1:10300", status: "ready", source: "auto" }
          : null,
    }) as unknown as ServiceDirectory;

  function fakeAsrSession(text: string) {
    const fed: { chunk: Buffer; format?: AudioFormat }[] = [];
    return {
      fed,
      session: {
        feed: (chunk: Buffer, format?: AudioFormat) =>
          fed.push({ chunk, format }),
        finish: async () => ({ text }),
        abort: vi.fn(),
      },
    };
  }

  it("400 without a satellite id; 503 without an ASR service", async () => {
    const { router, routes } = makeRouter();
    registerApiRoutes(router, makeDeps().deps); // default deps: no asr
    expect(
      (await call(routes, "post /api/transcribe", { body: {} })).statusCode,
    ).toBe(400);
    expect(
      (
        await call(routes, "post /api/transcribe", {
          body: { satellite: "a" },
        })
      ).statusCode,
    ).toBe(503);
  });

  it("404 for unknown satellites and satellites without a control API", async () => {
    const { router, routes } = makeRouter();
    const h = makeDeps({ directory: asrDirectory });
    h.satellites.set("nocontrol", fakeSatellite("nocontrol"));
    registerApiRoutes(router, h.deps);
    expect(
      (
        await call(routes, "post /api/transcribe", {
          body: { satellite: "ghost" },
        })
      ).statusCode,
    ).toBe(404);
    const res = await call(routes, "post /api/transcribe", {
      body: { satellite: "nocontrol" },
    });
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: string }).error).toMatch(/no control API/);
  });

  it("records via the control API, strips the WAV header, transcribes, reports latency", async () => {
    const pcm = sinePcm(16000, 8000); // 1 s of 16 kHz audio
    const wav = buildWav(pcm);
    const { router, routes } = makeRouter();
    const { fed, session } = fakeAsrSession("anchor is set");
    const asrOpen = vi.fn(async (uri: string, opts: { language?: string }) => {
      expect(uri).toBe("tcp://127.0.0.1:10300");
      expect(opts.language).toBe("en");
      return session;
    });
    const h = makeDeps({
      directory: asrDirectory,
      language: () => "en",
      asrOpen,
      fetchImpl: vi.fn(
        async (url: string | URL | Request, init?: RequestInit) => {
          expect(String(url)).toBe("http://127.0.0.1:10800/test/record");
          expect(JSON.parse(String(init?.body))).toEqual({ seconds: 5 });
          return new Response(wav, { status: 200 });
        },
      ) as unknown as typeof fetch,
    });
    h.satellites.set(
      "a",
      fakeSatellite("a", { hasControlApi: true, controlPort: 10800 }),
    );
    registerApiRoutes(router, h.deps);
    const res = await call(routes, "post /api/transcribe", {
      body: { satellite: "a", seconds: 5 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ text: "anchor is set" });
    expect(
      (res.body as { latencyMs: number }).latencyMs,
    ).toBeGreaterThanOrEqual(0);
    // Header stripped: exactly the PCM bytes were fed, in 2048-byte chunks,
    // with the WAV's own format.
    const total = fed.reduce((sum, f) => sum + f.chunk.length, 0);
    expect(total).toBe(pcm.length);
    expect(Buffer.concat(fed.map((f) => f.chunk)).equals(pcm)).toBe(true);
    expect(fed[0]?.format).toEqual({ rate: 16000, width: 2, channels: 1 });
    expect(Math.max(...fed.map((f) => f.chunk.length))).toBeLessThanOrEqual(
      2048,
    );
  });

  it("clamps seconds to the control API's 10 s cap", async () => {
    const { router, routes } = makeRouter();
    const { session } = fakeAsrSession("ok");
    const h = makeDeps({
      directory: asrDirectory,
      asrOpen: vi.fn(async () => session),
      fetchImpl: vi.fn(
        async (_url: string | URL | Request, init?: RequestInit) => {
          // A user-picked 30 s (the old UI max) must reach the control API
          // as 10 s instead of bouncing with an opaque 400→502.
          expect(JSON.parse(String(init?.body))).toEqual({ seconds: 10 });
          return new Response(buildWav(sinePcm(160, 100)), { status: 200 });
        },
      ) as unknown as typeof fetch,
    });
    h.satellites.set(
      "a",
      fakeSatellite("a", { hasControlApi: true, controlPort: 10800 }),
    );
    registerApiRoutes(router, h.deps);
    const res = await call(routes, "post /api/transcribe", {
      body: { satellite: "a", seconds: 30 },
    });
    expect(res.statusCode).toBe(200);
  });

  it("502 when the control API fails or returns junk; 502 when ASR fails", async () => {
    const { router, routes } = makeRouter();
    const failingRecord = makeDeps({
      directory: asrDirectory,
      fetchImpl: vi.fn(
        async () => new Response("no mic", { status: 500 }),
      ) as unknown as typeof fetch,
    });
    failingRecord.satellites.set(
      "a",
      fakeSatellite("a", { hasControlApi: true, controlPort: 10800 }),
    );
    registerApiRoutes(router, failingRecord.deps);
    expect(
      (
        await call(routes, "post /api/transcribe", {
          body: { satellite: "a" },
        })
      ).statusCode,
    ).toBe(502);

    const junkWav = makeRouter();
    const junk = makeDeps({
      directory: asrDirectory,
      fetchImpl: vi.fn(
        async () => new Response(Buffer.from("not a wav"), { status: 200 }),
      ) as unknown as typeof fetch,
    });
    junk.satellites.set(
      "a",
      fakeSatellite("a", { hasControlApi: true, controlPort: 10800 }),
    );
    registerApiRoutes(junkWav.router, junk.deps);
    const junkRes = await call(junkWav.routes, "post /api/transcribe", {
      body: { satellite: "a" },
    });
    expect(junkRes.statusCode).toBe(502);
    expect((junkRes.body as { error: string }).error).toMatch(/invalid WAV/);

    const asrFail = makeRouter();
    const abort = vi.fn();
    const failing = makeDeps({
      directory: asrDirectory,
      asrOpen: vi.fn(async () => ({
        feed: () => {},
        finish: async () => Promise.reject(new Error("whisper exploded")),
        abort,
      })),
      fetchImpl: vi.fn(
        async () => new Response(buildWav(sinePcm(160, 100)), { status: 200 }),
      ) as unknown as typeof fetch,
    });
    failing.satellites.set(
      "a",
      fakeSatellite("a", { hasControlApi: true, controlPort: 10800 }),
    );
    registerApiRoutes(asrFail.router, failing.deps);
    const failRes = await call(asrFail.routes, "post /api/transcribe", {
      body: { satellite: "a" },
    });
    expect(failRes.statusCode).toBe(502);
    expect((failRes.body as { error: string }).error).toMatch(
      /whisper exploded/,
    );
    expect(abort).toHaveBeenCalled();
  });
});

describe("misc endpoints", () => {
  it("POST /api/mute toggles the shared flag; 400 on bad body", async () => {
    const { router, routes } = makeRouter();
    const h = makeDeps();
    registerApiRoutes(router, h.deps);
    const res = await call(routes, "post /api/mute", { body: { muted: true } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ muted: true });
    expect(h.deps.getMuted()).toBe(true);
    expect(
      (await call(routes, "post /api/mute", { body: { muted: "yes" } }))
        .statusCode,
    ).toBe(400);
  });

  it("GET /api/log returns the hub ring buffer", async () => {
    const { router, routes } = makeRouter();
    const h = makeDeps();
    h.hub.emit("command", { text: "hello" });
    registerApiRoutes(router, h.deps);
    const res = await call(routes, "get /api/log");
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject([
      { kind: "command", data: { text: "hello" } },
    ]);
  });

  it("GET /api/events attaches an SSE client to the hub", async () => {
    const { router, routes } = makeRouter();
    const h = makeDeps();
    registerApiRoutes(router, h.deps);
    const res = await call(routes, "get /api/events");
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/event-stream");
    h.hub.emit("state", { x: 1 });
    expect(res.written.some((w) => String(w).startsWith("event: state"))).toBe(
      true,
    );
    h.hub.close();
  });

  it("update routes: 503 without a local container, delegate with one", async () => {
    const { router, routes } = makeRouter();
    const container = {
      checkForUpdate: vi.fn(async () => ({ updateAvailable: false })),
      applyUpdate: vi.fn(async (tag: string) => ({ tag })),
      lastStartedTag: "0.1.0",
    };
    const h = makeDeps();
    registerApiRoutes(router, h.deps);
    expect((await call(routes, "get /api/update/check")).statusCode).toBe(503);

    const withContainer = makeRouter();
    registerApiRoutes(withContainer.router, {
      ...makeDeps().deps,
      localContainer: () => container,
    });
    const check = await call(withContainer.routes, "get /api/update/check");
    expect(check.body).toEqual({ updateAvailable: false });
    const apply = await call(withContainer.routes, "post /api/update/apply", {
      body: {},
    });
    expect(apply.body).toEqual({ success: true, tag: "0.1.0" });
    expect(container.applyUpdate).toHaveBeenCalledWith("0.1.0");
  });
});

describe("generateTone", () => {
  it("produces 1s of 22050/16/mono PCM in ≤2048-byte chunks", () => {
    const tone = generateTone();
    expect(tone.format).toEqual({ rate: 22050, width: 2, channels: 1 });
    const total = tone.chunks.reduce((sum, c) => sum + c.length, 0);
    expect(total).toBe(22050 * 2);
    expect(Math.max(...tone.chunks.map((c) => c.length))).toBeLessThanOrEqual(
      2048,
    );
    // Non-silent, bounded samples
    const first = tone.chunks[0] as Buffer;
    let peak = 0;
    for (let i = 0; i < first.length; i += 2) {
      peak = Math.max(peak, Math.abs(first.readInt16LE(i)));
    }
    expect(peak).toBeGreaterThan(5000);
    expect(peak).toBeLessThanOrEqual(32767);
  });
});
