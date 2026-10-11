import { describe, expect, it, vi } from "vitest";
import {
  AnnouncementService,
  type AnnouncementTarget,
} from "../src/announcements.js";
import type {
  AnnouncementItem,
  AnnouncementQueueEvent,
  InterruptionReason,
} from "../src/queue.js";
import type { BufferedAudio } from "../src/types.js";

const audio: BufferedAudio = {
  format: { rate: 22050, width: 2, channels: 1 },
  chunks: [Buffer.alloc(100)],
};

function harness(options: { muted?: boolean; connected?: boolean } = {}) {
  const items: AnnouncementItem[] = [];
  const targets = new Map<string, AnnouncementTarget>();
  targets.set("helm", {
    satellite: { id: "helm", connected: options.connected ?? true },
    queue: {
      enqueue: (item) => {
        items.push(item);
        return 0;
      },
      cancel: vi.fn((id: string, reason?: InterruptionReason) => {
        void id;
        void reason;
        return true;
      }),
    },
  });
  const service = new AnnouncementService({
    directory: { get: () => ({ uri: "tcp://piper:10200" }) } as never,
    satellites: () => targets,
    sounds: { get: (id) => (id === "alarm" ? audio : undefined) },
    isMuted: () => options.muted ?? false,
    defaults: { language: "en", voice: "default" },
    log: vi.fn(),
    synthesize: vi.fn(async () => audio),
  });
  const event = (
    type: AnnouncementQueueEvent["type"],
    error?: string,
    extra: Partial<AnnouncementQueueEvent> = {},
  ) =>
    service.handleQueueEvent("helm", {
      type,
      item: items[0] as AnnouncementItem,
      ...(error ? { error } : {}),
      ...extra,
    });
  return { service, items, targets, event };
}

describe("AnnouncementService", () => {
  it("plays a sound without invoking TTS and resolves only after play-end", async () => {
    const h = harness();
    const initial = await h.service.announce({
      requestId: "bilge-1",
      content: { kind: "sound", soundId: "alarm" },
    });
    expect(initial.state).toBe("queued");
    expect(h.items[0]?.kind).toBe("sound");
    const completed = h.service.wait(initial.id);
    h.event("play-start");
    expect(h.service.get(initial.id)?.state).toBe("playing");
    h.event("play-end");
    await expect(completed).resolves.toMatchObject({ state: "played" });
  });

  it("deduplicates retries with the same requestId", async () => {
    const h = harness();
    const request = {
      requestId: "stable-id",
      content: { kind: "sound" as const, soundId: "alarm" },
    };
    const first = await h.service.announce(request);
    const second = await h.service.announce(request);
    expect(second.id).toBe(first.id);
    expect(h.items).toHaveLength(1);
    await expect(
      h.service.announce({
        requestId: "stable-id",
        content: { kind: "sound", soundId: "chime" },
      }),
    ).rejects.toThrow(/different content/);
  });

  it("marks a stream that ended without `played` as unknown, not played", async () => {
    const h = harness();
    const initial = await h.service.announce({
      content: { kind: "sound", soundId: "alarm" },
    });
    const completed = h.service.wait(initial.id, { timeoutMs: 1000 });
    h.event("play-start");
    h.event("play-end", undefined, { confirmed: false });
    const snapshot = await completed;
    expect(snapshot.state).toBe("unknown");
    expect(snapshot.targets.helm).toMatchObject({
      state: "unknown",
      error: expect.stringMatching(/confirm playback/),
    });
  });

  it("marks missing playback proof as unknown", async () => {
    const h = harness();
    const result = await h.service.announce({
      content: { kind: "sound", soundId: "alarm" },
    });
    const completed = h.service.wait(result.id);
    h.event("play-start");
    h.event("play-error", "satellite did not confirm playback with played");
    await expect(completed).resolves.toMatchObject({ state: "unknown" });
  });

  it("marks a connection loss during playback as unknown", async () => {
    const h = harness();
    const result = await h.service.announce({
      content: { kind: "sound", soundId: "alarm" },
    });
    const completed = h.service.wait(result.id);
    h.event("play-start");
    h.event("play-error", "connection lost during playback");
    await expect(completed).resolves.toMatchObject({ state: "unknown" });
  });

  it("suppresses normal announcements while muted but lets urgent through", async () => {
    const normal = harness({ muted: true });
    const suppressed = await normal.service.announce({
      content: { kind: "sound", soundId: "alarm" },
    });
    expect(suppressed.state).toBe("suppressed");
    expect(normal.items).toHaveLength(0);

    const urgent = harness({ muted: true });
    const queued = await urgent.service.announce({
      content: { kind: "sound", soundId: "alarm" },
      priority: "urgent",
    });
    expect(queued.state).toBe("queued");
    expect(urgent.items).toHaveLength(1);
  });
});
