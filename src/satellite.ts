/**
 * RemoteSatellite — the orchestrator's peer to a wyoming-satellite instance
 * (spec §2.2 seam; wyoming-satellite.md §5/§9 contract).
 *
 * - Persistent TCP client with reconnect backoff (immediate first retry, then
 *   1s/2s/5s/10s/30s cap — spec §8 fast-reclaim of the single-client slot).
 * - On connect: `describe` → record `info` → arm with `run-satellite` (wake
 *   mode) or `pause-satellite` (output-only mode).
 *
 *   Output-only via pause-satellite is SOURCE-VERIFIED against upstream
 *   wyoming_satellite/satellite.py @ master (== v1.4.1), fetched 2026-07-25:
 *   `SatelliteBase.event_from_server` routes `audio-start`/`audio-chunk`/
 *   `audio-stop` to `event_to_snd()` unconditionally — the `_is_paused` flag
 *   exists only in Wake/VadStreamingSatellite and only gates `event_from_mic`
 *   (mic chunks dropped, so wake detections/streaming stop while paused).
 *   TTS playback therefore still works while paused, so output-only
 *   satellites get `pause-satellite` (keeping their mic audio off the wire).
 *
 * - Keepalive: inbound `ping` is ALWAYS answered with `pong` (upstream drops
 *   the connection if a pong is >5s late once its ping loop is enabled). We
 *   ping every 15s while idle; a missing pong within 10s destroys the socket
 *   and takes the reconnect path.
 * - play(): frames BufferedAudio as audio-start/chunk/stop, paced at
 *   real-time rate (~4 chunks of lead, never firehosing minutes of audio into
 *   socket buffers); resolves on `played` (v1.4.1+) or a fallback timeout of
 *   audio duration + 5s. Cancellation stops sending chunks but still sends
 *   audio-stop.
 *
 * No pipeline logic here — pipeline lives in wave G's engine.
 */

import {
  AudioChunk,
  AudioStart,
  AudioStop,
  Describe,
  ErrorEvent,
  parseDetection,
  parseInfo,
  parsePing,
  parseRunPipeline,
  parseAudioChunk,
  PauseSatellite,
  pcmDurationMs,
  Ping,
  Pong,
  RunSatellite,
  Transcript,
  type Detection,
  type Info,
  type RunPipeline,
  type WyomingEvent,
  type AudioChunk as AudioChunkData,
} from "./protocol/events.js";
import { WyomingConnection } from "./protocol/client.js";
import {
  bufferedAudioDurationMs,
  defaultTimers,
  type BufferedAudio,
  type SatelliteState,
  type TimerApi,
} from "./types.js";

export type SatelliteMode = "wake" | "output-only";

export interface RemoteSatelliteOptions {
  id: string;
  name: string;
  host: string;
  port: number;
  wakeWords?: string[];
  hasControlApi?: boolean;
  controlPort?: number;
  /** Default: 'wake' when wakeWords non-empty, else 'output-only'. */
  mode?: SatelliteMode;
}

export type SatelliteEvent =
  | { type: "connected" }
  | { type: "disconnected" }
  | { type: "state"; state: SatelliteState }
  | { type: "detection"; detection: Detection }
  | { type: "run-pipeline"; runPipeline: RunPipeline }
  | { type: "audio-chunk"; chunk: AudioChunkData }
  | { type: "played" };

export interface RemoteSatelliteDeps {
  onEvent: (sat: RemoteSatellite, evt: SatelliteEvent) => void;
  log: (msg: string) => void;
  now?: () => number;
  timers?: TimerApi;
  /** Test injection; defaults to WyomingConnection.connect. */
  connect?: (host: string, port: number) => Promise<WyomingConnection>;
  /** Keepalive tuning (defaults 15000 / 10000 ms). */
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  /** Grace after audio duration to wait for `played` (default 5000 ms). */
  playedGraceMs?: number;
  connectTimeoutMs?: number;
  /**
   * Deadline for `info` after the TCP connect (default: connectTimeoutMs,
   * else 5000 ms). A peer that accepts the connection but never answers
   * `describe` (hung container, non-Wyoming listener, network black-hole)
   * would otherwise stall the satellite forever with no reconnect.
   */
  armTimeoutMs?: number;
  /**
   * A connection must survive this long after arming before the reconnect
   * backoff resets (default 5000 ms). The upstream satellite answers
   * `describe` on EVERY connection and only drops the socket when our
   * `run-satellite` arrives while another client holds the single-client
   * claim — so "got info" alone must not count as a healthy connection, or
   * a claim-refused cycle busy-loops at RECONNECT_DELAYS_MS[0] = 0.
   */
  stableConnectionMs?: number;
}

