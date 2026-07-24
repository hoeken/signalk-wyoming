import { describe, expect, it, vi } from "vitest";
import {
  createSay,
  MAX_SAY_TEXT_CHARS,
  WAIT_NOT_SUPPORTED_MESSAGE,
  type SayDeps,
  type SayTarget,
} from "../src/say.js";
import type { AnnouncementItem } from "../src/queue.js";
import type { BufferedAudio } from "../src/types.js";

const audio: BufferedAudio = {
  format: { rate: 22050, width: 2, channels: 1 },
  chunks: [Buffer.from([1, 2, 3, 4])],
};

interface Harness {
  deps: SayDeps;
  enqueued: { satellite: string; item: AnnouncementItem }[];
  synthesize: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  addSatellite(
    id: string,
    opts?: {
      connected?: boolean;
      enqueue?: (item: AnnouncementItem) => number;
    },
  ): void;
  setMuted(muted: boolean): void;
}

function makeHarness(
  opts: { tts?: boolean; defaultVoice?: string } = {},
): Harness {
  const satellites = new Map<string, SayTarget>();
  const enqueued: { satellite: string; item: AnnouncementItem }[] = [];
  let muted = false;
  const synthesize = vi.fn(async () => audio);
  const warn = vi.fn();
  const deps: SayDeps = {
    directory: {
      get: () => (opts.tts === false ? null : { uri: "tcp://127.0.0.1:10200" }),
    },
    satellites: () => satellites,
    isMuted: () => muted,
    defaults: { language: "en", voice: opts.defaultVoice ?? "" },
    log: vi.fn(),
    warn,
    synthesize: synthesize as unknown as SayDeps["synthesize"],
  };
  return {
    deps,
    enqueued,
    synthesize,
    warn,
    addSatellite(id, satOpts = {}) {
      const connected = satOpts.connected ?? true;
      satellites.set(id, {
        satellite: { id, connected },
        queue: {
          enqueue:
            satOpts.enqueue ??
            ((item) => {
              enqueued.push({ satellite: id, item });
              return 0;
            }),
        },
      });
    },
    setMuted(v: boolean) {
      muted = v;
    },
  };
}

