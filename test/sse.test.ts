import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventHub, type SseResponse } from "../src/events.js";

function makeRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    written: [] as string[],
    ended: false,
    writeHead(code: number, headers: Record<string, string>) {
      res.statusCode = code;
      Object.assign(res.headers, headers);
    },
    write(chunk: string) {
      res.written.push(chunk);
    },
    end() {
      res.ended = true;
    },
  };
  return res;
}

function makeReq() {
  const listeners: (() => void)[] = [];
  return {
    on: (_event: "close", listener: () => void) => listeners.push(listener),
    close: () => listeners.forEach((l) => l()),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EventHub ring buffer", () => {
  it("records events with timestamps and kinds", () => {
    const hub = new EventHub({ now: () => 42 });
    hub.emit("state", { satellite: "a" });
    expect(hub.ring()).toEqual([
      { at: 42, kind: "state", data: { satellite: "a" } },
    ]);
  });

  it("caps the buffer (default 200, oldest dropped)", () => {
    const hub = new EventHub();
    for (let i = 0; i < 230; i++) hub.emit("state", i);
    const ring = hub.ring();
    expect(ring).toHaveLength(200);
    expect(ring[0]?.data).toBe(30);
    expect(ring[199]?.data).toBe(229);
  });

  it("honors a custom capacity", () => {
    const hub = new EventHub({ capacity: 3 });
    for (let i = 0; i < 5; i++) hub.emit("error", i);
    expect(hub.ring().map((e) => e.data)).toEqual([2, 3, 4]);
  });
});

describe("EventHub SSE", () => {
  it("streams events to subscribers in SSE format", () => {
    const hub = new EventHub({ now: () => 7 });
    const req = makeReq();
    const res = makeRes();
    hub.addClient(req, res as SseResponse);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/event-stream");
    expect(res.written[0]).toBe(": connected\n\n");
    hub.emit("detection", { name: "okay_nabu" });
    expect(res.written[1]).toBe(
      `event: detection\ndata: {"at":7,"data":{"name":"okay_nabu"}}\n\n`,
    );
  });

  it("sends heartbeat comments every 15s", () => {
    const hub = new EventHub();
    const req = makeReq();
    const res = makeRes();
    hub.addClient(req, res as SseResponse);
    vi.advanceTimersByTime(15000);
    expect(res.written).toContain(": heartbeat\n\n");
    vi.advanceTimersByTime(15000);
    expect(res.written.filter((w) => w === ": heartbeat\n\n")).toHaveLength(2);
  });

  it("cleans up on request close (heartbeat stops with no clients)", () => {
    const hub = new EventHub();
    const req = makeReq();
    const res = makeRes();
    hub.addClient(req, res as SseResponse);
    expect(hub.clientCount).toBe(1);
    req.close();
    expect(hub.clientCount).toBe(0);
    vi.advanceTimersByTime(60000);
    expect(res.written.filter((w) => w === ": heartbeat\n\n")).toHaveLength(0);
    hub.emit("state", 1); // no throw, no write to a removed client
    expect(res.written).toHaveLength(1);
  });

  it("drops clients whose write throws", () => {
    const hub = new EventHub();
    const req = makeReq();
    const res = makeRes();
    let fail = false;
    const flaky = {
      ...res,
      writeHead: res.writeHead,
      write(chunk: string) {
        if (fail) throw new Error("EPIPE");
        res.written.push(chunk);
      },
      end: res.end,
    };
    hub.addClient(req, flaky as SseResponse);
    fail = true;
    hub.emit("state", 1);
    expect(hub.clientCount).toBe(0);
  });

  it("close() ends clients and refuses new ones", () => {
    const hub = new EventHub();
    const req = makeReq();
    const res = makeRes();
    hub.addClient(req, res as SseResponse);
    hub.close();
    expect(res.ended).toBe(true);
    expect(hub.clientCount).toBe(0);
    const res2 = makeRes();
    hub.addClient(makeReq(), res2 as SseResponse);
    expect(res2.statusCode).toBe(503);
    hub.emit("state", 1);
    expect(hub.ring()).toHaveLength(0);
  });
});
