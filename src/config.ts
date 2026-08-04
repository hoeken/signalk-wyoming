/**
 * Orchestrator configuration — parse + validate (SPEC §4.3) and the JSON
 * schema for the plugin config UI.
 *
 * `parseConfig` throws a plain `Error` with a clear message on invalid input;
 * the plugin start() surfaces it via setPluginError.
 */

import { parseWyomingUri } from "./protocol/client.js";

export const SATELLITE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Reserved id for the plugin-managed local satellite container. */
export const LOCAL_SATELLITE_ID = "local";
export const LOCAL_SATELLITE_NAME = "Local satellite";
export const WYOMING_SATELLITE_PORT = 10700;
export const SATELLITE_CONTROL_PORT = 10800;

export interface SatelliteConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  /**
   * Wake word names this satellite listens for (image WAKE_WORD_NAME / oww
   * model names).
   *
   * Three states, deliberately distinct:
   *   - omitted   → inherit whatever the wake service advertises, so the
   *                 boat's wake word is configured once in the wake plugin
   *                 rather than repeated here for every satellite;
   *   - `[]`      → deliberately no wake detection (a speaker-only satellite);
   *   - non-empty → this satellite's own wake words, overriding the service.
   */
  wakeWords?: string[];
  /**
   * The satellite runs our image and serves the control API (SPEC §4.4/§6:
   * device enumeration, record/play tests, VU meter, record-and-transcribe).
   * Implied by an explicit controlPort.
   */
  hasControlApi?: boolean;
  /** Control API port (default 10800); only set when hasControlApi. */
  controlPort?: number;
}

export type AudioMode = "alsa" | "pulse-socket";

export interface LocalSatelliteConfig {
  enabled: boolean;
  micDevice: string;
  sndDevice: string;
  wakeWords: string[];
  audioMode: AudioMode;
  feedbackSounds: boolean;
  /** Host sound-server socket path for audioMode 'pulse-socket'. */
  hostPulseSocket: string;
  /** webrtc noise suppression level 0-4 (unset = image default). */
  noiseSuppression?: number;
  /** webrtc auto gain 0-31 dbFS (unset = image default). */
  autoGain?: number;
  /** Mic volume multiplier (unset = image default). */
  micVolume?: number;
  /** Image tag; 'auto' runs the floating `latest` with digest tracking. */
  tag: string;
}

export interface ServicesConfig {
  asr: string;
  tts: string;
  wake: string;
}

export interface DefaultsConfig {
  language: string;
  /** Default piper voice; '' = use the TTS service's own configured voice. */
  voice: string;
}

export interface AdvancedConfig {
  silenceMs: number;
  maxUtteranceMs: number;
  minUtteranceMs: number;
  wakeDedupMs: number;
  pipelineTimeoutMs: number;
  /** Satellite image WAKE_REFRACTORY_SECONDS (spec §6 default 3.0). */
  wakeRefractorySeconds: number;
}

export interface OrchestratorConfig {
  satellites: SatelliteConfig[];
  localSatellite: LocalSatelliteConfig;
  services: ServicesConfig;
  defaults: DefaultsConfig;
  advanced: AdvancedConfig;
}

export const DEFAULT_ADVANCED: AdvancedConfig = {
  silenceMs: 800,
  maxUtteranceMs: 10000,
  minUtteranceMs: 300,
  wakeDedupMs: 2000,
  pipelineTimeoutMs: 30000,
  wakeRefractorySeconds: 3.0,
};

export const DEFAULT_LOCAL_SATELLITE: LocalSatelliteConfig = {
  enabled: false,
  micDevice: "auto",
  sndDevice: "auto",
  wakeWords: [],
  audioMode: "alsa",
  feedbackSounds: true,
  hostPulseSocket: "/run/user/1000/pulse/native",
  tag: "auto",
};

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
  fallback: string,
  context: string,
): string {
  const v = obj[key];
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v !== "string") {
    throw new Error(`${context}.${key} must be a string`);
  }
  return v;
}

function optionalNumber(
  obj: Record<string, unknown>,
  key: string,
  fallback: number,
  context: string,
): number {
  const v = obj[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`${context}.${key} must be a number`);
  }
  return v;
}

