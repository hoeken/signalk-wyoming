import { randomUUID } from "node:crypto";
import type { ServiceDirectory } from "./discovery.js";
import type {
  AnnouncementItem,
  AnnouncementQueueEvent,
  InterruptionReason,
} from "./queue.js";
import { MAX_SAY_TEXT_CHARS, WAIT_NOT_SUPPORTED_MESSAGE } from "./say.js";
import type { SoundLibrary } from "./sounds.js";
import type { BufferedAudio, Priority, SayResult } from "./types.js";

export type AnnouncementContent =
  | { kind: "speech"; text: string; voice?: string }
  | { kind: "sound"; soundId: string };

export interface AnnouncementRequest {
  requestId?: string;
  content: AnnouncementContent;
  targets?: string[];
  priority?: Priority;
}

export type TargetPlaybackState =
  | "queued"
  | "playing"
  | "played"
  | "suppressed"
  | "cancelled"
  | "interrupted"
  | "failed"
  | "unknown";

export type AnnouncementState =
  | "queued"
  | "playing"
  | "played"
  | "suppressed"
  | "cancelled"
  | "interrupted"
  | "failed"
  | "unknown"
  | "partial";

export interface TargetPlaybackSnapshot {
  state: TargetPlaybackState;
  queuedAt?: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export interface AnnouncementSnapshot {
  id: string;
  requestId?: string;
  content: AnnouncementContent;
  priority: Priority;
  state: AnnouncementState;
  createdAt: number;
  updatedAt: number;
  targets: Record<string, TargetPlaybackSnapshot>;
}

export interface AnnouncementEvent {
  sequence: number;
  at: number;
  announcementId: string;
  satellite?: string;
  state: AnnouncementState;
  targetState?: TargetPlaybackState;
}

export interface AnnouncementApiV1 {
  version: 1;
  announce(request: AnnouncementRequest): Promise<AnnouncementSnapshot>;
  getAnnouncement(id: string): AnnouncementSnapshot | undefined;
  waitForAnnouncement(
    id: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<AnnouncementSnapshot>;
  cancelAnnouncement(id: string): AnnouncementSnapshot | undefined;
  onAnnouncementEvent(listener: (event: AnnouncementEvent) => void): () => void;
}

export interface AnnouncementTarget {
  satellite: { id: string; connected: boolean };
  queue: {
    enqueue(item: AnnouncementItem): number;
    cancel(id: string, reason?: InterruptionReason): boolean;
  };
}

export interface AnnouncementServiceDeps {
  directory: Pick<ServiceDirectory, "get">;
  satellites(): Map<string, AnnouncementTarget>;
  sounds: Pick<SoundLibrary, "get">;
  isMuted(): boolean;
  defaults: { language: string; voice: string };
  log(message: string): void;
  warn?(message: string): void;
  synthesize(
    uri: string,
    text: string,
    voice: string | undefined,
    timeoutMs: number,
  ): Promise<BufferedAudio>;
  synthesisTimeoutMs?: number;
  now?: () => number;
  maxCompleted?: number;
  completedTtlMs?: number;
}

interface AnnouncementRecord extends AnnouncementSnapshot {
  fingerprint: string;
  terminal: boolean;
  waiters: Set<{
    resolve(snapshot: AnnouncementSnapshot): void;
    reject(error: Error): void;
  }>;
}

const terminalTargetStates = new Set<TargetPlaybackState>([
  "played",
  "suppressed",
  "cancelled",
  "interrupted",
  "failed",
  "unknown",
]);

export class AnnouncementService {
  private readonly records = new Map<string, AnnouncementRecord>();
  private readonly requestIds = new Map<string, string>();
  private readonly listeners = new Set<(event: AnnouncementEvent) => void>();
  private readonly now: () => number;
  private sequence = 0;

