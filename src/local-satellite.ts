/**
 * Local satellite container — ManagedContainer wrapping
 * ghcr.io/hoeken/wyoming-satellite (mic/speaker on the Signal K server box).
 *
 * The control API on :10800 is plain HTTP, so — unlike the raw-TCP Wyoming
 * services — the helper's HTTP readiness gate IS usable here
 * (readiness: {port: 10800, path: '/health'}).
 *
 * signalk-container 1.23.2 silently drops `devices`/`groupAdd`, so the
 * container gets no /dev/snd until the manager grows support; the config
 * carries the fields forward-compatibly and `checkAudioDevices()` surfaces
 * the gap honestly at runtime (M0 coordination item).
 */

import {
  ManagedContainer,
  type ContainerConfig,
} from "signalk-container-helper";
import type { AdvancedConfig, LocalSatelliteConfig } from "./config.js";
import { SATELLITE_CONTROL_PORT, WYOMING_SATELLITE_PORT } from "./config.js";
import { parseWyomingUri } from "./protocol/client.js";

export const LOCAL_SATELLITE_IMAGE = "ghcr.io/hoeken/wyoming-satellite";
export const LOCAL_SATELLITE_PINNED_TAG = "0.1.1";
export const LOCAL_SATELLITE_CONTAINER_NAME = "wyoming-satellite";
/** In-container alias for the Signal K host (extraHosts host-gateway). */
export const SK_HOST_ALIAS = "skhost";
const PULSE_SOCKET_CONTAINER_PATH = "/run/pulse-socket";

