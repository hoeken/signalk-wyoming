/**
 * Wyoming protocol events — typed constructors and tolerant parsers.
 *
 * Serialization mirrors the reference implementation (rhasspy/wyoming 1.10.0)
 * exactly:
 *
 * - Several events always write nullable keys (`timestamp: null`,
 *   `text: null`, `names: null`, ...) so those events always carry a data
 *   block on the wire.
 * - Optional keys that the reference omits when unset are omitted here too.
 * - `width` is BYTES per sample (2 = 16-bit signed little-endian PCM).
 *
 * Parsers are forward-compatible: they treat JSON `null` as "absent", ignore
 * unknown fields, and return `undefined` for events of the wrong type or with
 * missing required fields.
 *
 * This module has zero dependencies and no Signal K imports — it must stay
 * usable standalone (subpath export `signalk-wyoming/protocol`).
 */

/** A single Wyoming event: type + optional JSON data + optional binary payload. */
export interface WyomingEvent {
  type: string;
  data?: Record<string, unknown>;
  payload?: Buffer;
}

/** PCM format descriptor. `width` is bytes per sample (2 = 16-bit). */
export interface AudioFormat {
  rate: number;
  width: number;
  channels: number;
}

// ---------------------------------------------------------------------------
// Info structures (wire-shaped: snake_case, nullables serialized as null)
// ---------------------------------------------------------------------------

export interface Attribution {
  name: string;
  url: string;
}

/**
 * Base of every program/model/voice/satellite in an `info` response.
 * The reference serializes every field (nulls included); parsing here is
 * lenient, so everything but `name` is optional.
 */
export interface Artifact {
  name: string;
  attribution?: Attribution;
  installed?: boolean;
  description?: string | null;
  version?: string | null;
}

export interface AsrModel extends Artifact {
  languages?: string[];
}

export interface AsrProgram extends Artifact {
  models?: AsrModel[];
  supports_transcript_streaming?: boolean;
  requires_external_vad?: boolean;
  prefers_auto_gain_enabled?: boolean;
  prefers_noise_reduction_enabled?: boolean;
}

export interface TtsVoiceSpeaker {
  name: string;
}

export interface TtsVoice extends Artifact {
  languages?: string[];
  speakers?: TtsVoiceSpeaker[] | null;
}

export interface TtsProgram extends Artifact {
  voices?: TtsVoice[];
  supports_synthesize_streaming?: boolean;
}

export interface WakeModel extends Artifact {
  languages?: string[];
  phrase?: string | null;
}

export interface WakeProgram extends Artifact {
  models?: WakeModel[];
}

export interface MicProgram extends Artifact {
  mic_format?: AudioFormat;
}

export interface SndProgram extends Artifact {
  snd_format?: AudioFormat;
}

export interface Satellite extends Artifact {
  area?: string | null;
  has_vad?: boolean | null;
  active_wake_words?: string[] | null;
  max_active_wake_words?: number | null;
  supports_trigger?: boolean | null;
}

/** Payload of an `info` event. The seven lists are always present. */
export interface Info {
  asr: AsrProgram[];
  tts: TtsProgram[];
  handle: unknown[];
  intent: unknown[];
  wake: WakeProgram[];
  mic: MicProgram[];
  snd: SndProgram[];
  satellite?: Satellite;
}

// ---------------------------------------------------------------------------
// Misc shared types
// ---------------------------------------------------------------------------

/**
 * Voice selector for `synthesize`. Serialization rule (reference
 * `SynthesizeVoice.to_dict`): `name` (+ optional `speaker`) XOR `language` —
 * when `name` is set, `language` is never sent.
 */
export interface SynthesizeVoice {
  name?: string;
  speaker?: string;
  language?: string;
}

export type PipelineStage = "wake" | "asr" | "intent" | "handle" | "tts";

const STAGE_ORDER: readonly PipelineStage[] = [
  "wake",
  "asr",
  "intent",
  "handle",
  "tts",
];

