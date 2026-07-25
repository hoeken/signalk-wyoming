/**
 * Custom plugin-config panel for the Signal K Admin UI, built on the shared
 * signalk-container-helper/ui building blocks. Replaces the JSON-schema
 * auto-form (which remains the fallback on servers without panel support):
 * live orchestrator status (satellites + discovered services), a remote
 * satellite editor, the local satellite container with an image-version
 * dropdown fed by /api/versions and one-click update check/apply, service
 * URI overrides with live discovery dots, a voice dropdown fed by
 * /api/voices, and the advanced timing knobs.
 *
 * Loaded as a webpack Module Federation remote; `react` resolves to the
 * Admin UI's shared singleton. The defaults, ports, and the id pattern
 * mirror ../config.ts — the panel bundle cannot import the Node-only
 * server code.
 */

import React, { useEffect, useState } from "react";
import {
  panelStyles as S,
  stateColors,
  SectionTitle,
  StatusCard,
  StateDot,
  FieldRow,
  VersionSelect,
  UpdateControls,
  CollapsibleSection,
  ActionStatus,
  Button,
  useStatusPoll,
  useVersions,
} from "signalk-container-helper/ui";

const BASE = "/plugins/signalk-wyoming";
const WEBAPP_URL = "/signalk-wyoming";
const IMAGE = "ghcr.io/hoeken/wyoming-satellite";

/** Mirrors the constants in ../config.ts. */
const SATELLITE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const LOCAL_SATELLITE_ID = "local";
const WYOMING_SATELLITE_PORT = 10700;
const SATELLITE_CONTROL_PORT = 10800;

/** Mirrors DEFAULT_ADVANCED in ../config.ts. */
const DEFAULT_ADVANCED = {
  silenceMs: 800,
  maxUtteranceMs: 10000,
  minUtteranceMs: 300,
  wakeDedupMs: 2000,
  pipelineTimeoutMs: 30000,
  wakeRefractorySeconds: 3.0,
};

/** Mirrors DEFAULT_LOCAL_SATELLITE in ../config.ts. */
const DEFAULT_LOCAL_SATELLITE = {
  enabled: false,
  micDevice: "auto",
  sndDevice: "auto",
  wakeWords: [],
  audioMode: "alsa",
  feedbackSounds: true,
  hostPulseSocket: "/run/user/1000/pulse/native",
  tag: "auto",
};

const ADVANCED_FIELDS = [
  {
    key: "silenceMs",
    label: "End-of-utterance silence (ms)",
    hint: "silence that ends a spoken command",
  },
  {
    key: "maxUtteranceMs",
    label: "Max utterance (ms)",
    hint: "hard cap on a single command recording",
  },
  {
    key: "minUtteranceMs",
    label: "Min utterance (ms)",
    hint: "shorter recordings are discarded as noise",
  },
  {
    key: "wakeDedupMs",
    label: "Wake dedup window (ms)",
    hint: "repeat detections inside the window are ignored",
  },
  {
    key: "pipelineTimeoutMs",
    label: "Pipeline timeout (ms)",
    hint: "wake → transcript deadline before the pipeline aborts",
  },
  {
    key: "wakeRefractorySeconds",
    label: "Wake refractory (s)",
    hint: "satellite-side cooldown after each detection",
  },
];

const SERVICE_FIELDS = [
  { key: "asr", label: "Speech-to-text (whisper)", port: 10300 },
  { key: "tts", label: "Text-to-speech (piper)", port: 10200 },
  { key: "wake", label: "Wake word (openwakeword)", port: 10400 },
];

/** A satellite row in panel state — ports as strings for editing. */
function toSatelliteRow(raw) {
  const sat = raw && typeof raw === "object" ? raw : {};
  return {
    id: typeof sat.id === "string" ? sat.id : "",
    name: typeof sat.name === "string" ? sat.name : "",
    host: typeof sat.host === "string" ? sat.host : "",
    port: typeof sat.port === "number" ? String(sat.port) : "",
    wakeWords: Array.isArray(sat.wakeWords)
      ? sat.wakeWords.filter((w) => typeof w === "string" && w !== "")
      : [],
    hasControlApi:
      sat.hasControlApi === true ||
      (sat.controlPort !== undefined && sat.controlPort !== null),
    controlPort:
      typeof sat.controlPort === "number" ? String(sat.controlPort) : "",
  };
}