/** Reconnect delays; the last entry repeats (30s cap). */
export const RECONNECT_DELAYS_MS = [0, 1000, 2000, 5000, 10000, 30000];

const PACING_LEAD_CHUNKS = 4;

interface PlaySession {
  cancelled: boolean;
  /** Wakes a pacing sleep early on cancel/disconnect. */
  interrupt: (() => void) | null;
  playedResolve: (() => void) | null;
  disconnected: boolean;
}

export class RemoteSatellite {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly wakeWords: string[];
  readonly hasControlApi: boolean;
  readonly controlPort: number | undefined;
  readonly mode: SatelliteMode;

  state: SatelliteState = "disconnected";
  connected = false;
  /** Latest info response (includes wake models merged by the satellite). */
  satInfo: Info | null = null;

  private readonly deps: RemoteSatelliteDeps;
  private readonly now: () => number;
  private readonly timers: TimerApi;
  private conn: WyomingConnection | null = null;
  private shouldRun = false;
  private backoffIdx = 0;
  private reconnectTimer: unknown = null;
  private armTimer: unknown = null;
  /** now() when the current connection armed (backoff-stability check). */
  private armedAt = 0;
  private pingTimer: unknown = null;
  private pongTimer: unknown = null;
  private pingCounter = 0;
  private play_: PlaySession | null = null;

  constructor(options: RemoteSatelliteOptions, deps: RemoteSatelliteDeps) {
    this.id = options.id;
    this.name = options.name;
    this.host = options.host;
    this.port = options.port;
    this.wakeWords = options.wakeWords ?? [];
    this.hasControlApi = options.hasControlApi ?? false;
    this.controlPort = options.controlPort;
    this.mode =
      options.mode ?? (this.wakeWords.length > 0 ? "wake" : "output-only");
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? defaultTimers;
  }

  /** Start maintaining the connection (idempotent). */
  connect(): void {
    if (this.shouldRun) return;
    this.shouldRun = true;
    this.backoffIdx = 0;
    void this.attempt();
  }

  /** Stop reconnecting and drop the connection. */
  close(): void {
    this.shouldRun = false;
    if (this.reconnectTimer !== null) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearArmTimeout();
    this.stopKeepalive();
    if (this.conn !== null) {
      this.conn.close(); // triggers onDisconnected via close event
    } else {
      this.setDisconnected();
    }
  }

  /** Pipeline engine hook (wave G): externally drive listening/transcribing. */
  setState(state: SatelliteState): void {
    if (this.state === state) return;
    this.state = state;
    this.deps.onEvent(this, { type: "state", state });
  }

  /** Relay a transcript to the satellite — stops its streaming, plays done sound. */
  sendTranscript(text: string): void {
    this.write(Transcript(text));
    if (this.state === "listening" || this.state === "transcribing") {
      this.setState("idle");
    }
  }

  /** Abort the satellite's streaming silently (wake-dedup losers, pipeline aborts). */
  sendError(code: string, text: string): void {
    this.write(ErrorEvent(text, code));
    if (this.state === "listening" || this.state === "transcribing") {
      this.setState("idle");
    }
  }

  /**
   * Frame and send BufferedAudio as a Wyoming audio stream, paced at
   * real-time rate. Resolves when `played` arrives or after audio duration +
   * grace. Rejects if not connected or the connection drops mid-play.
   */
  async play(audio: BufferedAudio): Promise<void> {
    if (!this.connected || this.conn === null) {
      throw new Error("not connected");
    }
    if (this.play_ !== null) {
      throw new Error("already playing");
    }
    const session: PlaySession = {
      cancelled: false,
      interrupt: null,
      playedResolve: null,
      disconnected: false,
    };
    this.play_ = session;
    if (this.state === "idle") this.setState("speaking");
    const { format } = audio;
    const startedAt = this.now();
    let sentMs = 0;
    try {
      this.write(AudioStart(format));
      for (const chunk of audio.chunks) {
        if (session.cancelled) break;
        if (session.disconnected)
          throw new Error("connection lost during playback");
        const chunkMs = pcmDurationMs(chunk.length, format);
        // Pace: stay at most PACING_LEAD_CHUNKS chunk-durations ahead of
        // real time so a cancel drops nearly all unplayed audio.
        const leadMs = chunkMs * PACING_LEAD_CHUNKS;
        const waitMs = sentMs - (this.now() - startedAt) - leadMs;
        if (waitMs > 0) await this.sleep(waitMs, session);
        if (session.cancelled) break;
        if (session.disconnected)
          throw new Error("connection lost during playback");
        this.write(AudioChunk(format, chunk, Math.round(sentMs)));
        sentMs += chunkMs;
      }
      // Always close the stream — also on cancellation (drop remainder only).
      this.write(AudioStop());
      if (!session.cancelled) {
        await this.awaitPlayed(session, audio, startedAt);
      }
    } finally {
      this.play_ = null;
      if (this.state === "speaking") this.setState("idle");
    }
  }

