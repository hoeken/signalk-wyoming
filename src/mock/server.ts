/**
 * MockWyomingServer — a scriptable Wyoming TCP server for tests.
 *
 * Roles imitate the upstream services the orchestrator talks to:
 * - `asr`: wyoming-faster-whisper (transcribe/audio-* → transcript)
 * - `tts`: wyoming-piper (synthesize → audio-start/chunk/stop)
 * - `wake`: wyoming-openwakeword (detect/audio-* → detection/not-detected)
 * - `satellite`: rhasspy/wyoming-satellite v1.4.1 wake mode, including its
 *   single-client claim semantics, detection → run-pipeline → mic streaming,
 *   TTS playback → `played`, and ping/pong keepalive behavior.
 * - `custom`: describe/info + logging only; script with `send()`.
 *
 * Zero external dependencies (node:net + the protocol module only).
 */

import net from "node:net";
import {
  AudioChunk,
  AudioStart,
  AudioStop,
  Detection,
  ErrorEvent,
  InfoEvent,
  NotDetected,
  parseDetect,
  parsePing,
  parseSynthesize,
  pcmDurationMs,
  Ping,
  Played,
  Pong,
  RunPipeline,
  Transcript,
  type AudioFormat,
  type Info,
  type WyomingEvent,
} from "../protocol/events.js";
import {
  encodeEvent,
  EventDecoder,
  FramingError,
} from "../protocol/framing.js";

export type MockRole = "asr" | "tts" | "wake" | "satellite" | "custom";

export interface MockLogEntry {
  /** Connection id (1-based, per server). */
  conn: number;
  event: WyomingEvent;
  /** Date.now() at receipt. */
  at: number;
}

export interface MockWyomingServerOptions {
  role?: MockRole;
  /** Merged (shallow) over the role's canned `info` response. */
  info?: Partial<Info>;
  /** Delay before any scripted response is written. */
  responseDelayMs?: number;
  /** Destroy incoming sockets immediately. */
  refuseConnections?: boolean;
  /** Record received events but never answer (hung service). */
  hang?: boolean;

  // --- asr ---
  /** Transcript texts returned in order; falls back to "test transcript". */
  transcripts?: string[];

  // --- tts ---
  /** Format announced in audio-start. Default { rate: 22050, width: 2, channels: 1 }. */
  ttsFormat?: AudioFormat;
  /** PCM chunks streamed per synthesize. Default: 4 × 2048-byte deterministic ramp. */
  ttsChunks?: Buffer[];
  /** Synthesize with this voice name gets an `error` event instead of audio. */
  unknownVoice?: string;

  // --- wake ---
  /** Name sent in scripted/automatic detections. Default "okay_nabu". */
  detectionName?: string;
  /** Auto-send a detection after this many ms of received audio. */
  detectAfterAudioMs?: number;

  // --- satellite ---
  satelliteName?: string;
  /** Mic stream format. Default { rate: 16000, width: 2, channels: 1 }. */
  micFormat?: AudioFormat;
  /** snd_format sent in run-pipeline. Default { rate: 22050, width: 2, channels: 1 }. */
  sndFormat?: AudioFormat;
  /** Bytes per streamed mic chunk. Default 2048. */
  streamChunkBytes?: number;
  /** Interval between streamed mic chunks. Default 10 ms. */
  streamChunkIntervalMs?: number;
  /** Max chunks streamed per wake; default unlimited (until told to stop). */
  streamChunkCount?: number;
  /** PCM pattern for streamed chunks; default deterministic ramp. */
  streamPcm?: Buffer;
  /** Delay between receiving audio-stop and sending `played`. Default 0. */
  playedDelayMs?: number;
  /**
   * When set, mirrors upstream keepalive: after the server pings once, the
   * satellite pings the server at this interval and expects a pong within
   * `pongTimeoutMs`, clearing its claim (and dropping the connection) on
   * timeout. Upstream uses 2000/5000 ms.
   */
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
}

interface Conn {
  id: number;
  socket: net.Socket;
  decoder: EventDecoder;
  eventCount: number;
  // asr
  audioBytes: number;
  // wake
  detectNames?: string[];
  audioMs: number;
  wakeFired: boolean;
}

type DropRule = number | ((event: WyomingEvent, conn: number) => boolean);

