/**
 * PipelineEngine — the voice-command pipeline (spec §2.3/§2.5; DESIGN
 * "Wake dedup/barge-in mechanics").
 *
 * One session per satellite: `run-pipeline` from a wake-mode satellite →
 * dedup (first detection wins for `wakeDedupMs`) → barge-in/refusal rules
 * against that satellite's announcement queue → stream mic chunks through
 * the endpointer into a fresh ASR session → on end-of-utterance send
 * `audio-stop` to whisper → relay the `transcript` to the satellite (which
 * stops its streaming and plays the done sound) → publish `voice.command`.
 *
 * Interruption rules (spec §2.5):
 * - urgent announcement mid-pipeline → the queue calls `cancelForUrgent()`:
 *   ASR aborted, satellite gets `error` (silent stop, no done sound),
 *   NOTHING published, urgent plays immediately.
 * - wake during normal playback → barge-in via queue.interruptForPipeline().
 * - wake during urgent playback → refused (`busy-urgent` error).
 * - no transcript within `pipelineTimeoutMs` → aborted (`timeout` error),
 *   notifications.voice.asr alarm.
 * - empty transcript → `transcript` still relayed (stops the satellite,
 *   done sound plays) but voice.command is NOT published (documented
 *   decision — an empty command is noise for consumers).
 */

import { randomUUID } from "node:crypto";
import type { TranscribeSessionLike } from "./asr.js";
import type { Endpointer } from "./endpointer.js";
import type { VoiceCommand } from "./paths.js";
import type {
  AudioChunk as AudioChunkData,
  AudioFormat,
  Detection,
  RunPipeline,
} from "./protocol/events.js";
import {
  defaultTimers,
  type Priority,
  type SatelliteState,
  type TimerApi,
} from "./types.js";

/** How long a `detection` stays attributable to the following run-pipeline. */
const DETECTION_FRESH_MS = 10000;

/** Structural view of RemoteSatellite — the engine never dials sockets. */
export interface PipelineSatellite {
  readonly id: string;
  state: SatelliteState;
  setState(state: SatelliteState): void;
  sendTranscript(text: string): void;
  sendError(code: string, text: string): void;
}

/** Structural view of AnnouncementQueue. */
export interface PipelineQueue {
  interruptForPipeline(): boolean;
  pipelineDone(): void;
  readonly playing: { priority: Priority } | null;
}

export interface PipelineEngineDeps {
  directory: { get(type: "asr"): { uri: string } | null };
  queueFor(satelliteId: string): PipelineQueue | null;
  publishCommand(cmd: VoiceCommand): void;
  /** notifications.voice.<service> (state alarm|normal, method visual). */
  notify(service: string, state: "alarm" | "normal", message: string): void;
  /** SSE hub emit. */
  emit(kind: "command" | "error", data: unknown): void;
  endpointerFactory(): Endpointer;
  asrOpen(
    uri: string,
    opts: { language?: string },
  ): Promise<TranscribeSessionLike>;
  advanced: { wakeDedupMs: number; pipelineTimeoutMs: number };
  language: string;
  log(msg: string): void;
  now?: () => number;
  timers?: TimerApi;
}

interface Session {
  sat: PipelineSatellite;
  endpointer: Endpointer;
  /** Set once the ASR connection is open (chunks buffer until then). */
  asr: TranscribeSessionLike | null;
  asrReady: Promise<TranscribeSessionLike | null>;
  pending: { audio: Buffer; format: AudioFormat }[];
  startedAt: number;
  wakeWord?: string;
  timeout: unknown;
  /** Endpointer fired — no more feeding, transcription in flight. */
  ended: boolean;
  /** Completed or aborted — every path is idempotent past this. */
  done: boolean;
}

export class PipelineEngine {
  private readonly deps: PipelineEngineDeps;
  private readonly now: () => number;
  private readonly timers: TimerApi;
  private readonly sessions = new Map<string, Session>();
  private readonly lastDetection = new Map<
    string,
    { name?: string; at: number }
  >();
  private lastPipelineAt: number | null = null;
  private asrAlarmed = false;

  constructor(deps: PipelineEngineDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? defaultTimers;
  }

  /** Number of in-flight pipeline sessions (status/debug). */
  get activeSessions(): number {
    return this.sessions.size;
  }

  /** Remember the wake word for the run-pipeline that follows. */
  onDetection(satelliteId: string, detection: Detection): void {
    const entry: { name?: string; at: number } = { at: this.now() };
    if (detection.name !== undefined) entry.name = detection.name;
    this.lastDetection.set(satelliteId, entry);
  }

