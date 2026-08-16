import { describe, expect, it } from "vitest";
import {
  EnergyGateEndpointer,
  rms16le,
  SPEECH_ABS_MIN_RMS,
  type Endpointer,
} from "../src/endpointer.js";
import type { AudioFormat } from "../src/protocol/events.js";
import {
  ambientChunk,
  farFieldSpeechChunk,
  quietSpeechChunk,
  silencePcm,
  sinePcm,
  speechChunk,
} from "./pcm.js";

// 1024 samples @ 16 kHz / 16-bit / mono = 64 ms per chunk.
const FMT: AudioFormat = { rate: 16000, width: 2, channels: 1 };
const CHUNK_MS = 64;

function feedAll(
  ep: Endpointer,
  chunks: Buffer[],
  format: AudioFormat = FMT,
): ("continue" | "end")[] {
  return chunks.map((c) => ep.feed(c, format));
}

describe("rms16le", () => {
  it("computes RMS of 16-bit LE PCM", () => {
    expect(rms16le(silencePcm(1024))).toBe(0);
    const sine = sinePcm(1600, 8000, 100); // whole number of cycles
    const rms = rms16le(sine);
    expect(rms).toBeGreaterThan(8000 / Math.SQRT2 - 100);
    expect(rms).toBeLessThan(8000 / Math.SQRT2 + 100);
    expect(rms16le(Buffer.alloc(0))).toBe(0);
  });
});

describe("EnergyGateEndpointer — speech/silence segmentation", () => {
  const opts = { silenceMs: 200, minUtteranceMs: 100, maxUtteranceMs: 10000 };

  it("ends after silenceMs of silence following speech", () => {
    const ep = new EnergyGateEndpointer(opts);
    // 3 ambient (noise-floor seed) + 5 speech → all continue
    const lead = feedAll(ep, [
      ambientChunk(),
      ambientChunk(),
      ambientChunk(),
      speechChunk(),
      speechChunk(),
      speechChunk(),
      speechChunk(),
      speechChunk(),
    ]);
    expect(lead).toEqual(Array(8).fill("continue"));
    // Silence: 64/128/192 ms < 200 → continue; 256 ms ≥ 200 → end
    expect(ep.feed(ambientChunk(), FMT)).toBe("continue");
    expect(ep.feed(ambientChunk(), FMT)).toBe("continue");
    expect(ep.feed(ambientChunk(), FMT)).toBe("continue");
    expect(ep.feed(ambientChunk(), FMT)).toBe("end");
  });

  it("speech resets the silence run", () => {
    const ep = new EnergyGateEndpointer(opts);
    feedAll(ep, [ambientChunk(), ambientChunk(), ambientChunk()]);
    ep.feed(speechChunk(), FMT);
    // 2 silence chunks (128 ms), then speech again → run resets
    ep.feed(ambientChunk(), FMT);
    ep.feed(ambientChunk(), FMT);
    expect(ep.feed(speechChunk(), FMT)).toBe("continue");
    // now a full fresh silence run is needed
    expect(ep.feed(ambientChunk(), FMT)).toBe("continue");
    expect(ep.feed(ambientChunk(), FMT)).toBe("continue");
    expect(ep.feed(ambientChunk(), FMT)).toBe("continue");
    expect(ep.feed(ambientChunk(), FMT)).toBe("end");
  });

  it("never ends on silence before minUtteranceMs of audio", () => {
    const ep = new EnergyGateEndpointer({
      silenceMs: CHUNK_MS,
      minUtteranceMs: 1000,
      maxUtteranceMs: 10000,
    });
    // seed + one speech chunk, then silence: run ≥ silenceMs from the first
    // silence chunk, but elapsed audio must reach 1000 ms (chunk 16).
    feedAll(ep, [
      ambientChunk(),
      ambientChunk(),
      ambientChunk(),
      speechChunk(),
    ]);
    for (let chunk = 5; chunk <= 15; chunk++) {
      expect(ep.feed(ambientChunk(), FMT), `chunk ${chunk}`).toBe("continue");
    }
    expect(ep.feed(ambientChunk(), FMT)).toBe("end"); // 16 × 64 = 1024 ms
  });
});