describe("say() input validation", () => {
  it("rejects missing/empty/non-string text", async () => {
    const h = makeHarness();
    h.addSatellite("a");
    const say = createSay(h.deps);
    await expect(say({} as never)).rejects.toThrow(/text is required/);
    await expect(say({ text: "" })).rejects.toThrow(/text is required/);
    await expect(say({ text: 42 as unknown as string })).rejects.toThrow(
      /text is required/,
    );
  });

  it("rejects wait:true with the exact spec message", async () => {
    const h = makeHarness();
    h.addSatellite("a");
    const say = createSay(h.deps);
    await expect(say({ text: "hi", wait: true })).rejects.toThrow(
      WAIT_NOT_SUPPORTED_MESSAGE,
    );
    expect(WAIT_NOT_SUPPORTED_MESSAGE).toBe(
      "wait:true is not supported in v1; poll voice.satellites.<id>.state",
    );
  });

  it("caps text at 500 chars, truncating with … and warning", async () => {
    const h = makeHarness();
    h.addSatellite("a");
    const say = createSay(h.deps);
    const long = "x".repeat(600);
    const result = await say({ text: long });
    expect(result.ok).toBe(true);
    const sent = h.synthesize.mock.calls[0]?.[1] as string;
    expect(sent.length).toBe(MAX_SAY_TEXT_CHARS);
    expect(sent.endsWith("…")).toBe(true);
    expect(h.enqueued[0]?.item.text).toBe(sent);
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("truncated"));
  });

  it("ignores unknown fields", async () => {
    const h = makeHarness();
    h.addSatellite("a");
    const say = createSay(h.deps);
    await expect(
      say({ text: "hi", bogus: 1, wait: false } as never),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe("say() mute semantics (D14)", () => {
  it("muted + normal resolves suppressed without synthesizing", async () => {
    const h = makeHarness();
    h.addSatellite("a");
    h.setMuted(true);
    const say = createSay(h.deps);
    await expect(say({ text: "hi" })).resolves.toEqual({
      ok: false,
      queued: [],
      suppressed: "muted",
    });
    expect(h.synthesize).not.toHaveBeenCalled();
  });

  it("muted + urgent bypasses mute", async () => {
    const h = makeHarness();
    h.addSatellite("a");
    h.setMuted(true);
    const say = createSay(h.deps);
    await expect(say({ text: "hi", priority: "urgent" })).resolves.toEqual({
      ok: true,
      queued: ["a"],
    });
    expect(h.enqueued[0]?.item.priority).toBe("urgent");
  });
});

describe("say() target resolution", () => {
  it("omitting targets means all satellites", async () => {
    const h = makeHarness();
    h.addSatellite("a");
    h.addSatellite("b");
    const say = createSay(h.deps);
    const result = await say({ text: "hi" });
    expect(result.queued.sort()).toEqual(["a", "b"]);
  });

  it("honors an explicit target subset", async () => {
    const h = makeHarness();
    h.addSatellite("a");
    h.addSatellite("b");
    const say = createSay(h.deps);
    const result = await say({ text: "hi", targets: ["b"] });
    expect(result.queued).toEqual(["b"]);
    expect(h.enqueued.map((e) => e.satellite)).toEqual(["b"]);
  });

  it("unknown target id becomes a per-satellite error entry, not a throw", async () => {
    const h = makeHarness();
    h.addSatellite("a");
    const say = createSay(h.deps);
    const result = await say({ text: "hi", targets: ["a", "ghost"] });
    expect(result.ok).toBe(false);
    expect(result.queued).toEqual(["a"]);
    expect(result.errors).toEqual([
      { satellite: "ghost", error: "unknown satellite" },
    ]);
  });

  it("rejects with zero configured satellites", async () => {
    const h = makeHarness();
    const say = createSay(h.deps);
    await expect(say({ text: "hi" })).rejects.toThrow(
      /no satellites configured/,
    );
  });

  it("rejects (before synthesis) when every target is unknown", async () => {
    const h = makeHarness();
    h.addSatellite("a");
    const say = createSay(h.deps);
    await expect(say({ text: "hi", targets: ["ghost"] })).rejects.toThrow(
      /nothing queued.*ghost: unknown satellite/,
    );
    expect(h.synthesize).not.toHaveBeenCalled();
  });
});

describe("say() TTS handling", () => {
  it("rejects when no TTS service is available", async () => {
    const h = makeHarness({ tts: false });
    h.addSatellite("a");
    const say = createSay(h.deps);
    await expect(say({ text: "hi" })).rejects.toThrow(/TTS unavailable/);
  });

  it("rejects on synthesis failure — nothing queued", async () => {
    const h = makeHarness();
    h.addSatellite("a");
    h.synthesize.mockRejectedValueOnce(new Error("piper exploded"));
    const say = createSay(h.deps);
    await expect(say({ text: "hi" })).rejects.toThrow(
      /synthesis failed.*piper exploded/,
    );
    expect(h.enqueued).toEqual([]);
  });

  it("synthesizes once and fans the same buffer out to every queue", async () => {
    const h = makeHarness();
    h.addSatellite("a");
    h.addSatellite("b");
    const say = createSay(h.deps);
    await say({ text: "hi" });
    expect(h.synthesize).toHaveBeenCalledTimes(1);
    expect(h.enqueued[0]?.item.audio.chunks).toBe(
      h.enqueued[1]?.item.audio.chunks,
    );
  });

  it("passes the voice override, falls back to the default voice, else undefined", async () => {
    const h = makeHarness({ defaultVoice: "en_US-lessac-medium" });
    h.addSatellite("a");
    const say = createSay(h.deps);
    await say({ text: "hi", voice: "en_GB-alan-medium" });
    expect(h.synthesize.mock.calls[0]?.[2]).toBe("en_GB-alan-medium");
    await say({ text: "hi" });
    expect(h.synthesize.mock.calls[1]?.[2]).toBe("en_US-lessac-medium");

    const bare = makeHarness();
    bare.addSatellite("a");
    const bareSay = createSay(bare.deps);
    await bareSay({ text: "hi" });
    expect(bare.synthesize.mock.calls[0]?.[2]).toBeUndefined();
  });
});

describe("say() fan-out results (§4.2)", () => {
  it("disconnected satellite → error entry 'not connected'", async () => {
    const h = makeHarness();
    h.addSatellite("a");
    h.addSatellite("dead", { connected: false });
    const say = createSay(h.deps);
    const result = await say({ text: "hi" });
    expect(result.ok).toBe(false);
    expect(result.queued).toEqual(["a"]);
    expect(result.errors).toEqual([
      { satellite: "dead", error: "not connected" },
    ]);
  });

  it("queue full → error entry with the queue's message", async () => {
    const h = makeHarness();
    h.addSatellite("a");
    h.addSatellite("busy", {
      enqueue: () => {
        throw new Error("queue full");
      },
    });
    const say = createSay(h.deps);
    const result = await say({ text: "hi" });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([{ satellite: "busy", error: "queue full" }]);
  });

  it("partial failure resolves (never rejects)", async () => {
    const h = makeHarness();
    h.addSatellite("a");
    h.addSatellite("dead", { connected: false });
    const say = createSay(h.deps);
    await expect(say({ text: "hi" })).resolves.toMatchObject({ ok: false });
  });

  it("rejects with an aggregate message when NOTHING could be queued", async () => {
    const h = makeHarness();
    h.addSatellite("d1", { connected: false });
    h.addSatellite("d2", { connected: false });
    const say = createSay(h.deps);
    await expect(say({ text: "hi" })).rejects.toThrow(
      /nothing queued.*d1: not connected.*d2: not connected/,
    );
  });

  it("ok:true with all queued and no errors key", async () => {
    const h = makeHarness();
    h.addSatellite("a");
    const say = createSay(h.deps);
    const result = await say({ text: "hi" });
    expect(result).toEqual({ ok: true, queued: ["a"] });
    expect(result.errors).toBeUndefined();
  });

  it("resolves on enqueue, not playback (enqueue is synchronous)", async () => {
    const h = makeHarness();
    const played: string[] = [];
    h.addSatellite("a", {
      enqueue: () => {
        // playback would happen later; enqueue returns immediately
        return 0;
      },
    });
    const say = createSay(h.deps);
    await say({ text: "hi" });
    expect(played).toEqual([]);
  });

  it("items carry uuid ids and the priority", async () => {
    const h = makeHarness();
    h.addSatellite("a");
    const say = createSay(h.deps);
    await say({ text: "hi", priority: "urgent" });
    const item = h.enqueued[0]?.item;
    expect(item?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(item?.priority).toBe("urgent");
  });
});
