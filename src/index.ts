/**
 * signalk-wyoming — Wyoming voice orchestrator plugin for Signal K.
 *
 * Plugin factory wiring (ORCHESTRATOR-SPEC §F "src/index.ts"): config,
 * discovery, say() core (REST + PUT + PropertyValues facade), satellites +
 * per-satellite announcement queues, local satellite container, voice.*
 * paths, SSE/event hub. Construction is side-effect-free (CI harness).
 *
 * Subpath exports remain the stable protocol pieces:
 * - `signalk-wyoming/protocol` — Wyoming framing, typed events, TCP client
 * - `signalk-wyoming/mock` — scriptable mock Wyoming server for tests
 */

import { startSafely } from "signalk-container-helper";
import {
  registerApiRoutes,
  type ApiRouter,
  type SatelliteEntry,
} from "./api.js";
import {
  buildSchema,
  buildUiSchema,
  localSatelliteEntry,
  parseConfig,
  type OrchestratorConfig,
  type SatelliteConfig,
} from "./config.js";
import { ServiceDirectory } from "./discovery.js";
import { EnergyGateEndpointer } from "./endpointer.js";
import { EventHub } from "./events.js";
import {
  createLocalSatellite,
  micWithoutWakeWordsWarning,
  type LocalSatelliteDeps,
  type LocalSatelliteHandle,
} from "./local-satellite.js";
import { SignalKPublisher, type PutHandler } from "./paths.js";
import { PipelineEngine } from "./pipeline.js";
import { AnnouncementQueue } from "./queue.js";
import { RemoteSatellite, type SatelliteEvent } from "./satellite.js";
import { createSay, type SayFn, type SayOpts } from "./say.js";
import { TranscribeSession } from "./asr.js";
import { synthesize } from "./tts.js";
import type { SayResult } from "./types.js";

const PLUGIN_ID = "signalk-wyoming";

export interface OrchestratorApp {
  debug(msg: string): void;
  error(msg: string): void;
  setPluginStatus(msg: string): void;
  setPluginError(msg: string): void;
  handleMessage(pluginId: string, delta: Record<string, unknown>): void;
  registerPutHandler?(
    context: string,
    path: string,
    handler: PutHandler,
    source?: string,
  ): void;
  emitPropertyValue?(name: string, value: unknown): void;
  onPropertyValues?(
    name: string,
    cb: (history: unknown[]) => void,
  ): (() => void) | void;
}

interface Runtime {
  running: boolean;
  config: OrchestratorConfig | null;
  hub: EventHub | null;
  directory: ServiceDirectory | null;
  publisher: SignalKPublisher | null;
  engine: PipelineEngine | null;
  satellites: Map<string, SatelliteEntry>;
  say: SayFn | null;
  local: LocalSatelliteHandle | null;
  /**
   * The in-flight local satellite bring-up (or wake-rewire) chain. stop()
   * awaits it before container.stop() so a start still in flight — a first
   * pull can take minutes — can't resurrect the container afterwards
   * (spec §4.3: never leave an orphaned open microphone).
   */
  localStart: Promise<void> | null;
  muted: boolean;
  /** Wake-words-without-wake-service warning (spec §4.3 degraded mode). */
  wakeWarning: string | null;
  /**
   * Microphone-without-wake-words warning — the inverse of `wakeWarning`,
   * and the quieter failure of the two: a satellite with no wake words is
   * armed with `pause-satellite`, so it drops every mic chunk. A perfectly
   * wired microphone then produces nothing at all, and nothing anywhere says
   * why. See {@link updateMicWarning}.
   */
  micWarning: string | null;
}

/** Test seam only — Signal K calls plugin(app) with no second argument. */
export interface PluginOverrides {
  createLocalSatellite?: (deps: LocalSatelliteDeps) => LocalSatelliteHandle;
}