export interface LocalSatelliteBuildInputs {
  local: LocalSatelliteConfig;
  advanced: AdvancedConfig;
  /** Resolved wake service URI (null = no wake service → WAKE_URI unwired). */
  wakeUri: string | null;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

/**
 * WAKE_URI as seen from inside the container. The sibling openwakeword
 * plugin emits a loopback URI (spec: 127.0.0.1 with advertiseHost override) —
 * loopback is the container's own namespace, so it maps to the `skhost`
 * host-gateway alias. Any other host (manual off-box `services.wake`
 * override, spec §3.1) passes through verbatim.
 */
export function containerWakeUri(uri: string): string {
  try {
    const { host, port } = parseWyomingUri(uri);
    if (LOOPBACK_HOSTS.has(host)) return `tcp://${SK_HOST_ALIAS}:${port}`;
    return uri;
  } catch {
    // URI shape is validated at config load / by the emitting plugin — a
    // parse quirk here must not break announce-only startup.
    return uri;
  }
}

/** Env block for the satellite image (pure — unit-tested directly). */
export function buildLocalSatelliteEnv(
  inputs: LocalSatelliteBuildInputs,
): Record<string, string> {
  const { local, advanced, wakeUri } = inputs;
  const env: Record<string, string> = {};
  if (local.micDevice !== "auto") env.MIC_DEVICE = local.micDevice;
  if (local.sndDevice !== "auto") env.SND_DEVICE = local.sndDevice;
  if (wakeUri !== null && local.wakeWords.length > 0) {
    env.WAKE_URI = containerWakeUri(wakeUri);
    env.WAKE_WORD_NAME = local.wakeWords.join(" ");
    env.WAKE_REFRACTORY_SECONDS = String(advanced.wakeRefractorySeconds);
  }
  if (local.noiseSuppression !== undefined) {
    env.NOISE_SUPPRESSION = String(local.noiseSuppression);
  }
  if (local.autoGain !== undefined) env.AUTO_GAIN = String(local.autoGain);
  if (local.micVolume !== undefined) env.MIC_VOLUME = String(local.micVolume);
  if (!local.feedbackSounds) {
    env.AWAKE_WAV = "none";
    env.DONE_WAV = "none";
  }
  if (local.audioMode === "pulse-socket") {
    env.PULSE_SERVER = `unix://${PULSE_SOCKET_CONTAINER_PATH}`;
  }
  return env;
}

/** Full ContainerConfig for a tag (pure — unit-tested directly). */
export function buildLocalSatelliteConfig(
  tag: string,
  inputs: LocalSatelliteBuildInputs,
): ContainerConfig {
  const { local } = inputs;
  const config: ContainerConfig = {
    image: LOCAL_SATELLITE_IMAGE,
    tag,
    env: buildLocalSatelliteEnv(inputs),
    signalkAccessiblePorts: [WYOMING_SATELLITE_PORT, SATELLITE_CONTROL_PORT],
    restart: "unless-stopped",
    resources: { memory: "256m", memorySwap: "256m" },
  };
  if (inputs.wakeUri !== null && local.wakeWords.length > 0) {
    // Reaches the host's openwakeword from inside the container; works for
    // bare-metal and containerized Signal K alike (docker ≥20.10/podman ≥4.1).
    // Harmless when WAKE_URI points off-box and never uses the alias.
    config.extraHosts = { [SK_HOST_ALIAS]: "host-gateway" };
  }
  if (local.audioMode === "pulse-socket") {
    config.volumes = { [PULSE_SOCKET_CONTAINER_PATH]: local.hostPulseSocket };
  }
  // Forward-compatible audio-device fields: silently dropped by
  // signalk-container 1.23.2 (no drift loops), applied once the manager
  // ships /dev/snd passthrough support.
  const forward = config as ContainerConfig & {
    devices?: string[];
    groupAdd?: string[];
  };
  forward.devices = ["/dev/snd"];
  forward.groupAdd = ["audio"];
  return config;
}

export interface LocalSatelliteAddresses {
  /** Wyoming endpoint. */
  host: string;
  port: number;
  /** Control API endpoint. */
  controlHost: string;
  controlPort: number;
}

export interface LocalSatelliteAppLike {
  debug(msg: string): void;
  setPluginStatus(msg: string): void;
  setPluginError(msg: string): void;
}

export interface LocalSatelliteDeps {
  app: LocalSatelliteAppLike;
  local: LocalSatelliteConfig;
  advanced: AdvancedConfig;
  /**
   * Live getter for the resolved wake service URI — read on every container
   * (re)start so wake wiring follows discovery instead of freezing a
   * plugin-start snapshot (spec §3.1: start order never matters).
   */
  wakeUri: () => string | null;
  fetchImpl?: typeof fetch;
}

export interface LocalSatelliteHandle {
  container: ManagedContainer;
  /** Start the container and resolve its Wyoming + control addresses. */
  start(): Promise<LocalSatelliteAddresses>;
  stop(): Promise<void>;
  /**
   * True when the env the container was last started with differs from the
   * currently-desired env (e.g. the wake service appeared or moved after
   * start) — calling start() again lets ensureRunning's drift detection
   * recreate the container with the new env.
   */
  needsRestart(): boolean;
  /**
   * Probe the control API's /devices; returns a warning string when the
   * container sees no audio devices (the signalk-container passthrough gap),
   * null when devices are present or the probe is inconclusive.
   */
  checkAudioDevices(addresses: LocalSatelliteAddresses): Promise<string | null>;
}

export function createLocalSatellite(
  deps: LocalSatelliteDeps,
): LocalSatelliteHandle {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const currentInputs = (): LocalSatelliteBuildInputs => ({
    local: deps.local,
    advanced: deps.advanced,
    wakeUri: deps.wakeUri(),
  });
  const envKey = (): string =>
    JSON.stringify(buildLocalSatelliteEnv(currentInputs()));
  let startedEnvKey: string | null = null;
  const container = new ManagedContainer({
    app: deps.app,
    pluginId: "signalk-wyoming",
    name: LOCAL_SATELLITE_CONTAINER_NAME,
    image: LOCAL_SATELLITE_IMAGE,
    defaultTag: "auto",
    resolveTag: (requested) =>
      requested === "auto" ? LOCAL_SATELLITE_PINNED_TAG : requested,
    buildConfig: (tag) => buildLocalSatelliteConfig(tag, currentInputs()),
    // Control API is HTTP — helper readiness applies (unlike Wyoming TCP).
    readiness: { port: SATELLITE_CONTROL_PORT, path: "/health" },
  });

  return {
    container,

    async start(): Promise<LocalSatelliteAddresses> {
      startedEnvKey = envKey();
      await container.start(deps.local.tag);
      const wyoming = await container.resolveAddress(WYOMING_SATELLITE_PORT);
      const control = await container.resolveAddress(SATELLITE_CONTROL_PORT);
      if (wyoming === null || control === null) {
        throw new Error(
          "local satellite started but its address could not be resolved",
        );
      }
      const [host, port] = splitHostPort(wyoming);
      const [controlHost, controlPort] = splitHostPort(control);
      return { host, port, controlHost, controlPort };
    },

    async stop(): Promise<void> {
      // Never leave an orphaned open microphone (spec §4.3).
      await container.stop();
    },

    needsRestart(): boolean {
      return startedEnvKey !== null && startedEnvKey !== envKey();
    },

    async checkAudioDevices(
      addresses: LocalSatelliteAddresses,
    ): Promise<string | null> {
      if (deps.local.micDevice === "none") return null;
      try {
        const res = await fetchImpl(
          `http://${addresses.controlHost}:${addresses.controlPort}/devices`,
          { signal: AbortSignal.timeout(5000) },
        );
        if (!res.ok) return null;
        const body = (await res.json()) as {
          capture?: unknown[];
          playback?: unknown[];
        };
        const capture = Array.isArray(body.capture) ? body.capture : [];
        const playback = Array.isArray(body.playback) ? body.playback : [];
        if (capture.length === 0 && playback.length === 0) {
          return (
            "local satellite has no audio devices — signalk-container does " +
            "not yet support /dev/snd passthrough (devices/groupAdd); audio " +
            "will not work until the container manager ships device support"
          );
        }
        return null;
      } catch (err) {
        deps.app.debug(
          `local satellite device probe failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    },
  };
}

function splitHostPort(addr: string): [string, number] {
  const idx = addr.lastIndexOf(":");
  if (idx === -1) {
    throw new Error(`invalid address "${addr}" (expected host:port)`);
  }
  return [addr.slice(0, idx), Number(addr.slice(idx + 1))];
}
