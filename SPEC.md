# signalk-wyoming — Specification

**Status:** Draft v0.2 — RFC, community comments welcome (2026-07-23)
**Scope:** A family of SignalK plugins integrating the [Wyoming protocol](https://github.com/rhasspy/wyoming) voice-assistant ecosystem (Whisper STT, Piper TTS, openWakeWord) into SignalK, delivered as containerized microservices via signalk-container / [signalk-container-helper](https://github.com/hoeken/signalk-container-helper).

---

## 1. Decision log

Decisions made during ideation, with the deciding rationale:

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Orchestrator and self-satellite are one plugin** (`signalk-wyoming`), self-satellite as opt-in config, off by default | SignalK plugins share one Node process, so a separate plugin buys no isolation; merging avoids cross-plugin lifecycle handshakes, a shared library, and a second install for the common case. A `role` setting (satellite-only mode) remains a future escape hatch. |
| D2 | **Local audio via a containerized satellite** (self-maintained `wyoming-satellite`-based image), not native in-plugin audio | Many SignalK installs are themselves containerized; native `arecord`/`aplay` would require users to modify the SignalK image/compose. A sibling container launched via the host Docker socket works identically across all deployments, and a container runtime is already a hard prerequisite of this plugin family. No upstream satellite image exists, so we build one either way — and owning it lets us bake in device-test tooling. |
| D3 | **Publish-only intent model** — recognized text is published to `voice.command`; intent handling is explicitly out of scope | Clean boundary. node-red, custom plugins, or a future intents/LLM plugin consume commands and respond via the `say()` API. |
| D4 | **Notification→speech bridge is a core v1 feature** | The killer boat feature; works with zero microphones, making Piper + orchestrator alone a useful install. |
| D5 | **Flat plugin names** (`signalk-whisper`, `signalk-piper`, `signalk-openwakeword`, `signalk-wyoming`) | Shorter than family-prefixed names; npm availability confirmed for all four. Names reserved with 0.0.1 placeholder releases. |

---

## 2. Overview

### 2.1 What this is

Voice in and voice out for a boat's SignalK server, fully offline:

- **Voice out:** any plugin, node-red flow, or API client can make the boat speak ("Anchor alarm: drag detected") through speakers anywhere on the boat. SignalK notifications are spoken automatically.
- **Voice in:** wake-word-triggered voice commands ("ok nabu, log my position") are transcribed and published to a subscribable SignalK path for anything to consume.

### 2.2 The plugin family

| Plugin | Role | Wraps | Default port | Standalone? |
|--------|------|-------|--------------|-------------|
| `signalk-whisper` | Speech-to-text service | `rhasspy/wyoming-whisper` (faster-whisper) | 10300 | ✅ Usable by any Wyoming client, incl. Home Assistant |
| `signalk-piper` | Text-to-speech service | `rhasspy/wyoming-piper` | 10200 | ✅ Same |
| `signalk-openwakeword` | Wake word detection service | `rhasspy/wyoming-openwakeword` | 10400 | ✅ Same |
| `signalk-wyoming` | Orchestrator: pipelines, satellite manager, TTS router, notification bridge, SignalK paths/API, webapp. Optionally runs a **local satellite** container (mic/speaker on the server box). | our own satellite image (§7) | satellite: 10700, control: 10800 | Needs ≥1 of whisper/piper + ≥1 audio endpoint |

All four require **signalk-container** (container runtime manager, reached via `globalThis`) and use **signalk-container-helper** (`ManagedContainer`, `buildConfig()`, `startSafely()`, offline-tolerant conventions).

### 2.3 Non-goals (v1)

- Intent handling / NLU / conversation (D3 — future separate plugin)
- ESPHome-based voice devices (HA Voice PE, ESP32-S3-BOX) — they speak ESPHome's native protocol, not Wyoming
- Cloud STT/TTS providers (offline-first; pluggable providers possible later)
- Media/music playback, ducking, multiroom audio sync
- GPU acceleration
- Self-satellite on non-Linux hosts

---

## 3. Architecture

### 3.1 Topology

Wyoming services are plain TCP servers. **The orchestrator is a Wyoming TCP client to everything** — it dials out to whisper, piper, openwakeword, and every satellite (satellites *listen* on :10700; the server connects to them, as Home Assistant does).

```
                                                        ┌──── boat LAN ────────────┐
┌────────────────── SignalK server host ──────────────┐ │                          │
│                                                     │ │  Remote satellites       │
│  SignalK server process (native OR containerized)   │ │  (upstream or our image, │
│  ┌───────────────────────────────────────────────┐  │ │   each listens :10700)   │
│  │ signalk-wyoming (orchestrator)                │──────►  cockpit               │
│  │  · satellite mgr · pipelines · VAD            │  │ │ ►  salon                 │
│  │  · say() router  · notification bridge        │  │ │ ►  cabin                 │
│  │  · voice.* paths · REST/PUT API · webapp      │  │ └──────────────────────────┘
│  └───┬────────────┬────────────┬────────────┬────┘  │
│      │ :10300     │ :10200     │ :10400     │ :10700/:10800
│  ┌───▼──────┐ ┌───▼─────┐ ┌────▼─────────┐ ┌▼───────────────────┐
│  │ whisper  │ │ piper   │ │ openwakeword │ │ local satellite    │
│  │ (STT)    │ │ (TTS)   │ │ (wake)       │ │ (mic/spkr,/dev/snd)│
│  └──────────┘ └─────────┘ └──────────────┘ └────────────────────┘
│        sibling containers managed via signalk-container          │
└──────────────────────────────────────────────────────────────────┘
```

When SignalK itself runs in a container, signalk-container launches these as **sibling containers** via the host Docker socket; the SignalK container needs no audio access of any kind.

### 3.2 The `Satellite` interface (the seam)

The orchestrator manages satellites through one internal interface:

```ts
interface Satellite {
  id: string; name: string; zone?: string;
  wakeMode: 'satellite' | 'central';
  state: 'disconnected' | 'idle' | 'listening' | 'transcribing' | 'speaking';
  connect(): void;                    // maintains connection w/ backoff
  play(audio: AudioStream, opts?: { priority?: 'normal' | 'urgent' }): Promise<void>;
  events: /* wake detections, audio stream, state changes */;
}
```

v1 ships one implementation: `RemoteSatellite` (Wyoming TCP client). The **local satellite is simply a `RemoteSatellite` pointed at `tcp://localhost:10700`** whose container lifecycle the plugin also owns. A future native in-process backend (bare-metal optimization) or a `role: satellite-only` mode slots in behind this interface with zero orchestrator changes.

### 3.3 Pipeline flows

**Voice command — satellite wake mode** (satellite drives its own wake detection):
1. Satellite streams its mic audio to a wake service (`--wake-uri`, typically the boat's central `signalk-openwakeword`).
2. On detection, satellite plays its awake sound locally and asks the orchestrator to run a pipeline; audio streams to the orchestrator.
3. Orchestrator opens a `transcribe` session with whisper, forwards audio, and runs **endpointing** (§3.4) to decide when the utterance ended.
4. Whisper returns `transcript`; orchestrator publishes to `voice.command` (§5.1), updates state paths, satellite plays its done sound.

**Voice command — central wake mode** (dumb satellite, always streaming):
Same, except the satellite streams continuously to the orchestrator, which tees audio to openwakeword and watches for `detection` itself. Trades continuous LAN audio (~256 kbit/s/satellite raw PCM) and server CPU for simpler satellites.

**Announcement:**
1. `say()` invoked (REST / PUT / PropertyValues / notification bridge).
2. Orchestrator sends `synthesize` to piper, receives `audio-start/chunk/stop`.
3. Audio streams to each target satellite's per-satellite FIFO queue; `priority: 'urgent'` jumps the queue. State paths update (`speaking`).

**Notification bridge:**
`notifications.*` delta → filter (state ≥ `minState`, `method` includes `sound` unless configured otherwise, only on state *transitions*) → `say(value.message ?? "Alarm: <path>", targets, urgent if emergency)`.

### 3.4 Endpointing (utterance segmentation)

Lives in the orchestrator. v1: silero-VAD via `onnxruntime-node`, with an energy-gate + timeout fallback if the dependency proves painful. Tunables (advanced config): `silenceMs` (default 800), `maxUtteranceMs` (10000), `minUtteranceMs` (300). This is the one genuinely non-trivial implementation detail in the orchestrator — spike it early (M2).

---

## 4. Cross-cutting conventions

### 4.1 Service discovery (PropertyValues)

Each service plugin advertises itself on the shared property name **`wyoming-service`**:

```js
app.emitPropertyValue('wyoming-service', {
  plugin: 'signalk-whisper',   // key for latest-wins de-duplication
  type: 'asr',                 // 'asr' | 'tts' | 'wake'
  uri: 'tcp://localhost:10300',
  status: 'ready',             // 'starting' | 'ready' | 'stopped' | 'error'
})
```

PropertyValues replays history to late subscribers, so start order never matters. Consumers keep the **latest value per `plugin`**. Plugins emit again on every status change (including `stopped` in their `stop()` hook). Third-party plugins may advertise additional Wyoming services under the same convention.

The orchestrator's service config defaults to `auto` (use discovery) with manual `tcp://host:port` overrides — so an off-boat GPU box or an existing Home Assistant add-on can be used instead of the sibling plugins.

### 4.2 Model management (offline-first)

"First use at sea with no internet" is a real failure mode. Therefore:

- Models download **at plugin install/first-start**, into the plugin's `signalkDataMount` volume, and survive container recreation.
- Plugin status (`app.setPluginStatus`) reports download progress and blocks "ready" (and the `wyoming-service` `ready` emission) until models are present.
- Approximate sizes documented in each plugin README: whisper tiny ≈ 75 MB / base ≈ 150 MB / small ≈ 500 MB (int8 variants smaller); piper voice ≈ 60 MB; openWakeWord models ≈ 1–5 MB.

### 4.3 Error surfacing

- Service unreachable / container unhealthy → SignalK notification `notifications.voice.<service>` (state `alarm`), plus plugin status text.
- `say()` with piper down → immediate error result (REST 503 / PUT failure / rejected promise), never a silent drop.
- All containers use container-helper health checks + restart policy; offline Docker-pull failures are non-fatal per helper conventions.

---

## 5. `signalk-wyoming` (orchestrator) — detailed spec

### 5.1 SignalK paths (under `vessels.self`)

Custom `voice.*` branch (outside the SignalK schema — normal plugin practice):

| Path | Value | Notes |
|------|-------|-------|
| `voice.command` | `{ text, satellite, zone?, language, wakeWord?, durationMs? }` | One delta per utterance. `$source` = `signalk-wyoming.<satelliteId>` so source-based filtering also works. |
| `voice.satellites.<id>.connected` | `boolean` | |
| `voice.satellites.<id>.state` | `'idle' \| 'listening' \| 'transcribing' \| 'speaking'` | |
| `voice.say` | write-only PUT target | See §5.2 |

### 5.2 The `say()` surface (all three delegate to one internal function)

`say(opts)` where `opts = { text, targets?: string[] /* satellite ids or zones, default all */, voice?, priority?: 'normal'|'urgent' }` → `Promise<{ ok, queued: string[], errors?: [...] }>`

1. **REST** (respects SignalK write auth):
   - `POST /plugins/signalk-wyoming/api/say` — body is `opts`; returns 202 + result
   - `GET /plugins/signalk-wyoming/api/satellites` — status list
   - `GET /plugins/signalk-wyoming/api/services` — discovered services + health
   - `POST /plugins/signalk-wyoming/api/satellites/:id/test` — play test tone
2. **PUT** on `voice.say` — value is a plain string or the `opts` object. Works from node-red and any SignalK client with write permission.
3. **PropertyValues API object** (in-process, for other plugins):
   ```js
   app.emitPropertyValue('signalk-wyoming.api', { version: 1, say })
   ```
   Emitting an API object (not say-*events*) is deliberate: PropertyValues replays history, which would re-speak stale messages; replaying an API handle is instead a feature — late-loading plugins get it automatically.

### 5.3 Notification bridge (core v1)

Config:

| Field | Default | Notes |
|-------|---------|-------|
| `enabled` | `true` | |
| `minState` | `alarm` | speak `alert`/`warn`/`alarm`/`emergency` at or above this |
| `requireSoundMethod` | `true` | only speak notifications whose `method` includes `sound` |
| `includePaths` / `excludePaths` | `[]` | glob patterns on the notification path |
| `targets` | `all` | satellite ids or zones |

Behavior: speak on state *transitions* into qualifying states (no re-speak of unchanged notifications; escalation re-speaks). `emergency` maps to `priority: 'urgent'`. Spoken text is the notification's `message`, falling back to a path-derived phrase. Quiet hours and repeat/nag policies are v1.x (§10).

### 5.4 Satellites config

```
satellites: [
  { id: 'cockpit', name: 'Cockpit', host: '10.10.10.21', port: 10700,
    zone: 'deck', wakeMode: 'satellite' | 'central', wakeWords?: ['ok_nabu'] }
]
localSatellite: {
  enabled: false,                      // D1: opt-in, off by default
  micDevice: 'auto', sndDevice: 'auto',// populated via control-endpoint enumeration
  wakeMode: 'central', wakeWords?: [],
  audioMode: 'alsa' | 'pulse-socket',  // §8: headless vs desktop hosts
  feedbackSounds: true
}
services: { asr: 'auto'|uri, tts: 'auto'|uri, wake: 'auto'|uri }
defaults: { language: 'en', voice: /* piper voice */ }
```

Degraded modes are first-class: TTS-only (no whisper — announcements only, the recommended starter install), STT-only (no piper — commands published, no spoken replies). `wakeMode: central` or a wake-enabled local satellite without openwakeword available → config-time warning + `notifications.voice.wake` at runtime.

### 5.5 Webapp

One webapp, four screens. This is the answer to "audio config is frustrating":

1. **Status** — satellites (connection/state), services (health, model info), recent commands/announcements log.
2. **Audio setup** — device **dropdowns** (populated from the satellite image's control endpoint, §7), *record 3 s & play back* button, *play tone* button, live VU meter (websocket). No free-text ALSA device strings unless the user opens "advanced".
3. **Test** — type-and-say box (target picker), **push-to-talk** button (browser mic → orchestrator → whisper; doubles as the STT test before any wake word exists — note browsers require HTTPS or localhost for `getUserMedia`), wake-word test with live detection feedback.
4. **Config** — friendlier editor for the plugin config (the JSON-schema auto-UI degrades at this schema size).

---

## 6. Service plugins — config specs

Common to all three (via container-helper `buildConfig()`): image tag (default pinned, `auto` supported), port, restart policy, resource limits (memory cap especially — whisper), data mount for models. Each emits `wyoming-service` per §4.1. Recommended default: bind whisper/piper to localhost/docker-network only (§9).

### 6.1 `signalk-whisper`

| Param | Default | Stretch |
|-------|---------|---------|
| `model` | `tiny-int8` | — |
| `language` | `auto` | fixing to e.g. `en` improves speed/accuracy |
| `port` | 10300 | |
| — | | `beamSize`, `computeType`, `initialPrompt` (nautical vocabulary priming — likely high value: "genoa", "windlass", "gybe"), GPU |

### 6.2 `signalk-piper`

| Param | Default | Stretch |
|-------|---------|---------|
| `voice` | `en_US-lessac-medium` | multiple preloaded voices; per-message `voice` override honored from `say()` |
| `port` | 10200 | |
| — | | `lengthScale` (speech rate), streaming synthesis |

### 6.3 `signalk-openwakeword`

| Param | Default | Stretch |
|-------|---------|---------|
| `wakeWords` | `['ok_nabu']` | per-satellite wake words |
| `threshold` | 0.5 | |
| `triggerLevel` | 1 | |
| `port` | 10400 | |
| — | | custom `.tflite` model upload via webapp |

---

## 7. The satellite container image

**The one piece we build from scratch** (no upstream image exists; upstream pushes systemd installs). Working name: `ghcr.io/hoeken/wyoming-satellite` — deliberately SignalK-agnostic, usable standalone on any Docker host (cockpit Pi, or even by Home Assistant users; a small contribution back to the Wyoming ecosystem).

- **Contents:** upstream `wyoming-satellite` (pinned release) + `alsa-utils`, on a slim Debian/Python base. MIT, with attribution.
- **Arch:** `linux/arm64`, `linux/amd64` (armv7 = open question).
- **Ports:** `:10700` Wyoming satellite protocol; `:10800` control API.
- **Control API** (the audio-UX enabler, identical across all deployment scenarios):
  - `GET /devices` — parsed `arecord -l` / `aplay -l`
  - `POST /test/record` — record N seconds, return WAV
  - `POST /test/play` — tone or uploaded WAV
  - `GET /vu` — websocket/SSE stream of mic RMS levels
  - `GET /health`
- **Env config:** `MIC_DEVICE`, `SND_DEVICE`, `WAKE_URI`, `VAD`, `NOISE_SUPPRESSION`, `AUTO_GAIN`, `MIC_VOLUME`, `AWAKE_WAV`/`DONE_WAV` (defaults baked in, overridable via data mount).
- Runs upstream's VAD / noise-suppression / auto-gain — the Python audio stack we chose not to reimplement in Node (D2).

---

## 8. Audio configuration strategy

Principle: **audio never touches the SignalK process.** Whisper/piper/openwakeword are pure network services; all capture/playback happens in satellite containers (or remote satellites), which our image + control API make testable from the webapp.

| Deployment | Local-satellite approach |
|------------|--------------------------|
| SignalK native or containerized, **headless host** (Pi OS Lite — the common boat server) | `/dev/snd` passthrough, `audio` group. Raw ALSA, no sound server to fight. **Default path.** |
| **Desktop host** (OpenPlotter / Pi OS desktop, PipeWire owns devices) | `audioMode: pulse-socket` — mount the host sound-server socket instead of `/dev/snd`. Documented recipe; contention warning surfaced in webapp if `/dev/snd` mode fails. |

**Hardware recommendation (documented prominently):** a USB conference speakerphone (Anker PowerConf, Jabra Speak) — onboard DSP does echo cancellation / AGC / noise suppression in hardware, better than any software path, and it's one cable. Remote satellites: ship a tested "boat satellite" recipe (Pi Zero 2 W + speakerphone + our image or upstream installer).

---

## 9. Security

- REST/PUT respect SignalK's access control (write permission for `say`, admin for config). Webapp config screens require admin.
- **Wyoming has no authentication.** Defaults: whisper/piper bound to localhost/docker network (only the orchestrator needs them). openwakeword must be LAN-reachable only if remote satellites use `wakeMode: satellite` — call this out in config UI. Satellites are LAN-trust; document firewalling guidance for marina wifi. TLS/auth on Wyoming links: out of scope v1.

---

## 10. Roadmap

**M0 — Foundations (prerequisites, other repos):**
- signalk-container + helper: `devices: ['/dev/snd']`, `groupAdd: ['audio']` in `buildConfig()`; hot-plug handled properly (`device-cgroup-rule` + `/dev/snd` bind-mount rather than static `--device`) — generally useful beyond audio (serial/GPS dongles).
- Satellite image repo + multi-arch CI + control API.
- ~~Reserve npm names~~ Done — 0.0.1 placeholders published without the `signalk-node-server-plugin` keyword, so they stay out of the app store until a functional release.

**M1 — "The boat talks"** (useful with zero microphones): `signalk-piper`; orchestrator with `say()` core (REST + PUT + PropertyValues), local satellite (output-only), **notification bridge**, status paths, webapp Status + basic Test screens.

**M2 — "The boat listens":** `signalk-whisper`; pipeline engine + VAD endpointing spike; webapp push-to-talk and record/playback screens; `voice.command` publishing. (PTT makes STT testable before wake words exist.)

**M3 — "Hands-free":** `signalk-openwakeword`; both wake modes; feedback sounds; wake test UI.

**M4 — "Whole-boat":** remote satellites hardened (reconnect/backoff soak testing), zones/targets, queue polish, Pi satellite recipe docs.

**v1.x candidates:** quiet hours + repeat/nag policy for the bridge; priority queue refinement; per-satellite voices; mDNS "scan for satellites"; custom wake-word model upload.

**Stretch:** browser satellite webapp (`getUserMedia` → websocket satellite; zero audio config on any tablet — needs HTTPS); `role: satellite-only` mode; native in-process local satellite (bare-metal desktop optimization behind the `Satellite` seam); streaming TTS; Snapcast as an announce target; intents/LLM assistant as a **separate plugin** consuming `voice.command` + `signalk-wyoming.api`; GPU whisper.

---

## 11. Open questions

1. **`voice.command` value shape:** object (recommended, self-contained for node-red) vs plain string + `$source`-only satellite attribution. Spec assumes object.
2. **VAD choice:** silero via `onnxruntime-node` vs energy gate for v1 — decide after M2 spike.
3. **Satellite image registry/name:** ghcr.io vs Docker Hub; `wyoming-satellite` vs `signalk-wyoming-satellite`.
4. **armv7 support** for the satellite image (Pi Zero 2 W runs arm64; older Pis?).
5. **Whisper default model:** `tiny-int8` (Pi-safe) vs `base-int8` (better accuracy, still OK on Pi 5) — benchmark on real hardware in M2.
6. **Control API port** (10800 proposed) — confirm no conflicts with common marine stacks.
7. Assumption to verify: signalk-container is available/public in time for M0 (spec written against the helper README's description of it).