describe("EnergyGateEndpointer — maxUtteranceMs cap", () => {
  it("ends at the cap under continuous speech", () => {
    const ep = new EnergyGateEndpointer({
      silenceMs: 800,
      minUtteranceMs: 100,
      maxUtteranceMs: 320,
    });
    const results = feedAll(ep, [
      ambientChunk(),
      ambientChunk(),
      ambientChunk(),
      speechChunk(),
      speechChunk(), // 5 × 64 = 320 ms
    ]);
    expect(results).toEqual([
      "continue",
      "continue",
      "continue",
      "continue",
      "end",
    ]);
  });

  it("ends at the cap when no speech is ever seen", () => {
    const ep = new EnergyGateEndpointer({
      silenceMs: 100,
      minUtteranceMs: 50,
      maxUtteranceMs: 320,
    });
    const results = feedAll(
      ep,
      Array.from({ length: 5 }, () => ambientChunk()),
    );
    expect(results).toEqual([
      "continue",
      "continue",
      "continue",
      "continue",
      "end",
    ]);
  });

  it("keeps returning 'end' after ending", () => {
    const ep = new EnergyGateEndpointer({ maxUtteranceMs: CHUNK_MS });
    expect(ep.feed(ambientChunk(), FMT)).toBe("end");
    expect(ep.feed(speechChunk(), FMT)).toBe("end");
  });
});

describe("EnergyGateEndpointer — adaptive noise floor", () => {
  const opts = { silenceMs: 200, minUtteranceMs: 100, maxUtteranceMs: 10000 };
  // Engine-room ambient: RMS ≈ 1061 — above the absolute speech threshold
  // but the adaptive floor (× 3) keeps it classified as noise.
  const engineNoise = () => sinePcm(1024, 1500, 120);

  it("speech is detected over a loud noise floor and silence-run still works", () => {
    const ep = new EnergyGateEndpointer(opts);
    feedAll(ep, [engineNoise(), engineNoise(), engineNoise()]);
    expect(ep.feed(speechChunk(), FMT)).toBe("continue"); // RMS 5657 > 1061×3
    // "Silence" = back to engine noise; run of 256 ms ends the utterance.
    expect(ep.feed(engineNoise(), FMT)).toBe("continue");
    expect(ep.feed(engineNoise(), FMT)).toBe("continue");
    expect(ep.feed(engineNoise(), FMT)).toBe("continue");
    expect(ep.feed(engineNoise(), FMT)).toBe("end");
  });

  it("a moderate burst below floor×3 is not speech in a loud environment", () => {
    const ep = new EnergyGateEndpointer(opts);
    feedAll(ep, [engineNoise(), engineNoise(), engineNoise()]);
    // RMS ≈ 1768 < 1061 × 3 — would be speech in a quiet cabin, is noise here
    const burst = sinePcm(1024, 2500, 250);
    expect(ep.feed(burst, FMT)).toBe("continue");
    // No speech seen → no silence-based end, however long the noise runs.
    for (let i = 0; i < 20; i++) {
      expect(ep.feed(engineNoise(), FMT)).toBe("continue");
    }
  });

  it("very quiet sounds below the absolute threshold are never speech", () => {
    const ep = new EnergyGateEndpointer(opts);
    feedAll(ep, [ambientChunk(), ambientChunk(), ambientChunk()]);
    const whisper = sinePcm(1024, 400); // RMS ≈ 283 < SPEECH_ABS_MIN_RMS
    expect(rms16le(whisper)).toBeLessThan(SPEECH_ABS_MIN_RMS);
    for (let i = 0; i < 3; i++) expect(ep.feed(whisper, FMT)).toBe("continue");
    // Long silence afterwards — still no end (speech never seen).
    for (let i = 0; i < 10; i++) {
      expect(ep.feed(ambientChunk(), FMT)).toBe("continue");
    }
    // Real speech still works after all that.
    expect(ep.feed(speechChunk(), FMT)).toBe("continue");
    feedAll(ep, [ambientChunk(), ambientChunk(), ambientChunk()]);
    expect(ep.feed(ambientChunk(), FMT)).toBe("end");
  });
});

