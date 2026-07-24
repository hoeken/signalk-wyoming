import { describe, expect, it } from "vitest";
import {
  AudioChunk,
  AudioStart,
  AudioStop,
  Describe,
  Detect,
  Detection,
  ErrorEvent,
  InfoEvent,
  NotDetected,
  PauseSatellite,
  Ping,
  Played,
  Pong,
  RunPipeline,
  RunSatellite,
  StreamingStarted,
  StreamingStopped,
  Synthesize,
  Transcribe,
  Transcript,
  TranscriptChunk,
  TranscriptStart,
  TranscriptStop,
  VoiceStarted,
  VoiceStopped,
  type Info,
  type WyomingEvent,
} from "../src/protocol/events.js";
import {
  encodeEvent,
  EventDecoder,
  FramingError,
  MAX_BLOCK_BYTES,
} from "../src/protocol/framing.js";

const FORMAT = { rate: 16000, width: 2, channels: 1 };

function fullInfo(): Info {
  const artifact = {
    attribution: { name: "a", url: "https://example.com" },
    installed: true,
    description: null,
    version: "1.0",
  };
  return {
    asr: [
      {
        name: "faster-whisper",
        ...artifact,
        models: [{ name: "tiny-int8", ...artifact, languages: ["en"] }],
        supports_transcript_streaming: false,
        requires_external_vad: true,
        prefers_auto_gain_enabled: true,
        prefers_noise_reduction_enabled: true,
      },
    ],
    tts: [
      {
        name: "piper",
        ...artifact,
        voices: [
          {
            name: "en_US-lessac-medium",
            ...artifact,
            languages: ["en_US"],
            speakers: null,
          },
        ],
        supports_synthesize_streaming: false,
      },
    ],
    handle: [],
    intent: [],
    wake: [
      {
        name: "openwakeword",
        ...artifact,
        models: [
          {
            name: "okay_nabu",
            ...artifact,
            languages: [],
            phrase: "okay nabu",
          },
        ],
      },
    ],
    mic: [{ name: "mic", ...artifact, mic_format: FORMAT }],
    snd: [
      {
        name: "snd",
        ...artifact,
        snd_format: { rate: 22050, width: 2, channels: 1 },
      },
    ],
    satellite: {
      name: "sat",
      ...artifact,
      area: null,
      has_vad: false,
      active_wake_words: ["okay_nabu"],
      max_active_wake_words: 1,
      supports_trigger: false,
    },
  };
}

/** One event per constructor (i.e. every event type we speak). */
function allEvents(): [string, WyomingEvent][] {
  return [
    ["describe", Describe()],
    ["info", InfoEvent(fullInfo())],
    ["transcribe (empty)", Transcribe()],
    ["transcribe", Transcribe({ name: "m", language: "en" })],
    ["transcript", Transcript("hello world", { language: "en" })],
    ["transcript-start", TranscriptStart({ language: "en" })],
    ["transcript-chunk", TranscriptChunk("hel")],
    ["transcript-stop", TranscriptStop()],
    ["synthesize", Synthesize("Anchor alarm", { voice: { name: "v" } })],
    ["audio-start", AudioStart(FORMAT)],
    ["audio-chunk", AudioChunk(FORMAT, Buffer.from([1, 2, 3, 4]), 0)],
    ["audio-stop", AudioStop(1234)],
    ["detect", Detect(["okay_nabu"])],
    ["detection", Detection({ name: "okay_nabu", timestamp: 10 })],
    ["not-detected", NotDetected()],
    ["run-satellite", RunSatellite()],
    ["pause-satellite", PauseSatellite()],
    ["streaming-started", StreamingStarted()],
    ["streaming-stopped", StreamingStopped()],
    [
      "run-pipeline",
      RunPipeline({
        startStage: "asr",
        endStage: "tts",
        wakeWordName: "okay_nabu",
        sndFormat: { rate: 22050, width: 2, channels: 1 },
      }),
    ],
    ["ping", Ping("k")],
    ["pong", Pong("k")],
    ["error", ErrorEvent("boom", "bad")],
    ["played", Played()],
    ["voice-started", VoiceStarted(1)],
    ["voice-stopped", VoiceStopped(2)],
  ];
}

