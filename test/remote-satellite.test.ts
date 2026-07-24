import { afterEach, describe, expect, it, vi } from "vitest";
import { MockWyomingServer, pcmRamp } from "../src/mock/server.js";
import { WyomingConnection } from "../src/protocol/client.js";
import { RunSatellite } from "../src/protocol/events.js";
import {
  RECONNECT_DELAYS_MS,
  RemoteSatellite,
  type RemoteSatelliteDeps,
  type SatelliteEvent,
} from "../src/satellite.js";
import type { BufferedAudio, TimerApi } from "../src/types.js";
import { until } from "./helpers.js";

let servers: MockWyomingServer[] = [];
let sats: RemoteSatellite[] = [];

async function startSatelliteServer(
  options: ConstructorParameters<typeof MockWyomingServer>[0] = {},
): Promise<MockWyomingServer> {
  const server = new MockWyomingServer({ role: "satellite", ...options });
  await server.listen();
  servers.push(server);
  return server;
}

function makeSat(
  server: MockWyomingServer,
  opts: { wakeWords?: string[]; mode?: "wake" | "output-only" } = {},
  deps: Partial<RemoteSatelliteDeps> = {},
): { sat: RemoteSatellite; events: SatelliteEvent[] } {
  const events: SatelliteEvent[] = [];
  const sat = new RemoteSatellite(
    {
      id: "s1",
      name: "Test satellite",
      host: "127.0.0.1",
      port: server.port,
      wakeWords: opts.wakeWords,
      mode: opts.mode,
    },
    {
      onEvent: (_sat, evt) => events.push(evt),
      log: () => {},
      ...deps,
    },
  );
  sats.push(sat);
  return { sat, events };
}

function pcm(chunks: number, bytesPerChunk = 320): BufferedAudio {
  // 320 bytes @ 16000 Hz / 16-bit / mono = 10 ms per chunk.
  return {
    format: { rate: 16000, width: 2, channels: 1 },
    chunks: Array.from({ length: chunks }, (_, i) => pcmRamp(bytesPerChunk, i)),
  };
}