describe("EnergyGateEndpointer — audio-time bookkeeping", () => {
  it("measures durations from the chunk format, not wall clock or chunk count", () => {
    // 1024 samples @ 8 kHz = 128 ms per chunk → cap of 512 ms = 4 chunks.
    const fmt8k: AudioFormat = { rate: 8000, width: 2, channels: 1 };
    const ep = new EnergyGateEndpointer({
      silenceMs: 100,
      minUtteranceMs: 50,
      maxUtteranceMs: 512,
    });
    expect(ep.feed(ambientChunk(), fmt8k)).toBe("continue");
    expect(ep.feed(ambientChunk(), fmt8k)).toBe("continue");
    expect(ep.feed(ambientChunk(), fmt8k)).toBe("continue");
    expect(ep.feed(ambientChunk(), fmt8k)).toBe("end");
  });

  it("tolerates empty chunks", () => {
    const ep = new EnergyGateEndpointer({ maxUtteranceMs: 320 });
    expect(ep.feed(Buffer.alloc(0), FMT)).toBe("continue");
    expect(ep.feed(ambientChunk(), FMT)).toBe("continue");
  });

  it("reset() starts a fresh utterance and a fresh noise floor", () => {
    const ep = new EnergyGateEndpointer({
      silenceMs: 200,
      minUtteranceMs: 100,
      maxUtteranceMs: 320,
    });
    feedAll(
      ep,
      Array.from({ length: 5 }, () => ambientChunk()),
    );
    ep.reset();
    // Full fresh run to the cap again.
    const results = feedAll(
      ep,
      Array.from({ length: 5 }, () => ambientChunk()),
    );
    expect(results).toEqual([
      "continue",
      "continue",
      "continue",
      "continue",
      "end",
    ]);
  });
});

describe("EnergyGateEndpointer — floor seeding when speech starts immediately", () => {
  const opts = { silenceMs: 1500, minUtteranceMs: 300, maxUtteranceMs: 10000 };

  // On the wake path the satellite starts streaming at the wake word, so the
  // first chunks are the user already talking, not ambient. Seeding the floor
  // from them puts it AT speech level; the 3x factor then makes a threshold
  // no speech can reach, speechSeen stays false and every utterance runs to
  // maxUtteranceMs. Measured on hardware: floor=1086 thr=3259 rms=887.
  it("detects speech even when the first chunks are already speech", () => {
    const ep = new EnergyGateEndpointer(opts);
    // No ambient lead-in at all — speech from the very first chunk.
    const speech = Array.from({ length: 20 }, () => quietSpeechChunk());
    const trailing = Array.from({ length: 30 }, () => ambientChunk());
    const results = feedAll(ep, [...speech, ...trailing]);
    // Must end on the silence gate, well before the 10 s cap (156 chunks).
    expect(results).toContain("end");
    expect(results.indexOf("end")).toBeLessThan(
      speech.length + trailing.length,
    );
  });

  it("does not let a silence run inflate the floor past speech", () => {
    const ep = new EnergyGateEndpointer(opts);
    // Speech first (mis-seeds the floor), then more speech: the EWMA must not
    // have climbed so far that later speech is still scored as silence.
    feedAll(
      ep,
      Array.from({ length: 10 }, () => quietSpeechChunk()),
    );
    const later = feedAll(
      ep,
      Array.from({ length: 24 }, () => ambientChunk()),
    );
    expect(later).toContain("end");
  });
});

describe("EnergyGateEndpointer — speechMinRms", () => {
  const base = { silenceMs: 200, minUtteranceMs: 100, maxUtteranceMs: 10000 };

  // A far-field panel mic never reaches the 700 default: measured on hardware
  // a deliberately loud question peaked at 612, so speechSeen never flipped
  // and the utterance ran to maxUtteranceMs with a truncated transcript.
  it("never sees speech from a far-field mic at the default threshold", () => {
    const ep = new EnergyGateEndpointer(base);
    feedAll(
      ep,
      Array.from({ length: 8 }, () => farFieldSpeechChunk()),
    );
    // Silence after speech only ends the utterance if speech was SEEN; with
    // the default threshold it never was, so this runs on to the cap.
    const tail = feedAll(
      ep,
      Array.from({ length: 8 }, () => ambientChunk()),
    );
    expect(tail).not.toContain("end");
  });

  it("ends normally once the threshold suits the mic", () => {
    const ep = new EnergyGateEndpointer({ ...base, speechMinRms: 300 });
    feedAll(
      ep,
      Array.from({ length: 8 }, () => farFieldSpeechChunk()),
    );
    const tail = feedAll(
      ep,
      Array.from({ length: 8 }, () => ambientChunk()),
    );
    expect(tail).toContain("end");
  });
});
