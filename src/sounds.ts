import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { wavToPcm } from "./asr.js";
import type { BufferedAudio } from "./types.js";

export const MAX_SOUND_BYTES = 5 * 1024 * 1024;
export const MAX_SOUND_DURATION_MS = 30_000;
const SOUND_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface SoundInfo {
  id: string;
  builtIn: boolean;
  durationMs: number;
  rate: number;
  width: number;
  channels: number;
  bytes: number;
}

interface SoundEntry extends SoundInfo {
  audio: BufferedAudio;
}

function pcmChunks(pcm: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < pcm.length; offset += 2048)
    chunks.push(pcm.subarray(offset, Math.min(offset + 2048, pcm.length)));
  return chunks;
}

function durationMs(audio: BufferedAudio): number {
  const bytes = audio.chunks.reduce((total, chunk) => total + chunk.length, 0);
  return (
    (bytes / (audio.format.rate * audio.format.width * audio.format.channels)) *
    1000
  );
}

export function generateTone(
  opts: {
    frequencyHz?: number;
    durationMs?: number;
    alternatingFrequencyHz?: number;
  } = {},
): BufferedAudio {
  const format = { rate: 22050, width: 2, channels: 1 };
  const requestedDuration = opts.durationMs ?? 1000;
  const totalSamples = Math.round((format.rate * requestedDuration) / 1000);
  const pcm = Buffer.alloc(totalSamples * 2);
  for (let i = 0; i < totalSamples; i++) {
    const elapsedMs = (i / format.rate) * 1000;
    const frequency =
      opts.alternatingFrequencyHz !== undefined &&
      Math.floor(elapsedMs / 250) % 2 === 1
        ? opts.alternatingFrequencyHz
        : (opts.frequencyHz ?? 440);
    const sine = Math.sin(2 * Math.PI * frequency * (i / format.rate));
    const sample = Math.tanh(3 * sine) * 0.35;
    pcm.writeInt16LE(Math.round(sample * 32767), i * 2);
  }
  return { format, chunks: pcmChunks(pcm) };
}

function entry(id: string, builtIn: boolean, audio: BufferedAudio): SoundEntry {
  const bytes = audio.chunks.reduce((total, chunk) => total + chunk.length, 0);
  return {
    id,
    builtIn,
    audio,
    durationMs: Math.round(durationMs(audio)),
    ...audio.format,
    bytes,
  };
}

function infoOf(sound: SoundEntry): SoundInfo {
  return {
    id: sound.id,
    builtIn: sound.builtIn,
    durationMs: sound.durationMs,
    rate: sound.rate,
    width: sound.width,
    channels: sound.channels,
    bytes: sound.bytes,
  };
}

function decodeWav(id: string, wav: Buffer): SoundEntry {
  if (wav.length === 0 || wav.length > MAX_SOUND_BYTES)
    throw new Error(`sound must contain 1 to ${MAX_SOUND_BYTES} bytes`);
  if (wav.length < 36 || wav.toString("ascii", 0, 4) !== "RIFF")
    throw new Error("sound must be a PCM WAV file");
  let offset = 12;
  let pcmFormat = 0;
  while (offset + 8 <= wav.length) {
    const tag = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (tag === "fmt " && size >= 16 && body + 16 <= wav.length) {
      pcmFormat = wav.readUInt16LE(body);
      break;
    }
    offset = body + size + (size % 2);
  }
  if (pcmFormat !== 1)
    throw new Error("only uncompressed PCM WAV is supported");
  const { format, pcm } = wavToPcm(wav);
  if (
    format.rate < 8000 ||
    format.rate > 48000 ||
    ![1, 2, 3, 4].includes(format.width) ||
    format.channels < 1 ||
    format.channels > 2
  )
    throw new Error("unsupported WAV format");
  const result = entry(id, false, { format, chunks: pcmChunks(pcm) });
  if (result.durationMs <= 0 || result.durationMs > MAX_SOUND_DURATION_MS)
    throw new Error(
      `sound duration must be between 1 and ${MAX_SOUND_DURATION_MS} ms`,
    );
  return result;
}

export class SoundLibrary {
  private readonly entries = new Map<string, SoundEntry>();

  constructor(
    private readonly directory?: string,
    private readonly log: (message: string) => void = () => undefined,
  ) {
    this.entries.set("chime", entry("chime", true, generateTone()));
    this.entries.set(
      "warning",
      entry(
        "warning",
        true,
        generateTone({ frequencyHz: 660, durationMs: 1200 }),
      ),
    );
    this.entries.set(
      "alarm",
      entry(
        "alarm",
        true,
        generateTone({
          frequencyHz: 880,
          alternatingFrequencyHz: 660,
          durationMs: 2000,
        }),
      ),
    );
    this.loadCustomSounds();
  }

  list(): SoundInfo[] {
    return [...this.entries.values()]
      .map(infoOf)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  get(id: string): BufferedAudio | undefined {
    return this.entries.get(id)?.audio;
  }

  put(id: string, wavBase64: string): SoundInfo {
    if (!SOUND_ID.test(id))
      throw new Error("sound id must match ^[a-z0-9][a-z0-9_-]{0,63}$");
    if (this.entries.get(id)?.builtIn)
      throw new Error("built-in sound is read-only");
    if (this.directory === undefined)
      throw new Error("custom sound storage is unavailable");
    if (
      typeof wavBase64 !== "string" ||
      wavBase64.length === 0 ||
      wavBase64.length > Math.ceil((MAX_SOUND_BYTES * 4) / 3) + 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(wavBase64)
    )
      throw new Error("wavBase64 is not valid bounded base64");
    const wav = Buffer.from(wavBase64, "base64");
    const normalized = wavBase64.replace(/=+$/, "");
    if (wav.toString("base64").replace(/=+$/, "") !== normalized)
      throw new Error("wavBase64 is invalid");
    const sound = decodeWav(id, wav);
    mkdirSync(this.directory, { recursive: true });
    const destination = join(this.directory, `${id}.wav`);
    const temporary = join(this.directory, `.${id}.${process.pid}.tmp`);
    try {
      writeFileSync(temporary, wav, { flag: "wx" });
      renameSync(temporary, destination);
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
    this.entries.set(id, sound);
    return infoOf(sound);
  }

  delete(id: string): boolean {
    const existing = this.entries.get(id);
    if (!existing) return false;
    if (existing.builtIn) throw new Error("built-in sound is read-only");
    if (this.directory !== undefined) {
      const filename = join(this.directory, `${id}.wav`);
      if (existsSync(filename)) unlinkSync(filename);
    }
    this.entries.delete(id);
    return true;
  }

  private loadCustomSounds(): void {
    if (this.directory === undefined || !existsSync(this.directory)) return;
    for (const filename of readdirSync(this.directory)) {
      if (!filename.endsWith(".wav")) continue;
      const id = filename.slice(0, -4);
      if (!SOUND_ID.test(id) || this.entries.has(id)) continue;
      try {
        this.entries.set(
          id,
          decodeWav(id, readFileSync(join(this.directory, filename))),
        );
      } catch (error) {
        this.log(
          `ignoring invalid custom sound ${filename}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