afterEach(async () => {
  for (const sat of sats) sat.close();
  sats = [];
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

describe("RemoteSatellite connect + arming", () => {
  it("sends describe then run-satellite (wake mode), records info, claims", async () => {
    const server = await startSatelliteServer();
    const { sat, events } = makeSat(server, { wakeWords: ["okay_nabu"] });
    sat.connect();
    await until(() => sat.connected);
    await until(() => server.claimedBy !== null);
    expect(server.log.map((e) => e.event.type)).toEqual([
      "describe",
      "run-satellite",
    ]);
    expect(sat.satInfo?.satellite?.name).toBe("mock-satellite");
    expect(sat.state).toBe("idle");
    expect(events.map((e) => e.type)).toEqual(["connected", "state"]);
  });

  it("mode defaults: wakeWords → wake, none → output-only (pause-satellite)", async () => {
    const server = await startSatelliteServer();
    const { sat } = makeSat(server); // no wakeWords → output-only
    expect(sat.mode).toBe("output-only");
    sat.connect();
    await until(() => sat.connected);
    await until(() => server.claimedBy !== null);
    // Source-verified: paused satellites still play TTS (SatelliteBase
    // event_from_server routes audio events to snd unconditionally).
    expect(server.log.map((e) => e.event.type)).toEqual([
      "describe",
      "pause-satellite",
    ]);
  });

  it("close() drops the connection and stops reconnecting", async () => {
    const server = await startSatelliteServer();
    const { sat, events } = makeSat(server, { wakeWords: ["okay_nabu"] });
    sat.connect();
    await until(() => sat.connected);
    sat.close();
    await until(() => !sat.connected);
    expect(sat.state).toBe("disconnected");
    expect(events.some((e) => e.type === "disconnected")).toBe(true);
    await until(() => server.claimedBy === null);
  });
});

describe("RemoteSatellite reconnect", () => {
  it("reclaims after the connection drops (immediate first retry)", async () => {
    const server = await startSatelliteServer();
    const { sat, events } = makeSat(
      server,
      { wakeWords: ["okay_nabu"] },
      { pingIntervalMs: 10, pongTimeoutMs: 500 },
    );
    sat.connect();
    await until(() => sat.connected);
    // Drop the connection on the next ping, once.
    let dropped = false;
    server.dropConnectionAfter((event) => {
      if (event.type === "ping" && !dropped) {
        dropped = true;
        return true;
      }
      return false;
    });
    // The immediate first retry reconnects faster than a poll of
    // sat.connected can observe the gap — watch the recorded event instead.
    await until(() => events.some((e) => e.type === "disconnected"), 5000);
    // Immediate first retry → reclaim (the claim lands when the mock
    // processes our run-satellite, a beat after sat.connected flips).
    await until(() => sat.connected, 5000);
    await until(() => server.claimedBy !== null, 5000);
  });

  it("ramps backoff 0/1s/2s/5s/10s/30s (cap) while connects fail", async () => {
    const delays: number[] = [];
    const pending: (() => void)[] = [];
    const timers: TimerApi = {
      setTimeout: (fn, ms) => {
        delays.push(ms);
        pending.push(fn);
        return {};
      },
      clearTimeout: () => {},
      setInterval: () => ({}),
      clearInterval: () => {},
    };
    const sat = new RemoteSatellite(
      { id: "x", name: "x", host: "127.0.0.1", port: 1 },
      {
        onEvent: () => {},
        log: () => {},
        timers,
        connect: () => Promise.reject(new Error("refused")),
      },
    );
    sats.push(sat);
    sat.connect();
    for (let i = 0; i < 8; i++) {
      await vi.waitFor(() => {
        if (delays.length < i + 1)
          throw new Error("no reconnect scheduled yet");
      });
      pending.shift()?.();
    }
    expect(delays.slice(0, 7)).toEqual([
      0, 1000, 2000, 5000, 10000, 30000, 30000,
    ]);
    expect(RECONNECT_DELAYS_MS[0]).toBe(0);
  });

  it("times out the arming phase when info never arrives, then recovers", async () => {
    // A hung peer: accepts the TCP connection and swallows `describe` without
    // ever answering — without an arm deadline the satellite would sit in the
    // event loop forever with no reconnect and no keepalive.
    const server = await startSatelliteServer({ hang: true });
    const { sat, events } = makeSat(server, {}, { armTimeoutMs: 100 });
    sat.connect();
    // The deadline closes the connection and the reconnect loop retries
    // (a second describe proves a fresh attempt happened).
    await until(
      () => server.log.filter((e) => e.event.type === "describe").length >= 2,
      5000,
    );
    expect(sat.connected).toBe(false);
    expect(events.some((e) => e.type === "connected")).toBe(false);
    // The peer recovers: the maintained loop arms normally.
    server.hang = false;
    await until(() => sat.connected, 10000);
  });

  // Fake timers that record every delay and let the test fire reconnects
  // manually. Arm timeouts are given a sentinel delay so they can be told
  // apart from reconnect delays.
  const ARM_SENTINEL_MS = 99_999;
  interface TimerEntry {
    ms: number;
    fn: () => void;
    cleared: boolean;
    fired: boolean;
  }
  function recordingTimers(): { entries: TimerEntry[]; timers: TimerApi } {
    const entries: TimerEntry[] = [];
    const timers: TimerApi = {
      setTimeout: (fn, ms) => {
        const entry: TimerEntry = { ms, fn, cleared: false, fired: false };
        entries.push(entry);
        return entry;
      },
      clearTimeout: (handle) => {
        (handle as TimerEntry).cleared = true;
      },
      setInterval: () => ({}),
      clearInterval: () => {},
    };
    return { entries, timers };
  }

  async function claimRefusedDelays(
    server: MockWyomingServer,
    deps: Partial<RemoteSatelliteDeps>,
    cycles: number,
  ): Promise<number[]> {
    const { entries, timers } = recordingTimers();
    const { sat } = makeSat(
      server,
      { wakeWords: ["okay_nabu"] },
      { timers, armTimeoutMs: ARM_SENTINEL_MS, ...deps },
    );
    sat.connect();
    const delays: number[] = [];
    for (let i = 0; i < cycles; i++) {
      const entry = await vi.waitFor(
        () => {
          const pending = entries.find(
            (e) => !e.cleared && !e.fired && e.ms !== ARM_SENTINEL_MS,
          );
          if (pending === undefined) {
            throw new Error("no reconnect scheduled yet");
          }
          return pending;
        },
        { timeout: 5000 },
      );
      delays.push(entry.ms);
      entry.fired = true;
      entry.fn();
    }
    return delays;
  }

  it("keeps ramping backoff while another client holds the claim (no zero-delay busy loop)", async () => {
    const server = await startSatelliteServer();
    // A rival client holds the satellite's single-client slot: the satellite
    // still answers our `describe` with `info` on every connection and only
    // drops the socket when our `run-satellite` arrives.
    const rival = await WyomingConnection.connect("127.0.0.1", server.port);
    try {
      rival.write(RunSatellite());
      await server.waitForEvent((e) => e.event.type === "run-satellite");
      // Each cycle LOOKS like a successful connection (info received) but is
      // dropped immediately — the backoff must keep ramping, not reset to
      // RECONNECT_DELAYS_MS[0] = 0 on every `info`.
      const delays = await claimRefusedDelays(server, {}, 4);
      expect(delays).toEqual([0, 1000, 2000, 5000]);
    } finally {
      rival.close();
    }
  });

  it("resets backoff once a connection survives stableConnectionMs", async () => {
    const server = await startSatelliteServer();
    const rival = await WyomingConnection.connect("127.0.0.1", server.port);
    try {
      rival.write(RunSatellite());
      await server.waitForEvent((e) => e.event.type === "run-satellite");
      // stableConnectionMs 0: every armed connection counts as stable — the
      // reset path yields the spec §8 immediate-retry behavior.
      const delays = await claimRefusedDelays(
        server,
        { stableConnectionMs: 0 },
        4,
      );
      expect(delays).toEqual([0, 0, 0, 0]);
    } finally {
      rival.close();
    }
  });
});

describe("RemoteSatellite keepalive", () => {
  it("answers the satellite's pings so the claim survives", async () => {
    const server = await startSatelliteServer({
      pingIntervalMs: 20,
      pongTimeoutMs: 200,
    });
    const { sat } = makeSat(
      server,
      { wakeWords: ["okay_nabu"] },
      { pingIntervalMs: 15, pongTimeoutMs: 500 },
    );
    sat.connect();
    await until(() => sat.connected);
    // Our ping arms the mock's own ping loop; it drops us if a pong is late.
    await server.waitForEvent((e) => e.event.type === "pong", {
      timeoutMs: 2000,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(sat.connected).toBe(true);
    expect(server.claimedBy).not.toBeNull();
  });

  it("destroys the socket when its own ping gets no pong", async () => {
    const server = await startSatelliteServer();
    const { sat, events } = makeSat(
      server,
      { wakeWords: ["okay_nabu"] },
      { pingIntervalMs: 20, pongTimeoutMs: 60 },
    );
    sat.connect();
    await until(() => sat.connected);
    server.hang = true; // stop answering pings
    await until(() => !sat.connected, 3000);
    expect(events.some((e) => e.type === "disconnected")).toBe(true);
  });
});

describe("RemoteSatellite wake flow (satellite contract §5)", () => {
  it("surfaces detection + run-pipeline + mic chunks; transcript stops streaming", async () => {
    const server = await startSatelliteServer({ streamChunkIntervalMs: 5 });
    const { sat, events } = makeSat(server, { wakeWords: ["okay_nabu"] });
    sat.connect();
    await until(() => sat.connected);
    await until(() => server.claimedBy !== null); // run-satellite processed
    server.wake("okay_nabu");
    await until(() => events.some((e) => e.type === "audio-chunk"));
    const types = events.map((e) => e.type);
    expect(types).toContain("detection");
    expect(types).toContain("run-pipeline");
    expect(sat.state).toBe("listening");
    const rp = events.find((e) => e.type === "run-pipeline");
    expect(rp && "runPipeline" in rp && rp.runPipeline.startStage).toBe("asr");
    expect(rp && "runPipeline" in rp && rp.runPipeline.sndFormat).toEqual({
      rate: 22050,
      width: 2,
      channels: 1,
    });

    sat.sendTranscript("log my position");
    await until(() => !server.streaming);
    expect(sat.state).toBe("idle");
    const transcript = server.log.find((e) => e.event.type === "transcript");
    expect(transcript?.event.data?.text).toBe("log my position");
  });

  it("sendError stops streaming silently and returns to idle", async () => {
    const server = await startSatelliteServer({ streamChunkIntervalMs: 5 });
    const { sat } = makeSat(server, { wakeWords: ["okay_nabu"] });
    sat.connect();
    await until(() => sat.connected);
    await until(() => server.claimedBy !== null); // run-satellite processed
    server.wake("okay_nabu");
    await until(() => sat.state === "listening");
    sat.sendError("wake-dedup", "another satellite won");
    await until(() => !server.streaming);
    expect(sat.state).toBe("idle");
    const error = server.log.find((e) => e.event.type === "error");
    expect(error?.event.data?.code).toBe("wake-dedup");
  });

  it("does not surface mic chunks while idle", async () => {
    const server = await startSatelliteServer();
    const { sat, events } = makeSat(server, { wakeWords: ["okay_nabu"] });
    sat.connect();
    await until(() => sat.connected);
    // Manually push an audio-chunk without a pipeline.
    const { AudioChunk } = await import("../src/protocol/events.js");
    server.send(
      AudioChunk({ rate: 16000, width: 2, channels: 1 }, pcmRamp(320)),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events.some((e) => e.type === "audio-chunk")).toBe(false);
  });
});

describe("RemoteSatellite play()", () => {
  it("frames audio-start/chunks/audio-stop and resolves on played", async () => {
    const server = await startSatelliteServer();
    const { sat, events } = makeSat(server);
    sat.connect();
    await until(() => sat.connected);
    const audio = pcm(3);
    await sat.play(audio);
    const types = server.log.map((e) => e.event.type);
    expect(types).toEqual([
      "describe",
      "pause-satellite",
      "audio-start",
      "audio-chunk",
      "audio-chunk",
      "audio-chunk",
      "audio-stop",
    ]);
    const chunkEvents = server.log.filter(
      (e) => e.event.type === "audio-chunk",
    );
    expect(chunkEvents[0]?.event.payload?.equals(pcmRamp(320, 0))).toBe(true);
    expect(chunkEvents[2]?.event.payload?.equals(pcmRamp(320, 2))).toBe(true);
    const start = server.log.find((e) => e.event.type === "audio-start");
    expect(start?.event.data).toMatchObject({
      rate: 16000,
      width: 2,
      channels: 1,
    });
    expect(events.some((e) => e.type === "played")).toBe(true);
    expect(sat.state).toBe("idle");
  });

  it("surfaces 'speaking' state during playback", async () => {
    const server = await startSatelliteServer({ playedDelayMs: 50 });
    const { sat, events } = makeSat(server);
    sat.connect();
    await until(() => sat.connected);
    const playPromise = sat.play(pcm(2));
    await until(() => sat.state === "speaking");
    await playPromise;
    expect(sat.state).toBe("idle");
    const states = events.filter((e) => e.type === "state");
    expect(states.map((e) => "state" in e && e.state)).toContain("speaking");
  });

  it("paces chunks at roughly real-time rate (~4 chunks lead)", async () => {
    const server = await startSatelliteServer();
    const { sat } = makeSat(server);
    sat.connect();
    await until(() => sat.connected);
    const startedAt = Date.now();
    await sat.play(pcm(12)); // 120 ms of audio, 4 chunks lead → ≥ ~80 ms
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });

  it("cancelPlayback drops the remainder but still sends audio-stop", async () => {
    const server = await startSatelliteServer();
    const { sat } = makeSat(server);
    sat.connect();
    await until(() => sat.connected);
    const playPromise = sat.play(pcm(100)); // 1 s of audio
    await server.waitForEvent((e) => e.event.type === "audio-chunk");
    sat.cancelPlayback();
    await playPromise; // resolves promptly, without waiting for played
    await server.waitForEvent((e) => e.event.type === "audio-stop");
    const chunks = server.log.filter((e) => e.event.type === "audio-chunk");
    expect(chunks.length).toBeLessThan(100);
    expect(sat.state).toBe("idle");
  });

  it("resolves via fallback timeout when played never arrives", async () => {
    const server = await startSatelliteServer({ playedDelayMs: 60_000 });
    const { sat } = makeSat(server, {}, { playedGraceMs: 80 });
    sat.connect();
    await until(() => sat.connected);
    const startedAt = Date.now();
    await sat.play(pcm(2)); // 20 ms audio + 80 ms grace
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it("rejects when not connected", async () => {
    const server = await startSatelliteServer();
    const { sat } = makeSat(server);
    await expect(sat.play(pcm(1))).rejects.toThrow(/not connected/);
  });

  it("rejects when the connection drops mid-play", async () => {
    const server = await startSatelliteServer();
    const { sat } = makeSat(server);
    sat.connect();
    await until(() => sat.connected);
    const playPromise = sat.play(pcm(100));
    await server.waitForEvent((e) => e.event.type === "audio-chunk");
    server.dropConnectionAfter(() => true); // next event kills the connection
    await expect(playPromise).rejects.toThrow(/connection lost|closed/);
  });
});
