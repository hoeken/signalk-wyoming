/**
 * The mock satellite must imitate upstream wyoming-satellite v1.4.1 wake-mode
 * behavior (see .notes/wyoming-satellite.md §5): single-client claim,
 * detection → run-pipeline → mic streaming, transcript/error stop streaming,
 * TTS playback acknowledged with `played`, ping/pong keepalive.
 */

import { afterEach, describe, expect, it } from "vitest";
import { WyomingConnection } from "../src/protocol/client.js";
import {
  AudioChunk,
  AudioStart,
  AudioStop,
  ErrorEvent,
  parseAudioChunk,
  parseDetection,
  parsePong,
  parseRunPipeline,
  Ping,
  Pong,
  RunSatellite,
  Transcript,
  type WyomingEvent,
} from "../src/protocol/events.js";
import { MockWyomingServer, pcmRamp } from "../src/mock/server.js";
import { onceClosed, serverAndClient, sleep, until } from "./helpers.js";

const SND = { rate: 22050, width: 2, channels: 1 };

let cleanups: (() => Promise<void> | void)[] = [];
function cleanup(fn: () => Promise<void> | void) {
  cleanups.push(fn);
}
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups = [];
});

async function startSatellite(
  options: ConstructorParameters<typeof MockWyomingServer>[0] = {},
) {
  const { server, conn } = await serverAndClient({
    role: "satellite",
    streamChunkIntervalMs: 5,
    ...options,
  });
  cleanup(() => server.close());
  cleanup(() => conn.close());
  return { server, conn };
}

async function connectSecond(server: MockWyomingServer) {
  const conn = await WyomingConnection.connect("127.0.0.1", server.port);
  cleanup(() => conn.close());
  return conn;
}

describe("single-client claim semantics", () => {
  it("describe is answered without claiming", async () => {
    const { server, conn } = await startSatellite({ satelliteName: "cockpit" });
    conn.write({ type: "describe" });
    const info = await conn.nextEvent(2000);
    expect(info.type).toBe("info");
    expect((info.data?.satellite as { name: string }).name).toBe("cockpit");
    expect(server.claimedBy).toBeNull();
  });

  it("the first non-describe event claims; a second client is dropped", async () => {
    const { server, conn } = await startSatellite();
    conn.write(RunSatellite());
    await until(() => server.claimedBy !== null);

    const second = await connectSecond(server);
    // describe from the second client is still answered...
    second.write({ type: "describe" });
    expect((await second.nextEvent(2000)).type).toBe("info");
    // ...but its first non-describe event gets the socket closed, silently.
    second.write(RunSatellite());
    await onceClosed(second);
    expect(second.closed).toBe(true);
    expect(conn.closed).toBe(false);
    expect(server.connections).toHaveLength(1);
  });

  it("a new client can claim after the owner disconnects", async () => {
    const { server, conn } = await startSatellite();
    conn.write(RunSatellite());
    await until(() => server.claimedBy !== null);
    const first = server.claimedBy;
    conn.close();
    await until(() => server.claimedBy === null);

    const second = await connectSecond(server);
    second.write(RunSatellite());
    await until(() => server.claimedBy !== null);
    expect(server.claimedBy).not.toBe(first);
    expect(second.closed).toBe(false);
  });
});

