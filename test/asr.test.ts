import { afterEach, describe, expect, it } from "vitest";
import { MIC_FORMAT, TranscribeSession, wavToPcm } from "../src/asr.js";
import { MockWyomingServer } from "../src/mock/server.js";
import { ErrorEvent } from "../src/protocol/events.js";
import { buildWav, sinePcm, speechChunk } from "./pcm.js";
import { until } from "./helpers.js";

let servers: MockWyomingServer[] = [];

async function startServer(
  options: ConstructorParameters<typeof MockWyomingServer>[0] = {},
): Promise<MockWyomingServer> {
  const server = new MockWyomingServer(options);
  await server.listen();
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

describe("TranscribeSession", () => {
  it("open() sends transcribe {language} then audio-start (16k/2/1)", async () => {
    const server = await startServer({ role: "asr" });
    const session = await TranscribeSession.open(
      `tcp://127.0.0.1:${server.port}`,
      { language: "en" },
    );
    await server.waitForEvent((e) => e.event.type === "audio-start");
    expect(server.log.map((e) => e.event.type)).toEqual([
      "transcribe",
      "audio-start",
    ]);
    expect(server.log[0]?.event.data?.language).toBe("en");
    expect(server.log[1]?.event.data).toMatchObject({
      rate: 16000,
      width: 2,
      channels: 1,
    });
    session.abort();
  });

  it("feed() + finish() returns the transcript and closes the connection", async () => {
    const server = await startServer({
      role: "asr",
      transcripts: ["log my position"],
    });
    const session = await TranscribeSession.open(
      `tcp://127.0.0.1:${server.port}`,
    );
    session.feed(speechChunk());
    session.feed(speechChunk(), MIC_FORMAT);
    const { text } = await session.finish(3000);
    expect(text).toBe("log my position");
    const types = server.log.map((e) => e.event.type);
    expect(types).toEqual([
      "transcribe",
      "audio-start",
      "audio-chunk",
      "audio-chunk",
      "audio-stop",
    ]);
    await until(() => server.connections.length === 0);
  });

  it("chunks carry their own declared format (whisper resamples on ingest)", async () => {
    const server = await startServer({ role: "asr", transcripts: ["ok"] });
    const session = await TranscribeSession.open(
      `tcp://127.0.0.1:${server.port}`,
    );
    session.feed(sinePcm(512, 8000, 200, 22050), {
      rate: 22050,
      width: 2,
      channels: 1,
    });
    await session.finish(3000);
    const chunk = server.log.find((e) => e.event.type === "audio-chunk");
    expect(chunk?.event.data).toMatchObject({ rate: 22050 });
  });

  it("an error event from the service rejects finish()", async () => {
    const server = await startServer({ role: "custom" });
    const session = await TranscribeSession.open(
      `tcp://127.0.0.1:${server.port}`,
    );
    session.feed(speechChunk());
    const finishPromise = session.finish(3000);
    await server.waitForEvent((e) => e.event.type === "audio-stop");
    server.send(ErrorEvent("model kaboom", "asr-fail"));
    await expect(finishPromise).rejects.toThrow(/model kaboom/);
  });

  it("finish() times out against a hung service", async () => {
    const server = await startServer({ role: "custom" });
    const session = await TranscribeSession.open(
      `tcp://127.0.0.1:${server.port}`,
    );
    await expect(session.finish(100)).rejects.toThrow(/timed out/);
  });

  it("finish() rejects when the connection drops before the transcript", async () => {
    const server = await startServer({ role: "custom" });
    const session = await TranscribeSession.open(
      `tcp://127.0.0.1:${server.port}`,
    );
    const finishPromise = session.finish(3000);
    await server.waitForEvent((e) => e.event.type === "audio-stop");
    // Malformed framing is treated as a disconnect by the client.
    server.sendMalformedHeader();
    await expect(finishPromise).rejects.toThrow(/connection|closed|lost/i);
  });

  it("abort() closes the socket without transcribing", async () => {
    const server = await startServer({ role: "asr" });
    const session = await TranscribeSession.open(
      `tcp://127.0.0.1:${server.port}`,
    );
    await until(() => server.connections.length === 1);
    session.abort();
    await until(() => server.connections.length === 0);
    expect(server.log.some((e) => e.event.type === "audio-stop")).toBe(false);
  });

  it("feed() after finish/abort throws", async () => {
    const server = await startServer({ role: "asr" });
    const session = await TranscribeSession.open(
      `tcp://127.0.0.1:${server.port}`,
    );
    session.abort();
    expect(() => session.feed(speechChunk())).toThrow(/finished/);
  });

  it("rejects invalid URIs", async () => {
    await expect(TranscribeSession.open("http://nope:1")).rejects.toThrow(
      /unsupported Wyoming URI scheme/,
    );
  });
});

describe("wavToPcm", () => {
  it("parses a canonical 44-byte-header WAV", () => {
    const pcm = sinePcm(1600, 8000);
    const { format, pcm: out } = wavToPcm(buildWav(pcm));
    expect(format).toEqual({ rate: 16000, width: 2, channels: 1 });
    expect(out.equals(pcm)).toBe(true);
  });

  it("honors the fmt chunk (rate/channels/width)", () => {
    const pcm = sinePcm(441, 1000);
    const { format } = wavToPcm(
      buildWav(pcm, { rate: 44100, width: 2, channels: 2 }),
    );
    expect(format).toEqual({ rate: 44100, width: 2, channels: 2 });
  });

  it("skips extra RIFF chunks before data", () => {
    const pcm = sinePcm(160, 2000);
    const canonical = buildWav(pcm);
    const list = Buffer.alloc(8 + 4);
    list.write("LIST", 0, "ascii");
    list.writeUInt32LE(4, 4);
    list.write("INFO", 8, "ascii");
    // header (RIFF..fmt block = first 36 bytes) + LIST + data chunk
    const wav = Buffer.concat([
      canonical.subarray(0, 36),
      list,
      canonical.subarray(36),
    ]);
    const parsed = wavToPcm(wav);
    expect(parsed.format.rate).toBe(16000);
    expect(parsed.pcm.equals(pcm)).toBe(true);
  });

  it("rejects non-WAV bytes and WAVs without a data chunk", () => {
    expect(() => wavToPcm(Buffer.from("not audio at all"))).toThrow(
      /RIFF\/WAVE/,
    );
    const headerOnly = buildWav(Buffer.alloc(0)).subarray(0, 36);
    expect(() => wavToPcm(headerOnly)).toThrow(/no data chunk/);
  });
});