export default function plugin(
  app: OrchestratorApp,
  overrides: PluginOverrides = {},
) {
  const makeLocalSatellite =
    overrides.createLocalSatellite ?? createLocalSatellite;
  const runtime: Runtime = {
    running: false,
    config: null,
    hub: null,
    directory: null,
    publisher: null,
    engine: null,
    satellites: new Map(),
    say: null,
    local: null,
    localStart: null,
    muted: false,
    wakeWarning: null,
    micWarning: null,
  };

  // Stable across restarts: a stale handle held by another plugin fails
  // safely instead of calling into a dead closure (spec §4.2.3).
  const sayFacade = (opts: SayOpts): Promise<SayResult> => {
    if (!runtime.running || runtime.say === null) {
      return Promise.reject(new Error("signalk-wyoming is stopped"));
    }
    return runtime.say(opts);
  };

  // The single mute switch behind every surface (POST /api/mute AND the
  // voice.muted PUT — spec §4.1): flips the flag, publishes the voice.muted
  // delta, and emits the SSE state event, so Signal K consumers never see a
  // stale value while suppression is active.
  const setMuted = (muted: boolean): void => {
    runtime.muted = muted;
    runtime.publisher?.publishMuted(muted);
    runtime.hub?.emit("state", { muted });
  };

  const onSatelliteEvent = (
    sat: RemoteSatellite,
    evt: SatelliteEvent,
  ): void => {
    const publisher = runtime.publisher;
    const hub = runtime.hub;
    switch (evt.type) {
      case "disconnected":
        runtime.engine?.onSatelliteGone(sat.id);
      // fall through to the state publish
      case "connected":
      case "state":
        publisher?.publishSatellite(sat.id, {
          connected: sat.connected,
          state: sat.state,
        });
        hub?.emit("state", {
          satellite: sat.id,
          connected: sat.connected,
          state: sat.state,
        });
        break;
      case "detection":
        runtime.engine?.onDetection(sat.id, evt.detection);
        hub?.emit("detection", {
          satellite: sat.id,
          name: evt.detection.name ?? null,
        });
        break;
      case "run-pipeline":
        runtime.engine?.onRunPipeline(sat, evt.runPipeline);
        break;
      case "audio-chunk":
        runtime.engine?.onAudioChunk(sat, evt.chunk);
        break;
      case "played":
        // play() internals consume this.
        break;
    }
  };

  /**
   * The wake words a satellite should actually listen for.
   *
   * Omitting `wakeWords` means "follow the boat's wake service", so the
   * operator sets the wake word once in the wake plugin instead of repeating
   * it for every satellite — the commonest setup by far, and previously a
   * silent mismatch when the two disagreed. An explicit list still wins, and
   * an explicit empty list still means "no wake detection here".
   */
  const wakeWordsFor = (entry: SatelliteConfig): string[] => {
    if (entry.wakeWords !== undefined) return entry.wakeWords;
    return runtime.directory?.get("wake")?.wakeWords ?? [];
  };

  const makeSatellite = (entry: SatelliteConfig): void => {
    const satellite = new RemoteSatellite(
      {
        id: entry.id,
        name: entry.name,
        host: entry.host,
        port: entry.port,
        wakeWords: wakeWordsFor(entry),
        hasControlApi: entry.hasControlApi,
        controlPort: entry.controlPort,
      },
      { onEvent: onSatelliteEvent, log: (msg) => app.debug(msg) },
    );
    const queue = new AnnouncementQueue({
      play: (item) => satellite.play(item.audio),
      cancelPlayback: () => satellite.cancelPlayback(),
      // Urgent announcement mid-pipeline cancels the pipeline (spec §2.5).
      onUrgentDuringPipeline: () => runtime.engine?.cancelForUrgent(entry.id),
      log: (msg) => app.debug(`satellite ${entry.id}: ${msg}`),
      onEvent: (evt) => {
        if (evt.type === "play-error") {
          runtime.hub?.emit("error", {
            satellite: entry.id,
            error: evt.error,
            text: evt.item.text,
          });
        }
      },
    });
    runtime.satellites.set(entry.id, { satellite, queue });
    // Publish initial disconnected state so paths exist immediately.
    runtime.publisher?.publishSatellite(entry.id, {
      connected: false,
      state: "disconnected",
    });
    satellite.connect();
  };

  const statusSummary = (): string => {
    const total = runtime.satellites.size;
    const connected = [...runtime.satellites.values()].filter(
      (e) => e.satellite.connected,
    ).length;
    const services = runtime.directory?.snapshot();
    const svc = (["tts", "asr", "wake"] as const)
      .map((t) => `${t}: ${services?.[t]?.status ?? "—"}`)
      .join(", ");
    const base = `${connected}/${total} satellites connected; ${svc}`;
    const warnings = [runtime.wakeWarning, runtime.micWarning].filter(
      (w): w is string => w !== null,
    );
    return warnings.length === 0
      ? base
      : `${base} — WARNING: ${warnings.join("; ")}`;
  };

  /**
   * Spec §4.3 degraded mode: wake-enabled satellites configured but no wake
   * service available → plugin-status warning + notifications.voice.wake
   * alarm; clears (state normal) when a wake service appears.
   */
  const updateWakeWarning = (wakeSatelliteIds: string[]): void => {
    if (wakeSatelliteIds.length === 0 || !runtime.running) return;
    const missing = runtime.directory?.get("wake") === null;
    if (missing && runtime.wakeWarning === null) {
      runtime.wakeWarning =
        `wake words configured (${wakeSatelliteIds.join(", ")}) but no wake ` +
        `service is available — install/enable signalk-openwakeword`;
      app.error(runtime.wakeWarning);
      runtime.publisher?.publishNotification(
        "wake",
        "alarm",
        runtime.wakeWarning,
      );
    } else if (!missing && runtime.wakeWarning !== null) {
      runtime.wakeWarning = null;
      runtime.publisher?.publishNotification(
        "wake",
        "normal",
        "wake service available",
      );
    }
  };

  /**
   * The mirror image of updateWakeWarning: a microphone configured with no
   * wake words to trigger on. Logged once (not per re-evaluation) and folded
   * into the plugin status, because the runtime symptom — a satellite that
   * connects, plays audio and never hears anything — looks like broken
   * hardware rather than a missing setting.
   */
  const updateMicWarning = (): void => {
    if (!runtime.running || runtime.config === null) return;
    const warning = micWithoutWakeWordsWarning(
      runtime.config.localSatellite,
      runtime.directory?.get("wake")?.wakeWords ?? [],
    );
    if (warning === runtime.micWarning) return;
    runtime.micWarning = warning;
    if (warning !== null) app.error(warning);
  };

  return {
    id: PLUGIN_ID,
    name: "Voice Orchestrator (Wyoming)",
    description:
      "Voice in and voice out for Signal K via the Wyoming protocol: spoken announcements (say API) and wake-word voice commands.",
    schema: () => buildSchema(),
    uiSchema: () => buildUiSchema(),

    statusMessage(): string | void {
      if (!runtime.running) return;
      return statusSummary();
    },

    registerWithRouter(router: ApiRouter): void {
      // Called once per server process (even while disabled) — all handlers
      // read live state through these accessors and guard on running().
      registerApiRoutes(router, {
        running: () => runtime.running,
        say: (opts) => sayFacade(opts as SayOpts),
        directory: () => runtime.directory,
        satellites: () => runtime.satellites,
        hub: () => runtime.hub,
        getMuted: () => runtime.muted,
        setMuted,
        localContainer: () =>
          runtime.local === null ? null : runtime.local.container,
        language: () => runtime.config?.defaults.language ?? "en",
        log: (msg) => app.debug(msg),
        error: (msg) => app.error(msg),
      });
    },

    start(rawConfig: object): void {
      let config: OrchestratorConfig;
      try {
        config = parseConfig(rawConfig);
      } catch (err) {
        app.setPluginError(
          `invalid configuration: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      runtime.config = config;
      runtime.running = true;
      runtime.muted = false; // not persisted across restarts (D14)
      runtime.wakeWarning = null;
      runtime.micWarning = null;
      runtime.hub = new EventHub();

      // Satellites that expect a wake service (spec §4.3 degraded mode).
      //
      // An explicit non-empty list always expects one. An omitted list means
      // "inherit", which only expects a wake service once one is actually
      // advertising words — otherwise a plain output-only satellite on a boat
      // with no wake plugin would warn about a service it never asked for.
      const wakeSatelliteIds = (): string[] =>
        config.satellites
          .filter((s) =>
            s.wakeWords === undefined
              ? (runtime.directory?.get("wake")?.wakeWords?.length ?? 0) > 0
              : s.wakeWords.length > 0,
          )
          .map((s) => s.id)
          .concat(
            config.localSatellite.enabled &&
              config.localSatellite.wakeWords.length > 0
              ? [localSatelliteEntry().id]
              : [],
          );

      // --- local satellite plumbing (referenced by discovery below) ---
      // Live getter: read on every container (re)start so wake wiring follows
      // discovery instead of freezing a plugin-start snapshot (§3.1 "start
      // order never matters").
      const wakeUriFor = (): string | null =>
        config.localSatellite.wakeWords.length > 0
          ? (runtime.directory?.get("wake")?.uri ?? null)
          : null;

      const bringUpLocal = async (local: LocalSatelliteHandle) => {
        const addresses = await local.start();
        if (!runtime.running || runtime.local !== local) {
          // Stopped (or restarted) while the container start — potentially a
          // minutes-long first pull — was in flight: the container just came
          // up with restart=unless-stopped and an open microphone. Stop it
          // before letting go (spec §4.3).
          await local.stop();
          return;
        }
        const base = localSatelliteEntry();
        const existing = runtime.satellites.get(base.id);
        if (
          existing !== undefined &&
          (existing.satellite.host !== addresses.host ||
            existing.satellite.port !== addresses.port)
        ) {
          // Container recreated at a new address — replace the client.
          existing.queue.clear();
          existing.satellite.cancelPlayback();
          existing.satellite.close();
          runtime.satellites.delete(base.id);
        }
        if (!runtime.satellites.has(base.id)) {
          makeSatellite({
            id: base.id,
            name: base.name,
            host: addresses.host,
            port: addresses.port,
            wakeWords: config.localSatellite.wakeWords,
            hasControlApi: true,
            controlPort: addresses.controlPort,
          });
        }
        const warning = await local.checkAudioDevices(addresses);
        if (warning !== null && runtime.running) {
          app.setPluginStatus(warning);
          runtime.hub?.emit("error", { satellite: base.id, error: warning });
        }
      };

      /**
       * Wake service appeared or moved after start: the container env
       * (WAKE_URI & co) is stale — restart the container with the rebuilt
       * env, chained after any in-flight start (ensureRunning recreates on
       * config drift; the RemoteSatellite reconnects on its own). A wake
       * service *vanishing* deliberately does NOT tear the wiring down: the
       * satellite keeps retrying its old WAKE_URI and the §4.3 alarm is
       * already raised, so a flapping wake plugin can't churn container
       * restarts.
       */
      const rewireLocalWake = (): void => {
        const local = runtime.local;
        if (local === null || !runtime.running) return;
        if (wakeUriFor() === null) return;
        const next = (runtime.localStart ?? Promise.resolve())
          .catch(() => undefined) // earlier failure already reported
          .then(async () => {
            if (!runtime.running || runtime.local !== local) return;
            if (!local.needsRestart()) return;
            app.debug(
              "wake service changed — restarting the local satellite container with rebuilt env",
            );
            await bringUpLocal(local);
          });
        runtime.localStart = next;
        startSafely(app, () => next);
      };

      /**
       * Rebuild satellites that inherit their wake words when the advertised
       * list changes. RemoteSatellite freezes wakeWords (and derives its mode)
       * at construction, so changing the boat's wake word has to replace the
       * client — otherwise the operator changes it in the wake plugin and the
       * satellite keeps listening for the old one until a full restart.
       */
      const rewireInheritedWakeWords = (): void => {
        if (!runtime.running) return;
        const inherited = runtime.directory?.get("wake")?.wakeWords ?? [];
        for (const entry of config.satellites) {
          if (entry.wakeWords !== undefined) continue; // explicit: not ours
          const existing = runtime.satellites.get(entry.id);
          if (existing === undefined) continue;
          const current = existing.satellite.wakeWords;
          if (
            current.length === inherited.length &&
            current.every((w, i) => w === inherited[i])
          ) {
            continue;
          }
          app.debug(
            `satellite ${entry.id}: wake words changed to ` +
              `[${inherited.join(", ")}] — reconnecting`,
          );
          existing.queue.clear();
          existing.satellite.cancelPlayback();
          existing.satellite.close();
          runtime.satellites.delete(entry.id);
          makeSatellite(entry);
        }
      };

      // --- service discovery ---
      runtime.directory = new ServiceDirectory({
        overrides: config.services,
        log: (msg) => app.debug(msg),
      });
      if (typeof app.onPropertyValues === "function") {
        runtime.directory.start((name, cb) => app.onPropertyValues?.(name, cb));
      } else {
        app.debug("app.onPropertyValues unavailable — service discovery off");
      }
      runtime.directory.on("change", (type, resolved) => {
        runtime.hub?.emit("service", { type, service: resolved });
        if (type === "wake") {
          updateWakeWarning(wakeSatelliteIds());
          // Re-run: the wake service appearing is what supplies the list of
          // wake words the message suggests picking from.
          updateMicWarning();
          rewireLocalWake();
          rewireInheritedWakeWords();
        }
        app.setPluginStatus(statusSummary());
      });

      // --- say() core ---
      const sayCore = createSay({
        directory: runtime.directory,
        satellites: () => runtime.satellites,
        isMuted: () => runtime.muted,
        defaults: config.defaults,
        log: (msg) => app.debug(msg),
        warn: (msg) => app.error(msg),
        synthesize,
      });
      runtime.say = async (opts) => {
        const result = await sayCore(opts);
        runtime.hub?.emit("announcement", {
          text: typeof opts.text === "string" ? opts.text : "",
          priority: opts.priority === "urgent" ? "urgent" : "normal",
          queued: result.queued,
          errors: result.errors ?? [],
          suppressed: result.suppressed ?? null,
        });
        return result;
      };

      // --- voice.* paths + PUT handlers ---
      // Always constructed: deltas/notifications need only handleMessage;
      // PUT registration degrades to a no-op when the API is unavailable.
      if (typeof app.registerPutHandler !== "function") {
        app.debug("app.registerPutHandler unavailable — PUT handlers off");
      }
      runtime.publisher = new SignalKPublisher({
        app: {
          handleMessage: (id, delta) => app.handleMessage(id, delta),
          registerPutHandler: (context, path, handler) =>
            app.registerPutHandler?.(context, path, handler),
          error: (msg) => app.error(msg),
          debug: (msg) => app.debug(msg),
        },
        getMuted: () => runtime.muted,
        setMuted,
        say: (opts) => sayFacade(opts),
        onSayResult: (result) =>
          app.debug(`voice.say result: ${JSON.stringify(result)}`),
      });
      runtime.publisher.start();

      // --- pipeline engine (M2/M3: wake → ASR → voice.command) ---
      runtime.engine = new PipelineEngine({
        directory: runtime.directory,
        queueFor: (id) => runtime.satellites.get(id)?.queue ?? null,
        publishCommand: (cmd) => runtime.publisher?.publishCommand(cmd),
        notify: (service, state, message) =>
          runtime.publisher?.publishNotification(service, state, message),
        emit: (kind, data) => runtime.hub?.emit(kind, data),
        endpointerFactory: () =>
          new EnergyGateEndpointer({
            silenceMs: config.advanced.silenceMs,
            maxUtteranceMs: config.advanced.maxUtteranceMs,
            minUtteranceMs: config.advanced.minUtteranceMs,
          }),
        asrOpen: (uri, opts) => TranscribeSession.open(uri, opts),
        advanced: config.advanced,
        language: config.defaults.language,
        log: (msg) => app.debug(msg),
      });

      // --- satellites ---
      // An inheriting satellite picks up whatever discovery has already
      // resolved; if the wake plugin announces later (or changes its wake
      // word), rewireInheritedWakeWords rebuilds the client — so start order
      // never matters, per §3.1.
      for (const entry of config.satellites) {
        makeSatellite(entry);
      }
      updateWakeWarning(wakeSatelliteIds());
      updateMicWarning();

      // --- local satellite container (async; startSafely reports failures) ---
      if (config.localSatellite.enabled) {
        runtime.local = makeLocalSatellite({
          app,
          local: config.localSatellite,
          advanced: config.advanced,
          wakeUri: wakeUriFor,
        });
        const first = bringUpLocal(runtime.local);
        runtime.localStart = first;
        startSafely(app, () => first);
      }

      // --- PropertyValues API object (§4.2.3) — re-emitted on every start ---
      if (typeof app.emitPropertyValue === "function") {
        try {
          app.emitPropertyValue(`${PLUGIN_ID}.api`, {
            version: 1,
            say: sayFacade,
          });
        } catch (err) {
          // Global PropertyValues cap reached — degrade loudly, don't crash.
          app.error(
            `emitPropertyValue failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      app.setPluginStatus(statusSummary());
    },

    async stop(): Promise<void> {
      runtime.running = false;
      runtime.engine?.stop();
      runtime.engine = null;
      for (const { satellite, queue } of runtime.satellites.values()) {
        queue.clear();
        satellite.cancelPlayback();
        satellite.close();
      }
      runtime.satellites.clear();
      runtime.directory?.stop();
      runtime.directory = null;
      runtime.hub?.close();
      runtime.hub = null;
      runtime.publisher = null;
      runtime.say = null;
      const local = runtime.local;
      const localStart = runtime.localStart;
      runtime.local = null;
      runtime.localStart = null;
      if (localStart !== null) {
        // Wait out an in-flight container start: its ensureRunning would
        // otherwise complete AFTER the container.stop() below (which is a
        // no-op while the container doesn't exist yet) and leave a running,
        // restart=unless-stopped container with an open microphone. The
        // bring-up's own guard also stops the container once running flips
        // false; failures were already reported via startSafely.
        await localStart.catch(() => undefined);
      }
      if (local !== null) {
        // Never leave an orphaned open microphone (spec §4.3).
        await local.stop();
      }
    },
  };
}