function optionalBoolean(
  obj: Record<string, unknown>,
  key: string,
  fallback: boolean,
  context: string,
): boolean {
  const v = obj[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") {
    throw new Error(`${context}.${key} must be a boolean`);
  }
  return v;
}

function parseWakeWords(v: unknown, context: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (
    !Array.isArray(v) ||
    v.some((w) => typeof w !== "string" || w.trim() === "")
  ) {
    throw new Error(`${context}.wakeWords must be an array of strings`);
  }
  return v as string[];
}

function parseSatellite(raw: unknown, index: number): SatelliteConfig {
  const context = `satellites[${index}]`;
  if (!isObject(raw)) throw new Error(`${context} must be an object`);
  const id = raw.id;
  if (typeof id !== "string" || id === "") {
    throw new Error(`${context}.id is required`);
  }
  if (!SATELLITE_ID_PATTERN.test(id)) {
    throw new Error(
      `invalid satellite id "${id}" — ids must match ^[a-zA-Z0-9_-]+$ ` +
        `(they become Signal K path segments and REST URL components)`,
    );
  }
  const host = raw.host;
  if (typeof host !== "string" || host.trim() === "") {
    throw new Error(`${context} ("${id}"): host is required`);
  }
  const port = optionalNumber(raw, "port", WYOMING_SATELLITE_PORT, context);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${context} ("${id}"): port must be an integer 1-65535`);
  }
  const sat: SatelliteConfig = {
    id,
    name: optionalString(raw, "name", id, context),
    host: host.trim(),
    port,
  };
  const wakeWords = parseWakeWords(raw.wakeWords, context);
  if (wakeWords !== undefined) sat.wakeWords = wakeWords;
  // Remote satellites running our image expose the control API (Audio
  // screen, record/play/VU proxies, record-and-transcribe). An explicit
  // controlPort implies hasControlApi.
  const hasControlApi = optionalBoolean(
    raw,
    "hasControlApi",
    raw.controlPort !== undefined && raw.controlPort !== null,
    context,
  );
  if (hasControlApi) {
    const controlPort = optionalNumber(
      raw,
      "controlPort",
      SATELLITE_CONTROL_PORT,
      context,
    );
    if (
      !Number.isInteger(controlPort) ||
      controlPort < 1 ||
      controlPort > 65535
    ) {
      throw new Error(
        `${context} ("${id}"): controlPort must be an integer 1-65535`,
      );
    }
    sat.hasControlApi = true;
    sat.controlPort = controlPort;
  }
  return sat;
}

function parseServiceSetting(v: unknown, key: string): string {
  if (v === undefined || v === null || v === "") return "auto";
  if (typeof v !== "string") {
    throw new Error(`services.${key} must be 'auto' or a tcp://host:port URI`);
  }
  if (v === "auto") return v;
  try {
    parseWyomingUri(v);
  } catch (err) {
    throw new Error(
      `services.${key}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return v;
}

function parseLocalSatellite(raw: unknown): LocalSatelliteConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_LOCAL_SATELLITE };
  if (!isObject(raw)) throw new Error("localSatellite must be an object");
  const context = "localSatellite";
  const audioMode = optionalString(raw, "audioMode", "alsa", context);
  if (audioMode !== "alsa" && audioMode !== "pulse-socket") {
    throw new Error(`${context}.audioMode must be 'alsa' or 'pulse-socket'`);
  }
  const cfg: LocalSatelliteConfig = {
    enabled: optionalBoolean(raw, "enabled", false, context),
    micDevice: optionalString(raw, "micDevice", "auto", context),
    sndDevice: optionalString(raw, "sndDevice", "auto", context),
    wakeWords: parseWakeWords(raw.wakeWords, context) ?? [],
    audioMode,
    feedbackSounds: optionalBoolean(raw, "feedbackSounds", true, context),
    hostPulseSocket: optionalString(
      raw,
      "hostPulseSocket",
      DEFAULT_LOCAL_SATELLITE.hostPulseSocket,
      context,
    ),
    tag: optionalString(raw, "tag", "auto", context),
  };
  for (const key of ["noiseSuppression", "autoGain", "micVolume"] as const) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`${context}.${key} must be a number`);
    }
    cfg[key] = v;
  }
  return cfg;
}

function parseAdvanced(raw: unknown): AdvancedConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_ADVANCED };
  if (!isObject(raw)) throw new Error("advanced must be an object");
  const out = { ...DEFAULT_ADVANCED };
  for (const key of Object.keys(DEFAULT_ADVANCED) as (keyof AdvancedConfig)[]) {
    const v = optionalNumber(raw, key, DEFAULT_ADVANCED[key], "advanced");
    if (v <= 0) throw new Error(`advanced.${key} must be > 0`);
    out[key] = v;
  }
  return out;
}

/**
 * Parse and validate the plugin configuration (spec §4.3). Throws Error with
 * a clear message on any invalid field. Unknown fields are ignored.
 */
export function parseConfig(raw: unknown): OrchestratorConfig {
  const root = isObject(raw) ? raw : {};

  const rawSatellites = root.satellites ?? [];
  if (!Array.isArray(rawSatellites)) {
    throw new Error("satellites must be an array");
  }
  const satellites = rawSatellites.map((s, i) => parseSatellite(s, i));

  const seen = new Set<string>();
  for (const sat of satellites) {
    if (seen.has(sat.id)) {
      throw new Error(`duplicate satellite id "${sat.id}"`);
    }
    seen.add(sat.id);
  }

  const localSatellite = parseLocalSatellite(root.localSatellite);
  if (localSatellite.enabled && seen.has(LOCAL_SATELLITE_ID)) {
    throw new Error(
      `satellite id "${LOCAL_SATELLITE_ID}" is reserved for the local satellite ` +
        `container while localSatellite.enabled is true`,
    );
  }

  const rawServices = isObject(root.services) ? root.services : {};
  const services: ServicesConfig = {
    asr: parseServiceSetting(rawServices.asr, "asr"),
    tts: parseServiceSetting(rawServices.tts, "tts"),
    wake: parseServiceSetting(rawServices.wake, "wake"),
  };

  const rawDefaults = isObject(root.defaults) ? root.defaults : {};
  const defaults: DefaultsConfig = {
    language: optionalString(rawDefaults, "language", "en", "defaults"),
    voice: optionalString(rawDefaults, "voice", "", "defaults"),
  };

  return {
    satellites,
    localSatellite,
    services,
    defaults,
    advanced: parseAdvanced(root.advanced),
  };
}

/**
 * The synthetic satellite entry contributed by an enabled local satellite.
 * Host/ports are resolved from the container at runtime.
 */
export function localSatelliteEntry(): {
  id: string;
  name: string;
  port: number;
} {
  return {
    id: LOCAL_SATELLITE_ID,
    name: LOCAL_SATELLITE_NAME,
    port: WYOMING_SATELLITE_PORT,
  };
}

const serviceSchema = (label: string, defaultPort: number) => ({
  type: "string",
  title: label,
  default: "auto",
  description: `'auto' uses discovery (wyoming-service PropertyValues); or a manual tcp://host:${defaultPort} URI`,
});

