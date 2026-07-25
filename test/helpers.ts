import { WyomingConnection } from "../src/protocol/client.js";
import type { WyomingEvent } from "../src/protocol/events.js";
import {
  MockWyomingServer,
  type MockWyomingServerOptions,
} from "../src/mock/server.js";

/** Poll `cond` until true or `timeoutMs` elapses (rejects on timeout). */
export async function until(
  cond: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("until(): condition timed out");
    await sleep(5);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Collect the next `n` events from a connection. */
export async function collectN(
  conn: WyomingConnection,
  n: number,
  timeoutMs = 2000,
): Promise<WyomingEvent[]> {
  const events: WyomingEvent[] = [];
  for (let i = 0; i < n; i++) events.push(await conn.nextEvent(timeoutMs));
  return events;
}

/** Start a mock server and open a client connection to it. */
export async function serverAndClient(
  options: MockWyomingServerOptions,
): Promise<{ server: MockWyomingServer; conn: WyomingConnection }> {
  const server = new MockWyomingServer(options);
  await server.listen();
  const conn = await WyomingConnection.connect("127.0.0.1", server.port);
  // The client's connect event can fire before the server's accept callback
  // (seen on macOS CI) — a server→client send would then reach zero
  // connections and vanish. Wait until the server has registered the conn.
  await until(() => server.connections.length > 0);
  return { server, conn };
}

export function onceClosed(conn: WyomingConnection): Promise<void> {
  if (conn.closed) return Promise.resolve();
  return new Promise((resolve) => conn.once("close", () => resolve()));
}
