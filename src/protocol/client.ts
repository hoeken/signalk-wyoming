/**
 * Thin Wyoming TCP client over node:net.
 *
 * `WyomingConnection` is deliberately dumb: no reconnect logic (that lives in
 * the orchestrator's satellite layer), no request/response correlation — just
 * connect, write events, consume decoded events via `on("event")`, the async
 * iterator, or `nextEvent()`.
 *
 * Incoming events are buffered internally until consumed by `nextEvent()` or
 * the async iterator, so a consumer set up after `connect()` never misses an
 * event. Long-lived connections should therefore consume events (or `close()`)
 * rather than rely on `on("event")` alone.
 */

import { EventEmitter } from "node:events";
import net from "node:net";
import { Describe, parseInfo, type Info, type WyomingEvent } from "./events.js";
import { encodeEvent, EventDecoder } from "./framing.js";

export interface ConnectOptions {
  /** Applies to connect (and, for `describe`, to awaiting the reply). Default 5000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

interface Waiter {
  deliver(event: WyomingEvent): void;
  closed(error: Error | null): void;
}

/**
 * A single Wyoming TCP connection.
 *
 * Events: `"event"` (WyomingEvent), `"error"` (Error — framing or socket;
 * emitted only when a listener is attached, and always followed by
 * `"close"`), `"close"`.
 */
export class WyomingConnection extends EventEmitter {
  private readonly socket: net.Socket;
  private readonly decoder = new EventDecoder();
  private readonly queue: WyomingEvent[] = [];
  private readonly waiters: Waiter[] = [];
  private closeError: Error | null = null;
  private isClosed = false;

  /** Open a TCP connection to a Wyoming service. */
  static connect(
    host: string,
    port: number,
    opts: ConnectOptions = {},
  ): Promise<WyomingConnection> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`timed out connecting to ${host}:${port}`));
      }, timeoutMs);
      socket.once("error", onError);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.removeListener("error", onError);
        resolve(new WyomingConnection(socket));
      });
      function onError(err: Error) {
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      }
    });
  }

  private constructor(socket: net.Socket) {
    super();
    this.socket = socket;
    socket.on("data", (chunk) => {
      if (this.isClosed || this.closeError !== null) return;
      let events: WyomingEvent[];
      try {
        events = this.decoder.feed(chunk);
      } catch (err) {
        this.failAndClose(err as Error);
        return;
      }
      for (const event of events) this.dispatch(event);
    });
    socket.on("error", (err) => {
      if (this.closeError === null) this.closeError = err;
    });
    socket.on("close", () => this.finish());
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /** Write one event to the wire. Throws if the connection is closed. */
  write(event: WyomingEvent): void {
    if (this.isClosed || this.socket.destroyed) {
      throw new Error("connection is closed");
    }
    this.socket.write(encodeEvent(event));
  }

  /** Close the connection (idempotent). */
  close(): void {
    this.socket.destroy();
  }

  /**
   * Next buffered/incoming event. Rejects on connection error, close, or —
   * when `timeoutMs` is given — timeout.
   */
  nextEvent(timeoutMs?: number): Promise<WyomingEvent> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift() as WyomingEvent);
    }
    if (this.isClosed) {
      return Promise.reject(this.closeError ?? new Error("connection closed"));
    }
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter: Waiter = {
        deliver: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
        closed: (error) => {
          clearTimeout(timer);
          reject(error ?? new Error("connection closed"));
        },
      };
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx !== -1) this.waiters.splice(idx, 1);
          reject(new Error(`timed out after ${timeoutMs}ms waiting for event`));
        }, timeoutMs);
      }
      this.waiters.push(waiter);
    });
  }

  /**
   * Iterate incoming events. Ends when the connection closes cleanly; throws
   * the underlying error on socket/framing failure.
   */
  [Symbol.asyncIterator](): AsyncIterator<WyomingEvent> {
    return {
      next: (): Promise<IteratorResult<WyomingEvent>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({
            value: this.queue.shift() as WyomingEvent,
            done: false,
          });
        }
        if (this.isClosed) {
          if (this.closeError !== null) return Promise.reject(this.closeError);
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve, reject) => {
          this.waiters.push({
            deliver: (event) => resolve({ value: event, done: false }),
            closed: (error) => {
              if (error !== null) reject(error);
              else resolve({ value: undefined, done: true });
            },
          });
        });
      },
    };
  }

  private dispatch(event: WyomingEvent): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter.deliver(event);
    else this.queue.push(event);
    this.emit("event", event);
  }

  private failAndClose(err: Error): void {
    if (this.closeError === null) this.closeError = err;
    this.socket.destroy();
  }

  private finish(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.closed(this.closeError);
    if (this.closeError !== null && this.listenerCount("error") > 0) {
      this.emit("error", this.closeError);
    }
    this.emit("close");
  }
}

/**
 * Connect, send `describe`, await the `info` reply, close. This is the
 * readiness/health probe every service plugin gates on.
 */
export async function describe(
  host: string,
  port: number,
  opts: ConnectOptions = {},
): Promise<Info> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const conn = await WyomingConnection.connect(host, port, { timeoutMs });
  try {
    conn.write(Describe());
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`timed out waiting for info from ${host}:${port}`);
      }
      const event = await conn.nextEvent(remaining);
      const info = parseInfo(event);
      if (info !== undefined) return info;
      // Anything else (unknown event types included) is ignored.
    }
  } finally {
    conn.close();
  }
}

/**
 * Parse a `tcp://host:port` Wyoming URI. Only tcp:// is supported (the
 * reference also accepts unix:// and stdio://, which we do not).
 */
export function parseWyomingUri(uri: string): { host: string; port: number } {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error(`invalid Wyoming URI: ${uri}`);
  }
  if (url.protocol !== "tcp:") {
    throw new Error(
      `unsupported Wyoming URI scheme "${url.protocol}" (expected tcp://host:port): ${uri}`,
    );
  }
  if (url.hostname === "" || url.port === "") {
    throw new Error(`Wyoming URI must be tcp://host:port: ${uri}`);
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    throw new Error(`Wyoming URI must not have a path: ${uri}`);
  }
  // IPv6 hostnames come back bracketed from URL; strip for net.connect.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return { host, port: Number(url.port) };
}

/** Probe a Wyoming service by URI: parse, connect, describe. */
export function probeWyoming(
  uri: string,
  opts: ConnectOptions = {},
): Promise<Info> {
  const { host, port } = parseWyomingUri(uri);
  return describe(host, port, opts);
}
