/**
 * Endpointer — end-of-utterance detection for the post-wake mic stream
 * (spec §2.4, D7). The orchestrator endpoints every voice-command path in
 * v1: the satellite streams until we send `transcript`/`error`, and whisper
 * transcribes only on `audio-stop` — nothing upstream segments for us.
 *
 * All timing is measured in AUDIO time (the duration of the PCM fed), never
 * wall clock — so a satellite streaming faster/slower than real time (or a
 * test feeding pre-built buffers) endpoints identically. This also satisfies
 * the deterministic-time rule with no injected clock at all, and it means
 * the mic-muted window after the awake WAV (no chunks arrive) can never be
 * mistaken for silence: the gate only advances when audio actually arrives.
 *
 * Contingency (D7): if the real-boat-audio spike fails its go/no-go, silero
 * VAD replaces EnergyGateEndpointer behind this same interface.
 */

import { pcmDurationMs, type AudioFormat } from "./protocol/events.js";

export interface Endpointer {
  /** Feed one PCM chunk; returns 'end' once the utterance is complete. */
  feed(chunk: Buffer, format: AudioFormat): "continue" | "end";
  /** Forget everything (fresh utterance AND fresh noise floor). */
  reset(): void;
}

export interface EnergyGateOptions {
  /** Silence run (audio ms) after speech that ends the utterance. */
  silenceMs?: number;
  /** Hard cap (audio ms) — always ends, speech or not. */
  maxUtteranceMs?: number;
  /** Never end on silence before this much audio has elapsed. */
  minUtteranceMs?: number;
}

// ---------------------------------------------------------------------------
// Tunable constants (documented; spec §2.4 "tunable constants, documented")
// ---------------------------------------------------------------------------

/** A chunk is speech when its RMS exceeds `noise floor × this factor`. */
export const SPEECH_FLOOR_FACTOR = 3;

/**
 * ...and never below this absolute 16-bit RMS — keeps breaths/rustle in a
 * very quiet cabin from counting as speech. (Full-scale sine ≈ 23170 RMS;
 * normal speech into a near mic is typically several thousand.)
 */
export const SPEECH_ABS_MIN_RMS = 700;

/**
 * The noise floor seeds from the minimum RMS of the first chunks (the mic is
 * muted during the awake WAV +0.5 s, so early chunks are ambient noise; min()
 * defends against speech starting immediately).
 */
export const FLOOR_SEED_CHUNKS = 3;

/**
 * A floor is only believable while the loudest audio in the utterance stands
 * clear of it. If the peak never reaches `floor × SPEECH_FLOOR_FACTOR`, the
 * floor was seeded from speech (the wake path opens the stream mid-word), so
 * the gate falls back to `SPEECH_ABS_MIN_RMS` rather than a threshold nothing
 * can cross. Genuinely loud ambient — engine room — keeps its adaptive floor,
 * because there the speech peak does clear it.
 */
export const FLOOR_TRUST_PEAK_FACTOR = SPEECH_FLOOR_FACTOR;

/**
 * After seeding, the floor follows non-speech chunks with a slow EWMA so a
 * drifting ambient level (engine rpm changes) is tracked without letting
 * speech inflate the floor.
 */
export const FLOOR_EWMA_ALPHA = 0.05;

/**
 * Energy-gate endpointer over 16-bit little-endian PCM (the mic/STT path is
 * 16 kHz/16-bit/mono per spec §2.6; multi-channel audio is RMS'd across all
 * samples, which is fine for an energy gate).
 *
 * Ends the utterance when:
 *  (a) speech was seen and `silenceMs` of continuous sub-threshold audio has
 *      followed it, with at least `minUtteranceMs` of total audio elapsed; or
 *  (b) `maxUtteranceMs` of audio has elapsed (always — with or without
 *      speech), so a hot mic can never stream unbounded audio into whisper.
 */
export class EnergyGateEndpointer implements Endpointer {
  private readonly silenceMs: number;
  private readonly maxUtteranceMs: number;
  private readonly minUtteranceMs: number;

  private elapsedMs = 0;
  private silenceRunMs = 0;
  private speechSeen = false;
  private floor: number | null = null;
  private peakRms = 0;
  private seedCount = 0;
  private ended = false;

  constructor(opts: EnergyGateOptions = {}) {
    this.silenceMs = opts.silenceMs ?? 800;
    this.maxUtteranceMs = opts.maxUtteranceMs ?? 10000;
    this.minUtteranceMs = opts.minUtteranceMs ?? 300;
  }

  feed(chunk: Buffer, format: AudioFormat): "continue" | "end" {
    if (this.ended) return "end";
    const chunkMs = pcmDurationMs(chunk.length, format);
    const rms = rms16le(chunk);

    if (this.seedCount < FLOOR_SEED_CHUNKS) {
      this.floor = this.floor === null ? rms : Math.min(this.floor, rms);
      this.seedCount++;
    }
    // The seed is only ambient if the user was not ALREADY talking when the
    // stream opened. On the wake path they usually are — the satellite starts
    // streaming at the wake word — so the floor can seed at speech level, and
    // floor*FLOOR_FACTOR then exceeds anything the same voice produces:
    // speechSeen never flips and the utterance runs to maxUtteranceMs.
    // Measured on an ESP32-P4 satellite: floor=1086, threshold=3259, speech
    // 887 RMS, ten seconds scored as unbroken silence.
    //
    // So trust the floor only while the loudest chunk seen stands clear of it;
    // a floor seeded from speech never does, and the gate falls back to the
    // absolute threshold instead of locking itself shut.
    if (rms > this.peakRms) this.peakRms = rms;
    const seeded = this.floor ?? 0;
    const floor = this.peakRms >= seeded * FLOOR_TRUST_PEAK_FACTOR ? seeded : 0;
    const threshold = Math.max(floor * SPEECH_FLOOR_FACTOR, SPEECH_ABS_MIN_RMS);

    if (rms >= threshold) {
      this.speechSeen = true;
      this.silenceRunMs = 0;
    } else {
      this.silenceRunMs += chunkMs;
      // Track ambient DOWNWARD freely, but never let a run of sub-threshold
      // chunks drag the floor UP toward speech: a mis-seeded floor must be
      // able to recover, not compound. (Rising ambient is picked up on the
      // next utterance, which reseeds.)
      if (this.seedCount >= FLOOR_SEED_CHUNKS) {
        const next = floor + FLOOR_EWMA_ALPHA * (rms - floor);
        this.floor = Math.min(next, floor);
      }
    }

    this.elapsedMs += chunkMs;
    if (this.elapsedMs >= this.maxUtteranceMs) {
      this.ended = true;
      return "end";
    }
    if (
      this.speechSeen &&
      this.silenceRunMs >= this.silenceMs &&
      this.elapsedMs >= this.minUtteranceMs
    ) {
      this.ended = true;
      return "end";
    }
    return "continue";
  }

  reset(): void {
    this.elapsedMs = 0;
    this.silenceRunMs = 0;
    this.speechSeen = false;
    this.floor = null;
    this.peakRms = 0;
    this.seedCount = 0;
    this.ended = false;
  }
}

/** RMS of a buffer of 16-bit signed little-endian PCM samples. */
export function rms16le(chunk: Buffer): number {
  const samples = chunk.length >> 1;
  if (samples === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples; i++) {
    const sample = chunk.readInt16LE(i * 2);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples);
}