describe("wake flow", () => {
  it("wake() sends detection, run-pipeline(asr→tts), then streams mic chunks", async () => {
    const { server, conn } = await startSatellite();
    conn.write(RunSatellite());
    await server.waitForEvent((l) => l.event.type === "run-satellite");

    server.wake("okay_nabu");
    const detection = parseDetection(await conn.nextEvent(2000));
    expect(detection?.name).toBe("okay_nabu");

    const pipeline = parseRunPipeline(await conn.nextEvent(2000));
    expect(pipeline).toMatchObject({
      startStage: "asr",
      endStage: "tts",
      restartOnEnd: false,
      wakeWordName: "okay_nabu",
      sndFormat: SND,
    });

    const chunk = parseAudioChunk(await conn.nextEvent(2000));
    expect(chunk).toMatchObject({ rate: 16000, width: 2, channels: 1 });
    expect(chunk?.audio.length).toBe(2048);
  });

  it("streaming stops when the server sends transcript (and never audio-stop)", async () => {
    const { server, conn } = await startSatellite();
    conn.write(RunSatellite());
    await server.waitForEvent((l) => l.event.type === "run-satellite");
    server.wake("okay_nabu");
    await until(() => server.streaming);
    expect((await conn.nextEvent(2000)).type).toBe("detection");
    expect((await conn.nextEvent(2000)).type).toBe("run-pipeline");

    conn.write(Transcript("log my position"));
    await until(() => !server.streaming);
    await sleep(25); // several stream intervals
    const tail: WyomingEvent[] = [];
    // drain whatever was in flight; no new chunks after the drain
    for (;;) {
      try {
        tail.push(await conn.nextEvent(30));
      } catch {
        break;
      }
    }
    expect(tail.every((e) => e.type === "audio-chunk")).toBe(true);
    // the satellite never sends audio-stop in wake mode
    expect(tail.some((e) => e.type === "audio-stop")).toBe(false);
  });

  it("streaming also stops on error (silent abort)", async () => {
    const { server, conn } = await startSatellite();
    conn.write(RunSatellite());
    await server.waitForEvent((l) => l.event.type === "run-satellite");
    server.wake("okay_nabu");
    await until(() => server.streaming);
    conn.write(ErrorEvent("wake dedup loser", "aborted"));
    await until(() => !server.streaming);
  });

  it("honors streamChunkCount and custom PCM", async () => {
    const pcm = pcmRamp(256);
    const { server, conn } = await startSatellite({
      streamChunkCount: 3,
      streamPcm: pcm,
    });
    conn.write(RunSatellite());
    await server.waitForEvent((l) => l.event.type === "run-satellite");
    server.wake("okay_nabu");
    await until(() => !server.streaming, 2000);

    const received: WyomingEvent[] = [];
    for (;;) {
      try {
        received.push(await conn.nextEvent(50));
      } catch {
        break;
      }
    }
    const chunks = received.filter((e) => e.type === "audio-chunk");
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.payload).toEqual(pcm);
  });

  it("wake() throws when no server has claimed the satellite", async () => {
    const { server } = await startSatellite();
    expect(() => server.wake("okay_nabu")).toThrow(/no server/);
  });
});

describe("TTS playback", () => {
  it("records audio-start/chunk/stop and answers with played", async () => {
    const { server, conn } = await startSatellite({ playedDelayMs: 40 });
    conn.write(RunSatellite());
    conn.write(AudioStart(SND));
    conn.write(AudioChunk(SND, pcmRamp(2048)));
    conn.write(AudioChunk(SND, pcmRamp(2048, 1)));
    const sentStopAt = Date.now();
    conn.write(AudioStop());

    const played = await conn.nextEvent(2000);
    expect(played.type).toBe("played");
    expect(Date.now() - sentStopAt).toBeGreaterThanOrEqual(35);

    const types = server.log.map((l) => l.event.type);
    expect(types).toEqual([
      "run-satellite",
      "audio-start",
      "audio-chunk",
      "audio-chunk",
      "audio-stop",
    ]);
    const chunkEntries = server.log.filter(
      (l) => l.event.type === "audio-chunk",
    );
    expect(chunkEntries[0]?.event.payload?.length).toBe(2048);
  });
});

describe("ping/pong keepalive", () => {
  it("answers ping with pong, echoing the text", async () => {
    const { conn } = await startSatellite();
    conn.write(Ping("hello"));
    const pong = parsePong(await conn.nextEvent(2000));
    expect(pong?.text).toBe("hello");
  });

  it("starts pinging the server after the server's first ping, staying alive on pongs", async () => {
    const { server, conn } = await startSatellite({
      pingIntervalMs: 20,
      pongTimeoutMs: 100,
    });
    conn.on("event", (e: WyomingEvent) => {
      if (e.type === "ping" && !conn.closed) {
        conn.write(Pong(e.data?.text as string | undefined));
      }
    });
    conn.write(Ping()); // enables the satellite's ping loop
    await server.waitForEvent((l) => l.event.type === "pong", {
      timeoutMs: 2000,
    });
    await sleep(150); // several ping cycles with timely pongs
    expect(conn.closed).toBe(false);
    expect(server.claimedBy).not.toBeNull();
  });

  it("clears the claim and drops the connection on pong timeout", async () => {
    const { server, conn } = await startSatellite({
      pingIntervalMs: 20,
      pongTimeoutMs: 60,
    });
    conn.write(Ping()); // enable ping loop, then never answer the pings
    await conn.nextEvent(2000); // the pong to our ping
    await onceClosed(conn);
    expect(server.claimedBy).toBeNull();
  });
});

describe("injectable misbehavior", () => {
  it("hang: records events but never answers", async () => {
    const { server, conn } = await startSatellite({ hang: true });
    conn.write({ type: "describe" });
    await expect(conn.nextEvent(80)).rejects.toThrow(/timed out/);
    expect(server.log.map((l) => l.event.type)).toEqual(["describe"]);
  });

  it("sendMalformedHeader() kills the client connection", async () => {
    const { server, conn } = await startSatellite();
    conn.write(RunSatellite());
    await server.waitForEvent((l) => l.event.type === "run-satellite");
    server.sendMalformedHeader();
    await onceClosed(conn);
    expect(conn.closed).toBe(true);
  });
});