/** What the decoder should emit for a constructed event. */
function decoded(e: WyomingEvent): WyomingEvent {
  const out: WyomingEvent = { type: e.type, data: e.data ?? {} };
  if (e.payload !== undefined && e.payload.length > 0) out.payload = e.payload;
  return out;
}

describe("encode/decode round trips", () => {
  it("round-trips every event type", () => {
    for (const [name, event] of allEvents()) {
      const events = new EventDecoder().feed(encodeEvent(event));
      expect(events, name).toEqual([decoded(event)]);
    }
  });

  it("decodes a multi-event stream from a single feed", () => {
    const all = allEvents();
    const wire = Buffer.concat(all.map(([, e]) => encodeEvent(e)));
    const events = new EventDecoder().feed(wire);
    expect(events).toEqual(all.map(([, e]) => decoded(e)));
  });

  it("decodes a stream fed one byte at a time", () => {
    const all = allEvents();
    const wire = Buffer.concat(all.map(([, e]) => encodeEvent(e)));
    const decoder = new EventDecoder();
    const events: WyomingEvent[] = [];
    for (let i = 0; i < wire.length; i++) {
      events.push(...decoder.feed(wire.subarray(i, i + 1)));
    }
    expect(events).toEqual(all.map(([, e]) => decoded(e)));
  });

  it("decodes a stream fed in awkward 7-byte chunks", () => {
    const all = allEvents();
    const wire = Buffer.concat(all.map(([, e]) => encodeEvent(e)));
    const decoder = new EventDecoder();
    const events: WyomingEvent[] = [];
    for (let i = 0; i < wire.length; i += 7) {
      events.push(...decoder.feed(wire.subarray(i, i + 7)));
    }
    expect(events).toEqual(all.map(([, e]) => decoded(e)));
  });

  it("preserves payload bytes exactly", () => {
    const payload = Buffer.alloc(10000);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) % 256;
    const [event] = new EventDecoder().feed(
      encodeEvent(AudioChunk(FORMAT, payload)),
    );
    expect(event?.payload?.equals(payload)).toBe(true);
  });

  it("a huge info event spans many reads", () => {
    const info = fullInfo();
    const voices = [];
    for (let i = 0; i < 500; i++) {
      voices.push({
        name: `voice-${i}`,
        attribution: { name: "x".repeat(100), url: "https://example.com" },
        installed: true,
        description: "d".repeat(200),
        version: null,
        languages: ["en_US"],
        speakers: null,
      });
    }
    info.tts = [{ name: "piper", voices }];
    const wire = encodeEvent(InfoEvent(info));
    expect(wire.length).toBeGreaterThan(100 * 1024);
    const decoder = new EventDecoder();
    const events: WyomingEvent[] = [];
    for (let i = 0; i < wire.length; i += 4096) {
      events.push(...decoder.feed(wire.subarray(i, i + 4096)));
    }
    expect(events).toHaveLength(1);
    expect((events[0]?.data?.tts as unknown[]).length).toBe(1);
  });
});

describe("encode: header rules", () => {
  it("omits data_length and payload_length for header-only events", () => {
    const wire = encodeEvent(Describe()).toString("utf8");
    expect(wire.endsWith("\n")).toBe(true);
    const header = JSON.parse(wire.slice(0, -1));
    expect(header).toEqual({ type: "describe", version: "1.10.0" });
  });

  it("omits data_length for an explicitly empty data dict", () => {
    const wire = encodeEvent({ type: "transcribe", data: {} }).toString("utf8");
    const header = JSON.parse(wire.slice(0, -1));
    expect(header).toEqual({ type: "transcribe", version: "1.10.0" });
  });

  it("omits payload_length for an empty payload", () => {
    const wire = encodeEvent({ type: "played", payload: Buffer.alloc(0) });
    const header = JSON.parse(wire.toString("utf8").slice(0, -1));
    expect(header).not.toHaveProperty("payload_length");
  });

  it("data_length is a UTF-8 byte count, not a character count", () => {
    const text = "Ahoy ⚓ Åland";
    const wire = encodeEvent(Transcript(text));
    const newline = wire.indexOf(0x0a);
    const header = JSON.parse(wire.subarray(0, newline).toString("utf8"));
    const dataJson = JSON.stringify({ text });
    expect(header.data_length).toBe(Buffer.byteLength(dataJson, "utf8"));
    expect(header.data_length).toBeGreaterThan(dataJson.length); // bytes > chars
    expect(wire.length).toBe(newline + 1 + header.data_length);
    const [event] = new EventDecoder().feed(wire);
    expect(event?.data?.text).toBe(text);
  });
});

