import { afterEach, describe, expect, it } from "vitest";
import {
  describe as wyomingDescribe,
  parseWyomingUri,
  probeWyoming,
  WyomingConnection,
} from "../src/protocol/client.js";
import {
  AudioChunk,
  AudioStart,
  AudioStop,
  Detect,
  parseAudioChunk,
  parseDetection,
  parseError,
  parseTranscript,
  Synthesize,
  Transcribe,
  type WyomingEvent,
} from "../src/protocol/events.js";
import { FramingError } from "../src/protocol/framing.js";
import { MockWyomingServer, pcmRamp } from "../src/mock/server.js";
import {
  collectN,
  onceClosed,
  serverAndClient,
  sleep,
  until,
} from "./helpers.js";

const FORMAT = { rate: 16000, width: 2, channels: 1 };

let cleanups: (() => Promise<void> | void)[] = [];
function cleanup(fn: () => Promise<void> | void) {
  cleanups.push(fn);
}
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups = [];
});

async function start(
  options: ConstructorParameters<typeof MockWyomingServer>[0],
) {
  const { server, conn } = await serverAndClient(options ?? {});
  cleanup(() => server.close());
  cleanup(() => conn.close());
  return { server, conn };
}

describe("parseWyomingUri", () => {
  it("parses tcp://host:port (trailing slash tolerated)", () => {
    expect(parseWyomingUri("tcp://10.10.10.21:10700")).toEqual({
      host: "10.10.10.21",
      port: 10700,
    });
    expect(parseWyomingUri("tcp://whisper.local:10300/")).toEqual({
      host: "whisper.local",
      port: 10300,
    });
  });

  it("rejects non-tcp schemes, missing ports, paths, and garbage", () => {
    expect(() => parseWyomingUri("unix:///tmp/sock")).toThrow(/unsupported/);
    expect(() => parseWyomingUri("http://x:80")).toThrow(/unsupported/);
    expect(() => parseWyomingUri("tcp://hostonly")).toThrow(
      /tcp:\/\/host:port/,
    );
    expect(() => parseWyomingUri("tcp://h:1/path")).toThrow(/path/);
    expect(() => parseWyomingUri("not a uri")).toThrow(/invalid/);
  });
});

describe("describe/probe helpers", () => {
  it("describe() returns the mock's info", async () => {
    const server = new MockWyomingServer({ role: "asr" });
    await server.listen();
    cleanup(() => server.close());
    const info = await wyomingDescribe("127.0.0.1", server.port);
    expect(info.asr[0]?.name).toBe("mock-whisper");
    expect(info.asr[0]?.models?.[0]?.name).toBe("tiny-int8");
    expect(info.tts).toEqual([]);
  });

  it("probeWyoming() accepts a tcp:// URI", async () => {
    const server = new MockWyomingServer({ role: "tts" });
    await server.listen();
    cleanup(() => server.close());
    const info = await probeWyoming(`tcp://127.0.0.1:${server.port}`);
    expect(info.tts[0]?.voices?.[0]?.name).toBe("en_US-lessac-medium");
  });

  it("info override option is merged over the canned response", async () => {
    const server = new MockWyomingServer({
      role: "asr",
      info: { asr: [{ name: "custom-asr" }] },
    });
    await server.listen();
    cleanup(() => server.close());
    const info = await wyomingDescribe("127.0.0.1", server.port);
    expect(info.asr[0]?.name).toBe("custom-asr");
  });

  it("describe() times out against a hung service", async () => {
    const server = new MockWyomingServer({ role: "asr", hang: true });
    await server.listen();
    cleanup(() => server.close());
    await expect(
      wyomingDescribe("127.0.0.1", server.port, { timeoutMs: 100 }),
    ).rejects.toThrow(/timed out/);
    // The describe still reached the server (recorded, unanswered).
    expect(server.log.some((l) => l.event.type === "describe")).toBe(true);
  });

  it("describe() rejects when connections are refused", async () => {
    const server = new MockWyomingServer({
      role: "asr",
      refuseConnections: true,
    });
    await server.listen();
    cleanup(() => server.close());
    await expect(
      wyomingDescribe("127.0.0.1", server.port, { timeoutMs: 200 }),
    ).rejects.toThrow();
  });

  it("connect rejects against a closed port", async () => {
    const server = new MockWyomingServer({});
    const port = await server.listen();
    await server.close();
    await expect(
      WyomingConnection.connect("127.0.0.1", port, { timeoutMs: 500 }),
    ).rejects.toThrow();
  });
});

