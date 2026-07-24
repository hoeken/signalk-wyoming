/**
 * TranscribeSession — one ASR (whisper) transcription over a fresh Wyoming
 * connection (spec §2.3 step 3).
 *
 * Contract with wyoming-faster-whisper: `transcribe {language}` opens the
 * session, `audio-start`/`audio-chunk` stream PCM (whisper resamples on
 * ingest, so the chunks' own declared format is honored), and it transcribes
 * ONLY when it receives `audio-stop` — the orchestrator's endpointer decides
 * when that is. The reply is a single `transcript {text}` event.
 */

import {
  AudioChunk,
  AudioStart,
  AudioStop,
  parseError,
  parseTranscript,
  Transcribe,
  type AudioFormat,
} from "./protocol/events.js";
import { parseWyomingUri, WyomingConnection } from "./protocol/client.js";

/** Mic/STT path format (spec §2.6): 16 kHz, 16-bit, mono. */
export const MIC_FORMAT: AudioFormat = { rate: 16000, width: 2, channels: 1 };

/** Structural session type so pipeline/api tests can inject fakes. */
export interface TranscribeSessionLike {
  feed(chunk: Buffer, format?: AudioFormat): void;
  finish(timeoutMs: number): Promise<{ text: string }>;
  abort(): void;
}

export interface TranscribeOpenOptions {
  language?: string;
  /** TCP connect timeout (default 5000 ms). */
  connectTimeoutMs?: number;
}

export class TranscribeSession implements TranscribeSessionLike {
  private readonly conn: WyomingConnection;
  private finished = false;

  private constructor(conn: WyomingConnection) {
    this.conn = conn;
  }

  /**
   * Connect to the ASR service and start a session: sends
   * `transcribe {language}` + `audio-start` (16k/2/1).
   */
  static async open(
    uri: string,
    opts: TranscribeOpenOptions = {},
  ): Promise<TranscribeSession> {
    const { host, port } = parseWyomingUri(uri);
    const conn = await WyomingConnection.connect(host, port, {
      timeoutMs: opts.connectTimeoutMs ?? 5000,
    });
    try {
      conn.write(
        Transcribe(
          opts.language !== undefined ? { language: opts.language } : {},
        ),
      );
      conn.write(AudioStart(MIC_FORMAT));
    } catch (err) {
      conn.close();
      throw err;
    }
    return new TranscribeSession(conn);
  }

  /**
   * Forward one PCM chunk. `format` defaults to 16k/2/1; whisper resamples
   * nonconforming audio on ingest, so the chunk's real format is passed
   * through verbatim. Throws if the connection is gone.
   */
  feed(chunk: Buffer, format: AudioFormat = MIC_FORMAT): void {
    if (this.finished) throw new Error("transcribe session is finished");
    this.conn.write(AudioChunk(format, chunk));
  }

  /**
   * End the utterance: sends `audio-stop` and awaits the `transcript`.
   * Rejects on an `error` event from the service, connection loss, or
   * `timeoutMs` elapsing; the connection is closed either way.
   */
  async finish(timeoutMs: number): Promise<{ text: string }> {
    if (this.finished) throw new Error("transcribe session is finished");
    this.finished = true;
    const deadline = Date.now() + timeoutMs;
    try {
      this.conn.write(AudioStop());
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(`ASR transcription timed out after ${timeoutMs}ms`);
        }
        let event;
        try {
          event = await this.conn.nextEvent(remaining);
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("timed out")) {
            throw new Error(
              `ASR transcription timed out after ${timeoutMs}ms`,
              { cause: err },
            );
          }
          throw new Error(
            `ASR connection lost before transcript: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
        const error = parseError(event);
        if (error !== undefined) {
          throw new Error(`ASR error: ${error.text}`);
        }
        const transcript = parseTranscript(event);
        if (transcript !== undefined) {
          return { text: transcript.text };
        }
        // Unknown events ignored (forward compatibility).
      }
    } finally {
      this.conn.close();
    }
  }

  /** Drop the session: close the socket, nothing transcribed. */
  abort(): void {
    this.finished = true;
    this.conn.close();
  }
}

/**
 * Extract raw PCM + format from a WAV file (the satellite control API's
 * /test/record response). Walks the RIFF chunks rather than blindly slicing
 * 44 bytes so a WAV with extra chunks (LIST/INFO) still parses; the common
 * case is exactly the 44-byte canonical header.
 */
export function wavToPcm(wav: Buffer): { format: AudioFormat; pcm: Buffer } {
  if (
    wav.length < 12 ||
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("not a RIFF/WAVE file");
  }
  let format: AudioFormat | null = null;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const tag = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (tag === "fmt " && size >= 16 && body + 16 <= wav.length) {
      const channels = wav.readUInt16LE(body + 2);
      const rate = wav.readUInt32LE(body + 4);
      const bitsPerSample = wav.readUInt16LE(body + 14);
      format = {
        rate,
        width: Math.max(1, Math.floor(bitsPerSample / 8)),
        channels: Math.max(1, channels),
      };
    } else if (tag === "data") {
      const end = Math.min(body + size, wav.length);
      return {
        format: format ?? MIC_FORMAT,
        pcm: wav.subarray(body, end),
      };
    }
    offset = body + size + (size % 2); // RIFF chunks are word-aligned
  }
  throw new Error("WAV file has no data chunk");
}