function isPipelineStage(v: unknown): v is PipelineStage {
  return (
    typeof v === "string" && STAGE_ORDER.includes(v as unknown as PipelineStage)
  );
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

function ev(
  type: string,
  data?: Record<string, unknown>,
  payload?: Buffer,
): WyomingEvent {
  const e: WyomingEvent = { type };
  if (data !== undefined) e.data = data;
  if (payload !== undefined) e.payload = payload;
  return e;
}

/** `describe` — header-only service discovery request. */
export function Describe(): WyomingEvent {
  return ev("describe");
}

/** `info` — service discovery response. */
export function InfoEvent(info: Info): WyomingEvent {
  return ev("info", { ...info } as unknown as Record<string, unknown>);
}

export interface Transcribe {
  name?: string;
  language?: string;
  context?: Record<string, unknown>;
}

/** `transcribe` — start an ASR session. With no options: header-only. */
export function Transcribe(opts: Transcribe = {}): WyomingEvent {
  const data: Record<string, unknown> = {};
  if (opts.name !== undefined) data.name = opts.name;
  if (opts.language !== undefined) data.language = opts.language;
  if (opts.context !== undefined) data.context = opts.context;
  return ev("transcribe", data);
}

export interface Transcript {
  text: string;
  language?: string;
}

/** `transcript` — ASR result. */
export function Transcript(
  text: string,
  opts: { language?: string } = {},
): WyomingEvent {
  const data: Record<string, unknown> = { text };
  if (opts.language !== undefined) data.language = opts.language;
  return ev("transcript", data);
}

/** `transcript-start` — begin a streaming ASR response. */
export function TranscriptStart(
  opts: { language?: string } = {},
): WyomingEvent {
  const data: Record<string, unknown> = {};
  if (opts.language !== undefined) data.language = opts.language;
  return ev("transcript-start", data);
}

export interface TranscriptChunk {
  text: string;
}

/** `transcript-chunk` — piece of a streaming ASR response. */
export function TranscriptChunk(text: string): WyomingEvent {
  return ev("transcript-chunk", { text });
}

/** `transcript-stop` — end of a streaming ASR response. */
export function TranscriptStop(): WyomingEvent {
  return ev("transcript-stop");
}

export interface Synthesize {
  text: string;
  voice?: SynthesizeVoice;
}

/** `synthesize` — TTS request. */
export function Synthesize(
  text: string,
  opts: { voice?: SynthesizeVoice } = {},
): WyomingEvent {
  const data: Record<string, unknown> = { text };
  if (opts.voice !== undefined) {
    data.voice = serializeSynthesizeVoice(opts.voice);
  }
  return ev("synthesize", data);
}

function serializeSynthesizeVoice(
  voice: SynthesizeVoice,
): Record<string, unknown> {
  // Reference SynthesizeVoice.to_dict(): name (+speaker) overrides language.
  if (voice.name !== undefined) {
    const out: Record<string, unknown> = { name: voice.name };
    if (voice.speaker) out.speaker = voice.speaker;
    return out;
  }
  if (voice.language !== undefined) return { language: voice.language };
  return {};
}

export interface AudioStart extends AudioFormat {
  timestamp?: number;
}

/** `audio-start` — begin an audio stream. `timestamp` serialized as null when unset. */
export function AudioStart(
  format: AudioFormat,
  timestamp?: number,
): WyomingEvent {
  return ev("audio-start", {
    rate: format.rate,
    width: format.width,
    channels: format.channels,
    timestamp: timestamp ?? null,
  });
}

export interface AudioChunk extends AudioFormat {
  timestamp?: number;
  /** Raw headerless PCM (signed little-endian). */
  audio: Buffer;
}

/** `audio-chunk` — raw PCM payload. */
export function AudioChunk(
  format: AudioFormat,
  audio: Buffer,
  timestamp?: number,
): WyomingEvent {
  return ev(
    "audio-chunk",
    {
      rate: format.rate,
      width: format.width,
      channels: format.channels,
      timestamp: timestamp ?? null,
    },
    audio,
  );
}

export interface AudioStop {
  timestamp?: number;
}

/** `audio-stop` — end of an audio stream. */
export function AudioStop(timestamp?: number): WyomingEvent {
  return ev("audio-stop", { timestamp: timestamp ?? null });
}

export interface Detect {
  /** Wake word names to listen for; absent = any. */
  names?: string[];
}

/** `detect` — start wake word detection. `names` serialized as null when unset. */
export function Detect(names?: string[]): WyomingEvent {
  return ev("detect", { names: names ?? null });
}

export interface Detection {
  name?: string;
  timestamp?: number;
  speaker?: string;
}

/** `detection` — a wake word was detected. All keys serialized (null when unset). */
export function Detection(opts: Detection = {}): WyomingEvent {
  return ev("detection", {
    name: opts.name ?? null,
    timestamp: opts.timestamp ?? null,
    speaker: opts.speaker ?? null,
  });
}

/** `not-detected` — audio stream ended without a detection. */
export function NotDetected(): WyomingEvent {
  return ev("not-detected");
}

/** `run-satellite` — server is ready to run a pipeline (header-only). */
export function RunSatellite(): WyomingEvent {
  return ev("run-satellite");
}

/** `pause-satellite` — server is not ready (header-only). */
export function PauseSatellite(): WyomingEvent {
  return ev("pause-satellite");
}

/** `streaming-started` — satellite started streaming mic audio (header-only). */
export function StreamingStarted(): WyomingEvent {
  return ev("streaming-started");
}

/** `streaming-stopped` — satellite stopped streaming (header-only). */
export function StreamingStopped(): WyomingEvent {
  return ev("streaming-stopped");
}

export interface RunPipeline {
  startStage: PipelineStage;
  endStage: PipelineStage;
  restartOnEnd: boolean;
  name?: string;
  wakeWordName?: string;
  wakeWordNames?: string[];
  announceText?: string;
  sndFormat?: AudioFormat;
}

export interface RunPipelineOptions {
  startStage: PipelineStage;
  endStage: PipelineStage;
  restartOnEnd?: boolean;
  name?: string;
  wakeWordName?: string;
  /** Omitted from the wire when empty (reference truthy check). */
  wakeWordNames?: string[];
  announceText?: string;
  sndFormat?: AudioFormat;
}

/** `run-pipeline` — request a pipeline run. Validates stage ordering. */
export function RunPipeline(opts: RunPipelineOptions): WyomingEvent {
  const startIdx = STAGE_ORDER.indexOf(opts.startStage);
  const endIdx = STAGE_ORDER.indexOf(opts.endStage);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(
      `invalid pipeline stages: start_stage=${opts.startStage} end_stage=${opts.endStage}`,
    );
  }
  const data: Record<string, unknown> = {
    start_stage: opts.startStage,
    end_stage: opts.endStage,
    restart_on_end: opts.restartOnEnd ?? false,
  };
  if (opts.name !== undefined) data.name = opts.name;
  if (opts.wakeWordName !== undefined) data.wake_word_name = opts.wakeWordName;
  if (opts.wakeWordNames !== undefined && opts.wakeWordNames.length > 0) {
    data.wake_word_names = opts.wakeWordNames;
  }
  if (opts.announceText !== undefined) data.announce_text = opts.announceText;
  if (opts.sndFormat !== undefined) {
    data.snd_format = {
      rate: opts.sndFormat.rate,
      width: opts.sndFormat.width,
      channels: opts.sndFormat.channels,
    };
  }
  return ev("run-pipeline", data);
}

