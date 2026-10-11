/**
 * SignalKPublisher — voice.* deltas, meta, and PUT handlers (SPEC §4.1/§4.2).
 *
 * $source discipline:
 * - satellite status paths: plain 'signalk-wyoming' (orchestrator-owned)
 * - voice.command: 'signalk-wyoming.<satelliteId>' (set per-update, verbatim)
 */

import type { SatelliteState, SayResult } from "./types.js";
import type { SayFn, SayOpts } from "./say.js";
import type {
  AnnouncementContent,
  AnnouncementRequest,
  AnnouncementSnapshot,
} from "./announcements.js";

export interface ActionResult {
  state: "COMPLETED" | "PENDING";
  statusCode?: number;
  message?: string;
}

export type PutHandler = (
  context: string,
  path: string,
  value: unknown,
  callback: (reply: ActionResult) => void,
) => ActionResult | Promise<ActionResult>;

export interface PublisherApp {
  handleMessage(pluginId: string, delta: Record<string, unknown>): void;
  registerPutHandler(
    context: string,
    path: string,
    handler: PutHandler,
    source?: string,
  ): void;
  error(msg: string): void;
  debug(msg: string): void;
}

export interface VoiceCommand {
  id: string;
  text: string;
  satellite: string;
  language: string;
  wakeWord?: string;
  durationMs?: number;
}

export interface SignalKPublisherDeps {
  app: PublisherApp;
  pluginId?: string;
  getMuted(): boolean;
  /**
   * The shared mute switch (also behind POST /api/mute). The implementation
   * owns publishing the voice.muted delta (via publishMuted) so every
   * surface keeps the Signal K path in sync.
   */
  setMuted(muted: boolean): void;
  say: SayFn;
  /** Log a say() outcome (ring buffer/SSE); PUT answers before completion. */
  onSayResult?: (result: SayResult) => void;
  /**
   * Delivery-aware announcements behind the voice.announce PUT (the same
   * service as POST /api/announcements). Optional so the publisher keeps
   * working for callers that only wire say().
   */
  announce?: (request: AnnouncementRequest) => Promise<AnnouncementSnapshot>;
}

const PLUGIN_ID = "signalk-wyoming";

export class SignalKPublisher {
  private readonly deps: SignalKPublisherDeps;
  private readonly pluginId: string;
  private readonly lastPublished = new Map<
    string,
    { connected: boolean; state: SatelliteState }
  >();
  private readonly metaPublished = new Set<string>();
  private readonly lastNotified = new Map<string, "alarm" | "normal">();

  constructor(deps: SignalKPublisherDeps) {
    this.deps = deps;
    this.pluginId = deps.pluginId ?? PLUGIN_ID;
  }

  /** Register PUT handlers, emit static meta, publish initial muted=false. */
  start(): void {
    this.publishStaticMeta();
    this.registerPutHandlers();
    // voice.muted defaults to false on every start (not persisted — D14).
    this.publishMuted(this.deps.getMuted());
  }

  /** voice.satellites.<id>.connected/.state — only on change. */
  publishSatellite(
    id: string,
    status: { connected: boolean; state: SatelliteState },
  ): void {
    const prev = this.lastPublished.get(id);
    const values: { path: string; value: unknown }[] = [];
    if (prev === undefined || prev.connected !== status.connected) {
      values.push({
        path: `voice.satellites.${id}.connected`,
        value: status.connected,
      });
    }
    if (prev === undefined || prev.state !== status.state) {
      values.push({
        path: `voice.satellites.${id}.state`,
        value: status.state,
      });
    }
    this.lastPublished.set(id, { ...status });
    if (values.length === 0) return;
    this.publishSatelliteMeta(id);
    this.deps.app.handleMessage(this.pluginId, {
      updates: [{ $source: this.pluginId, values }],
    });
  }

