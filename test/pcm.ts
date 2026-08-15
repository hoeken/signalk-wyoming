/** Synthetic PCM builders for endpointer/ASR/pipeline tests — no audio files. */

import type { AudioFormat } from "../src/protocol/events.js";

/** Mic/STT format (spec §2.6). */
export const MIC_FORMAT: AudioFormat = { rate: 16000, width: 2, channels: 1 };

/**
 * `samples` of a sine wave at peak `amplitude` (16-bit LE mono).
 * RMS ≈ amplitude / √2.
 */
export function sinePcm(
  samples: number,
  amplitude: number,
  freqHz = 200,
  rate = 16000,
): Buffer {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(
      amplitude * Math.sin((2 * Math.PI * freqHz * i) / rate),
    );
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, value)), i * 2);
  }
  return buf;
}

/** `samples` of digital silence. */
export function silencePcm(samples: number): Buffer {
  return Buffer.alloc(samples * 2);
}

/** Quiet-cabin ambient noise (RMS ≈ 35). */
export function ambientChunk(samples = 1024): Buffer {
  return sinePcm(samples, 50);
}

/** Loud, clear speech (RMS ≈ 5657). */
export function speechChunk(samples = 1024): Buffer {
  return sinePcm(samples, 8000, 300);
}

/** Canonical 44-byte-header WAV wrapping raw PCM. */
export function buildWav(
  pcm: Buffer,
  format: AudioFormat = MIC_FORMAT,
): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.rate, 24);
  header.writeUInt32LE(format.rate * format.width * format.channels, 28);
  header.writeUInt16LE(format.width * format.channels, 32);
  header.writeUInt16LE(format.width * 8, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Speech as it actually arrives from a quiet far-field panel mic
 * (RMS ≈ 880, measured on an ESP32-P4 satellite). Only ~25x the cabin
 * ambient above, not the ~160x a close-talking mic gives.
 */
export function quietSpeechChunk(samples = 1024): Buffer {
  return sinePcm(samples, 1250, 300);
}