  onRunPipeline(sat: PipelineSatellite, runPipeline: RunPipeline): void {
    if (this.sessions.has(sat.id)) {
      this.deps.log(
        `pipeline: ignoring run-pipeline from ${sat.id} — session already active`,
      );
      return;
    }
    const now = this.now();
    const detection = this.lastDetection.get(sat.id);
    this.lastDetection.delete(sat.id);
    const wakeWord =
      detection !== undefined && now - detection.at < DETECTION_FRESH_MS
        ? (detection.name ?? runPipeline.wakeWordName)
        : runPipeline.wakeWordName;

    // Wake dedup: the FIRST run-pipeline wins; others within wakeDedupMs get
    // a (silent-stop) error — no score-comparison window (spec §2.5).
    if (
      this.lastPipelineAt !== null &&
      now - this.lastPipelineAt < this.deps.advanced.wakeDedupMs
    ) {
      this.deps.log(
        `pipeline: wake-dedup — ${sat.id} lost to a pipeline started ${now - this.lastPipelineAt}ms ago`,
      );
      this.safeSendError(sat, "wake-dedup", "another satellite heard it first");
      return;
    }

    const queue = this.deps.queueFor(sat.id);
    if (queue !== null && !queue.interruptForPipeline()) {
      // §2.5: wake during URGENT playback is ignored — announcement first.
      this.deps.log(
        `pipeline: ${sat.id} woke during urgent playback — refused`,
      );
      this.safeSendError(sat, "busy-urgent", "urgent announcement in progress");
      return;
    }

    const asr = this.deps.directory.get("asr");
    if (asr === null) {
      queue?.pipelineDone();
      this.safeSendError(
        sat,
        "no-asr",
        "voice commands unavailable: no speech-to-text service",
      );
      const message =
        "wake word detected but no speech-to-text (ASR) service is available — install/enable signalk-whisper";
      this.alarmAsr(message);
      this.deps.emit("error", {
        satellite: sat.id,
        code: "no-asr",
        error: message,
      });
      return;
    }

    // Accepted — this pipeline starts the dedup window.
    this.lastPipelineAt = now;
    sat.setState("listening");
    const session: Session = {
      sat,
      endpointer: this.deps.endpointerFactory(),
      asr: null,
      asrReady: Promise.resolve(null),
      pending: [],
      startedAt: now,
      timeout: null,
      ended: false,
      done: false,
    };
    if (wakeWord !== undefined) session.wakeWord = wakeWord;
    this.sessions.set(sat.id, session);
    session.timeout = this.timers.setTimeout(() => {
      this.abortSession(
        session,
        "timeout",
        `pipeline timed out after ${this.deps.advanced.pipelineTimeoutMs}ms (no transcript)`,
        { alarm: true },
      );
    }, this.deps.advanced.pipelineTimeoutMs);

    // Open the ASR connection in the background; mic chunks buffer in
    // `pending` until it is up, then flush in order.
    session.asrReady = this.deps
      .asrOpen(asr.uri, { language: this.deps.language })
      .then((opened) => {
        if (session.done) {
          opened.abort();
          return null;
        }
        session.asr = opened;
        for (const chunk of session.pending) {
          opened.feed(chunk.audio, chunk.format);
        }
        session.pending = [];
        return opened;
      })
      .catch((err: unknown) => {
        this.abortSession(
          session,
          "asr-error",
          `ASR connection failed: ${err instanceof Error ? err.message : String(err)}`,
          { alarm: true },
        );
        return null;
      });
  }

  /** Mic audio from a satellite in listening/transcribing state. */
  onAudioChunk(sat: PipelineSatellite, chunk: AudioChunkData): void {
    const session = this.sessions.get(sat.id);
    if (session === undefined || session.ended || session.done) return;
    const format: AudioFormat = {
      rate: chunk.rate,
      width: chunk.width,
      channels: chunk.channels,
    };
    if (session.asr !== null) {
      try {
        session.asr.feed(chunk.audio, format);
      } catch (err) {
        this.abortSession(
          session,
          "asr-error",
          `ASR connection lost: ${err instanceof Error ? err.message : String(err)}`,
          { alarm: true },
        );
        return;
      }
    } else {
      session.pending.push({ audio: chunk.audio, format });
    }
    if (session.endpointer.feed(chunk.audio, format) === "end") {
      session.ended = true;
      sat.setState("transcribing");
      void this.finishSession(session);
    }
  }

