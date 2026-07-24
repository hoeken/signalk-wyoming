/**
 * Shared kernel types for the orchestrator (ORCHESTRATOR-SPEC "Shared kernel
 * types"). Protocol-level types (events, AudioFormat) live in src/protocol.
 */

import type { AudioFormat } from "./protocol/events.js";

export type { AudioFormat };

/** A single-consumer audio stream (spec §2.2). */
export interface AudioStream {
  format: AudioFormat;
  chunks: AsyncIterable<Buffer>;
}

/** Fully-buffered audio — replayable, safe to fan out to multiple queues. */
export interface BufferedAudio {
  format: AudioFormat;
  chunks: Buffer[];
}

export type SatelliteState =
  "disconnected" | "idle" | "listening" | "transcribing" | "speaking";

export type Priority = "normal" | "urgent";

export interface SayResult {
  ok: boolean;
  queued: string[];
  errors?: { satellite: string; error: string }[];
  suppressed?: "muted";
}

/**
 * Injectable timer functions so every timing module works under vitest fake
 * timers (deterministic-time rule). Defaults are the globals.
 */
export interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const defaultTimers: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

/** Total duration in ms of a BufferedAudio. */
export function bufferedAudioDurationMs(audio: BufferedAudio): number {
  const bytesPerSecond =
    audio.format.rate * audio.format.width * audio.format.channels;
  if (bytesPerSecond <= 0) return 0;
  const bytes = audio.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  return (bytes / bytesPerSecond) * 1000;
}
