import { afterEach, describe, expect, it } from "vitest";
import { MockWyomingServer, pcmRamp } from "../src/mock/server.js";
import { synthesize } from "../src/tts.js";

let servers: MockWyomingServer[] = [];

async function startTts(
  options: ConstructorParameters<typeof MockWyomingServer>[0] = {},
): Promise<{ server: MockWyomingServer; uri: string }> {
  const server = new MockWyomingServer({ role: "tts", ...options });
  const port = await server.listen();
  servers.push(server);
  return { server, uri: `tcp://127.0.0.1:${port}` };
}

afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

describe("synthesize()", () => {
  it("buffers the full audio stream with the declared format", async () => {
    const { server, uri } = await startTts();
    const audio = await synthesize(uri, "hello boat", undefined, 2000);
    expect(audio.format).toEqual({ rate: 22050, width: 2, channels: 1 });
    expect(audio.chunks).toHaveLength(4);
    expect(audio.chunks[0]?.equals(pcmRamp(2048, 0))).toBe(true);
    expect(audio.chunks[3]?.equals(pcmRamp(2048, 3))).toBe(true);
    // The request carried the text and no voice.
    const synth = server.log.find((e) => e.event.type === "synthesize");
    expect(synth?.event.data?.text).toBe("hello boat");
    expect(synth?.event.data?.voice).toBeUndefined();
  });

  it("honors the TTS service's own format", async () => {
    const { uri } = await startTts({
      ttsFormat: { rate: 16000, width: 2, channels: 1 },
      ttsChunks: [pcmRamp(320)],
    });
    const audio = await synthesize(uri, "hi", undefined, 2000);
    expect(audio.format.rate).toBe(16000);
    expect(audio.chunks).toHaveLength(1);
  });

  it("passes the voice name as voice:{name}", async () => {
    const { server, uri } = await startTts();
    await synthesize(uri, "hi", "en_US-lessac-medium", 2000);
    const synth = server.log.find((e) => e.event.type === "synthesize");
    expect(synth?.event.data?.voice).toEqual({ name: "en_US-lessac-medium" });
  });

  it("rejects with the error event's text", async () => {
    const { uri } = await startTts({ unknownVoice: "bogus-voice" });
    await expect(synthesize(uri, "hi", "bogus-voice", 2000)).rejects.toThrow(
      /TTS error: unknown voice: bogus-voice/,
    );
  });

  it("rejects on timeout against a hung service", async () => {
    const { uri } = await startTts({ hang: true });
    await expect(synthesize(uri, "hi", undefined, 150)).rejects.toThrow(
      /timed out after 150ms/,
    );
  });

  it("rejects when the stream ends before audio-stop", async () => {
    const { server, uri } = await startTts();
    server.dropConnectionAfter(1); // drop right after the synthesize event
    await expect(synthesize(uri, "hi", undefined, 2000)).rejects.toThrow(
      /ended before audio-stop/,
    );
  });

  it("rejects on unreachable service", async () => {
    const { server, uri } = await startTts();
    await server.close();
    await expect(synthesize(uri, "hi", undefined, 500)).rejects.toThrow();
  });

  it("rejects invalid URIs", async () => {
    await expect(
      synthesize("http://x:1", "hi", undefined, 500),
    ).rejects.toThrow(/unsupported Wyoming URI scheme/);
  });
});