  /** voice.command — $source 'signalk-wyoming.<satelliteId>' (spec §4.1). */
  publishCommand(cmd: VoiceCommand): void {
    const value: Record<string, unknown> = {
      id: cmd.id,
      text: cmd.text,
      satellite: cmd.satellite,
      language: cmd.language,
    };
    if (cmd.wakeWord !== undefined) value.wakeWord = cmd.wakeWord;
    if (cmd.durationMs !== undefined) value.durationMs = cmd.durationMs;
    this.deps.app.handleMessage(this.pluginId, {
      updates: [
        {
          $source: `${this.pluginId}.${cmd.satellite}`,
          values: [{ path: "voice.command", value }],
        },
      ],
    });
  }

  publishMuted(muted: boolean): void {
    this.deps.app.handleMessage(this.pluginId, {
      updates: [
        {
          $source: this.pluginId,
          values: [{ path: "voice.muted", value: muted }],
        },
      ],
    });
  }

  /**
   * notifications.voice.<service> (spec §3.3) — state 'alarm'|'normal',
   * method ['visual'] only (never 'sound': a notification→speech bridge must
   * not speak our own alarms back through us). Deduplicates consecutive
   * identical states per service.
   */
  publishNotification(
    service: string,
    state: "alarm" | "normal",
    message: string,
  ): void {
    if (this.lastNotified.get(service) === state) return;
    this.lastNotified.set(service, state);
    this.deps.app.handleMessage(this.pluginId, {
      updates: [
        {
          $source: this.pluginId,
          values: [
            {
              path: `notifications.voice.${service}`,
              value: { state, method: ["visual"], message },
            },
          ],
        },
      ],
    });
  }

  // ---------------------------------------------------------------------

  private registerPutHandlers(): void {
    this.deps.app.registerPutHandler(
      "vessels.self",
      "voice.muted",
      (_context, _path, value) => this.handleMutedPut(value),
    );
    this.deps.app.registerPutHandler(
      "vessels.self",
      "voice.say",
      (_context, _path, value) => this.handleSayPut(value),
    );
    this.deps.app.registerPutHandler(
      "vessels.self",
      "voice.announce",
      (_context, _path, value) => this.handleAnnouncePut(value),
    );
  }

  private handleMutedPut(value: unknown): ActionResult {
    let muted: unknown = value;
    if (muted !== null && typeof muted === "object" && "value" in muted) {
      muted = (muted as { value: unknown }).value;
    }
    if (typeof muted !== "boolean") {
      return {
        state: "COMPLETED",
        statusCode: 400,
        message: "voice.muted expects a boolean (or {value: boolean})",
      };
    }
    // setMuted owns publishing the voice.muted delta (single switch shared
    // with POST /api/mute) — publishing here too would double-emit.
    this.deps.setMuted(muted);
    return { state: "COMPLETED", statusCode: 200 };
  }

  /**
   * voice.say PUT: string value → say({text}); object → say(opts). Returns
   * the promise of an ActionResult (put.ts awaits promise returns): 200 once
   * enqueued, 503 when nothing could be queued.
   */
  private handleSayPut(value: unknown): ActionResult | Promise<ActionResult> {
    let opts: SayOpts;
    if (typeof value === "string") {
      opts = { text: value };
    } else if (value !== null && typeof value === "object") {
      opts = value as SayOpts;
    } else {
      return {
        state: "COMPLETED",
        statusCode: 400,
        message: "voice.say expects a string or a say() options object",
      };
    }
    return this.deps.say(opts).then(
      (result): ActionResult => {
        this.deps.onSayResult?.(result);
        return { state: "COMPLETED", statusCode: 200 };
      },
      (err): ActionResult => {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.app.error(`voice.say PUT failed: ${message}`);
        return { state: "COMPLETED", statusCode: 503, message };
      },
    );
  }

