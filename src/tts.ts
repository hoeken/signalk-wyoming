/**
 * synthesize() — one fully-buffered TTS synthesis via a Wyoming TTS service
 * (piper). Fresh connection per call; announcements are short, so buffering
 * in full (spec §2.3) keeps fan-out trivial.
 *
 * piper streams audio per sentence but sends a single audio-start/audio-stop
 * pair (2.3.1) — we collect chunks until audio-stop regardless of count.
 */

import {
  parseAudioChunk,
  parseAudioStart,
  parseError,
  Synthesize,
  type AudioFormat,
} from "./protocol/events.js";
import { parseWyomingUri, WyomingConnection } from "./protocol/client.js";
import type { BufferedAudio } from "./types.js";

/**
 * Synthesize `text` at the TTS service at `uri` (tcp://host:port).
 *
 * - `voice` (piper voice name) is passed as `voice: {name}` when set.
 * - Resolves with the full buffered audio in the service's declared format.
 * - Rejects on: `error` event from the service (with its text), overall
 *   `timeoutMs` deadline, connection loss before audio-stop, invalid URI.
 */
export async function synthesize(
  uri: string,
  text: string,
  voice: string | undefined,
  timeoutMs: number,
): Promise<BufferedAudio> {
  const { host, port } = parseWyomingUri(uri);
  const deadline = Date.now() + timeoutMs;
  const conn = await WyomingConnection.connect(host, port, {
    timeoutMs: Math.min(timeoutMs, 5000),
  });
  try {
    conn.write(
      Synthesize(text, voice !== undefined ? { voice: { name: voice } } : {}),
    );
    let format: AudioFormat | null = null;
    const chunks: Buffer[] = [];
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`TTS synthesis timed out after ${timeoutMs}ms`);
      }
      let event;
      try {
        event = await conn.nextEvent(remaining);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("timed out")) {
          throw new Error(`TTS synthesis timed out after ${timeoutMs}ms`, {
            cause: err,
          });
        }
        throw new Error(
          `TTS stream ended before audio-stop: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      const error = parseError(event);
      if (error !== undefined) {
        throw new Error(`TTS error: ${error.text}`);
      }
      const start = parseAudioStart(event);
      if (start !== undefined) {
        format = {
          rate: start.rate,
          width: start.width,
          channels: start.channels,
        };
        continue;
      }
      const chunk = parseAudioChunk(event);
      if (chunk !== undefined) {
        // Honor the chunk's own declared format if audio-start was missed.
        format ??= {
          rate: chunk.rate,
          width: chunk.width,
          channels: chunk.channels,
        };
        if (chunk.audio.length > 0) chunks.push(chunk.audio);
        continue;
      }
      if (event.type === "audio-stop") {
        if (format === null || chunks.length === 0) {
          throw new Error("TTS returned no audio");
        }
        return { format, chunks };
      }
      // Unknown events ignored (forward compatibility).
    }
  } finally {
    conn.close();
  }
}
