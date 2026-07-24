import { describe, expect, it, vi } from "vitest";
import { AnnouncementQueue, type AnnouncementItem } from "../src/queue.js";
import type { BufferedAudio, Priority } from "../src/types.js";

const audio: BufferedAudio = {
  format: { rate: 22050, width: 2, channels: 1 },
  chunks: [Buffer.alloc(2048)],
};

let nextId = 0;
function item(priority: Priority = "normal", text = "hello"): AnnouncementItem {
  return { id: `item-${nextId++}`, audio, priority, text, enqueuedAt: 0 };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A player whose per-item completion the test controls. */
function makePlayer() {
  const playing: {
    item: AnnouncementItem;
    done: ReturnType<typeof deferred>;
  }[] = [];
  const cancelPlayback = vi.fn(() => {
    // Model RemoteSatellite.cancelPlayback: current play resolves promptly.
    playing[playing.length - 1]?.done.resolve();
  });
  return {
    playing,
    cancelPlayback,
    play: vi.fn((i: AnnouncementItem) => {
      const done = deferred();
      playing.push({ item: i, done });
      return done.promise;
    }),
    /** Wait until the player has been asked to play `n` items. */
    async until(n: number) {
      await vi.waitFor(() => {
        if (playing.length < n) throw new Error("not yet");
      });
    },
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("AnnouncementQueue ordering", () => {
  it("plays items FIFO", async () => {
    const player = makePlayer();
    const queue = new AnnouncementQueue(player);
    const a = item("normal", "a");
    const b = item("normal", "b");
    expect(queue.enqueue(a)).toBe(0);
    expect(queue.enqueue(b)).toBe(1);
    await player.until(1);
    expect(player.playing[0]?.item).toBe(a);
    expect(queue.playing).toBe(a);
    expect(queue.depth).toBe(2);
    player.playing[0]?.done.resolve();
    await player.until(2);
    expect(player.playing[1]?.item).toBe(b);
  });

  it("urgent jumps to the head of the queue", async () => {
    const player = makePlayer();
    const queue = new AnnouncementQueue(player);
    const a = item("normal", "a");
    const b = item("normal", "b");
    const u = item("urgent", "u");
    queue.enqueue(a);
    await player.until(1);
    queue.enqueue(b);
    expect(queue.enqueue(u)).toBe(0); // head position
    // a was mid-playback and normal → cancelled
    expect(player.cancelPlayback).toHaveBeenCalledTimes(1);
    await player.until(2);
    expect(player.playing[1]?.item).toBe(u);
    player.playing[1]?.done.resolve();
    await player.until(3);
    expect(player.playing[2]?.item).toBe(b);
  });

  it("urgent does NOT cancel urgent playback (queues behind it)", async () => {
    const player = makePlayer();
    const queue = new AnnouncementQueue(player);
    const u1 = item("urgent", "u1");
    const u2 = item("urgent", "u2");
    queue.enqueue(u1);
    await player.until(1);
    queue.enqueue(u2);
    expect(player.cancelPlayback).not.toHaveBeenCalled();
    player.playing[0]?.done.resolve();
    await player.until(2);
    expect(player.playing[1]?.item).toBe(u2);
  });

  it("continues draining when a play fails", async () => {
    const log = vi.fn();
    const events: string[] = [];
    const player = makePlayer();
    const queue = new AnnouncementQueue({
      ...player,
      log,
      onEvent: (evt) => events.push(evt.type),
    });
    const a = item("normal", "a");
    const b = item("normal", "b");
    queue.enqueue(a);
    queue.enqueue(b);
    await player.until(1);
    player.playing[0]?.done.reject(new Error("boom"));
    await player.until(2);
    expect(player.playing[1]?.item).toBe(b);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("boom"));
    expect(events).toEqual(["play-start", "play-error", "play-start"]);
  });
});

describe("AnnouncementQueue barge-in (interruptForPipeline)", () => {
  it("cancels normal playback and pauses draining until pipelineDone", async () => {
    const player = makePlayer();
    const queue = new AnnouncementQueue(player);
    const a = item("normal", "a");
    const b = item("normal", "b");
    queue.enqueue(a);
    queue.enqueue(b);
    await player.until(1);
    expect(queue.interruptForPipeline()).toBe(true);
    expect(player.cancelPlayback).toHaveBeenCalledTimes(1);
    expect(queue.pausedForPipeline).toBe(true);
    await tick();
    await tick();
    // b must NOT start while the pipeline runs
    expect(player.play).toHaveBeenCalledTimes(1);
    queue.pipelineDone();
    await player.until(2);
    expect(player.playing[1]?.item).toBe(b);
    expect(queue.pausedForPipeline).toBe(false);
  });

  it("refuses barge-in during urgent playback (§2.5)", async () => {
    const player = makePlayer();
    const queue = new AnnouncementQueue(player);
    queue.enqueue(item("urgent", "u"));
    await player.until(1);
    expect(queue.interruptForPipeline()).toBe(false);
    expect(player.cancelPlayback).not.toHaveBeenCalled();
    expect(queue.pausedForPipeline).toBe(false);
  });

  it("pauses an idle queue too; items enqueued mid-pipeline wait", async () => {
    const player = makePlayer();
    const queue = new AnnouncementQueue(player);
    expect(queue.interruptForPipeline()).toBe(true);
    queue.enqueue(item("normal", "a"));
    await tick();
    await tick();
    expect(player.play).not.toHaveBeenCalled();
    queue.pipelineDone();
    await player.until(1);
  });

  it("pipelineDone without a pipeline is a no-op", () => {
    const player = makePlayer();
    const queue = new AnnouncementQueue(player);
    expect(() => queue.pipelineDone()).not.toThrow();
  });
});

describe("AnnouncementQueue bounds and bookkeeping", () => {
  it("throws 'queue full' beyond maxItems", () => {
    const player = makePlayer();
    const queue = new AnnouncementQueue({ ...player, maxItems: 2 });
    queue.interruptForPipeline(); // hold draining so items stay pending
    queue.enqueue(item());
    queue.enqueue(item());
    expect(() => queue.enqueue(item())).toThrow("queue full");
  });

  it("defaults to a bound of 20", () => {
    const player = makePlayer();
    const queue = new AnnouncementQueue(player);
    queue.interruptForPipeline();
    for (let i = 0; i < 20; i++) queue.enqueue(item());
    expect(() => queue.enqueue(item())).toThrow("queue full");
  });

  it("clear() drops pending items but not the current one", async () => {
    const player = makePlayer();
    const queue = new AnnouncementQueue(player);
    queue.enqueue(item("normal", "a"));
    queue.enqueue(item("normal", "b"));
    await player.until(1);
    queue.clear();
    expect(queue.depth).toBe(1); // only the playing item
    player.playing[0]?.done.resolve();
    await tick();
    await tick();
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(queue.depth).toBe(0);
  });
});
