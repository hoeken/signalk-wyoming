/**
 * EventHub — orchestrator activity ring buffer + Server-Sent-Events fan-out.
 *
 * GET /api/log returns the ring buffer (last 200 events); GET /api/events
 * streams new events as SSE with a heartbeat comment every 15s.
 */

import { defaultTimers, type TimerApi } from "./types.js";

export type HubEventKind =
  "state" | "command" | "announcement" | "detection" | "service" | "error";

export interface HubEvent {
  at: number;
  kind: HubEventKind;
  data: unknown;
}

/** Minimal response surface (express Response satisfies it). */
export interface SseResponse {
  writeHead(statusCode: number, headers: Record<string, string>): unknown;
  write(chunk: string): unknown;
  end?: () => unknown;
}

export interface SseRequest {
  on(event: "close", listener: () => void): unknown;
}

export interface EventHubOptions {
  capacity?: number;
  heartbeatMs?: number;
  timers?: TimerApi;
  now?: () => number;
}

export class EventHub {
  private readonly capacity: number;
  private readonly heartbeatMs: number;
  private readonly timers: TimerApi;
  private readonly now: () => number;
  private readonly buffer: HubEvent[] = [];
  private readonly clients = new Set<SseResponse>();
  private heartbeatTimer: unknown = null;
  private closed = false;

  constructor(options: EventHubOptions = {}) {
    this.capacity = options.capacity ?? 200;
    this.heartbeatMs = options.heartbeatMs ?? 15000;
    this.timers = options.timers ?? defaultTimers;
    this.now = options.now ?? Date.now;
  }

  /** Record an event and push it to every SSE subscriber. */
  emit(kind: HubEventKind, data: unknown): void {
    if (this.closed) return;
    const event: HubEvent = { at: this.now(), kind, data };
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
    const frame = formatSse(event);
    for (const client of this.clients) {
      this.safeWrite(client, frame);
    }
  }

  /** Snapshot of the ring buffer (oldest first). */
  ring(): HubEvent[] {
    return [...this.buffer];
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Attach an SSE subscriber; detaches automatically when the request closes. */
  addClient(req: SseRequest, res: SseResponse): void {
    if (this.closed) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end?.();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    this.safeWrite(res, ": connected\n\n");
    this.clients.add(res);
    if (this.heartbeatTimer === null) {
      this.heartbeatTimer = this.timers.setInterval(() => {
        for (const client of this.clients) {
          this.safeWrite(client, ": heartbeat\n\n");
        }
      }, this.heartbeatMs);
    }
    req.on("close", () => this.removeClient(res));
  }

  /** End all SSE streams and stop the heartbeat (plugin stop). */
  close(): void {
    this.closed = true;
    if (this.heartbeatTimer !== null) {
      this.timers.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const client of this.clients) {
      try {
        client.end?.();
      } catch {
        /* already gone */
      }
    }
    this.clients.clear();
  }

  private removeClient(res: SseResponse): void {
    this.clients.delete(res);
    if (this.clients.size === 0 && this.heartbeatTimer !== null) {
      this.timers.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private safeWrite(client: SseResponse, chunk: string): void {
    try {
      client.write(chunk);
    } catch {
      this.removeClient(client);
    }
  }
}

function formatSse(event: HubEvent): string {
  return `event: ${event.kind}\ndata: ${JSON.stringify({ at: event.at, data: event.data })}\n\n`;
}
