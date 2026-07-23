# signalk-wyoming — Specification

**Status:** Draft v0.3 — RFC, community comments welcome (2026-07-23; v0.2 open questions resolved, see §12)
**Scope:** A family of SignalK plugins integrating the [Wyoming protocol](https://github.com/rhasspy/wyoming) voice-assistant ecosystem (Whisper STT, Piper TTS, openWakeWord) into SignalK, delivered as containerized microservices via signalk-container / [signalk-container-helper](https://github.com/hoeken/signalk-container-helper).

---

## 1. Decision log

Decisions made during ideation and RFC review, with the deciding rationale:

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Orchestrator and self-satellite are one plugin** (`signalk-wyoming`), self-satellite as opt-in config, off by default | SignalK plugins share one Node process, so a separate plugin buys no isolation; merging avoids cross-plugin lifecycle handshakes, a shared library, and a second install for the common case. A `role` setting (satellite-only mode) remains a future escape hatch. |
| D2 | **Local audio via a containerized satellite** (self-maintained `wyoming-satellite`-based image), not native in-plugin audio | Many SignalK installs are themselves containerized; native `arecord`/`aplay` would require users to modify the SignalK image/compose. A sibling container launched via the host Docker socket works identically across all deployments, and a container runtime is already a hard prerequisite of this plugin family. No upstream satellite image exists, so we build one either way — and owning it lets us bake in device-test tooling. |
| D3 | **Publish-only intent model** — recognized text is published to `voice.command`; intent handling is explicitly out of scope | Clean boundary. node-red, custom plugins, or a future intents/LLM plugin consume commands and respond via the `say()` API. |
| D4 | **Notification→speech bridge is a core v1 feature** | The killer boat feature; works with zero microphones, making Piper + orchestrator alone a useful install. |
| D5 | **Flat plugin names** (`signalk-whisper`, `signalk-piper`, `signalk-openwakeword`, `signalk-wyoming`) | Shorter than family-prefixed names; npm availability confirmed for all four. Names reserved with 0.0.1 placeholder releases. |
| D6 | **`voice.command` publishes an object**, including `id` and `confidence` | Self-contained for node-red consumers (no `$source` parsing); `id` lets a future intents plugin correlate its reply to the utterance; `confidence` (from whisper) lets consumers drop garbage transcripts. `$source`-based filtering still works. |
| D7 | **Endpointing v1 = satellite-side VAD + central energy gate**; silero-in-orchestrator deferred to v1.x | Upstream `wyoming-satellite` already ships silero VAD — enabling it in our image (§7) covers satellite-wake mode for free. `onnxruntime-node` is a heavy native dependency (a classic Pi install failure); an energy gate suffices for the remaining paths (central wake, push-to-talk) on short command utterances. Both sit behind one `Endpointer` interface, so the upgrade is invisible. |
| D8 | **Satellite image published as `ghcr.io/hoeken/wyoming-satellite`** | ghcr.io has no anonymous pull rate limits (Docker Hub's break boat provisioning scripts) and is CI-native with GitHub Actions. The namespace avoids collision with upstream, and matching the upstream project name maximizes discoverability ("wyoming-satellite docker") — fitting the contribution-back positioning. |
| D9 | **No armv7 in v1** (`linux/arm64` + `linux/amd64` only) | Every current Pi (Zero 2 W, 3, 4, 5) runs arm64 and 64-bit Pi OS has been the default since 2022; armv7-only hardware can't usefully run whisper anyway; Python ML wheels on armv7 are a packaging tarpit. Revisit if someone opens an issue. |
| D10 | **Whisper defaults: `tiny-int8` + `language: en` + nautical `initialPrompt`, all v1** | A fixed language plus domain priming makes tiny far better on short commands than raw benchmarks suggest, at Pi-safe latency — while `base-int8` at 3–8 s on a Pi 4 *feels* broken. The webapp Test screen displays per-utterance latency, so every user's own hardware becomes the benchmark for upgrading the model. |
| D11 | **Ports match the Wyoming/Home Assistant ecosystem 1:1** (10200 piper, 10300 whisper, 10400 openwakeword, 10700 satellite); control API on 10800 | Drop-in familiarity for HA users and third-party Wyoming clients. The control API has no ecosystem equivalent, so it sits adjacent to the satellite port; no conflicts with common marine stacks. |
| D12 | **Upstream images own model downloads**; plugin readiness gated on a Wyoming `describe` handshake | Avoids duplicating upstream's model URL/version knowledge and fragile container-log parsing. Progress reporting is coarse, but the readiness signal is protocol-native — models loaded *and* service answering — and doubles as the health check (§4.3). |
| D13 | **Test-driven development at every level**, anchored by a mock Wyoming server (§11) | Voice pipelines fail in ways end users can't debug, so correctness must be established below the audio layer. The protocol (JSONL headers + PCM payloads) is trivially fakeable, making the orchestrator fully testable in CI without containers or audio hardware. |

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

### 2.4 Hardware requirements (RAM budget)

Model *download* sizes are in §4.2; what actually constrains boat servers is resident RAM:

| Component | Approx. resident RAM |
|-----------|----------------------|
| whisper `tiny-int8` | ~400–500 MB (`base-int8` ~700 MB) |
| piper (one voice) | ~150 MB |
| openwakeword | ~100 MB |
| satellite container | ~50 MB |
| orchestrator | negligible (runs inside SignalK's Node process) |

Documented minimums (each plugin README): **TTS-only install** (piper + orchestrator — the recommended starter, §5.4) runs comfortably alongside SignalK on a Pi 4 / 2 GB. **Full stack** (all four plugins + local satellite): Pi 4/5 with 4 GB. Container-helper memory caps (§6) keep a misbehaving service from OOMing the boat server.

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
3. Orchestrator opens a `transcribe` session with whisper and forwards audio; **endpointing happens on the satellite** (its built-in VAD signals end-of-utterance, §3.4/D7).
4. Whisper returns `transcript`; orchestrator publishes to `voice.command` (§5.1), updates state paths, satellite plays its done sound.

**Voice command — central wake mode** (dumb satellite, always streaming):
Same, except the satellite streams continuously to the orchestrator, which tees audio to openwakeword and watches for `detection` itself — and runs its own energy-gate **endpointing** (§3.4), since a continuously-streaming satellite can't signal end-of-utterance. Trades continuous LAN audio (~256 kbit/s/satellite raw PCM) and server CPU for simpler satellites.

**Announcement:**
1. `say()` invoked (REST / PUT / PropertyValues / notification bridge).
2. Orchestrator sends `synthesize` to piper, receives `audio-start/chunk/stop`.
3. Audio streams to each target satellite's per-satellite FIFO queue; `priority: 'urgent'` jumps the queue. State paths update (`speaking`).

**Notification bridge:**
`notifications.*` delta → filter (state ≥ `minState`, `method` includes `sound` unless configured otherwise, only on state *transitions*) → `say(value.message ?? "Alarm: <path>", targets, urgent if emergency)`.

### 3.4 Endpointing (utterance segmentation)

Decided (D7) — **no ML VAD in the orchestrator for v1**:

- **Satellite wake mode:** endpointing happens on the satellite. Upstream `wyoming-satellite` ships silero VAD; our image enables it by default (§7). The satellite signals end-of-utterance; the orchestrator just relays.
- **Central wake mode & push-to-talk:** the orchestrator runs an **energy gate + timeout** endpointer. Tunables (advanced config, §5.4): `silenceMs` (default 800), `maxUtteranceMs` (10000), `minUtteranceMs` (300).
- Both paths feed one internal `Endpointer` interface. Silero via `onnxruntime-node` is the v1.x upgrade behind that interface if the energy gate proves inadequate — the M2 spike validates it against real boat audio (engine noise, wind).

### 3.5 Concurrency & interruption semantics

Voice systems earn their reputation for jank where queues, wake events, and alarms collide. The rules, per satellite:

**Announcement arrives while a pipeline is active** (satellite `listening`/`transcribing`):
- `priority: 'normal'` → queued; plays after the pipeline completes.
- `priority: 'urgent'` → **cancels the pipeline** (whisper session aborted, nothing published, no done sound) and plays immediately. An anchor alarm never waits behind "what's the weather".

**Wake word detected while `speaking`:**
- During `normal` playback → barge-in: playback stops (remainder of that item dropped), pipeline starts.
- During `urgent` playback → ignored; the announcement finishes first.

**Wake dedup across satellites** — open companionways mean two satellites routinely hear the same wake word: after accepting a wake event, wake events from *other* satellites are ignored for `wakeDedupMs` (default 2000). Detections arriving within a 300 ms window are resolved by highest detection score.

**Pipeline timeout:** a pipeline that hasn't produced a transcript within `pipelineTimeoutMs` (default 30000) is aborted — e.g. a hung whisper session — returning the satellite to `idle` and surfacing the error per §4.3.

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

"First use at sea with no internet" is a real failure mode. Decided (D12): the **upstream images own model downloads** — on first container start they fetch models into the plugin's `signalkDataMount` volume, where they survive container recreation. The plugin's responsibilities:

- **Surface it:** `app.setPluginStatus` reports "starting — first start downloads ~150 MB" until ready. Progress is coarse by design; we do not parse container logs.
- **Gate readiness on the protocol, not the container:** the plugin reports `ready` (status text + `wyoming-service` emission) only once a Wyoming `describe` request returns a valid `info` response — which proves models are present *and* the service actually answers.
- Approximate sizes documented in each plugin README: whisper tiny ≈ 75 MB / base ≈ 150 MB / small ≈ 500 MB (int8 variants smaller); piper voice ≈ 60 MB; openWakeWord models ≈ 1–5 MB.

### 4.3 Error surfacing & health

- **Health checks are protocol-native:** each owning plugin sends a periodic Wyoming `describe` ping and requires a valid `info` response (same mechanism as the §4.2 readiness gate). The `info` response's protocol version is validated, with a logged warning on unrecognized versions — images are pinned, but upstream protocol drift should be loud, not mysterious.
- Service unreachable / unhealthy → SignalK notification `notifications.voice.<service>` (state `alarm`), plus plugin status text.
- `say()` with piper down → immediate error result (REST 503 / PUT failure / rejected promise), never a silent drop (see §5.2 for partial-failure semantics).
- All containers use container-helper restart policies; offline Docker-pull failures are non-fatal per helper conventions.

---

## 5. `signalk-wyoming` (orchestrator) — detailed spec

### 5.1 SignalK paths (under `vessels.self`)

Custom `voice.*` branch (outside the SignalK schema — normal plugin practice):

| Path | Value | Notes |
|------|-------|-------|
| `voice.command` | `{ id, text, confidence, satellite, zone?, language, wakeWord?, durationMs? }` | One delta per utterance (D6). `id` is a UUID for correlating replies; `confidence` comes from whisper (consumers should ignore low-confidence transcripts). `$source` = `signalk-wyoming.<satelliteId>` so source-based filtering also works. To reply to the originating satellite: `say({ text, targets: [command.satellite] })`. |
| `voice.satellites.<id>.connected` | `boolean` | |
| `voice.satellites.<id>.state` | `'idle' \| 'listening' \| 'transcribing' \| 'speaking'` | |
| `voice.say` | write-only PUT target | See §5.2 |

### 5.2 The `say()` surface (all three delegate to one internal function)

```ts
say(opts: {
  text: string,
  targets?: string[],   // satellite ids
  zones?: string[],     // zone names
  voice?: string,       // piper voice override
  priority?: 'normal' | 'urgent'
}) => Promise<{ ok: boolean, queued: string[], errors?: { satellite: string, error: string }[] }>
```

Semantics (shared by all three surfaces):

- `targets` and `zones` are **separate fields** — a satellite id and a zone name may share a spelling, so they never compete in one namespace. The effective target set is their union; omitting both means all satellites.
- The promise resolves on **enqueue**, not playback completion. `queued` lists the satellites the audio was queued to; `errors` lists per-satellite failures (disconnected, queue full). `ok` is `true` iff every effective target was queued.
- **Partial failure resolves** (`ok: false`, both arrays populated) — it never rejects. Callers who care check `errors`; fire-and-forget callers aren't punished for one dead satellite.
- It rejects (REST 503 / PUT failure) only when **nothing** could be queued: TTS unavailable, or zero reachable targets.
- `wait: true` (resolve on playback completion, for node-red sequencing) is reserved for v1.x — the field is honored-or-rejected, never silently ignored.

1. **REST** (respects SignalK write auth):
   - `POST /plugins/signalk-wyoming/api/say` — body is `opts`; 202 + result when ≥1 target queued, 503 when none
   - `GET /plugins/signalk-wyoming/api/satellites` — status list
   - `GET /plugins/signalk-wyoming/api/services` — discovered services + health
   - `POST /plugins/signalk-wyoming/api/satellites/:id/test` — play test tone
2. **PUT** on `voice.say` — value is a plain string or the `opts` object. Works from node-red and any SignalK client with write permission.
3. **PropertyValues API object** (in-process, for other plugins):
   ```js
   app.emitPropertyValue('signalk-wyoming.api', { version: 1, say })
   ```
   Emitting an API object (not say-*events*) is deliberate: PropertyValues replays history, which would re-speak stale messages; replaying an API handle is instead a feature — late-loading plugins get it automatically. The emitted object is a **stable facade**: `say` checks plugin state internally and rejects with a clear "signalk-wyoming is stopped" error while the plugin is disabled, and the plugin re-emits on every start. Consumers keep the latest emission (§4.1 convention), but a stale handle held across a restart still fails safely instead of calling into a dead closure.

### 5.3 Notification bridge (core v1)

Config:

| Field | Default | Notes |
|-------|---------|-------|
| `enabled` | `true` | |
| `minState` | `alarm` | speak `alert`/`warn`/`alarm`/`emergency` at or above this |
| `requireSoundMethod` | `true` | only speak notifications whose `method` includes `sound` |
| `includePaths` / `excludePaths` | `[]` | glob patterns on the notification path |
| `targets` / `zones` | all | satellite ids / zone names (§5.2 semantics) |
| `announceActiveOnStartup` | `true` | see startup behavior below |
| `cooldownEnabled` | `true` | per-path flap protection |
| `cooldownSeconds` | `60` | minimum interval before re-speaking the same notification path |

Behavior:

- Speak on state *transitions* into qualifying states — no re-speak of unchanged notifications; escalation to a higher state re-speaks.
- **Flap protection:** the per-path cooldown suppresses re-speaking the same notification path within `cooldownSeconds` — a bouncing sensor toggling normal↔alarm speaks once a minute, not once a second. Escalation to a *higher* state bypasses the cooldown (a flap should not mute an emergency).
- **Startup:** alarms already active when the plugin starts are exactly what a user rebooting the server needs to hear. After a settle delay (`startupGraceMs`, default 10000, advanced — lets the notification tree repopulate), qualifying active notifications are spoken once as a single summary ("Active alarms: anchor drag, engine temperature"). Disable via `announceActiveOnStartup: false`.
- `emergency` maps to `priority: 'urgent'`. Spoken text is the notification's `message`, falling back to a path-derived phrase. Quiet hours and repeat/nag policies are v1.x (§10).

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
advanced: {                              // §3.4/§3.5 tunables; defaults shown
  silenceMs: 800, maxUtteranceMs: 10000, minUtteranceMs: 300,
  wakeDedupMs: 2000, pipelineTimeoutMs: 30000, startupGraceMs: 10000
}
```

Degraded modes are first-class: TTS-only (no whisper — announcements only, the recommended starter install), STT-only (no piper — commands published, no spoken replies). `wakeMode: central` or a wake-enabled local satellite without openwakeword available → config-time warning + `notifications.voice.wake` at runtime.

### 5.5 Webapp

One webapp, four screens. This is the answer to "audio config is frustrating":

1. **Status** — satellites (connection/state), services (health, model info), recent commands/announcements log.
2. **Audio setup** — device **dropdowns** (populated from the satellite image's control endpoint, §7), *record 3 s & play back* button, *play tone* button, live VU meter (websocket). No free-text ALSA device strings unless the user opens "advanced".
3. **Test** — type-and-say box (target picker), **push-to-talk** button (browser mic → orchestrator → whisper; doubles as the STT test before any wake word exists — note browsers require HTTPS or localhost for `getUserMedia`), wake-word test with live detection feedback. Displays **per-utterance transcription latency** — the real-hardware benchmark for choosing a whisper model (D10).
4. **Config** — friendlier editor for the plugin config (the JSON-schema auto-UI degrades at this schema size).

---

## 6. Service plugins — config specs

Common to all three (via container-helper `buildConfig()`): image tag (default pinned, `auto` supported), port, restart policy, resource limits (memory cap especially — whisper), data mount for models. Each emits `wyoming-service` per §4.1. Recommended default: bind whisper/piper to localhost/docker-network only (§9).

### 6.1 `signalk-whisper`

| Param | Default | Notes / stretch |
|-------|---------|-----------------|
| `model` | `tiny-int8` | `base-int8` recommended for Pi 5 / x86 — the webapp Test screen's latency display guides the choice (D10) |
| `language` | `en` | `auto` supported but costs both speed and accuracy on small models (D10) |
| `initialPrompt` | shipped nautical prompt ("genoa", "windlass", "gybe", …) | user-editable; cheapest accuracy win available, so it's v1, not stretch (D10) |
| `port` | 10300 | |
| — | | stretch: `beamSize`, `computeType`, GPU |

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

**The one piece we build from scratch** (no upstream image exists; upstream pushes systemd installs). Published as `ghcr.io/hoeken/wyoming-satellite` (D8) — deliberately SignalK-agnostic, usable standalone on any Docker host (cockpit Pi, or even by Home Assistant users; a small contribution back to the Wyoming ecosystem). The image README's first line states it is a containerization of the upstream project.

- **Contents:** upstream `wyoming-satellite` (pinned release) + `alsa-utils`, on a slim Debian/Python base. MIT, with attribution.
- **Arch:** `linux/arm64`, `linux/amd64`. No armv7 in v1 (D9); README says "open an issue if you need it".
- **Ports:** `:10700` Wyoming satellite protocol; `:10800` control API.
- **Single Wyoming client:** the satellite accepts one Wyoming connection at a time; further attempts are refused while one is held. This is a deliberate security property (§9) — whoever holds the connection owns the microphone, and the orchestrator's always-held connection occupies the slot, locking out rogue LAN clients.
- **Control API** (the audio-UX enabler, identical across all deployment scenarios):
  - `GET /devices` — parsed `arecord -l` / `aplay -l`
  - `POST /test/record` — record N seconds, return WAV
  - `POST /test/play` — tone or uploaded WAV
  - `GET /vu` — websocket/SSE stream of mic RMS levels
  - `GET /health`
- **Env config:** `MIC_DEVICE`, `SND_DEVICE`, `WAKE_URI`, `VAD`, `NOISE_SUPPRESSION`, `AUTO_GAIN`, `MIC_VOLUME`, `AWAKE_WAV`/`DONE_WAV` (defaults baked in, overridable via data mount).
- Runs upstream's VAD / noise-suppression / auto-gain — the Python audio stack we chose not to reimplement in Node (D2). **VAD is enabled by default**: it provides satellite-side endpointing (D7, §3.4).

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
- **Wyoming has no authentication, and a satellite is an open live microphone.** Any client that can reach a satellite's `:10700` can connect and stream cabin audio — treat every satellite port like a baby monitor, and say so bluntly in the READMEs. Mitigations:
  - Our satellite image accepts a **single Wyoming client** at a time, and the orchestrator's always-held connection occupies that slot (§7) — a rogue client on the LAN finds the mic busy.
  - whisper/piper bind to localhost/docker network by default (only the orchestrator needs them).
  - openwakeword must be LAN-reachable only if remote satellites use `wakeMode: satellite` — called out in the config UI.
  - Documentation ships a firewalling + WireGuard/VLAN recipe for marina wifi and multi-AP boats.
  - TLS/auth on Wyoming links: out of scope v1.

---

## 10. Roadmap

**M0 — Foundations (prerequisites, other repos — signalk-container-helper is ours and developed in parallel, so these are coordination items, not external risks):**
- signalk-container + helper: `devices: ['/dev/snd']`, `groupAdd: ['audio']` in `buildConfig()`; hot-plug handled properly (`device-cgroup-rule` + `/dev/snd` bind-mount rather than static `--device`) — generally useful beyond audio (serial/GPS dongles).
- Satellite image repo + multi-arch CI + control API.
- Mock Wyoming server test package (§11) — needed before the first line of orchestrator code (D13).
- ~~Reserve npm names~~ Done — 0.0.1 placeholders published without the `signalk-node-server-plugin` keyword, so they stay out of the app store until a functional release.

**M1 — "The boat talks"** (useful with zero microphones): `signalk-piper`; orchestrator with `say()` core (REST + PUT + PropertyValues), local satellite (output-only), **notification bridge**, status paths, webapp Status + basic Test screens.

**M2 — "The boat listens":** `signalk-whisper`; pipeline engine + energy-gate endpointer, with a spike validating it against real boat audio (engine noise, wind — D7); webapp push-to-talk and record/playback screens; `voice.command` publishing. (PTT makes STT testable before wake words exist.)

**M3 — "Hands-free":** `signalk-openwakeword`; both wake modes; feedback sounds; wake test UI.

**M4 — "Whole-boat":** remote satellites hardened (reconnect/backoff soak testing), zones/targets, queue polish, Pi satellite recipe docs.

**v1.x candidates:** quiet hours + repeat/nag policy for the bridge; `say({ wait: true })` (resolve on playback completion); silero VAD endpointer in the orchestrator (D7); priority queue refinement; per-satellite voices; mDNS "scan for satellites"; custom wake-word model upload.

**Stretch:** browser satellite webapp (`getUserMedia` → websocket satellite; zero audio config on any tablet — needs HTTPS); `role: satellite-only` mode; native in-process local satellite (bare-metal desktop optimization behind the `Satellite` seam); streaming TTS; Snapcast as an announce target; intents/LLM assistant as a **separate plugin** consuming `voice.command` + `signalk-wyoming.api`; GPU whisper.

---

## 11. Testing strategy

Built test-driven, with tests at every level (D13). A voice pipeline that fails mysteriously is undebuggable for end users, so correctness has to be established *below* the audio layer:

| Level | What | How |
|-------|------|-----|
| **Unit** | Notification-bridge state machine (transitions, cooldown, startup summary), queue / priority / interruption rules (§3.5), endpointer, target/zone resolution, config validation | Plain Node tests with fake timers; no I/O |
| **Protocol** | Orchestrator's Wyoming client, pipeline flows end-to-end, `describe` health checks, satellite reconnect/backoff | **Mock Wyoming server** — the protocol is JSONL headers + PCM payloads; a scriptable fake (canned transcripts, injectable delays/disconnects) is ~100 lines. Published as a shared dev package used by all four plugins. |
| **Integration** | Service plugins boot their real images, models load, `describe` succeeds; satellite image control API (record/play/VU assertions) | CI with Docker on amd64 every merge; periodic arm64 runs |
| **Hardware / manual** | Real mics, speakers, echo, engine noise | The webapp Test screens (§5.5) *are* the manual rig — PTT, record/playback, wake test, latency display |

Every PR runs unit + protocol suites; integration runs on merge; a release requires the integration suite green on arm64.

---

## 12. Resolved questions (v0.2 RFC)

All seven open questions from v0.2 are resolved and folded into the decision log: `voice.command` shape → D6, VAD choice → D7, image registry/name → D8, armv7 → D9, whisper default model → D10, ports → D11. Q7 (signalk-container availability) is moot — signalk-container-helper is developed by us, in parallel (M0).
