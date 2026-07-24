import { describe, expect, it } from "vitest";
import {
  AudioChunk,
  AudioStart,
  Describe,
  Detect,
  Detection,
  ErrorEvent,
  parseAudioChunk,
  parseAudioStart,
  parseDetect,
  parseDetection,
  parseError,
  parseInfo,
  parsePing,
  parseRunPipeline,
  parseSynthesize,
  parseTranscribe,
  parseTranscript,
  pcmDurationMs,
  Ping,
  Pong,
  RunPipeline,
  Synthesize,
  Transcribe,
  Transcript,
} from "../src/protocol/events.js";

describe("constructors: reference serialization rules", () => {
  it("describe is header-only (no data)", () => {
    expect(Describe()).toEqual({ type: "describe" });
  });

  it("audio events always serialize timestamp (null when unset)", () => {
    const format = { rate: 16000, width: 2, channels: 1 };
    expect(AudioStart(format).data).toEqual({ ...format, timestamp: null });
    expect(AudioStart(format, 42).data).toEqual({ ...format, timestamp: 42 });
    const chunk = AudioChunk(format, Buffer.from([1, 2]));
    expect(chunk.data).toEqual({ ...format, timestamp: null });
    expect(chunk.payload).toEqual(Buffer.from([1, 2]));
  });

  it("detect serializes names as null when unset", () => {
    expect(Detect().data).toEqual({ names: null });
    expect(Detect(["okay_nabu"]).data).toEqual({ names: ["okay_nabu"] });
  });

  it("detection always serializes name/timestamp/speaker (null-ok)", () => {
    expect(Detection().data).toEqual({
      name: null,
      timestamp: null,
      speaker: null,
    });
    expect(Detection({ name: "okay_nabu", timestamp: 7 }).data).toEqual({
      name: "okay_nabu",
      timestamp: 7,
      speaker: null,
    });
  });

  it("synthesize voice: name (+speaker) wins over language", () => {
    expect(
      Synthesize("hi", { voice: { name: "v", speaker: "s", language: "en" } })
        .data,
    ).toEqual({ text: "hi", voice: { name: "v", speaker: "s" } });
    expect(Synthesize("hi", { voice: { name: "v" } }).data).toEqual({
      text: "hi",
      voice: { name: "v" },
    });
  });

  it("synthesize voice: language-only", () => {
    expect(Synthesize("hi", { voice: { language: "en" } }).data).toEqual({
      text: "hi",
      voice: { language: "en" },
    });
  });

  it("transcribe with no options produces an empty data dict", () => {
    expect(Transcribe().data).toEqual({});
    expect(Transcribe({ name: "m", language: "en" }).data).toEqual({
      name: "m",
      language: "en",
    });
  });

  it("ping/pong always serialize text (null when unset)", () => {
    expect(Ping().data).toEqual({ text: null });
    expect(Ping("x").data).toEqual({ text: "x" });
    expect(Pong("x").data).toEqual({ text: "x" });
  });

  it("error carries text and optional code", () => {
    expect(ErrorEvent("boom").data).toEqual({ text: "boom" });
    expect(ErrorEvent("boom", "bad").data).toEqual({
      text: "boom",
      code: "bad",
    });
  });

  it("run-pipeline serializes snake_case with restart_on_end default false", () => {
    const e = RunPipeline({
      startStage: "asr",
      endStage: "tts",
      wakeWordName: "okay_nabu",
      sndFormat: { rate: 22050, width: 2, channels: 1 },
    });
    expect(e.data).toEqual({
      start_stage: "asr",
      end_stage: "tts",
      restart_on_end: false,
      wake_word_name: "okay_nabu",
      snd_format: { rate: 22050, width: 2, channels: 1 },
    });
  });

  it("run-pipeline omits wake_word_names when empty, keeps it when non-empty", () => {
    const empty = RunPipeline({
      startStage: "wake",
      endStage: "tts",
      wakeWordNames: [],
    });
    expect(empty.data).not.toHaveProperty("wake_word_names");
    const named = RunPipeline({
      startStage: "wake",
      endStage: "tts",
      wakeWordNames: ["okay_nabu"],
    });
    expect(named.data).toHaveProperty("wake_word_names", ["okay_nabu"]);
  });

  it("run-pipeline rejects out-of-order stages", () => {
    expect(() => RunPipeline({ startStage: "tts", endStage: "asr" })).toThrow(
      /invalid pipeline stages/,
    );
  });
});