function emptySatelliteRow() {
  return {
    id: "",
    name: "",
    host: "",
    port: "",
    wakeWords: [],
    hasControlApi: false,
    controlPort: "",
  };
}

/** Parse an optional port field; returns fallback when empty, NaN when bad. */
function portValue(text, fallback) {
  if (text.trim() === "") return fallback;
  const n = Number(text);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : NaN;
}

/** Mirrors isLowSampleRateVoice in signalk-piper — say() needs 22.05 kHz. */
function isLowSampleRateVoice(voice) {
  return voice.endsWith("-low") || voice.endsWith("-x_low");
}

/**
 * Wake-word picker: checkboxes for every known model (what the running wake
 * service advertises via /api/services, merged with the current selection so
 * saved words never silently disappear), plus an add-a-model input for
 * custom models or pre-first-start setup.
 */
function WakeWordsEditor({ value, onChange, knownWords }) {
  const [custom, setCustom] = useState("");
  const listed = [
    ...knownWords,
    ...value.filter((w) => !knownWords.includes(w)),
  ];
  const toggle = (word) => {
    onChange(
      value.includes(word) ? value.filter((w) => w !== word) : [...value, word],
    );
  };
  const addCustom = () => {
    const word = custom.trim();
    setCustom("");
    if (word !== "" && !value.includes(word)) onChange([...value, word]);
  };
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "6px 16px",
      }}
    >
      {listed.map((word) => (
        <label
          key={word}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
          }}
        >
          <input
            style={S.checkbox}
            type="checkbox"
            checked={value.includes(word)}
            onChange={() => toggle(word)}
          />
          {word}
        </label>
      ))}
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <input
          style={{ ...S.input, width: 140 }}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCustom();
            }
          }}
          placeholder="model_name"
        />
        <Button variant="secondary" small onClick={addCustom}>
          Add
        </Button>
      </span>
    </div>
  );
}

/** Border-boxed editor card for one remote satellite. */
function SatelliteEditor({ sat, live, knownWords, onChange, onRemove }) {
  const set = (patch) => onChange({ ...sat, ...patch });
  return (
    <div
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        padding: "10px 12px",
        marginBottom: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
        }}
      >
        {live !== null && (
          <StateDot
            state={live.connected ? "ok" : "error"}
            title={live.state}
          />
        )}
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>
          {sat.name || sat.id || "new satellite"}
          {live !== null && (
            <span style={{ color: "#888", fontWeight: 400 }}>
              {" "}
              — {live.state}
            </span>
          )}
        </span>
        <Button variant="danger" small onClick={onRemove}>
          Remove
        </Button>
      </div>
      <FieldRow
        label="Id"
        hint="letters/digits/_/- only; becomes voice.satellites.<id>"
      >
        <input
          style={{ ...S.input, width: 140 }}
          value={sat.id}
          onChange={(e) => set({ id: e.target.value })}
          placeholder="cockpit"
        />
      </FieldRow>
      <FieldRow label="Name" hint="display name; defaults to the id">
        <input
          style={{ ...S.input, width: 180 }}
          value={sat.name}
          onChange={(e) => set({ name: e.target.value })}
        />
      </FieldRow>
      <FieldRow label="Host">
        <input
          style={{ ...S.input, width: 180 }}
          value={sat.host}
          onChange={(e) => set({ host: e.target.value })}
          placeholder="192.168.1.50"
        />
      </FieldRow>
      <FieldRow label="Port">
        <input
          style={{ ...S.input, width: 90 }}
          type="number"
          value={sat.port}
          onChange={(e) => set({ port: e.target.value })}
          placeholder={String(WYOMING_SATELLITE_PORT)}
        />
      </FieldRow>
      <FieldRow
        label="Wake words"
        hint="leave empty for announce-only satellites"
      >
        <WakeWordsEditor
          value={sat.wakeWords}
          onChange={(wakeWords) => set({ wakeWords })}
          knownWords={knownWords}
        />
      </FieldRow>
      <FieldRow
        label="Runs our satellite image"
        hint="unlocks the webapp Audio screen, record/play tests and record-and-transcribe"
      >
        <input
          style={S.checkbox}
          type="checkbox"
          checked={sat.hasControlApi}
          onChange={(e) => set({ hasControlApi: e.target.checked })}
        />
        {sat.hasControlApi && (
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <span style={{ fontSize: 13, color: "#555" }}>Control port</span>
            <input
              style={{ ...S.input, width: 90 }}
              type="number"
              value={sat.controlPort}
              onChange={(e) => set({ controlPort: e.target.value })}
              placeholder={String(SATELLITE_CONTROL_PORT)}
            />
          </span>
        )}
      </FieldRow>
    </div>
  );
}

