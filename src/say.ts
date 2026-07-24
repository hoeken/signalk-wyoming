/**
 * createSay() — the one internal say() implementation behind all three
 * surfaces (REST / PUT / PropertyValues API object). Semantics per SPEC §4.2,
 * bullet for bullet.
 */

import { randomUUID } from "node:crypto";
import type { AnnouncementItem } from "./queue.js";
import type { BufferedAudio, Priority, SayResult } from "./types.js";

export const MAX_SAY_TEXT_CHARS = 500;
export const WAIT_NOT_SUPPORTED_MESSAGE =
  "wait:true is not supported in v1; poll voice.satellites.<id>.state";

export interface SayOpts {
  text: string;
  targets?: string[];
  voice?: string;
  priority?: Priority;
  wait?: boolean;
  /** Unknown fields are ignored. */
  [key: string]: unknown;
}

export interface SayTarget {
  satellite: { id: string; connected: boolean };
  queue: { enqueue(item: AnnouncementItem): number };
}

export interface SayDeps {
  directory: { get(type: "tts"): { uri: string } | null };
  satellites(): Map<string, SayTarget>;
  isMuted(): boolean;
  defaults: { language: string; voice: string };
  log: (msg: string) => void;
  /** Warning channel (app.error) for the truncation warning. */
  warn?: (msg: string) => void;
  synthesize(
    uri: string,
    text: string,
    voice: string | undefined,
    timeoutMs: number,
  ): Promise<BufferedAudio>;
  synthesisTimeoutMs?: number;
  now?: () => number;
}

export type SayFn = (opts: SayOpts) => Promise<SayResult>;

export function createSay(deps: SayDeps): SayFn {
  const now = deps.now ?? Date.now;
  const warn = deps.warn ?? deps.log;
  const synthesisTimeoutMs = deps.synthesisTimeoutMs ?? 15000;

  return async function say(opts: SayOpts): Promise<SayResult> {
    if (
      opts === null ||
      typeof opts !== "object" ||
      typeof opts.text !== "string" ||
      opts.text.length === 0
    ) {
      throw new Error("say: text is required and must be a non-empty string");
    }
    // wait:true is honored-or-rejected, never silently ignored (§4.2).
    if (opts.wait === true) {
      throw new Error(WAIT_NOT_SUPPORTED_MESSAGE);
    }
    const priority: Priority = opts.priority === "urgent" ? "urgent" : "normal";

    let text = opts.text;
    if (text.length > MAX_SAY_TEXT_CHARS) {
      text = text.slice(0, MAX_SAY_TEXT_CHARS - 1) + "…";
      warn(
        `say: text truncated to ${MAX_SAY_TEXT_CHARS} characters (was ${opts.text.length})`,
      );
    }

    // Mute suppresses normal announcements — resolved, not an error (D14).
    if (deps.isMuted() && priority === "normal") {
      return { ok: false, queued: [], suppressed: "muted" };
    }

    const satellites = deps.satellites();
    if (satellites.size === 0) {
      throw new Error("say: no satellites configured");
    }

    const targetIds = opts.targets ?? [...satellites.keys()];
    const errors: { satellite: string; error: string }[] = [];
    const validTargets: { id: string; target: SayTarget }[] = [];
    for (const id of targetIds) {
      const target = satellites.get(id);
      if (target === undefined) {
        errors.push({ satellite: id, error: "unknown satellite" });
      } else {
        validTargets.push({ id, target });
      }
    }
    if (validTargets.length === 0) {
      throw new Error(
        `say: nothing queued — ${formatErrors(errors) || "no targets"}`,
      );
    }

    const tts = deps.directory.get("tts");
    if (tts === null) {
      throw new Error("say: TTS unavailable (no tts service discovered)");
    }

    // One synthesis per announcement; the buffer replays to every target
    // (chunks array is shared — BufferedAudio is replayable by design).
    const voice =
      opts.voice !== undefined && opts.voice !== ""
        ? opts.voice
        : deps.defaults.voice !== ""
          ? deps.defaults.voice
          : undefined;
    let audio: BufferedAudio;
    try {
      audio = await deps.synthesize(tts.uri, text, voice, synthesisTimeoutMs);
    } catch (err) {
      throw new Error(
        `say: synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    const queued: string[] = [];
    for (const { id, target } of validTargets) {
      if (!target.satellite.connected) {
        errors.push({ satellite: id, error: "not connected" });
        continue;
      }
      const item: AnnouncementItem = {
        id: randomUUID(),
        audio,
        priority,
        text,
        enqueuedAt: now(),
      };
      try {
        target.queue.enqueue(item);
        queued.push(id);
      } catch (err) {
        errors.push({
          satellite: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (queued.length === 0) {
      // Nothing queued anywhere → reject (REST 503 / PUT failure).
      throw new Error(`say: nothing queued — ${formatErrors(errors)}`);
    }
    const result: SayResult = { ok: errors.length === 0, queued };
    if (errors.length > 0) result.errors = errors;
    return result;
  };
}

function formatErrors(errors: { satellite: string; error: string }[]): string {
  return errors.map((e) => `${e.satellite}: ${e.error}`).join("; ");
}