describe("parsers: tolerant reads", () => {
  it("return undefined for events of the wrong type", () => {
    expect(parseTranscript(Describe())).toBeUndefined();
    expect(parseInfo(Describe())).toBeUndefined();
    expect(parseSynthesize(Transcript("x"))).toBeUndefined();
  });

  it("parseTranscript requires text and ignores unknown fields", () => {
    expect(
      parseTranscript({
        type: "transcript",
        data: { text: "hello", language: "en", confidence: 0.9 },
      }),
    ).toEqual({ text: "hello", language: "en" });
    expect(parseTranscript({ type: "transcript", data: {} })).toBeUndefined();
    expect(parseTranscript({ type: "transcript", data: { text: "" } })).toEqual(
      { text: "" },
    );
  });

  it("treats JSON null as absent", () => {
    expect(
      parseDetection({
        type: "detection",
        data: { name: null, timestamp: null, speaker: null },
      }),
    ).toEqual({});
    expect(parsePing({ type: "ping", data: { text: null } })).toEqual({});
    expect(parseDetect({ type: "detect", data: { names: null } })).toEqual({});
    expect(
      parseTranscribe({ type: "transcribe", data: { language: null } }),
    ).toEqual({});
  });

  it("parseInfo fills missing program lists and keeps satellite", () => {
    const info = parseInfo({
      type: "info",
      data: {
        asr: [{ name: "w" }],
        satellite: { name: "sat", area: null },
        unknown_future_key: 1,
      },
    });
    expect(info).toBeDefined();
    expect(info?.asr).toEqual([{ name: "w" }]);
    expect(info?.tts).toEqual([]);
    expect(info?.wake).toEqual([]);
    expect(info?.mic).toEqual([]);
    expect(info?.snd).toEqual([]);
    expect(info?.handle).toEqual([]);
    expect(info?.intent).toEqual([]);
    expect(info?.satellite?.name).toBe("sat");
  });

  it("parseSynthesize applies the voice name/language rules", () => {
    expect(
      parseSynthesize({
        type: "synthesize",
        data: { text: "t", voice: { name: "v", speaker: "s" } },
      }),
    ).toEqual({ text: "t", voice: { name: "v", speaker: "s" } });
    expect(
      parseSynthesize({
        type: "synthesize",
        data: { text: "t", voice: { language: "en" } },
      }),
    ).toEqual({ text: "t", voice: { language: "en" } });
    // Voice with neither name nor language parses as no voice at all.
    expect(
      parseSynthesize({ type: "synthesize", data: { text: "t", voice: {} } }),
    ).toEqual({ text: "t" });
  });

  it("parseRunPipeline maps snake_case and defaults restartOnEnd", () => {
    expect(
      parseRunPipeline({
        type: "run-pipeline",
        data: {
          start_stage: "asr",
          end_stage: "tts",
          restart_on_end: false,
          snd_format: { rate: 22050, width: 2, channels: 1 },
        },
      }),
    ).toEqual({
      startStage: "asr",
      endStage: "tts",
      restartOnEnd: false,
      sndFormat: { rate: 22050, width: 2, channels: 1 },
    });
    expect(
      parseRunPipeline({
        type: "run-pipeline",
        data: { start_stage: "asr" },
      }),
    ).toBeUndefined();
    expect(
      parseRunPipeline({
        type: "run-pipeline",
        data: { start_stage: "asr", end_stage: "nonsense" },
      }),
    ).toBeUndefined();
  });

  it("parseAudioStart/Chunk require the format fields", () => {
    expect(
      parseAudioStart({
        type: "audio-start",
        data: { rate: 16000, width: 2, channels: 1, timestamp: null },
      }),
    ).toEqual({ rate: 16000, width: 2, channels: 1 });
    expect(
      parseAudioStart({ type: "audio-start", data: { rate: 16000 } }),
    ).toBeUndefined();
    // A chunk without payload is legal and yields empty audio.
    const chunk = parseAudioChunk({
      type: "audio-chunk",
      data: { rate: 16000, width: 2, channels: 1, timestamp: 5 },
    });
    expect(chunk?.audio).toEqual(Buffer.alloc(0));
    expect(chunk?.timestamp).toBe(5);
  });

  it("parseError requires text", () => {
    expect(
      parseError({ type: "error", data: { text: "boom", code: "c" } }),
    ).toEqual({ text: "boom", code: "c" });
    expect(parseError({ type: "error", data: {} })).toBeUndefined();
  });
});

describe("pcmDurationMs", () => {
  it("derives milliseconds from byte length and format", () => {
    // 16 kHz, 16-bit mono: 32000 bytes/s => 2048 bytes = 64 ms
    expect(pcmDurationMs(2048, { rate: 16000, width: 2, channels: 1 })).toBe(
      64,
    );
    expect(pcmDurationMs(0, { rate: 16000, width: 2, channels: 1 })).toBe(0);
    expect(pcmDurationMs(100, { rate: 0, width: 2, channels: 1 })).toBe(0);
  });
});