interface LogWatcher {
  predicate: (entry: MockLogEntry) => boolean;
  resolve: (entry: MockLogEntry) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_MIC_FORMAT: AudioFormat = { rate: 16000, width: 2, channels: 1 };
const DEFAULT_SND_FORMAT: AudioFormat = { rate: 22050, width: 2, channels: 1 };

/** Deterministic PCM ramp: byte i of chunk c is (c * length + i) % 256. */
export function pcmRamp(length: number, chunkIndex = 0): Buffer {
  const buf = Buffer.alloc(length);
  for (let i = 0; i < length; i++) buf[i] = (chunkIndex * length + i) % 256;
  return buf;
}

export class MockWyomingServer {
  readonly role: MockRole;
  readonly log: MockLogEntry[] = [];
  responseDelayMs: number;
  refuseConnections: boolean;
  hang: boolean;

  private readonly options: MockWyomingServerOptions;
  private readonly server: net.Server;
  private readonly conns = new Map<number, Conn>();
  private readonly watchers = new Set<LogWatcher>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly transcriptQueue: string[];
  private nextConnId = 1;
  private listening = false;
  private dropRule: DropRule | null = null;

  // satellite state
  private serverId: number | null = null;
  private streamTimer: NodeJS.Timeout | null = null;
  private streamedChunks = 0;
  private streamedMs = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;

  constructor(options: MockWyomingServerOptions = {}) {
    this.options = options;
    this.role = options.role ?? "custom";
    this.responseDelayMs = options.responseDelayMs ?? 0;
    this.refuseConnections = options.refuseConnections ?? false;
    this.hang = options.hang ?? false;
    this.transcriptQueue = [...(options.transcripts ?? [])];
    this.server = net.createServer((socket) => this.onConnection(socket));
  }

