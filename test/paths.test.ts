import { describe, expect, it, vi } from "vitest";
import {
  SignalKPublisher,
  type ActionResult,
  type PutHandler,
} from "../src/paths.js";
import type { SayResult } from "../src/types.js";

interface Delta {
  updates: {
    $source?: string;
    values?: { path: string; value: unknown }[];
    meta?: { path: string; value: unknown }[];
  }[];
}

function makeHarness(sayImpl?: (opts: unknown) => Promise<SayResult>) {
  const deltas: Delta[] = [];
  const putHandlers = new Map<string, PutHandler>();
  let muted = false;
  const say = vi.fn(
    sayImpl ?? (async () => ({ ok: true, queued: ["a"] }) as SayResult),
  );
  const app = {
    handleMessage: (_id: string, delta: Record<string, unknown>) =>
      deltas.push(delta as unknown as Delta),
    registerPutHandler: (
      context: string,
      path: string,
      handler: PutHandler,
    ) => {
      expect(context).toBe("vessels.self");
      putHandlers.set(path, handler);
    },
    error: vi.fn(),
    debug: vi.fn(),
  };
  const publisher: SignalKPublisher = new SignalKPublisher({
    app,
    getMuted: () => muted,
    // Mirrors src/index.ts setMuted: the shared switch (also behind
    // POST /api/mute) owns publishing the voice.muted delta.
    setMuted: (v) => {
      muted = v;
      publisher.publishMuted(v);
    },
    say: say as never,
  });
  const values = () =>
    deltas.flatMap((d) => d.updates.flatMap((u) => u.values ?? []));
  const put = (path: string, value: unknown) => {
    const handler = putHandlers.get(path);
    if (handler === undefined) throw new Error(`no PUT handler for ${path}`);
    return handler("vessels.self", path, value, () => {});
  };
  return {
    publisher,
    app,
    deltas,
    putHandlers,
    values,
    put,
    say,
    isMuted: () => muted,
  };
}

describe("SignalKPublisher start()", () => {
  it("registers PUT handlers, emits meta once, publishes muted=false", () => {
    const h = makeHarness();
    h.publisher.start();
    expect([...h.putHandlers.keys()].sort()).toEqual([
      "voice.muted",
      "voice.say",
    ]);
    const metas = h.deltas.flatMap((d) =>
      d.updates.flatMap((u) => u.meta ?? []),
    );
    expect(metas.map((m) => m.path)).toEqual(
      expect.arrayContaining(["voice.command", "voice.muted", "voice.say"]),
    );
    const mutedValue = h.values().find((v) => v.path === "voice.muted");
    expect(mutedValue?.value).toBe(false);
  });
});

describe("satellite status deltas", () => {
  it("publishes connected + state with plain $source, only on change", () => {
    const h = makeHarness();
    h.publisher.publishSatellite("cockpit", { connected: true, state: "idle" });
    const first = h.deltas.filter((d) => d.updates.some((u) => u.values));
    expect(first).toHaveLength(1);
    expect(first[0]?.updates[0]?.$source).toBe("signalk-wyoming");
    expect(first[0]?.updates[0]?.values).toEqual([
      { path: "voice.satellites.cockpit.connected", value: true },
      { path: "voice.satellites.cockpit.state", value: "idle" },
    ]);
    // identical publish → no new delta
    h.publisher.publishSatellite("cockpit", { connected: true, state: "idle" });
    expect(
      h.deltas.filter((d) => d.updates.some((u) => u.values)),
    ).toHaveLength(1);
    // only the changed path is re-published
    h.publisher.publishSatellite("cockpit", {
      connected: true,
      state: "speaking",
    });
    const last = h.deltas[h.deltas.length - 1];
    expect(last?.updates[0]?.values).toEqual([
      { path: "voice.satellites.cockpit.state", value: "speaking" },
    ]);
  });

  it("emits per-satellite meta once", () => {
    const h = makeHarness();
    h.publisher.publishSatellite("a", {
      connected: false,
      state: "disconnected",
    });
    h.publisher.publishSatellite("a", { connected: true, state: "idle" });
    const metas = h.deltas.flatMap((d) =>
      d.updates.flatMap((u) => u.meta ?? []),
    );
    const aMetas = metas.filter((m) =>
      m.path.startsWith("voice.satellites.a."),
    );
    expect(aMetas).toHaveLength(2);
  });
});