  /**
   * voice.announce PUT — the sound counterpart of voice.say, on the
   * delivery-aware service. Accepts:
   *   - a string: a sound id (`"alarm"`)
   *   - `{soundId | text, targets?, priority?, requestId?}` shorthand
   *   - a full announcement request `{content: {kind, ...}, targets?, ...}`
   * Answers 200 once at least one target is queued (or every target was
   * suppressed by mute), 503 when every target failed or the service
   * rejected the request, 400 for an unusable value.
   */
  private handleAnnouncePut(
    value: unknown,
  ): ActionResult | Promise<ActionResult> {
    const request = announceRequestFromPut(value);
    if (request === null) {
      return {
        state: "COMPLETED",
        statusCode: 400,
        message:
          "voice.announce expects a sound id, {soundId | text, " +
          "targets?, priority?, requestId?} or an announcement request",
      };
    }
    if (this.deps.announce === undefined) {
      return {
        state: "COMPLETED",
        statusCode: 503,
        message: "announcement service unavailable",
      };
    }
    return this.deps.announce(request).then(
      (snapshot): ActionResult => {
        const targets = Object.values(snapshot.targets);
        const failed = targets.filter((t) => t.state === "failed");
        if (targets.length > 0 && failed.length === targets.length) {
          const message =
            failed.find((t) => t.error)?.error ?? "no target could play";
          this.deps.app.error(`voice.announce PUT failed: ${message}`);
          return { state: "COMPLETED", statusCode: 503, message };
        }
        return { state: "COMPLETED", statusCode: 200 };
      },
      (err): ActionResult => {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.app.error(`voice.announce PUT failed: ${message}`);
        return { state: "COMPLETED", statusCode: 503, message };
      },
    );
  }

  private publishStaticMeta(): void {
    this.deps.app.handleMessage(this.pluginId, {
      updates: [
        {
          meta: [
            {
              path: "voice.command",
              value: {
                description:
                  "Last transcribed voice command ({id, text, satellite, language, wakeWord?, durationMs?})",
              },
            },
            {
              path: "voice.muted",
              value: {
                description:
                  "Suppresses normal-priority announcements (urgent plays through); PUT true/false",
              },
            },
            {
              path: "voice.say",
              value: {
                description:
                  "Write-only PUT target: string or {text, targets?, voice?, priority?}",
              },
            },
            {
              path: "voice.announce",
              value: {
                description:
                  "Write-only PUT target: sound id, {soundId | text, targets?, priority?, requestId?} or a full announcement request",
              },
            },
          ],
        },
      ],
    });
  }

  private publishSatelliteMeta(id: string): void {
    if (this.metaPublished.has(id)) return;
    this.metaPublished.add(id);
    this.deps.app.handleMessage(this.pluginId, {
      updates: [
        {
          meta: [
            {
              path: `voice.satellites.${id}.connected`,
              value: { description: `Satellite '${id}' connection status` },
            },
            {
              path: `voice.satellites.${id}.state`,
              value: {
                description: `Satellite '${id}' state (idle|listening|transcribing|speaking|disconnected)`,
              },
            },
          ],
        },
      ],
    });
  }
}

/**
 * Normalize a voice.announce PUT value into an announcement request, or null
 * when the shape is unusable. A bare string is a sound id (speech has its own
 * path). The shorthand keys are mutually exclusive; `content` wins when
 * present so a full request passes through untouched.
 */
export function announceRequestFromPut(
  value: unknown,
): AnnouncementRequest | null {
  if (typeof value === "string") {
    return value.length > 0
      ? { content: { kind: "sound", soundId: value } }
      : null;
  }
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const common = {
    ...(raw.targets !== undefined ? { targets: raw.targets } : {}),
    ...(raw.priority !== undefined ? { priority: raw.priority } : {}),
    ...(raw.requestId !== undefined ? { requestId: raw.requestId } : {}),
  } as Pick<AnnouncementRequest, "targets" | "priority" | "requestId">;
  if (raw.content !== undefined) {
    if (raw.content === null || typeof raw.content !== "object") return null;
    return { ...common, content: raw.content as AnnouncementContent };
  }
  let content: AnnouncementContent;
  if (typeof raw.soundId === "string") {
    content = { kind: "sound", soundId: raw.soundId };
  } else if (typeof raw.text === "string") {
    content = {
      kind: "speech",
      text: raw.text,
      ...(typeof raw.voice === "string" ? { voice: raw.voice } : {}),
    };
  } else return null;
  return { ...common, content };
}