/** JSON schema for the Signal K plugin config UI (mirrors parseConfig). */
export function buildSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      satellites: {
        type: "array",
        title: "Remote satellites",
        description:
          "Wyoming satellites the orchestrator connects to (each listens on its own host, default port 10700)",
        default: [],
        items: {
          type: "object",
          required: ["id", "host"],
          properties: {
            id: {
              type: "string",
              title: "Id",
              pattern: SATELLITE_ID_PATTERN.source,
              description:
                "Letters/digits/_/- only; becomes voice.satellites.<id> and a REST URL segment",
            },
            name: { type: "string", title: "Name" },
            host: { type: "string", title: "Host" },
            port: {
              type: "number",
              title: "Port",
              default: WYOMING_SATELLITE_PORT,
            },
            wakeWords: {
              type: "array",
              title: "Wake words",
              description:
                "Leave this alone and the satellite listens for whatever the " +
                "wake word plugin is set to — configure the boat's wake word " +
                "once, there. Set model names here (e.g. okay_nabu) only to " +
                "give this satellite different ones.",
              items: { type: "string" },
              default: [],
            },
            hasControlApi: {
              type: "boolean",
              title: "Runs our satellite image (control API)",
              default: false,
              description:
                "Enable when the satellite runs ghcr.io/hoeken/wyoming-satellite — unlocks the webapp Audio screen, record/play tests and record-and-transcribe for this satellite",
            },
            controlPort: {
              type: "number",
              title: "Control API port",
              default: SATELLITE_CONTROL_PORT,
              description: "Only used when the control API is enabled",
            },
          },
        },
      },
      localSatellite: {
        type: "object",
        title: "Local satellite (mic/speaker on this server)",
        properties: {
          enabled: { type: "boolean", title: "Enabled", default: false },
          micDevice: {
            type: "string",
            title: "Microphone device",
            default: "auto",
            description:
              "ALSA device string (see the webapp Audio screen); 'auto' = image default, 'none' = no microphone",
          },
          sndDevice: {
            type: "string",
            title: "Speaker device",
            default: "auto",
            description: "ALSA device string; 'auto' = image default",
          },
          wakeWords: {
            type: "array",
            title: "Wake words",
            description: "openWakeWord model names (e.g. okay_nabu)",
            items: { type: "string" },
            default: [],
          },
          audioMode: {
            type: "string",
            title: "Audio mode",
            enum: ["alsa", "pulse-socket"],
            default: "alsa",
            description:
              "alsa = /dev/snd passthrough (headless hosts); pulse-socket = mount the host sound-server socket (desktop hosts)",
          },
          feedbackSounds: {
            type: "boolean",
            title: "Feedback sounds",
            default: true,
            description: "Play awake/done sounds on wake word interactions",
          },
          hostPulseSocket: {
            type: "string",
            title: "Host pulse socket",
            default: DEFAULT_LOCAL_SATELLITE.hostPulseSocket,
            description: "Sound-server socket path (pulse-socket mode only)",
          },
          noiseSuppression: {
            type: "number",
            title: "Noise suppression (0-4)",
          },
          autoGain: { type: "number", title: "Auto gain (0-31)" },
          micVolume: { type: "number", title: "Mic volume multiplier" },
          tag: {
            type: "string",
            title: "Image tag",
            default: "auto",
            description:
              "ghcr.io/hoeken/wyoming-satellite tag; 'auto' = pinned release",
          },
        },
      },
      services: {
        type: "object",
        title: "Services",
        properties: {
          asr: serviceSchema("Speech-to-text (whisper)", 10300),
          tts: serviceSchema("Text-to-speech (piper)", 10200),
          wake: serviceSchema("Wake word (openwakeword)", 10400),
        },
      },
      defaults: {
        type: "object",
        title: "Defaults",
        properties: {
          language: { type: "string", title: "Language", default: "en" },
          voice: {
            type: "string",
            title: "Voice",
            default: "",
            description:
              "Default piper voice (22.05 kHz voices only); empty = the TTS service's configured voice",
          },
        },
      },
      advanced: {
        type: "object",
        title: "Advanced",
        properties: {
          silenceMs: {
            type: "number",
            title: "End-of-utterance silence (ms)",
            default: DEFAULT_ADVANCED.silenceMs,
          },
          maxUtteranceMs: {
            type: "number",
            title: "Max utterance (ms)",
            default: DEFAULT_ADVANCED.maxUtteranceMs,
          },
          minUtteranceMs: {
            type: "number",
            title: "Min utterance (ms)",
            default: DEFAULT_ADVANCED.minUtteranceMs,
          },
          wakeDedupMs: {
            type: "number",
            title: "Wake dedup window (ms)",
            default: DEFAULT_ADVANCED.wakeDedupMs,
          },
          pipelineTimeoutMs: {
            type: "number",
            title: "Pipeline timeout (ms)",
            default: DEFAULT_ADVANCED.pipelineTimeoutMs,
          },
          wakeRefractorySeconds: {
            type: "number",
            title: "Wake refractory (s)",
            default: DEFAULT_ADVANCED.wakeRefractorySeconds,
          },
        },
      },
    },
  };
}

/** uiSchema companion: collapse the advanced section. */
export function buildUiSchema(): Record<string, unknown> {
  return {
    advanced: {
      "ui:field": "collapsible",
      collapse: { field: "ObjectField", wrapClassName: "panel-group" },
    },
  };
}
