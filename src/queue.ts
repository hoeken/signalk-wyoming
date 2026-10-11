/**
 * AnnouncementQueue — per-satellite announcement FIFO (spec §2.5).
 *
 * - normal items append; urgent items jump to the head AND cancel a normal
 *   item that is mid-playback (its remainder is dropped).
 * - interruptForPipeline(): barge-in hook — cancels current NORMAL playback
 *   and pauses draining until pipelineDone(); returns false during URGENT
 *   playback (wake is ignored while an urgent announcement plays).
 * - Bounded at `maxItems` (default 20): enqueue throws 'queue full'.
 *
 * The player is injected ((item) => Promise<void>, i.e. RemoteSatellite.play)
 * so the queue is unit-testable with plain promises and fake timers.
 */

import type { BufferedAudio, PlaybackResult, Priority } from "./types.js";

export interface AnnouncementItem {
  id: string;
  audio: BufferedAudio;
  priority: Priority;
  /** Original text, for the activity log. */
  text: string;
  kind?: "speech" | "sound";
  enqueuedAt: number;
}

export type InterruptionReason = "caller" | "urgent" | "pipeline" | "shutdown";

export interface AnnouncementQueueEvent {
  type: "play-start" | "play-end" | "play-error" | "play-interrupted";
  item: AnnouncementItem;
  error?: string;
  reason?: InterruptionReason;
  /**
   * play-end only: whether the satellite acknowledged the stream with
   * `played`. False = streamed to completion but unproven (satellite that
   * never sends `played`).
   */
  confirmed?: boolean;
}

export interface AnnouncementQueueDeps {
  play(item: AnnouncementItem): Promise<PlaybackResult>;
  /** Cancel the in-flight play (RemoteSatellite.cancelPlayback). */
  cancelPlayback(): void;
  /**
   * An urgent item was enqueued while a pipeline holds the queue paused
   * (spec §2.5: urgent cancels the pipeline). The pipeline engine aborts
   * the session and calls pipelineDone(), so the urgent item plays
   * immediately.
   */
  onUrgentDuringPipeline?: () => void;
  log?: (msg: string) => void;
  onEvent?: (evt: AnnouncementQueueEvent) => void;
  maxItems?: number;
}

export const DEFAULT_MAX_QUEUE_ITEMS = 20;

export class AnnouncementQueue {
  private readonly deps: AnnouncementQueueDeps;
  private readonly maxItems: number;
  private items: AnnouncementItem[] = [];
  private current: AnnouncementItem | null = null;
  private pipelineActive = false;
  private draining = false;
  private interruption: { id: string; reason: InterruptionReason } | null =
    null;

  constructor(deps: AnnouncementQueueDeps) {
    this.deps = deps;
    this.maxItems = deps.maxItems ?? DEFAULT_MAX_QUEUE_ITEMS;
  }

  /** Pending + currently-playing count. */
  get depth(): number {
    return this.items.length + (this.current !== null ? 1 : 0);
  }

  /** The item currently being played, if any. */
  get playing(): AnnouncementItem | null {
    return this.current;
  }

  /** True while a pipeline holds the queue paused (barge-in). */
  get pausedForPipeline(): boolean {
    return this.pipelineActive;
  }

  /**
   * Enqueue an item; returns the number of items ahead of it (0 = plays
   * next/immediately). Throws Error('queue full') beyond the bound.
   */
  enqueue(item: AnnouncementItem): number {
    if (this.items.length >= this.maxItems) {
      throw new Error("queue full");
    }
    let position: number;
    if (item.priority === "urgent") {
      this.items.unshift(item);
      position = 0;
      if (this.current !== null && this.current.priority === "normal") {
        // Urgent jumps the queue AND cancels normal playback (spec §2.5).
        this.interruption = { id: this.current.id, reason: "urgent" };
        this.deps.cancelPlayback();
      }
      if (this.pipelineActive) {
        // Urgent during a pipeline cancels the pipeline (spec §2.5); the
        // engine's abort path calls pipelineDone(), resuming the drain.
        this.deps.onUrgentDuringPipeline?.();
      }
    } else {
      this.items.push(item);
      position = this.items.length - 1 + (this.current !== null ? 1 : 0);
    }
    void this.drain();
    return position;
  }

  /**
   * Barge-in hook: a wake word arrived while speaking. Cancels current
   * NORMAL playback (remainder dropped) and pauses draining until
   * pipelineDone(). Returns false during urgent playback (refused — §2.5).
   */
  interruptForPipeline(): boolean {
    if (this.current !== null && this.current.priority === "urgent") {
      return false;
    }
    this.pipelineActive = true;
    if (this.current !== null) {
      this.interruption = { id: this.current.id, reason: "pipeline" };
      this.deps.cancelPlayback();
    }
    return true;
  }

  /** Resume draining after a pipeline completes/aborts. */
  pipelineDone(): void {
    if (!this.pipelineActive) return;
    this.pipelineActive = false;
    void this.drain();
  }

  /** Cancel a queued or playing item by id. */
  cancel(id: string, reason: InterruptionReason = "caller"): boolean {
    const pending = this.items.findIndex((item) => item.id === id);
    if (pending >= 0) {
      const [item] = this.items.splice(pending, 1);
      if (item) this.deps.onEvent?.({ type: "play-interrupted", item, reason });
      return true;
    }
    if (this.current?.id === id) {
      this.interruption = { id, reason };
      this.deps.cancelPlayback();
      return true;
    }
    return false;
  }

  /** Drop all pending items and publish a terminal reason for each. */
  clear(reason: InterruptionReason = "shutdown"): void {
    const pending = this.items;
    this.items = [];
    for (const item of pending)
      this.deps.onEvent?.({ type: "play-interrupted", item, reason });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.pipelineActive && this.items.length > 0) {
        const item = this.items.shift() as AnnouncementItem;
        this.current = item;
        this.deps.onEvent?.({ type: "play-start", item });
        try {
          const result = await this.deps.play(item);
          const interrupted =
            this.interruption?.id === item.id ? this.interruption : null;
          if (interrupted)
            this.deps.onEvent?.({
              type: "play-interrupted",
              item,
              reason: interrupted.reason,
            });
          else
            this.deps.onEvent?.({
              type: "play-end",
              item,
              confirmed: result.confirmed,
            });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const interrupted =
            this.interruption?.id === item.id ? this.interruption : null;
          if (interrupted)
            this.deps.onEvent?.({
              type: "play-interrupted",
              item,
              reason: interrupted.reason,
              error: message,
            });
          else {
            this.deps.log?.(`announcement playback failed: ${message}`);
            this.deps.onEvent?.({ type: "play-error", item, error: message });
          }
        } finally {
          if (this.interruption?.id === item.id) this.interruption = null;
          this.current = null;
        }
      }
    } finally {
      this.draining = false;
    }
    // Items enqueued while the loop was exiting (or a pipeline that ended
    // in between) are picked up by their own drain() calls.
  }
}