describe("decode: tolerant reads", () => {
  it("merges inline header data UNDER the out-of-line block", () => {
    const data = JSON.stringify({ text: "block" });
    const header = JSON.stringify({
      type: "transcript",
      data: { text: "inline", language: "en" },
      data_length: Buffer.byteLength(data),
    });
    const events = new EventDecoder().feed(
      Buffer.from(header + "\n" + data, "utf8"),
    );
    expect(events).toEqual([
      { type: "transcript", data: { text: "block", language: "en" } },
    ]);
  });

  it("uses inline header data when there is no data block", () => {
    const wire = Buffer.from(
      JSON.stringify({ type: "transcript", data: { text: "inline" } }) + "\n",
      "utf8",
    );
    expect(new EventDecoder().feed(wire)).toEqual([
      { type: "transcript", data: { text: "inline" } },
    ]);
  });

  it("treats data_length 0 and null lengths as absent", () => {
    const wire = Buffer.from(
      JSON.stringify({
        type: "describe",
        data_length: 0,
        payload_length: null,
      }) + "\n",
      "utf8",
    );
    expect(new EventDecoder().feed(wire)).toEqual([
      { type: "describe", data: {} },
    ]);
  });

  it("tolerates a missing version and ignores unknown header fields", () => {
    const wire = Buffer.from(
      JSON.stringify({ type: "played", future_field: [1, 2, 3] }) + "\n",
      "utf8",
    );
    expect(new EventDecoder().feed(wire)).toEqual([
      { type: "played", data: {} },
    ]);
  });

  it("passes unknown event types through (callers ignore them)", () => {
    const wire = Buffer.from(
      JSON.stringify({ type: "select-program" }) + "\n",
      "utf8",
    );
    expect(new EventDecoder().feed(wire)).toEqual([
      { type: "select-program", data: {} },
    ]);
  });
});

describe("decode: protocol violations", () => {
  it("throws FramingError on malformed header JSON, then stays dead", () => {
    const decoder = new EventDecoder();
    expect(() => decoder.feed(Buffer.from("this is not json\n"))).toThrow(
      FramingError,
    );
    expect(() => decoder.feed(Buffer.from("{}\n"))).toThrow(FramingError);
  });

  it("throws FramingError when the header is not an object or lacks type", () => {
    expect(() => new EventDecoder().feed(Buffer.from("42\n"))).toThrow(
      FramingError,
    );
    expect(() =>
      new EventDecoder().feed(Buffer.from('{"data_length": 5}\n')),
    ).toThrow(FramingError);
  });

  it("throws FramingError on malformed data-block JSON", () => {
    const wire = Buffer.from(
      '{"type": "transcript", "data_length": 5}\nnope!',
      "utf8",
    );
    expect(() => new EventDecoder().feed(wire)).toThrow(FramingError);
  });

  it("enforces the 1 MiB header-line guard", () => {
    const decoder = new EventDecoder();
    const junk = Buffer.alloc(1024 * 1024 + 2, 0x61); // no newline anywhere
    expect(() => decoder.feed(junk)).toThrow(FramingError);
  });

  it("enforces the 64 MiB data/payload length guards", () => {
    const over = MAX_BLOCK_BYTES + 1;
    expect(() =>
      new EventDecoder().feed(
        Buffer.from(`{"type": "x", "data_length": ${over}}\n`),
      ),
    ).toThrow(FramingError);
    expect(() =>
      new EventDecoder().feed(
        Buffer.from(`{"type": "x", "payload_length": ${over}}\n`),
      ),
    ).toThrow(FramingError);
  });

  it("rejects negative and non-integer lengths", () => {
    expect(() =>
      new EventDecoder().feed(
        Buffer.from('{"type": "x", "data_length": -1}\n'),
      ),
    ).toThrow(FramingError);
    expect(() =>
      new EventDecoder().feed(
        Buffer.from('{"type": "x", "payload_length": 1.5}\n'),
      ),
    ).toThrow(FramingError);
  });
});