  /** Cancel in-flight playback: remaining chunks are dropped (audio-stop still sent). */
  cancelPlayback(): void {
    const session = this.play_;
    if (session === null) return;
    session.cancelled = true;
    session.interrupt?.();
    session.playedResolve?.();
  }

  // ---------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------

  private async attempt(): Promise<void> {
    if (!this.shouldRun) return;
    this.reconnectTimer = null;
    const connectImpl =
      this.deps.connect ??
      ((host: string, port: number) =>
        WyomingConnection.connect(host, port, {
          timeoutMs: this.deps.connectTimeoutMs ?? 5000,
        }));
    let conn: WyomingConnection;
    try {
      conn = await connectImpl(this.host, this.port);
    } catch (err) {
      if (!this.shouldRun) return;
      this.deps.log(
        `satellite ${this.id}: connect to ${this.host}:${this.port} failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      this.scheduleReconnect();
      return;
    }
    if (!this.shouldRun) {
      conn.close();
      return;
    }
    this.conn = conn;
    try {
      conn.write(Describe());
    } catch {
      conn.close();
    }
    this.startArmTimeout(conn);
    await this.consume(conn);
  }

  /**
   * Watchdog for the connect→info window — the only otherwise-unbounded
   * state (connect has its own timeout; armed connections have the pong
   * timeout). Closing the connection takes the normal reconnect path.
   */
  private startArmTimeout(conn: WyomingConnection): void {
    const armTimeoutMs =
      this.deps.armTimeoutMs ?? this.deps.connectTimeoutMs ?? 5000;
    this.armTimer = this.timers.setTimeout(() => {
      this.armTimer = null;
      if (this.connected || this.conn !== conn) return;
      this.deps.log(
        `satellite ${this.id}: no info within ${armTimeoutMs}ms of connecting — reconnecting`,
      );
      conn.close(); // reconnect path via onDisconnected
    }, armTimeoutMs);
  }

  private clearArmTimeout(): void {
    if (this.armTimer !== null) {
      this.timers.clearTimeout(this.armTimer);
      this.armTimer = null;
    }
  }

  private async consume(conn: WyomingConnection): Promise<void> {
    try {
      for await (const event of conn) {
        this.handleEvent(event);
      }
    } catch (err) {
      this.deps.log(
        `satellite ${this.id}: connection error: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.onDisconnected(conn);
    }
  }

  private handleEvent(event: WyomingEvent): void {
    const ping = parsePing(event);
    if (ping !== undefined) {
      // ALWAYS answer pings — the satellite's own ping loop (armed by our
      // first ping) drops the connection on a >5s pong delay.
      this.safeWrite(Pong(ping.text));
      return;
    }
    if (event.type === "pong") {
      if (this.pongTimer !== null) {
        this.timers.clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
      return;
    }
    const info = parseInfo(event);
    if (info !== undefined) {
      this.satInfo = info;
      if (!this.connected) this.onArmed();
      return;
    }
    const detection = parseDetection(event);
    if (detection !== undefined) {
      this.deps.onEvent(this, { type: "detection", detection });
      return;
    }
    const runPipeline = parseRunPipeline(event);
    if (runPipeline !== undefined) {
      // Only an idle satellite flips to listening here — while `speaking`
      // the pipeline engine decides (barge-in cancels normal playback and
      // sets listening itself; a wake refused during urgent playback must
      // not disturb the speaking state, and its mic chunks stay gated off).
      if (this.state === "idle") this.setState("listening");
      this.deps.onEvent(this, { type: "run-pipeline", runPipeline });
      return;
    }
    const chunk = parseAudioChunk(event);
    if (chunk !== undefined) {
      // Mic audio is only meaningful while a pipeline is active.
      if (this.state === "listening" || this.state === "transcribing") {
        this.deps.onEvent(this, { type: "audio-chunk", chunk });
      }
      return;
    }
    if (event.type === "played") {
      this.play_?.playedResolve?.();
      this.deps.onEvent(this, { type: "played" });
      return;
    }
    // Unknown event types are ignored (forward compatibility).
  }

  /** First info received: claim/arm the satellite and go live. */
  private onArmed(): void {
    this.clearArmTimeout();
    // run-satellite arms the wake flow; pause-satellite keeps mic audio off
    // the wire for output-only satellites (TTS playback verified unaffected —
    // see the class doc comment).
    this.write(this.mode === "output-only" ? PauseSatellite() : RunSatellite());
    this.connected = true;
    // NOT a backoff reset: the claim outcome is unknown until the connection
    // survives — an immediate drop (claim held by another client) must keep
    // ramping the backoff. See onDisconnected.
    this.armedAt = this.now();
    this.deps.onEvent(this, { type: "connected" });
    this.setState("idle");
    this.startKeepalive();
  }

  private onDisconnected(conn: WyomingConnection): void {
    if (this.conn !== conn) return;
    this.conn = null;
    this.clearArmTimeout();
    this.stopKeepalive();
    const session = this.play_;
    if (session !== null) {
      session.disconnected = true;
      session.interrupt?.();
      session.playedResolve?.();
    }
    const wasConnected = this.connected;
    this.connected = false;
    // Backoff resets only after a connection proved stable post-arm; a
    // connect→info→drop cycle (single-client claim held elsewhere) keeps
    // ramping toward the 30s cap instead of busy-looping at delay 0.
    const stableMs = this.deps.stableConnectionMs ?? 5000;
    if (wasConnected && this.now() - this.armedAt >= stableMs) {
      this.backoffIdx = 0;
    }
    this.setDisconnected();
    if (wasConnected) this.deps.onEvent(this, { type: "disconnected" });
    if (this.shouldRun) this.scheduleReconnect();
  }

  private setDisconnected(): void {
    if (this.state !== "disconnected") this.setState("disconnected");
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const idx = Math.min(this.backoffIdx, RECONNECT_DELAYS_MS.length - 1);
    const delay = RECONNECT_DELAYS_MS[idx] as number;
    this.backoffIdx++;
    this.reconnectTimer = this.timers.setTimeout(() => {
      void this.attempt();
    }, delay);
  }

  // ---------------------------------------------------------------------
  // Keepalive
  // ---------------------------------------------------------------------

  private startKeepalive(): void {
    const intervalMs = this.deps.pingIntervalMs ?? 15000;
    const pongTimeoutMs = this.deps.pongTimeoutMs ?? 10000;
    this.pingTimer = this.timers.setInterval(() => {
      if (!this.connected || this.conn === null) return;
      if (this.state !== "idle") return; // only ping when idle
      if (this.pongTimer !== null) return; // previous ping still outstanding
      this.pingCounter++;
      if (!this.safeWrite(Ping(String(this.pingCounter)))) return;
      this.pongTimer = this.timers.setTimeout(() => {
        this.pongTimer = null;
        this.deps.log(
          `satellite ${this.id}: no pong within ${pongTimeoutMs}ms — reconnecting`,
        );
        this.conn?.close(); // reconnect path via onDisconnected
      }, pongTimeoutMs);
    }, intervalMs);
  }

  private stopKeepalive(): void {
    if (this.pingTimer !== null) {
      this.timers.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer !== null) {
      this.timers.clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  private write(event: WyomingEvent): void {
    if (this.conn === null) throw new Error("not connected");
    this.conn.write(event);
  }

  /** Write that tolerates the connection racing away (keepalive paths). */
  private safeWrite(event: WyomingEvent): boolean {
    try {
      this.write(event);
      return true;
    } catch {
      return false;
    }
  }

  /** Interruptible sleep for pacing. */
  private sleep(ms: number, session: PlaySession): Promise<void> {
    return new Promise((resolve) => {
      const timer = this.timers.setTimeout(() => {
        session.interrupt = null;
        resolve();
      }, ms);
      session.interrupt = () => {
        this.timers.clearTimeout(timer);
        session.interrupt = null;
        resolve();
      };
    });
  }

  private awaitPlayed(
    session: PlaySession,
    audio: BufferedAudio,
    startedAt: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const graceMs = this.deps.playedGraceMs ?? 5000;
      const deadline = startedAt + bufferedAudioDurationMs(audio) + graceMs;
      const timer = this.timers.setTimeout(
        () => {
          // Fallback: older/foreign satellites never send `played`.
          session.playedResolve = null;
          resolve();
        },
        Math.max(0, deadline - this.now()),
      );
      session.playedResolve = () => {
        this.timers.clearTimeout(timer);
        session.playedResolve = null;
        if (session.disconnected) {
          reject(new Error("connection lost during playback"));
        } else {
          resolve();
        }
      };
    });
  }
}