export default function PluginConfigurationPanel({ configuration, save }) {
  const cfg = configuration || {};
  const cfgLocal =
    cfg.localSatellite && typeof cfg.localSatellite === "object"
      ? cfg.localSatellite
      : {};
  const cfgServices =
    cfg.services && typeof cfg.services === "object" ? cfg.services : {};
  const cfgDefaults =
    cfg.defaults && typeof cfg.defaults === "object" ? cfg.defaults : {};
  const cfgAdvanced =
    cfg.advanced && typeof cfg.advanced === "object" ? cfg.advanced : {};

  const [satellites, setSatellites] = useState(() =>
    (Array.isArray(cfg.satellites) ? cfg.satellites : []).map(toSatelliteRow),
  );
  const [local, setLocal] = useState(() => ({
    enabled: cfgLocal.enabled === true,
    micDevice:
      typeof cfgLocal.micDevice === "string" && cfgLocal.micDevice !== ""
        ? cfgLocal.micDevice
        : DEFAULT_LOCAL_SATELLITE.micDevice,
    sndDevice:
      typeof cfgLocal.sndDevice === "string" && cfgLocal.sndDevice !== ""
        ? cfgLocal.sndDevice
        : DEFAULT_LOCAL_SATELLITE.sndDevice,
    wakeWords: Array.isArray(cfgLocal.wakeWords)
      ? cfgLocal.wakeWords.filter((w) => typeof w === "string" && w !== "")
      : [],
    audioMode: cfgLocal.audioMode === "pulse-socket" ? "pulse-socket" : "alsa",
    feedbackSounds: cfgLocal.feedbackSounds !== false,
    hostPulseSocket:
      typeof cfgLocal.hostPulseSocket === "string" &&
      cfgLocal.hostPulseSocket !== ""
        ? cfgLocal.hostPulseSocket
        : DEFAULT_LOCAL_SATELLITE.hostPulseSocket,
    noiseSuppression:
      typeof cfgLocal.noiseSuppression === "number"
        ? String(cfgLocal.noiseSuppression)
        : "",
    autoGain:
      typeof cfgLocal.autoGain === "number" ? String(cfgLocal.autoGain) : "",
    micVolume:
      typeof cfgLocal.micVolume === "number" ? String(cfgLocal.micVolume) : "",
    tag:
      typeof cfgLocal.tag === "string" && cfgLocal.tag !== ""
        ? cfgLocal.tag
        : DEFAULT_LOCAL_SATELLITE.tag,
  }));
  const [services, setServices] = useState(() => ({
    asr: typeof cfgServices.asr === "string" ? cfgServices.asr : "auto",
    tts: typeof cfgServices.tts === "string" ? cfgServices.tts : "auto",
    wake: typeof cfgServices.wake === "string" ? cfgServices.wake : "auto",
  }));
  const [language, setLanguage] = useState(
    typeof cfgDefaults.language === "string" && cfgDefaults.language !== ""
      ? cfgDefaults.language
      : "en",
  );
  // Empty string is meaningful (use the TTS service's own voice), so no ||.
  const [voice, setVoice] = useState(
    typeof cfgDefaults.voice === "string" ? cfgDefaults.voice : "",
  );
  const [advanced, setAdvanced] = useState(() => {
    const out = {};
    for (const { key } of ADVANCED_FIELDS) {
      out[key] =
        typeof cfgAdvanced[key] === "number"
          ? String(cfgAdvanced[key])
          : String(DEFAULT_ADVANCED[key]);
    }
    return out;
  });
  const [saved, setSaved] = useState("");
  const [saveError, setSaveError] = useState(false);

  // Live orchestrator state. Both routes answer 503 { error } while the
  // plugin is disabled, so a wrong-shaped body means "not running".
  const servicesPoll = useStatusPoll(`${BASE}/api/services`, {
    fallback: null,
  });
  const satellitesPoll = useStatusPoll(`${BASE}/api/satellites`, {
    fallback: null,
  });
  const versions = useVersions(`${BASE}/api/versions`);

  const snapshot =
    servicesPoll.status &&
    typeof servicesPoll.status === "object" &&
    !Array.isArray(servicesPoll.status) &&
    servicesPoll.status.tts !== undefined
      ? servicesPoll.status
      : null;
  const liveSatellites = Array.isArray(satellitesPoll.status)
    ? satellitesPoll.status
    : null;
  const running = snapshot !== null;

  // Voice list for the defaults dropdown — one fetch whenever TTS becomes
  // ready; null means "unknown, fall back to a text input".
  const ttsReady = snapshot !== null && snapshot.tts?.status === "ready";
  const [voices, setVoices] = useState(null);
  useEffect(() => {
    if (!ttsReady) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${BASE}/api/voices`, {
          credentials: "include",
        });
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled && Array.isArray(body)) {
          setVoices(body.filter((v) => v && typeof v.name === "string"));
        }
      } catch {
        /* offline or TTS gone — keep the text input */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ttsReady]);

  // Wake-word models the running wake service advertises (merged into the
  // checkbox lists; selections are kept even when not advertised).
  const knownWakeWords =
    snapshot !== null && Array.isArray(snapshot.wake?.models)
      ? snapshot.wake.models.filter((m) => typeof m === "string" && m !== "")
      : [];

  const connectedCount =
    liveSatellites === null
      ? 0
      : liveSatellites.filter((s) => s && s.connected === true).length;
  const meta = servicesPoll.loading
    ? "Checking..."
    : running
      ? `${connectedCount}/${liveSatellites === null ? 0 : liveSatellites.length} satellites connected; ` +
        SERVICE_FIELDS.map(
          ({ key }) => `${key}: ${snapshot[key]?.status ?? "—"}`,
        ).join(", ")
      : "Not running";

  const localLive =
    liveSatellites === null
      ? null
      : (liveSatellites.find((s) => s && s.id === LOCAL_SATELLITE_ID) ?? null);

  const setAdv = (key, value) =>
    setAdvanced((prev) => ({ ...prev, [key]: value }));

  /** Mirrors parseConfig's checks so bad input fails here, not on restart. */
  const validate = () => {
    const seen = new Set();
    for (const sat of satellites) {
      const label = sat.id !== "" ? `"${sat.id}"` : "a satellite";
      if (sat.id.trim() === "") return "every satellite needs an id";
      if (!SATELLITE_ID_PATTERN.test(sat.id)) {
        return `satellite id "${sat.id}" must match ^[a-zA-Z0-9_-]+$`;
      }
      if (seen.has(sat.id)) return `duplicate satellite id "${sat.id}"`;
      seen.add(sat.id);
      if (sat.host.trim() === "") return `satellite ${label} needs a host`;
      if (Number.isNaN(portValue(sat.port, WYOMING_SATELLITE_PORT))) {
        return `satellite ${label}: port must be an integer 1-65535`;
      }
      if (
        sat.hasControlApi &&
        Number.isNaN(portValue(sat.controlPort, SATELLITE_CONTROL_PORT))
      ) {
        return `satellite ${label}: control port must be an integer 1-65535`;
      }
    }
    if (local.enabled && seen.has(LOCAL_SATELLITE_ID)) {
      return `satellite id "${LOCAL_SATELLITE_ID}" is reserved for the local satellite`;
    }
    for (const key of ["noiseSuppression", "autoGain", "micVolume"]) {
      if (local[key] !== "" && !Number.isFinite(Number(local[key]))) {
        return `local satellite: ${key} must be a number`;
      }
    }
    for (const { key, label } of ADVANCED_FIELDS) {
      const n = Number(advanced[key]);
      if (advanced[key] !== "" && (!Number.isFinite(n) || n <= 0)) {
        return `${label} must be a number > 0`;
      }
    }
    return null;
  };

  const doSave = () => {
    const problem = validate();
    if (problem !== null) {
      setSaveError(true);
      setSaved(`Not saved: ${problem}`);
      return;
    }
    const outSatellites = satellites.map((sat) => {
      const out = {
        id: sat.id.trim(),
        host: sat.host.trim(),
        port: portValue(sat.port, WYOMING_SATELLITE_PORT),
        wakeWords: sat.wakeWords,
      };
      if (sat.name.trim() !== "") out.name = sat.name.trim();
      if (sat.hasControlApi) {
        out.hasControlApi = true;
        out.controlPort = portValue(sat.controlPort, SATELLITE_CONTROL_PORT);
      }
      return out;
    });
    const outLocal = {
      enabled: local.enabled,
      micDevice: local.micDevice.trim() || "auto",
      sndDevice: local.sndDevice.trim() || "auto",
      wakeWords: local.wakeWords,
      audioMode: local.audioMode,
      feedbackSounds: local.feedbackSounds,
      hostPulseSocket:
        local.hostPulseSocket.trim() || DEFAULT_LOCAL_SATELLITE.hostPulseSocket,
      tag: local.tag,
    };
    // Cleared optional numbers are omitted, not sent as empty strings —
    // parseConfig applies image defaults for absent fields.
    for (const key of ["noiseSuppression", "autoGain", "micVolume"]) {
      if (local[key] !== "") outLocal[key] = Number(local[key]);
    }
    const outAdvanced = {};
    for (const { key } of ADVANCED_FIELDS) {
      outAdvanced[key] =
        advanced[key] === "" ? DEFAULT_ADVANCED[key] : Number(advanced[key]);
    }
    save({
      ...cfg,
      satellites: outSatellites,
      localSatellite: outLocal,
      services: {
        asr: services.asr.trim() || "auto",
        tts: services.tts.trim() || "auto",
        wake: services.wake.trim() || "auto",
      },
      defaults: { language: language.trim() || "en", voice },
      advanced: outAdvanced,
    });
    setSaveError(false);
    setSaved("Saved. Signal K restarts the plugin with the new configuration.");
  };

  const voiceKnown =
    voices !== null && (voice === "" || voices.some((v) => v.name === voice));
  const lowRate = voice !== "" && isLowSampleRateVoice(voice);

  return (
    <div style={S.root}>
      <SectionTitle>Voice orchestrator status</SectionTitle>
      <StatusCard
        icon="V"
        iconBackground={running ? "#7c3aed" : undefined}
        title="Wyoming voice orchestrator"
        meta={meta}
        state={running ? "ok" : "error"}
        stateTitle={running ? "running" : "not running"}
        link={
          running ? { href: WEBAPP_URL, label: "Open webapp ↗" } : undefined
        }
      />

      <SectionTitle>Remote satellites</SectionTitle>
      {satellites.length === 0 && (
        <div style={{ ...S.empty, padding: "8px 0", textAlign: "left" }}>
          No remote satellites — the local satellite below covers a mic/speaker
          on the server box itself.
        </div>
      )}
      {satellites.map((sat, i) => (
        <SatelliteEditor
          key={i}
          sat={sat}
          live={
            liveSatellites === null
              ? null
              : (liveSatellites.find((s) => s && s.id === sat.id) ?? null)
          }
          knownWords={knownWakeWords}
          onChange={(next) =>
            setSatellites((prev) => prev.map((p, j) => (j === i ? next : p)))
          }
          onRemove={() =>
            setSatellites((prev) => prev.filter((_, j) => j !== i))
          }
        />
      ))}
      <Button
        variant="secondary"
        onClick={() => setSatellites((prev) => [...prev, emptySatelliteRow()])}
      >
        Add satellite
      </Button>

      <SectionTitle>Local satellite (mic/speaker on this server)</SectionTitle>
      <FieldRow
        label="Enabled"
        hint={`runs ${IMAGE} in a container on this box`}
      >
        <input
          style={S.checkbox}
          type="checkbox"
          checked={local.enabled}
          onChange={(e) => setLocal({ ...local, enabled: e.target.checked })}
        />
      </FieldRow>
      {local.enabled && (
        <>
          {localLive !== null && (
            <StatusCard
              icon="S"
              iconBackground={localLive.connected ? "#7c3aed" : undefined}
              title="Local satellite container"
              meta={
                localLive.connected
                  ? `connected at ${localLive.host}:${localLive.port} — ${localLive.state}`
                  : `not connected — ${localLive.state}`
              }
              state={localLive.connected ? "ok" : "warn"}
              stateTitle={localLive.state}
            />
          )}
          {/* Check/apply against the /api/update routes; they answer 503
              until the plugin runs with the local satellite enabled. */}
          {localLive !== null && (
            <UpdateControls
              checkUrl={`${BASE}/api/update/check`}
              applyUrl={`${BASE}/api/update/apply`}
              tag={local.tag}
              onApplied={() => void satellitesPoll.refresh()}
            />
          )}
          <FieldRow
            label="Microphone device"
            hint="ALSA device string (see the webapp Audio screen); 'auto' = image default, 'none' = no microphone"
          >
            <input
              style={{ ...S.input, width: 180 }}
              value={local.micDevice}
              onChange={(e) =>
                setLocal({ ...local, micDevice: e.target.value })
              }
              placeholder="auto"
            />
          </FieldRow>
          <FieldRow
            label="Speaker device"
            hint="ALSA device string; 'auto' = image default"
          >
            <input
              style={{ ...S.input, width: 180 }}
              value={local.sndDevice}
              onChange={(e) =>
                setLocal({ ...local, sndDevice: e.target.value })
              }
              placeholder="auto"
            />
          </FieldRow>
          <FieldRow label="Wake words" hint="openWakeWord model names">
            <WakeWordsEditor
              value={local.wakeWords}
              onChange={(wakeWords) => setLocal({ ...local, wakeWords })}
              knownWords={knownWakeWords}
            />
          </FieldRow>
          <FieldRow
            label="Audio mode"
            hint={
              local.audioMode === "pulse-socket"
                ? "mounts the host sound-server socket (desktop hosts)"
                : "/dev/snd passthrough (headless hosts)"
            }
          >
            <select
              style={S.select}
              value={local.audioMode}
              onChange={(e) =>
                setLocal({ ...local, audioMode: e.target.value })
              }
            >
              <option value="alsa">alsa</option>
              <option value="pulse-socket">pulse-socket</option>
            </select>
          </FieldRow>
          {local.audioMode === "pulse-socket" && (
            <FieldRow
              label="Host pulse socket"
              hint="sound-server socket path on the host"
            >
              <input
                style={{ ...S.input, width: 260 }}
                value={local.hostPulseSocket}
                onChange={(e) =>
                  setLocal({ ...local, hostPulseSocket: e.target.value })
                }
                placeholder={DEFAULT_LOCAL_SATELLITE.hostPulseSocket}
              />
            </FieldRow>
          )}
          <FieldRow
            label="Feedback sounds"
            hint="play awake/done sounds on wake word interactions"
          >
            <input
              style={S.checkbox}
              type="checkbox"
              checked={local.feedbackSounds}
              onChange={(e) =>
                setLocal({ ...local, feedbackSounds: e.target.checked })
              }
            />
          </FieldRow>
          <FieldRow label="Image version">
            <VersionSelect
              value={local.tag}
              onChange={(tag) => setLocal({ ...local, tag })}
              versions={versions.versions}
              floatingOptions={[
                { tag: "auto", label: "auto (pinned release, recommended)" },
              ]}
              loading={versions.loading}
              error={versions.versionsError}
              onRefresh={versions.refresh}
            />
          </FieldRow>
          <CollapsibleSection title="Audio tuning">
            <FieldRow
              label="Noise suppression"
              hint="webrtc level 0-4; empty = image default"
            >
              <input
                style={{ ...S.input, width: 90 }}
                type="number"
                min="0"
                max="4"
                step="1"
                value={local.noiseSuppression}
                onChange={(e) =>
                  setLocal({ ...local, noiseSuppression: e.target.value })
                }
              />
            </FieldRow>
            <FieldRow label="Auto gain" hint="0-31 dbFS; empty = image default">
              <input
                style={{ ...S.input, width: 90 }}
                type="number"
                min="0"
                max="31"
                step="1"
                value={local.autoGain}
                onChange={(e) =>
                  setLocal({ ...local, autoGain: e.target.value })
                }
              />
            </FieldRow>
            <FieldRow
              label="Mic volume"
              hint="multiplier; empty = image default"
            >
              <input
                style={{ ...S.input, width: 90 }}
                type="number"
                step="0.1"
                value={local.micVolume}
                onChange={(e) =>
                  setLocal({ ...local, micVolume: e.target.value })
                }
              />
            </FieldRow>
          </CollapsibleSection>
        </>
      )}

      <SectionTitle>Services</SectionTitle>
      {SERVICE_FIELDS.map(({ key, label, port }) => {
        const resolved = snapshot === null ? null : (snapshot[key] ?? null);
        const value = services[key];
        const isAuto = value.trim() === "" || value.trim() === "auto";
        return (
          <FieldRow
            key={key}
            label={label}
            hint={
              isAuto
                ? resolved !== null && resolved.uri !== null
                  ? `discovered: ${resolved.uri} (${resolved.status})`
                  : `'auto' discovers the sibling plugin; or a manual tcp://host:${port} URI`
                : "manual override — 'auto' discovers the sibling plugin"
            }
          >
            {resolved !== null && (
              <StateDot
                state={
                  resolved.status === "ready"
                    ? "ok"
                    : resolved.status === "starting"
                      ? "warn"
                      : "error"
                }
                title={resolved.status ?? "not discovered"}
              />
            )}
            <input
              style={{ ...S.input, width: 220 }}
              value={value}
              onChange={(e) =>
                setServices((prev) => ({ ...prev, [key]: e.target.value }))
              }
              placeholder="auto"
            />
          </FieldRow>
        );
      })}

      <SectionTitle>Defaults</SectionTitle>
      <FieldRow label="Language" hint="spoken language code, e.g. en, de, fr">
        <input
          style={{ ...S.input, width: 90 }}
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          placeholder="en"
        />
      </FieldRow>
      <FieldRow
        label="Voice"
        hint={
          lowRate
            ? `${voice} is a 16 kHz voice — use -medium or -high (22.05 kHz)`
            : "default piper voice (22.05 kHz voices only); empty = the TTS service's configured voice"
        }
        hintColor={lowRate ? stateColors.warn : undefined}
      >
        {voices !== null && voices.length > 0 ? (
          <select
            style={S.select}
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
          >
            <option value="">TTS service default</option>
            {voices.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name}
              </option>
            ))}
            {/* A controlled select must always render its value. */}
            {!voiceKnown && <option value={voice}>{voice} (saved)</option>}
          </select>
        ) : (
          <input
            style={{ ...S.input, width: 220 }}
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
            placeholder="TTS service default"
          />
        )}
      </FieldRow>

      <CollapsibleSection title="Advanced">
        {ADVANCED_FIELDS.map(({ key, label, hint }) => (
          <FieldRow key={key} label={label} hint={hint}>
            <input
              style={{ ...S.input, width: 90 }}
              type="number"
              value={advanced[key]}
              onChange={(e) => setAdv(key, e.target.value)}
              placeholder={String(DEFAULT_ADVANCED[key])}
            />
          </FieldRow>
        ))}
      </CollapsibleSection>

      <div style={{ marginTop: 24 }}>
        <Button onClick={doSave}>Save Configuration</Button>
      </div>
      <ActionStatus message={saved} error={saveError} />
    </div>
  );
}