  /** Start listening on 127.0.0.1 (ephemeral port). Resolves with the port. */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.listening = true;
        resolve(this.port);
      });
    });
  }

  get port(): number {
    const addr = this.server.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("server is not listening");
    }
    return addr.port;
  }

  /** Ids of currently open connections. */
  get connections(): number[] {
    return [...this.conns.keys()];
  }

  /** Connection id currently claiming the satellite (satellite role). */
  get claimedBy(): number | null {
    return this.serverId;
  }

  async close(): Promise<void> {
    this.stopStreaming();
    this.stopPingLoop();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const watcher of this.watchers) clearTimeout(watcher.timer);
    this.watchers.clear();
    for (const conn of this.conns.values()) conn.socket.destroy();
    this.conns.clear();
    if (!this.listening) return;
    this.listening = false;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // -------------------------------------------------------------------------
  // Scripting hooks
  // -------------------------------------------------------------------------

  /**
   * Drop connections after `rule` events (per connection) or whenever the
   * predicate returns true for a received event.
   */
  dropConnectionAfter(rule: DropRule): void {
    this.dropRule = rule;
  }

  /** Write bytes that are not a valid Wyoming frame (malformed header). */
  sendMalformedHeader(connId?: number): void {
    this.sendRaw(Buffer.from("this is not json\n", "utf8"), connId);
  }

  /** Write raw bytes to one/all connections (for wire-level fault injection). */
  sendRaw(bytes: Buffer, connId?: number): void {
    for (const conn of this.targets(connId)) conn.socket.write(bytes);
  }

  /** Send an event to one/all connections. */
  send(event: WyomingEvent, connId?: number): void {
    for (const conn of this.targets(connId)) this.write(conn, event);
  }

  /**
   * Resolve when a received event matches `predicate` (existing log entries
   * from `opts.from` on are checked first). Rejects on timeout.
   */
  waitForEvent(
    predicate: (entry: MockLogEntry) => boolean,
    opts: { timeoutMs?: number; from?: number } = {},
  ): Promise<MockLogEntry> {
    const from = opts.from ?? 0;
    for (let i = from; i < this.log.length; i++) {
      const entry = this.log[i] as MockLogEntry;
      if (predicate(entry)) return Promise.resolve(entry);
    }
    const timeoutMs = opts.timeoutMs ?? 2000;
    return new Promise((resolve, reject) => {
      const watcher: LogWatcher = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          this.watchers.delete(watcher);
          reject(new Error(`timed out after ${timeoutMs}ms waiting for event`));
        }, timeoutMs),
      };
      this.watchers.add(watcher);
    });
  }

  /** Wake role: send a `detection` to every open connection. */
  injectDetection(name?: string): void {
    const detection = Detection({
      name: name ?? this.options.detectionName ?? "okay_nabu",
      timestamp: 0,
    });
    this.send(detection);
  }

  /**
   * Satellite role: simulate hearing a wake word — sends `detection` then
   * `run-pipeline{asr→tts}` to the claiming server, then streams mic
   * audio-chunks until `stopStreaming()` / a `transcript` / an `error`
   * arrives (or the configured chunk count runs out).
   */
  wake(name: string): void {
    if (this.role !== "satellite") {
      throw new Error("wake() is only available in the satellite role");
    }
    const conn =
      this.serverId !== null ? this.conns.get(this.serverId) : undefined;
    if (conn === undefined) {
      throw new Error("no server has claimed the satellite");
    }
    this.write(conn, Detection({ name, timestamp: 0 }));
    this.write(
      conn,
      RunPipeline({
        startStage: "asr",
        endStage: "tts",
        restartOnEnd: false,
        wakeWordName: name,
        sndFormat: this.options.sndFormat ?? DEFAULT_SND_FORMAT,
      }),
    );
    this.startStreaming(conn);
  }

  /** Satellite role: stop the mic audio-chunk stream. */
  stopStreaming(): void {
    if (this.streamTimer !== null) {
      clearInterval(this.streamTimer);
      this.streamTimer = null;
    }
  }

  /** True while the satellite is streaming mic audio. */
  get streaming(): boolean {
    return this.streamTimer !== null;
  }

  // -------------------------------------------------------------------------
  // Connection plumbing
  // -------------------------------------------------------------------------

  private onConnection(socket: net.Socket): void {
    if (this.refuseConnections) {
      socket.destroy();
      return;
    }
    const conn: Conn = {
      id: this.nextConnId++,
      socket,
      decoder: new EventDecoder(),
      eventCount: 0,
      audioBytes: 0,
      audioMs: 0,
      wakeFired: false,
    };
    this.conns.set(conn.id, conn);
    socket.on("data", (chunk) => {
      let events: WyomingEvent[];
      try {
        events = conn.decoder.feed(chunk);
      } catch (err) {
        if (err instanceof FramingError) {
          socket.destroy();
          return;
        }
        throw err;
      }
      for (const event of events) this.handleEvent(conn, event);
    });
    socket.on("error", () => {
      /* RST from dropped clients is expected in tests */
    });
    socket.on("close", () => {
      this.conns.delete(conn.id);
      if (this.serverId === conn.id) this.clearClaim();
    });
  }

  private targets(connId?: number): Conn[] {
    if (connId !== undefined) {
      const conn = this.conns.get(connId);
      return conn === undefined ? [] : [conn];
    }
    return [...this.conns.values()];
  }

  private write(conn: Conn, event: WyomingEvent): void {
    if (conn.socket.destroyed) return;
    conn.socket.write(encodeEvent(event));
  }

  /** Write scripted responses, honoring responseDelayMs. */
  private respond(conn: Conn, events: WyomingEvent[]): void {
    if (this.responseDelayMs <= 0) {
      for (const event of events) this.write(conn, event);
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      for (const event of events) this.write(conn, event);
    }, this.responseDelayMs);
    this.timers.add(timer);
  }

  private pushLog(entry: MockLogEntry): void {
    this.log.push(entry);
    for (const watcher of this.watchers) {
      if (watcher.predicate(entry)) {
        clearTimeout(watcher.timer);
        this.watchers.delete(watcher);
        watcher.resolve(entry);
      }
    }
  }

  private shouldDrop(conn: Conn, event: WyomingEvent): boolean {
    if (this.dropRule === null) return false;
    if (typeof this.dropRule === "number") {
      return conn.eventCount >= this.dropRule;
    }
    return this.dropRule(event, conn.id);
  }

  private handleEvent(conn: Conn, event: WyomingEvent): void {
    conn.eventCount++;
    this.pushLog({ conn: conn.id, event, at: Date.now() });
    if (this.shouldDrop(conn, event)) {
      conn.socket.destroy();
      return;
    }
    if (this.hang) return;
    // describe is answered on every connection and never claims (upstream
    // satellite behavior; harmless for the service roles too).
    if (event.type === "describe") {
      this.respond(conn, [InfoEvent(this.buildInfo())]);
      return;
    }
    switch (this.role) {
      case "asr":
        this.handleAsr(conn, event);
        break;
      case "tts":
        this.handleTts(conn, event);
        break;
      case "wake":
        this.handleWake(conn, event);
        break;
      case "satellite":
        this.handleSatellite(conn, event);
        break;
      case "custom":
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Roles
  // -------------------------------------------------------------------------

  private handleAsr(conn: Conn, event: WyomingEvent): void {
    switch (event.type) {
      case "transcribe":
      case "audio-start":
        conn.audioBytes = 0;
        break;
      case "audio-chunk":
        conn.audioBytes += event.payload?.length ?? 0;
        break;
      case "audio-stop": {
        const text =
          conn.audioBytes === 0
            ? ""
            : (this.transcriptQueue.shift() ?? "test transcript");
        this.respond(conn, [Transcript(text)]);
        conn.audioBytes = 0;
        break;
      }
    }
  }

  private handleTts(conn: Conn, event: WyomingEvent): void {
    const synthesize = parseSynthesize(event);
    if (synthesize === undefined) return;
    if (
      this.options.unknownVoice !== undefined &&
      synthesize.voice?.name === this.options.unknownVoice
    ) {
      this.respond(conn, [
        ErrorEvent(`unknown voice: ${synthesize.voice.name}`, "unknown-voice"),
      ]);
      return;
    }
    const format = this.options.ttsFormat ?? DEFAULT_SND_FORMAT;
    const chunks =
      this.options.ttsChunks ?? [0, 1, 2, 3].map((i) => pcmRamp(2048, i));
    this.respond(conn, [
      AudioStart(format),
      ...chunks.map((pcm) => AudioChunk(format, pcm)),
      AudioStop(),
    ]);
  }

  private handleWake(conn: Conn, event: WyomingEvent): void {
    switch (event.type) {
      case "detect": {
        const detect = parseDetect(event);
        conn.detectNames = detect?.names;
        break;
      }
      case "audio-start":
        conn.audioMs = 0;
        conn.wakeFired = false;
        break;
      case "audio-chunk": {
        const data = event.data ?? {};
        const format: AudioFormat = {
          rate: typeof data.rate === "number" ? data.rate : 16000,
          width: typeof data.width === "number" ? data.width : 2,
          channels: typeof data.channels === "number" ? data.channels : 1,
        };
        conn.audioMs += pcmDurationMs(event.payload?.length ?? 0, format);
        const after = this.options.detectAfterAudioMs;
        if (after !== undefined && !conn.wakeFired && conn.audioMs >= after) {
          conn.wakeFired = true;
          this.respond(conn, [
            Detection({
              name:
                this.options.detectionName ??
                conn.detectNames?.[0] ??
                "okay_nabu",
              timestamp: Math.round(conn.audioMs),
            }),
          ]);
        }
        break;
      }
      case "audio-stop":
        if (!conn.wakeFired) this.respond(conn, [NotDetected()]);
        break;
    }
  }

  private handleSatellite(conn: Conn, event: WyomingEvent): void {
    // Single-client claim (upstream event_handler.py): first non-describe
    // event claims; other connections' non-describe events close their socket
    // with no error event.
    if (this.serverId === null) {
      this.serverId = conn.id;
    } else if (this.serverId !== conn.id) {
      conn.socket.destroy();
      return;
    }
    switch (event.type) {
      case "run-satellite":
      case "pause-satellite":
      case "transcript":
      case "error":
        // Upstream stops mic streaming on all four.
        this.stopStreaming();
        break;
      case "audio-stop": {
        // End of TTS playback: acknowledge with `played` (v1.4.1 behavior).
        const delay = this.options.playedDelayMs ?? 0;
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          this.write(conn, Played());
        }, delay);
        this.timers.add(timer);
        break;
      }
      case "ping": {
        const ping = parsePing(event);
        this.respond(conn, [Pong(ping?.text)]);
        // Upstream: the first server ping enables the satellite's own ping
        // loop toward the server.
        if (
          this.options.pingIntervalMs !== undefined &&
          this.pingTimer === null
        ) {
          this.startPingLoop(conn.id);
        }
        break;
      }
      case "pong":
        if (this.pongTimer !== null) {
          clearTimeout(this.pongTimer);
          this.timers.delete(this.pongTimer);
          this.pongTimer = null;
        }
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Satellite internals
  // -------------------------------------------------------------------------

  private startStreaming(conn: Conn): void {
    this.stopStreaming();
    this.streamedChunks = 0;
    this.streamedMs = 0;
    const format = this.options.micFormat ?? DEFAULT_MIC_FORMAT;
    const chunkBytes = this.options.streamChunkBytes ?? 2048;
    const intervalMs = this.options.streamChunkIntervalMs ?? 10;
    const maxChunks = this.options.streamChunkCount ?? Infinity;
    this.streamTimer = setInterval(() => {
      if (
        conn.socket.destroyed ||
        this.serverId !== conn.id ||
        this.streamedChunks >= maxChunks
      ) {
        this.stopStreaming();
        return;
      }
      const pcm =
        this.options.streamPcm ?? pcmRamp(chunkBytes, this.streamedChunks);
      this.write(conn, AudioChunk(format, pcm, Math.round(this.streamedMs)));
      this.streamedChunks++;
      this.streamedMs += pcmDurationMs(pcm.length, format);
    }, intervalMs);
  }

  private startPingLoop(connId: number): void {
    const intervalMs = this.options.pingIntervalMs ?? 2000;
    const pongTimeoutMs = this.options.pongTimeoutMs ?? 5000;
    this.pingTimer = setInterval(() => {
      const conn = this.conns.get(connId);
      if (conn === undefined || this.serverId !== connId) {
        this.stopPingLoop();
        return;
      }
      this.write(conn, Ping());
      if (this.pongTimer === null) {
        this.pongTimer = setTimeout(() => {
          // Upstream: pong timeout ⇒ connection considered dead, claim cleared.
          this.pongTimer = null;
          this.stopPingLoop();
          conn.socket.destroy();
          this.clearClaim();
        }, pongTimeoutMs);
        this.timers.add(this.pongTimer);
      }
    }, intervalMs);
  }

  private stopPingLoop(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer !== null) {
      clearTimeout(this.pongTimer);
      this.timers.delete(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private clearClaim(): void {
    this.serverId = null;
    this.stopStreaming();
    this.stopPingLoop();
  }

  // -------------------------------------------------------------------------
  // Canned info
  // -------------------------------------------------------------------------

  private buildInfo(): Info {
    const attribution = {
      name: "signalk-wyoming mock",
      url: "https://github.com/hoeken/signalk-wyoming",
    };
    const artifact = {
      attribution,
      installed: true,
      description: null,
      version: "0.1.0",
    };
    const info: Info = {
      asr: [],
      tts: [],
      handle: [],
      intent: [],
      wake: [],
      mic: [],
      snd: [],
    };
    switch (this.role) {
      case "asr":
        info.asr = [
          {
            name: "mock-whisper",
            ...artifact,
            models: [
              {
                name: "tiny-int8",
                ...artifact,
                languages: ["en"],
              },
            ],
            supports_transcript_streaming: false,
            requires_external_vad: true,
            prefers_auto_gain_enabled: true,
            prefers_noise_reduction_enabled: true,
          },
        ];
        break;
      case "tts":
        info.tts = [
          {
            name: "mock-piper",
            ...artifact,
            voices: [
              {
                name: "en_US-lessac-medium",
                ...artifact,
                languages: ["en_US"],
                speakers: null,
              },
            ],
            supports_synthesize_streaming: false,
          },
        ];
        break;
      case "wake":
        info.wake = [
          {
            name: "mock-openwakeword",
            ...artifact,
            models: [
              {
                name: this.options.detectionName ?? "okay_nabu",
                ...artifact,
                languages: ["en"],
                phrase: "okay nabu",
              },
            ],
          },
        ];
        break;
      case "satellite":
        info.satellite = {
          name: this.options.satelliteName ?? "mock-satellite",
          ...artifact,
          area: null,
          has_vad: false,
          active_wake_words: ["okay_nabu"],
          max_active_wake_words: 1,
          supports_trigger: false,
        };
        break;
      case "custom":
        break;
    }
    return { ...info, ...this.options.info };
  }
}