describe("asr role", () => {
  it("runs the transcribe → audio → transcript flow with a text queue", async () => {
    const { server, conn } = await start({
      role: "asr",
      transcripts: ["first", "second"],
    });
    for (const expected of ["first", "second", "test transcript"]) {
      conn.write(Transcribe({ language: "en" }));
      conn.write(AudioStart(FORMAT));
      conn.write(AudioChunk(FORMAT, pcmRamp(2048)));
      conn.write(AudioChunk(FORMAT, pcmRamp(2048, 1)));
      conn.write(AudioStop());
      const transcript = parseTranscript(await conn.nextEvent(2000));
      expect(transcript?.text).toBe(expected);
    }
    expect(
      server.log.filter((l) => l.event.type === "audio-chunk").length,
    ).toBe(6);
  });

  it("returns an empty transcript for empty audio", async () => {
    const { conn } = await start({ role: "asr", transcripts: ["nope"] });
    conn.write(Transcribe());
    conn.write(AudioStart(FORMAT));
    conn.write(AudioStop());
    const transcript = parseTranscript(await conn.nextEvent(2000));
    expect(transcript?.text).toBe("");
  });

  it("honors responseDelayMs", async () => {
    const { conn } = await start({ role: "asr", responseDelayMs: 60 });
    conn.write(AudioStart(FORMAT));
    conn.write(AudioChunk(FORMAT, pcmRamp(64)));
    conn.write(AudioStop());
    const started = Date.now();
    await conn.nextEvent(2000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });
});

describe("tts role", () => {
  it("answers synthesize with audio-start/chunk/stop at 22050/2/1", async () => {
    const { conn } = await start({ role: "tts" });
    conn.write(Synthesize("Anchor alarm", { voice: { name: "any" } }));
    const events = await collectN(conn, 6);
    expect(events.map((e) => e.type)).toEqual([
      "audio-start",
      "audio-chunk",
      "audio-chunk",
      "audio-chunk",
      "audio-chunk",
      "audio-stop",
    ]);
    expect(events[0]?.data).toMatchObject({
      rate: 22050,
      width: 2,
      channels: 1,
    });
    const chunks = events.slice(1, 5).map((e) => parseAudioChunk(e)!);
    expect(chunks.every((c) => c.audio.length === 2048)).toBe(true);
    // deterministic ramp continues across chunks
    expect(chunks[0]?.audio[0]).toBe(0);
    expect(chunks[1]?.audio[0]).toBe(2048 % 256);
  });

  it("replies with an error event for the configured unknown voice", async () => {
    const { conn } = await start({ role: "tts", unknownVoice: "missing" });
    conn.write(Synthesize("hi", { voice: { name: "missing" } }));
    const error = parseError(await conn.nextEvent(2000));
    expect(error?.text).toMatch(/unknown voice/);
    expect(error?.code).toBe("unknown-voice");
  });

  it("supports custom PCM chunks", async () => {
    const pcm = [Buffer.from([9, 9]), Buffer.from([7])];
    const { conn } = await start({ role: "tts", ttsChunks: pcm });
    conn.write(Synthesize("hi"));
    const events = await collectN(conn, 4);
    expect(events[1]?.payload).toEqual(pcm[0]);
    expect(events[2]?.payload).toEqual(pcm[1]);
  });
});

describe("wake role", () => {
  it("emits a detection after the configured amount of audio", async () => {
    // 2048 bytes @ 16k/2/1 = 64 ms per chunk; threshold 100 ms → 2nd chunk.
    const { conn } = await start({ role: "wake", detectAfterAudioMs: 100 });
    conn.write(Detect(["okay_nabu"]));
    conn.write(AudioStart(FORMAT));
    conn.write(AudioChunk(FORMAT, pcmRamp(2048)));
    conn.write(AudioChunk(FORMAT, pcmRamp(2048, 1)));
    const detection = parseDetection(await conn.nextEvent(2000));
    expect(detection?.name).toBe("okay_nabu");
    expect(detection?.timestamp).toBe(128);
  });

  it("replies not-detected when audio stops without a detection", async () => {
    const { conn } = await start({ role: "wake" });
    conn.write(Detect());
    conn.write(AudioStart(FORMAT));
    conn.write(AudioChunk(FORMAT, pcmRamp(2048)));
    conn.write(AudioStop());
    const event = await conn.nextEvent(2000);
    expect(event.type).toBe("not-detected");
  });

  it("injectDetection() pushes a scripted detection", async () => {
    const { server, conn } = await start({ role: "wake" });
    conn.write(Detect(["okay_nabu"]));
    await server.waitForEvent((l) => l.event.type === "detect");
    server.injectDetection("hey_jarvis");
    const detection = parseDetection(await conn.nextEvent(2000));
    expect(detection?.name).toBe("hey_jarvis");
  });
});

describe("connection behavior", () => {
  it("delivers events via on('event') and the async iterator", async () => {
    const { server, conn } = await start({ role: "custom" });
    const seen: string[] = [];
    conn.on("event", (e: WyomingEvent) => seen.push(e.type));
    await until(() => server.connections.length === 1);
    server.send({ type: "ping", data: { text: null } });
    server.send({ type: "pong", data: { text: null } });
    const first = await conn.nextEvent(2000);
    expect(first.type).toBe("ping");
    const iterator = conn[Symbol.asyncIterator]();
    const second = await iterator.next();
    expect(second).toEqual({
      value: { type: "pong", data: { text: null } },
      done: false,
    });
    expect(seen).toEqual(["ping", "pong"]);
  });

  it("the async iterator ends when the server closes cleanly", async () => {
    const { server, conn } = await start({ role: "custom" });
    const events: WyomingEvent[] = [];
    const iteration = (async () => {
      for await (const e of conn) events.push(e);
    })();
    await sleep(20);
    await server.close();
    await iteration; // resolves — clean end, no error
    expect(events).toEqual([]);
    expect(conn.closed).toBe(true);
  });

  it("a partial event at disconnect is dropped, not delivered", async () => {
    const { server, conn } = await start({ role: "custom" });
    // Header promises a 100-byte payload; only 10 bytes ever arrive.
    server.sendRaw(
      Buffer.from('{"type": "audio-chunk", "payload_length": 100}\n'),
    );
    server.sendRaw(Buffer.alloc(10));
    await sleep(20);
    await server.close();
    const events: WyomingEvent[] = [];
    for await (const e of conn) events.push(e);
    expect(events).toEqual([]);
  });

  it("a malformed header from the server fails the connection with FramingError", async () => {
    const { server, conn } = await start({ role: "custom" });
    const errors: Error[] = [];
    conn.on("error", (err: Error) => errors.push(err));
    const iteration = (async () => {
      for await (const e of conn) void e;
    })();
    server.sendMalformedHeader();
    await expect(iteration).rejects.toThrow(FramingError);
    expect(errors[0]).toBeInstanceOf(FramingError);
    expect(conn.closed).toBe(true);
  });

  it("dropConnectionAfter(n) severs the connection mid-flow", async () => {
    const { server, conn } = await start({ role: "asr" });
    server.dropConnectionAfter(2);
    conn.write(Transcribe());
    conn.write(AudioStart(FORMAT));
    conn.write(AudioChunk(FORMAT, pcmRamp(16)));
    await onceClosed(conn);
    expect(conn.closed).toBe(true);
  });

  it("dropConnectionAfter(predicate) drops on a matching event", async () => {
    const { server, conn } = await start({ role: "asr" });
    server.dropConnectionAfter((event) => event.type === "audio-stop");
    conn.write(AudioStart(FORMAT));
    conn.write(AudioChunk(FORMAT, pcmRamp(16)));
    conn.write(AudioStop());
    await onceClosed(conn);
    // no transcript was ever sent
    await expect(conn.nextEvent()).rejects.toThrow();
  });

  it("write() after close throws", async () => {
    const { conn } = await start({ role: "custom" });
    conn.close();
    await onceClosed(conn);
    expect(() => conn.write({ type: "describe" })).toThrow(/closed/);
  });
});