  constructor(private readonly deps: AnnouncementServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  async announce(request: AnnouncementRequest): Promise<AnnouncementSnapshot> {
    const normalized = this.validateRequest(request);
    const fingerprint = JSON.stringify(normalized);
    if (normalized.requestId) {
      const existingId = this.requestIds.get(normalized.requestId);
      if (existingId) {
        const existing = this.records.get(existingId);
        if (!existing) this.requestIds.delete(normalized.requestId);
        else {
          if (existing.fingerprint !== fingerprint)
            throw new Error("requestId was already used for different content");
          return this.snapshot(existing);
        }
      }
    }

    const satellites = this.deps.satellites();
    if (satellites.size === 0) throw new Error("no satellites configured");
    const targetIds = [
      ...new Set(normalized.targets ?? [...satellites.keys()]),
    ];
    if (targetIds.length === 0) throw new Error("no targets requested");
    const at = this.now();
    const record: AnnouncementRecord = {
      id: randomUUID(),
      ...(normalized.requestId ? { requestId: normalized.requestId } : {}),
      content: normalized.content,
      priority: normalized.priority,
      state: "queued",
      createdAt: at,
      updatedAt: at,
      targets: {},
      fingerprint,
      terminal: false,
      waiters: new Set(),
    };
    this.records.set(record.id, record);
    if (record.requestId) this.requestIds.set(record.requestId, record.id);

    for (const targetId of targetIds) {
      const target = satellites.get(targetId);
      if (!target)
        record.targets[targetId] = {
          state: "failed",
          finishedAt: at,
          error: "unknown satellite",
        };
      else if (!target.satellite.connected)
        record.targets[targetId] = {
          state: "failed",
          finishedAt: at,
          error: "not connected",
        };
      else record.targets[targetId] = { state: "queued" };
    }

    if (this.deps.isMuted() && normalized.priority === "normal") {
      for (const target of Object.values(record.targets)) {
        if (target.state === "queued") {
          target.state = "suppressed";
          target.finishedAt = at;
        }
      }
      this.update(record);
      return this.snapshot(record);
    }

    let audio: BufferedAudio;
    let label: string;
    try {
      if (normalized.content.kind === "speech") {
        const tts = this.deps.directory.get("tts");
        if (!tts)
          throw new Error("TTS unavailable (no tts service discovered)");
        const voice =
          normalized.content.voice?.trim() ||
          this.deps.defaults.voice.trim() ||
          undefined;
        audio = await this.deps.synthesize(
          tts.uri,
          normalized.content.text,
          voice,
          this.deps.synthesisTimeoutMs ?? 15000,
        );
        label = normalized.content.text;
      } else {
        const sound = this.deps.sounds.get(normalized.content.soundId);
        if (!sound)
          throw new Error(`unknown sound "${normalized.content.soundId}"`);
        audio = sound;
        label = `[sound:${normalized.content.soundId}]`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const target of Object.values(record.targets)) {
        if (target.state === "queued") {
          target.state = "failed";
          target.error = message;
          target.finishedAt = this.now();
        }
      }
      this.update(record);
      return this.snapshot(record);
    }

    for (const targetId of targetIds) {
      const status = record.targets[targetId];
      const target = satellites.get(targetId);
      if (!status || status.state !== "queued" || !target) continue;
      try {
        target.queue.enqueue({
          id: record.id,
          audio,
          priority: normalized.priority,
          text: label,
          kind: normalized.content.kind,
          enqueuedAt: this.now(),
        });
        status.queuedAt = this.now();
      } catch (error) {
        status.state = "failed";
        status.error = error instanceof Error ? error.message : String(error);
        status.finishedAt = this.now();
      }
    }
    this.update(record);
    return this.snapshot(record);
  }

  async say(opts: {
    text: string;
    targets?: string[];
    voice?: string;
    priority?: Priority;
    wait?: boolean;
    [key: string]: unknown;
  }): Promise<SayResult> {
    if (
      !opts ||
      typeof opts !== "object" ||
      typeof opts.text !== "string" ||
      opts.text.length === 0
    )
      throw new Error("say: text is required and must be a non-empty string");
    if (opts.wait === true) throw new Error(WAIT_NOT_SUPPORTED_MESSAGE);
    let text = opts.text;
    if (text.length > MAX_SAY_TEXT_CHARS) {
      text = `${text.slice(0, MAX_SAY_TEXT_CHARS - 1)}…`;
      (this.deps.warn ?? this.deps.log)(
        `say: text truncated to ${MAX_SAY_TEXT_CHARS} characters (was ${opts.text.length})`,
      );
    }
    const result = await this.announce({
      content: {
        kind: "speech",
        text,
        ...(opts.voice ? { voice: opts.voice } : {}),
      },
      ...(opts.targets ? { targets: opts.targets } : {}),
      priority: opts.priority === "urgent" ? "urgent" : "normal",
    });
    const queued: string[] = [];
    const errors: { satellite: string; error: string }[] = [];
    let suppressed = false;
    for (const [satellite, target] of Object.entries(result.targets)) {
      if (["queued", "playing", "played"].includes(target.state))
        queued.push(satellite);
      else if (target.state === "suppressed") suppressed = true;
      else errors.push({ satellite, error: target.error ?? target.state });
    }
    if (suppressed && queued.length === 0 && errors.length === 0)
      return { ok: false, queued: [], suppressed: "muted" };
    if (queued.length === 0)
      throw new Error(
        `say: nothing queued — ${errors.map((item) => `${item.satellite}: ${item.error}`).join("; ")}`,
      );
    return {
      ok: errors.length === 0,
      queued,
      ...(errors.length ? { errors } : {}),
    };
  }

  get(id: string): AnnouncementSnapshot | undefined {
    const record = this.records.get(id);
    return record ? this.snapshot(record) : undefined;
  }

  wait(
    id: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<AnnouncementSnapshot> {
    const record = this.records.get(id);
    if (!record) return Promise.reject(new Error("unknown announcement"));
    if (record.terminal) return Promise.resolve(this.snapshot(record));
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = {
        resolve: (snapshot: AnnouncementSnapshot) => {
          cleanup();
          resolve(snapshot);
        },
        reject: (error: Error) => {
          cleanup();
          reject(error);
        },
      };
      const onAbort = () => waiter.reject(new Error("wait aborted"));
      const cleanup = () => {
        record.waiters.delete(waiter);
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      record.waiters.add(waiter);
      if (options.timeoutMs !== undefined)
        timer = setTimeout(
          () => waiter.reject(new Error("announcement wait timed out")),
          options.timeoutMs,
        );
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  cancel(id: string): AnnouncementSnapshot | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    for (const [satellite, target] of Object.entries(record.targets)) {
      if (terminalTargetStates.has(target.state)) continue;
      const queued = this.deps
        .satellites()
        .get(satellite)
        ?.queue.cancel(id, "caller");
      if (!queued) {
        target.state = "cancelled";
        target.finishedAt = this.now();
      }
    }
    this.update(record);
    return this.snapshot(record);
  }

  handleQueueEvent(satellite: string, event: AnnouncementQueueEvent): void {
    const record = this.records.get(event.item.id);
    const target = record?.targets[satellite];
    if (!record || !target || terminalTargetStates.has(target.state)) return;
    const at = this.now();
    if (event.type === "play-start") {
      target.state = "playing";
      target.startedAt = at;
    } else if (event.type === "play-end") {
      // Only Wyoming's `played` ack proves playback. A stream that closed
      // without it (satellites before 1.4.1 never send one) is unknown, not
      // played and not failed.
      if (event.confirmed === false) {
        target.state = "unknown";
        target.error = "satellite did not confirm playback with played";
      } else {
        target.state = "played";
      }
      target.finishedAt = at;
    } else if (event.type === "play-error") {
      target.state =
        /confirm playback|connection lost|connection closed|socket|EPIPE/i.test(
          event.error ?? "",
        )
          ? "unknown"
          : "failed";
      target.error = event.error;
      target.finishedAt = at;
    } else {
      target.state =
        event.reason === "caller"
          ? "cancelled"
          : event.reason === "shutdown"
            ? "unknown"
            : "interrupted";
      target.error = event.error;
      target.finishedAt = at;
    }
    this.update(record, satellite, target.state);
  }

  subscribe(listener: (event: AnnouncementEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    for (const record of this.records.values()) {
      if (record.terminal) continue;
      for (const [satellite, target] of Object.entries(record.targets)) {
        if (terminalTargetStates.has(target.state)) continue;
        this.deps
          .satellites()
          .get(satellite)
          ?.queue.cancel(record.id, "shutdown");
        target.state = "unknown";
        target.error = "signalk-wyoming stopped before playback was confirmed";
        target.finishedAt = this.now();
      }
      this.update(record);
    }
    this.listeners.clear();
  }

  private validateRequest(
    request: AnnouncementRequest,
  ): Required<Pick<AnnouncementRequest, "content" | "priority">> &
    Pick<AnnouncementRequest, "requestId" | "targets"> {
    if (!request || typeof request !== "object" || !request.content)
      throw new Error("announcement content is required");
    if (
      request.requestId !== undefined &&
      (typeof request.requestId !== "string" ||
        request.requestId.length < 1 ||
        request.requestId.length > 128)
    )
      throw new Error("requestId must contain 1 to 128 characters");
    if (
      request.targets !== undefined &&
      (!Array.isArray(request.targets) ||
        request.targets.some((target) => typeof target !== "string" || !target))
    )
      throw new Error("targets must contain non-empty satellite ids");
    let content: AnnouncementContent;
    if (request.content.kind === "speech") {
      if (
        typeof request.content.text !== "string" ||
        request.content.text.length === 0 ||
        request.content.text.length > MAX_SAY_TEXT_CHARS
      )
        throw new Error(
          `speech text must contain 1 to ${MAX_SAY_TEXT_CHARS} characters`,
        );
      content = {
        kind: "speech",
        text: request.content.text,
        ...(request.content.voice ? { voice: request.content.voice } : {}),
      };
    } else if (request.content.kind === "sound") {
      if (
        typeof request.content.soundId !== "string" ||
        request.content.soundId.length === 0
      )
        throw new Error("soundId is required");
      content = { kind: "sound", soundId: request.content.soundId };
    } else throw new Error("content.kind must be speech or sound");
    return {
      ...(request.requestId ? { requestId: request.requestId } : {}),
      content,
      ...(request.targets
        ? { targets: [...new Set(request.targets)].sort() }
        : {}),
      priority: request.priority === "urgent" ? "urgent" : "normal",
    };
  }

  private update(
    record: AnnouncementRecord,
    satellite?: string,
    targetState?: TargetPlaybackState,
  ): void {
    record.updatedAt = this.now();
    const states = Object.values(record.targets).map((target) => target.state);
    const terminal = states.every((state) => terminalTargetStates.has(state));
    record.terminal = terminal;
    if (!terminal)
      record.state = states.includes("playing") ? "playing" : "queued";
    else {
      const unique = new Set(states);
      if (unique.size === 1) record.state = states[0] as AnnouncementState;
      else if (states.includes("played")) record.state = "partial";
      else if (states.includes("unknown")) record.state = "unknown";
      else record.state = "failed";
    }
    const event: AnnouncementEvent = {
      sequence: ++this.sequence,
      at: record.updatedAt,
      announcementId: record.id,
      ...(satellite ? { satellite } : {}),
      state: record.state,
      ...(targetState ? { targetState } : {}),
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.deps.warn?.(
          `announcement listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (record.terminal) {
      const snapshot = this.snapshot(record);
      for (const waiter of [...record.waiters]) waiter.resolve(snapshot);
      this.prune();
    }
  }

  private prune(): void {
    const cutoff = this.now() - (this.deps.completedTtlMs ?? 60 * 60 * 1000);
    const completed = [...this.records.values()]
      .filter((record) => record.terminal)
      .sort((left, right) => left.updatedAt - right.updatedAt);
    const maximum = this.deps.maxCompleted ?? 1000;
    for (let index = 0; index < completed.length; index++) {
      const record = completed[index];
      if (!record) continue;
      if (record.updatedAt >= cutoff && completed.length - index <= maximum)
        break;
      this.records.delete(record.id);
      if (record.requestId) this.requestIds.delete(record.requestId);
    }
  }

  private snapshot(record: AnnouncementRecord): AnnouncementSnapshot {
    return {
      id: record.id,
      ...(record.requestId ? { requestId: record.requestId } : {}),
      content: { ...record.content },
      priority: record.priority,
      state: record.state,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      targets: Object.fromEntries(
        Object.entries(record.targets).map(([id, target]) => [
          id,
          { ...target },
        ]),
      ),
    };
  }
}