describe("voice.command deltas", () => {
  it("uses $source signalk-wyoming.<satId> and the §4.1 value shape", () => {
    const h = makeHarness();
    h.publisher.publishCommand({
      id: "uuid-1",
      text: "log my position",
      satellite: "cockpit",
      language: "en",
      wakeWord: "okay_nabu",
      durationMs: 1234,
    });
    const delta = h.deltas[h.deltas.length - 1];
    expect(delta?.updates[0]?.$source).toBe("signalk-wyoming.cockpit");
    expect(delta?.updates[0]?.values).toEqual([
      {
        path: "voice.command",
        value: {
          id: "uuid-1",
          text: "log my position",
          satellite: "cockpit",
          language: "en",
          wakeWord: "okay_nabu",
          durationMs: 1234,
        },
      },
    ]);
  });

  it("omits optional fields when absent", () => {
    const h = makeHarness();
    h.publisher.publishCommand({
      id: "u",
      text: "t",
      satellite: "s",
      language: "en",
    });
    const value = h.values().find((v) => v.path === "voice.command")
      ?.value as Record<string, unknown>;
    expect("wakeWord" in value).toBe(false);
    expect("durationMs" in value).toBe(false);
  });
});

describe("notifications.voice.<service>", () => {
  it("publishes {state, method:['visual'], message} deltas", () => {
    const h = makeHarness();
    h.publisher.publishNotification("wake", "alarm", "no wake service");
    const value = h
      .values()
      .find((v) => v.path === "notifications.voice.wake")?.value;
    expect(value).toEqual({
      state: "alarm",
      method: ["visual"],
      message: "no wake service",
    });
    const delta = h.deltas[h.deltas.length - 1];
    expect(delta?.updates[0]?.$source).toBe("signalk-wyoming");
  });

  it("dedupes consecutive identical states per service", () => {
    const h = makeHarness();
    h.publisher.publishNotification("asr", "alarm", "down");
    h.publisher.publishNotification("asr", "alarm", "still down");
    h.publisher.publishNotification("asr", "normal", "recovered");
    h.publisher.publishNotification("asr", "normal", "recovered again");
    h.publisher.publishNotification("wake", "alarm", "independent service");
    const notifications = h
      .values()
      .filter((v) => v.path.startsWith("notifications.voice."));
    expect(
      notifications.map((n) => (n.value as { state: string }).state),
    ).toEqual(["alarm", "normal", "alarm"]);
  });
});

describe("voice.muted PUT", () => {
  it("accepts booleans and {value}", () => {
    const h = makeHarness();
    h.publisher.start();
    const r1 = h.put("voice.muted", true) as ActionResult;
    expect(r1).toEqual({ state: "COMPLETED", statusCode: 200 });
    expect(h.isMuted()).toBe(true);
    const mutedValues = () =>
      h.values().filter((v) => v.path === "voice.muted");
    expect(mutedValues().pop()?.value).toBe(true);
    // Published exactly once per change (start() + the PUT): the handler
    // must not double-publish on top of setMuted's own publish.
    expect(mutedValues()).toHaveLength(2);
    const r2 = h.put("voice.muted", { value: false }) as ActionResult;
    expect(r2.statusCode).toBe(200);
    expect(h.isMuted()).toBe(false);
    expect(mutedValues().pop()?.value).toBe(false);
  });

  it("rejects non-boolean values with COMPLETED/400", () => {
    const h = makeHarness();
    h.publisher.start();
    const r = h.put("voice.muted", "yes") as ActionResult;
    expect(r.state).toBe("COMPLETED");
    expect(r.statusCode).toBe(400);
    expect(r.message).toMatch(/boolean/);
    expect(h.isMuted()).toBe(false);
  });
});

describe("voice.say PUT", () => {
  it("maps a string value to say({text}) and answers 202", async () => {
    const h = makeHarness();
    h.publisher.start();
    const r = (await h.put("voice.say", "anchor alarm")) as ActionResult;
    expect(r).toEqual({ state: "COMPLETED", statusCode: 202 });
    expect(h.say).toHaveBeenCalledWith({ text: "anchor alarm" });
  });

  it("passes an object value through as opts", async () => {
    const h = makeHarness();
    h.publisher.start();
    const opts = { text: "hi", targets: ["cockpit"], priority: "urgent" };
    await h.put("voice.say", opts);
    expect(h.say).toHaveBeenCalledWith(opts);
  });

  it("maps full rejection to COMPLETED/503 and logs it", async () => {
    const h = makeHarness(async () => {
      throw new Error("say: TTS unavailable");
    });
    h.publisher.start();
    const r = (await h.put("voice.say", "hi")) as ActionResult;
    expect(r.state).toBe("COMPLETED");
    expect(r.statusCode).toBe(503);
    expect(r.message).toMatch(/TTS unavailable/);
    expect(h.app.error).toHaveBeenCalledWith(
      expect.stringContaining("TTS unavailable"),
    );
  });

  it("rejects invalid values with COMPLETED/400", () => {
    const h = makeHarness();
    h.publisher.start();
    const r = h.put("voice.say", 42) as ActionResult;
    expect(r).toMatchObject({ state: "COMPLETED", statusCode: 400 });
    expect(h.say).not.toHaveBeenCalled();
  });
});