  /**
   * Urgent announcement enqueued mid-pipeline (spec §2.5): abort the ASR
   * session, silence the satellite (error → no done sound), publish nothing.
   * Calls queue.pipelineDone() so the urgent item plays immediately.
   */
  cancelForUrgent(satelliteId: string): void {
    const session = this.sessions.get(satelliteId);
    if (session === undefined) return;
    this.abortSession(
      session,
      "cancelled",
      "urgent announcement interrupted the pipeline",
    );
  }

  /** Satellite dropped mid-pipeline — clean up without writing to it. */
  onSatelliteGone(satelliteId: string): void {
    const session = this.sessions.get(satelliteId);
    if (session === undefined) return;
    this.abortSession(
      session,
      "disconnected",
      "satellite disconnected mid-pipeline",
      { sendToSatellite: false },
    );
  }

  /** Abort every session silently (plugin stop). */
  stop(): void {
    for (const session of [...this.sessions.values()]) {
      this.settle(session);
      session.asr?.abort();
    }
    this.sessions.clear();
    this.lastDetection.clear();
  }

  // -------------------------------------------------------------------------

  private async finishSession(session: Session): Promise<void> {
    const asr = await session.asrReady; // flushes pending before resolving
    if (session.done || asr === null) return;
    let text: string;
    try {
      // The session watchdog owns the overall deadline (it aborts the ASR
      // connection, which rejects this finish); the finish timeout is only
      // a backstop, so it gets the full budget rather than the remainder.
      ({ text } = await asr.finish(this.deps.advanced.pipelineTimeoutMs));
    } catch (err) {
      this.abortSession(
        session,
        "asr-error",
        `transcription failed: ${err instanceof Error ? err.message : String(err)}`,
        { alarm: true },
      );
      return;
    }
    if (session.done) return;
    this.completeSession(session, text);
  }

  private completeSession(session: Session, text: string): void {
    this.settle(session);
    // The transcript is relayed even when empty — it is what stops the
    // satellite's streaming and triggers its done sound (upstream behavior).
    try {
      session.sat.sendTranscript(text);
    } catch {
      /* connection raced away — reconnect handles it */
    }
    if (text.trim() === "") {
      this.deps.log(
        `pipeline: empty transcript from ${session.sat.id} — voice.command not published`,
      );
    } else {
      const cmd: VoiceCommand = {
        id: randomUUID(),
        text,
        satellite: session.sat.id,
        language: this.deps.language,
        durationMs: Math.round(this.now() - session.startedAt),
      };
      if (session.wakeWord !== undefined) cmd.wakeWord = session.wakeWord;
      this.deps.publishCommand(cmd);
      this.deps.emit("command", cmd);
    }
    if (this.asrAlarmed) {
      this.asrAlarmed = false;
      this.deps.notify("asr", "normal", "speech-to-text recovered");
    }
    this.deps.queueFor(session.sat.id)?.pipelineDone();
  }

  private abortSession(
    session: Session,
    code: string,
    text: string,
    opts: { alarm?: boolean; sendToSatellite?: boolean } = {},
  ): void {
    if (session.done) return;
    this.settle(session);
    session.asr?.abort();
    if (opts.sendToSatellite !== false) {
      // `error` stops the satellite's streaming silently (no done sound) —
      // per DESIGN, used for dedup losers and every pipeline abort.
      this.safeSendError(session.sat, code, text);
    }
    this.deps.emit("error", {
      satellite: session.sat.id,
      code,
      error: text,
    });
    if (opts.alarm === true) this.alarmAsr(text);
    this.deps.log(`pipeline: aborted (${code}) on ${session.sat.id}: ${text}`);
    this.deps.queueFor(session.sat.id)?.pipelineDone();
  }

  /** Mark done, clear the watchdog, drop from the session map. */
  private settle(session: Session): void {
    session.done = true;
    if (session.timeout !== null) {
      this.timers.clearTimeout(session.timeout);
      session.timeout = null;
    }
    this.sessions.delete(session.sat.id);
  }

  private alarmAsr(message: string): void {
    this.asrAlarmed = true;
    this.deps.notify("asr", "alarm", message);
  }

  private safeSendError(
    sat: PipelineSatellite,
    code: string,
    text: string,
  ): void {
    try {
      sat.sendError(code, text);
    } catch {
      /* connection raced away */
    }
  }
}
