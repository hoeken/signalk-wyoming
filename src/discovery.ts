/**
 * ServiceDirectory — consumes `wyoming-service` PropertyValues emissions
 * (spec §3.1) and merges them with manual service overrides (§4.3).
 *
 * PropertyValues callbacks receive the FULL history array (leading element is
 * always `undefined`); the latest value per `value.plugin` wins. Emissions
 * with status 'stopped' remove that plugin's service from consideration.
 */

import { EventEmitter } from "node:events";

export type ServiceType = "asr" | "tts" | "wake";
export type ServiceStatus = "starting" | "ready" | "error";

export const SERVICE_TYPES: readonly ServiceType[] = ["asr", "tts", "wake"];

export interface ResolvedService {
  uri: string;
  /** Emitting plugin id (absent for manual overrides). */
  plugin?: string;
  status: ServiceStatus;
  source: "auto" | "manual";
}

export interface ServiceSnapshotEntry {
  uri: string | null;
  status: ServiceStatus | null;
  source: "auto" | "manual" | null;
  plugin?: string;
}

export type ServiceSnapshot = Record<ServiceType, ServiceSnapshotEntry>;

/** app.onPropertyValues-shaped subscribe function. */
export type PropertySubscribe = (
  name: string,
  cb: (history: unknown[]) => void,
) => (() => void) | void;

interface Emission {
  plugin: string;
  type: ServiceType;
  uri: string;
  status: "starting" | "ready" | "stopped" | "error";
  order: number;
}

function isServiceType(v: unknown): v is ServiceType {
  return v === "asr" || v === "tts" || v === "wake";
}

function parseEmission(entry: unknown, order: number): Emission | null {
  if (entry === null || typeof entry !== "object") return null;
  const value = (entry as Record<string, unknown>).value;
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.plugin !== "string" || v.plugin === "") return null;
  if (!isServiceType(v.type)) return null;
  if (typeof v.uri !== "string" || v.uri === "") return null;
  if (
    v.status !== "starting" &&
    v.status !== "ready" &&
    v.status !== "stopped" &&
    v.status !== "error"
  ) {
    return null;
  }
  return {
    plugin: v.plugin,
    type: v.type,
    uri: v.uri,
    status: v.status,
    order,
  };
}

export interface ServiceDirectoryOptions {
  /** Per-type 'auto' | 'tcp://host:port' (spec §4.3 services{}). */
  overrides: Record<ServiceType, string>;
  log?: (msg: string) => void;
}

/**
 * Emits `"change"` with `(type: ServiceType, resolved: ResolvedService | null)`
 * whenever the effective service for a type changes.
 */
export class ServiceDirectory extends EventEmitter {
  private readonly overrides: Record<ServiceType, string>;
  private readonly log: (msg: string) => void;
  private resolved: Record<ServiceType, ResolvedService | null> = {
    asr: null,
    tts: null,
    wake: null,
  };
  private unsubscribe: (() => void) | null = null;
  private stopped = false;

  constructor(options: ServiceDirectoryOptions) {
    super();
    this.overrides = options.overrides;
    this.log = options.log ?? (() => {});
  }

  /** Subscribe to `wyoming-service` PropertyValues. Idempotent. */
  start(subscribe: PropertySubscribe): void {
    if (this.unsubscribe !== null) return;
    this.stopped = false;
    const unsub = subscribe("wyoming-service", (history) => {
      if (this.stopped) return;
      try {
        this.ingest(history);
      } catch (err) {
        this.log(
          `wyoming-service ingest failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
    this.unsubscribe = typeof unsub === "function" ? unsub : () => {};
  }

  stop(): void {
    this.stopped = true;
    if (this.unsubscribe !== null) {
      try {
        this.unsubscribe();
      } catch {
        /* unsubscribing a dead stream is fine */
      }
      this.unsubscribe = null;
    }
  }

  /**
   * Effective service for a type. Manual overrides always resolve (status
   * 'ready' — the orchestrator trusts explicit URIs); 'auto' resolves to the
   * newest non-stopped emission.
   */
  get(type: ServiceType): ResolvedService | null {
    const override = this.overrides[type];
    if (override !== undefined && override !== "auto" && override !== "") {
      return { uri: override, status: "ready", source: "manual" };
    }
    return this.resolved[type];
  }

  /** REST /api/services shape. */
  snapshot(): ServiceSnapshot {
    const out = {} as ServiceSnapshot;
    for (const type of SERVICE_TYPES) {
      const resolved = this.get(type);
      if (resolved === null) {
        out[type] = { uri: null, status: null, source: null };
      } else {
        const entry: ServiceSnapshotEntry = {
          uri: resolved.uri,
          status: resolved.status,
          source: resolved.source,
        };
        if (resolved.plugin !== undefined) entry.plugin = resolved.plugin;
        out[type] = entry;
      }
    }
    return out;
  }

  private ingest(history: unknown[]): void {
    // Latest emission per plugin (history is ordered; leading undefined).
    const byPlugin = new Map<string, Emission>();
    for (let i = 0; i < history.length; i++) {
      const emission = parseEmission(history[i], i);
      if (emission !== null) byPlugin.set(emission.plugin, emission);
    }
    for (const type of SERVICE_TYPES) {
      let best: Emission | null = null;
      for (const emission of byPlugin.values()) {
        if (emission.type !== type || emission.status === "stopped") continue;
        if (best === null || emission.order > best.order) best = emission;
      }
      const next: ResolvedService | null =
        best === null
          ? null
          : {
              uri: best.uri,
              plugin: best.plugin,
              status: best.status as ServiceStatus,
              source: "auto",
            };
      const prev = this.resolved[type];
      if (!sameResolved(prev, next)) {
        this.resolved[type] = next;
        // Manual overrides mask auto changes entirely.
        const override = this.overrides[type];
        if (override === undefined || override === "auto" || override === "") {
          this.emit("change", type, next);
        }
      }
    }
  }
}

function sameResolved(
  a: ResolvedService | null,
  b: ResolvedService | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.uri === b.uri && a.status === b.status && a.plugin === b.plugin;
}