export interface Ping {
  text?: string;
}

/** `ping` — keepalive request. `text` serialized as null when unset. */
export function Ping(text?: string): WyomingEvent {
  return ev("ping", { text: text ?? null });
}

export interface Pong {
  text?: string;
}

/** `pong` — keepalive response, echoing the ping's text. */
export function Pong(text?: string): WyomingEvent {
  return ev("pong", { text: text ?? null });
}

export interface ErrorEvent {
  text: string;
  code?: string;
}

/** `error` — human-readable `text` plus optional machine-readable `code`. */
export function ErrorEvent(text: string, code?: string): WyomingEvent {
  const data: Record<string, unknown> = { text };
  if (code !== undefined) data.code = code;
  return ev("error", data);
}

/** `played` — audio finished playing on the output device (header-only). */
export function Played(): WyomingEvent {
  return ev("played");
}

export interface VoiceStarted {
  timestamp?: number;
}

/** `voice-started` — VAD: voice activity began. */
export function VoiceStarted(timestamp?: number): WyomingEvent {
  return ev("voice-started", { timestamp: timestamp ?? null });
}

export interface VoiceStopped {
  timestamp?: number;
}

/** `voice-stopped` — VAD: voice activity ended. */
export function VoiceStopped(timestamp?: number): WyomingEvent {
  return ev("voice-stopped", { timestamp: timestamp ?? null });
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function dataOf(e: WyomingEvent): Record<string, unknown> {
  return e.data ?? {};
}

function optString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function optNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function optBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function optStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

function optObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function optAudioFormat(v: unknown): AudioFormat | undefined {
  const obj = optObject(v);
  if (obj === undefined) return undefined;
  const rate = optNumber(obj.rate);
  const width = optNumber(obj.width);
  const channels = optNumber(obj.channels);
  if (rate === undefined || width === undefined || channels === undefined) {
    return undefined;
  }
  return { rate, width, channels };
}

/** Parse an `info` event. Missing program lists become empty arrays. */
export function parseInfo(e: WyomingEvent): Info | undefined {
  if (e.type !== "info") return undefined;
  const data = dataOf(e);
  const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const info: Info = {
    asr: list<AsrProgram>(data.asr),
    tts: list<TtsProgram>(data.tts),
    handle: list<unknown>(data.handle),
    intent: list<unknown>(data.intent),
    wake: list<WakeProgram>(data.wake),
    mic: list<MicProgram>(data.mic),
    snd: list<SndProgram>(data.snd),
  };
  const satellite = optObject(data.satellite);
  if (satellite !== undefined) {
    info.satellite = satellite as unknown as Satellite;
  }
  return info;
}

export function parseTranscribe(e: WyomingEvent): Transcribe | undefined {
  if (e.type !== "transcribe") return undefined;
  const data = dataOf(e);
  const out: Transcribe = {};
  const name = optString(data.name);
  if (name !== undefined) out.name = name;
  const language = optString(data.language);
  if (language !== undefined) out.language = language;
  const context = optObject(data.context);
  if (context !== undefined) out.context = context;
  return out;
}

export function parseTranscript(e: WyomingEvent): Transcript | undefined {
  if (e.type !== "transcript") return undefined;
  const data = dataOf(e);
  const text = optString(data.text);
  if (text === undefined) return undefined;
  const out: Transcript = { text };
  const language = optString(data.language);
  if (language !== undefined) out.language = language;
  return out;
}

export function parseTranscriptChunk(
  e: WyomingEvent,
): TranscriptChunk | undefined {
  if (e.type !== "transcript-chunk") return undefined;
  const text = optString(dataOf(e).text);
  if (text === undefined) return undefined;
  return { text };
}

export function parseSynthesize(e: WyomingEvent): Synthesize | undefined {
  if (e.type !== "synthesize") return undefined;
  const data = dataOf(e);
  const text = optString(data.text);
  if (text === undefined) return undefined;
  const out: Synthesize = { text };
  const voiceObj = optObject(data.voice);
  if (voiceObj !== undefined) {
    // Reference SynthesizeVoice.from_dict: None unless name or language set.
    const name = optString(voiceObj.name);
    const speaker = optString(voiceObj.speaker);
    const language = optString(voiceObj.language);
    if (name !== undefined) {
      out.voice = speaker !== undefined ? { name, speaker } : { name };
    } else if (language !== undefined) {
      out.voice = { language };
    }
  }
  return out;
}

export function parseAudioStart(e: WyomingEvent): AudioStart | undefined {
  if (e.type !== "audio-start") return undefined;
  const data = dataOf(e);
  const format = optAudioFormat(data);
  if (format === undefined) return undefined;
  const out: AudioStart = { ...format };
  const timestamp = optNumber(data.timestamp);
  if (timestamp !== undefined) out.timestamp = timestamp;
  return out;
}

export function parseAudioChunk(e: WyomingEvent): AudioChunk | undefined {
  if (e.type !== "audio-chunk") return undefined;
  const data = dataOf(e);
  const format = optAudioFormat(data);
  if (format === undefined) return undefined;
  const out: AudioChunk = { ...format, audio: e.payload ?? Buffer.alloc(0) };
  const timestamp = optNumber(data.timestamp);
  if (timestamp !== undefined) out.timestamp = timestamp;
  return out;
}

export function parseAudioStop(e: WyomingEvent): AudioStop | undefined {
  if (e.type !== "audio-stop") return undefined;
  const out: AudioStop = {};
  const timestamp = optNumber(dataOf(e).timestamp);
  if (timestamp !== undefined) out.timestamp = timestamp;
  return out;
}

export function parseDetect(e: WyomingEvent): Detect | undefined {
  if (e.type !== "detect") return undefined;
  const out: Detect = {};
  const names = optStringArray(dataOf(e).names);
  if (names !== undefined) out.names = names;
  return out;
}

export function parseDetection(e: WyomingEvent): Detection | undefined {
  if (e.type !== "detection") return undefined;
  const data = dataOf(e);
  const out: Detection = {};
  const name = optString(data.name);
  if (name !== undefined) out.name = name;
  const timestamp = optNumber(data.timestamp);
  if (timestamp !== undefined) out.timestamp = timestamp;
  const speaker = optString(data.speaker);
  if (speaker !== undefined) out.speaker = speaker;
  return out;
}

export function parseRunPipeline(e: WyomingEvent): RunPipeline | undefined {
  if (e.type !== "run-pipeline") return undefined;
  const data = dataOf(e);
  if (!isPipelineStage(data.start_stage) || !isPipelineStage(data.end_stage)) {
    return undefined;
  }
  const out: RunPipeline = {
    startStage: data.start_stage,
    endStage: data.end_stage,
    restartOnEnd: optBoolean(data.restart_on_end) ?? false,
  };
  const name = optString(data.name);
  if (name !== undefined) out.name = name;
  const wakeWordName = optString(data.wake_word_name);
  if (wakeWordName !== undefined) out.wakeWordName = wakeWordName;
  const wakeWordNames = optStringArray(data.wake_word_names);
  if (wakeWordNames !== undefined) out.wakeWordNames = wakeWordNames;
  const announceText = optString(data.announce_text);
  if (announceText !== undefined) out.announceText = announceText;
  const sndFormat = optAudioFormat(data.snd_format);
  if (sndFormat !== undefined) out.sndFormat = sndFormat;
  return out;
}

export function parsePing(e: WyomingEvent): Ping | undefined {
  if (e.type !== "ping") return undefined;
  const out: Ping = {};
  const text = optString(dataOf(e).text);
  if (text !== undefined) out.text = text;
  return out;
}

export function parsePong(e: WyomingEvent): Pong | undefined {
  if (e.type !== "pong") return undefined;
  const out: Pong = {};
  const text = optString(dataOf(e).text);
  if (text !== undefined) out.text = text;
  return out;
}

export function parseError(e: WyomingEvent): ErrorEvent | undefined {
  if (e.type !== "error") return undefined;
  const data = dataOf(e);
  const text = optString(data.text);
  if (text === undefined) return undefined;
  const out: ErrorEvent = { text };
  const code = optString(data.code);
  if (code !== undefined) out.code = code;
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Duration in milliseconds of `byteLength` bytes of PCM in `format`. */
export function pcmDurationMs(byteLength: number, format: AudioFormat): number {
  const bytesPerSecond = format.rate * format.width * format.channels;
  if (bytesPerSecond <= 0) return 0;
  return (byteLength / bytesPerSecond) * 1000;
}
