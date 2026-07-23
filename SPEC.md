# signalk-wyoming — Specification

**Status:** Draft v0.5 — RFC, community comments welcome (2026-07-23)
**Scope:** A family of SignalK plugins integrating the [Wyoming protocol](https://github.com/rhasspy/wyoming) voice-assistant ecosystem (Whisper STT, Piper TTS, openWakeWord) into SignalK, delivered as containerized microservices via signalk-container / [signalk-container-helper](https://github.com/hoeken/signalk-container-helper).
**Rationale & history:** design decisions and RFC evolution live in [DECISIONS.md](DECISIONS.md), referenced here as (D1)…(D15).

---

## 1. Overview

### 1.1 What this is

Voice in and voice out for a boat's SignalK server, fully offline:

- **Voice out:** any plugin, node-red flow, or API client can make the boat speak ("Anchor alarm: drag detected") through speakers anywhere on the boat. SignalK notifications are spoken automatically.
- **Voice in:** wake-word-triggered voice commands ("ok nabu, log my position") are transcribed and published to a subscribable SignalK path for anything to consume.

### 1.2 The plugin family

| Plugin | Role | Wraps | Default port | Standalone? |
|--------|------|-------|--------------|-------------|
| `signalk-whisper` | Speech-to-text service | `rhasspy/wyoming-whisper` (faster-whisper) | 10300 | ✅ Usable by any Wyoming client, incl. Home Assistant |
| `signalk-piper` | Text-to-speech service | `rhasspy/wyoming-piper` | 10200 | ✅ Same |
| `signalk-openwakeword` | Wake word detection service | `rhasspy/wyoming-openwakeword` | 10400 | ✅ Same |
| `signalk-wyoming` | Orchestrator: pipelines, satellite manager, TTS router, notification bridge, SignalK paths/API, webapp. Optionally runs a **local satellite** container (mic/speaker on the server box). | our own satellite image (§6) | satellite: 10700, control: 10800 | Needs ≥1 of whisper/piper + ≥1 audio endpoint |

All four require **signalk-container** (container runtime manager, reached via `globalThis`) and use **signalk-container-helper** (`ManagedContainer`, `buildConfig()`, `startSafely()`, offline-tolerant conventions).

### 1.3 Non-goals (v1)

- Intent handling / NLU / conversation (D3 — future separate plugin)
- ESPHome-based voice devices (HA Voice PE, ESP32-S3-BOX) — they speak ESPHome's native protocol, not Wyoming
- Cloud STT/TTS providers (offline-first; pluggable providers possible later)
- Media/music playback, ducking, multiroom audio sync
- GPU acceleration
- Self-satellite on non-Linux hosts

### 1.4 Hardware requirements (RAM budget)

Model *download* sizes are in §3.2; what actually constrains boat servers is resident RAM:

| Component | Approx. resident RAM |
|-----------|----------------------|
| whisper `tiny-int8` | ~400–500 MB (`base-int8` ~700 MB) |
| piper (one voice) | ~150 MB |
| openwakeword | ~100 MB |
| satellite container | ~50 MB |
| orchestrator | negligible (runs inside SignalK's Node process) |

Documented minimums (each plugin README): **TTS-only install** (piper + orchestrator — the recommended starter, §4.4) runs comfortably alongside SignalK on a Pi 4 / 2 GB. **Full stack** (all four plugins + local satellite): Pi 4/5 with 4 GB. Container-helper memory caps (§5) keep a misbehaving service from OOMing the boat server.

---

## 2. Architecture

### 2.1 Topology

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

### 2.2 The `Satellite` interface (the seam)

The orchestrator manages satellites through one internal interface:

```ts
interface Satellite {
  id: string; name: string;
  state: 'disconnected' | 'idle' | 'listening' | 'transcribing' | 'speaking';
  connect(): void;                    // maintains connection w/ backoff
  play(audio: AudioStream, opts?: { priority?: 'normal' | 'urgent' }): Promise<void>;
  events: /* wake detections, audio stream, state changes */;
}

interface AudioStream {
  format: { rate: number; width: number; channels: number };  // from piper's audio-start
  chunks: AsyncIterable<Buffer>;                              // raw PCM payloads
}
```

`RemoteSatellite.play()` frames an `AudioStream` as Wyoming `audio-start` / `audio-chunk` / `audio-stop` events on the satellite's TCP connection — satellites never see unframed PCM.

v1 ships one implementation: `RemoteSatellite` (Wyoming TCP client). The **local satellite is simply a `RemoteSatellite` pointed at `tcp://localhost:10700`** whose container lifecycle the plugin also owns. A future native in-process backend (bare-metal optimization) or a `role: satellite-only` mode slots in behind this interface with zero orchestrator changes.

### 2.3 Pipeline flows

**Voice command — satellite wake mode** (the v1 mode, D15; the satellite drives its own wake detection):
1. Satellite streams its mic audio to a wake service (`--wake-uri`, typically the boat's central `signalk-openwakeword`).
2. On detection, satellite plays its awake sound locally and asks the orchestrator to run a pipeline; audio streams to the orchestrator.
3. Orchestrator opens a `transcribe` session with whisper and forwards audio. **The orchestrator endpoints** (§2.4/D7): the satellite streams until told to stop, and whisper transcribes only on `AudioStop`.
4. On end-of-utterance the orchestrator sends whisper `AudioStop`; whisper returns `transcript`; orchestrator publishes to `voice.command` (§4.1), updates state paths, and forwards the `Transcript` to the satellite — which is what stops its streaming and triggers its done sound (upstream behavior).

**Voice command — central wake mode** (dumb satellite, always streaming): **deferred to v1.x (D15).** The satellite would stream continuously to the orchestrator, which tees audio to openwakeword and watches for `detection` itself — trading continuous LAN audio (~256 kbit/s/satellite raw PCM) and server CPU for satellites that can't run wake streaming. v1 supports satellite wake mode only.

**Announcement:**
1. `say()` invoked (REST / PUT / PropertyValues / notification bridge).
2. Orchestrator sends `synthesize` to piper, receives `audio-start/chunk/stop`. One synthesis per unique voice per announcement: the default voice synthesizes once, is **buffered in full**, and replays to each target's queue — an `AudioStream` is single-consumer, so fan-out to queues at different depths requires the buffer; announcements are short, so this is cheap. A per-satellite voice override (v1.x) synthesizes separately for that satellite only.
3. Audio streams to each target satellite's per-satellite FIFO queue; `priority: 'urgent'` jumps the queue. State paths update (`speaking`).

**Notification bridge:**
`notifications.*` delta → filter (state ≥ `minState`, `method` includes `sound` unless configured otherwise, only on state *transitions*) → `say(value.message ?? "Alarm: <path>", targets, urgent if emergency)`.

### 2.4 Endpointing (utterance segmentation)

**The orchestrator endpoints every voice-command path in v1** (D7), because nothing upstream does it for us:

- `wyoming-satellite` **disables VAD when a wake service is configured** (logs "VAD is not used with local wake word detection"); after a wake detection, `WakeStreamingSatellite` streams until the server sends back a `Transcript` or `Error`.
- `wyoming-faster-whisper` **transcribes only when it receives `AudioStop`**; its internal silero pass trims silence from already-collected audio — it does not detect end-of-speech in a live stream. (In Home Assistant deployments, HA's assist pipeline runs the VAD segmenter; our orchestrator plays that role.)

| Mode | Who endpoints | Mechanism |
|------|---------------|-----------|
| Satellite wake (`--wake-uri`) — the only v1 pipeline mode (D15) | **Orchestrator** | Energy gate + timeout on the post-wake stream → sends whisper `AudioStop` → relays the resulting `Transcript` to the satellite, which stops streaming on it |
| Satellite VAD mode (`--vad`, no wake service) | Satellite (silero) | Not used by any v1 configuration; the image supports it for standalone/upstream-style use |

Tunables (advanced config, §4.4): `silenceMs` (default 800), `maxUtteranceMs` (10000), `minUtteranceMs` (300). All paths feed one internal `Endpointer` interface. **Contingency (D7):** if the M2 spike fails its go/no-go (<10% false-endpoint rate on ≥30 min of real boat audio: engine on; engine off + wind; motoring into chop), silero VAD via `onnxruntime-node` replaces the energy gate behind the same interface **in v1**.

### 2.5 Concurrency & interruption semantics

Voice systems earn their reputation for jank where queues, wake events, and alarms collide. The rules, per satellite:

**Announcement arrives while a pipeline is active** (satellite `listening`/`transcribing`):
- `priority: 'normal'` → queued; plays after the pipeline completes.
- `priority: 'urgent'` → **cancels the pipeline** (whisper session aborted, nothing published, no done sound) and plays immediately. An anchor alarm never waits behind "what's the weather".

**Wake word detected while `speaking`:**
- During `normal` playback → barge-in: playback stops (remainder of that item dropped), pipeline starts.
- During `urgent` playback → ignored; the announcement finishes first.

**Wake dedup across satellites** — open companionways mean two satellites routinely hear the same wake word: the **first detection wins** and starts the pipeline immediately; wake events from *other* satellites are ignored for `wakeDedupMs` (default 2000). No score-comparison window — that would delay every wake acceptance to break a rare tie.

**Pipeline timeout:** a pipeline that hasn't produced a transcript within `pipelineTimeoutMs` (default 30000) is aborted — e.g. a hung whisper session — returning the satellite to `idle` and surfacing the error per §3.3.

### 2.6 Audio format conventions

- **Mic/STT path:** satellites capture 16 kHz, 16-bit, mono (upstream default; whisper's native rate). `wyoming-faster-whisper` additionally resamples on ingest (`AudioChunkConverter`), so a nonconforming source degrades gracefully rather than failing.
- **TTS/playback path:** piper `medium`/`high` voices output 22 050 Hz, 16-bit, mono; the satellite image's playback command is configured for 22 050 Hz to match natively. **v1 constrains voice selection to 22 050 Hz voices** — `-low`/`-x_low` voices output 16 kHz and would play at the wrong speed, since the satellite does not resample playback. A future TTS provider at a different rate likewise requires matching satellite `snd` settings.
- The orchestrator performs **no resampling** — Wyoming `audio-start` events carry `rate/width/channels`, and each hop honors them.

---

## 3. Cross-cutting conventions

### 3.1 Service discovery (PropertyValues)

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

**Emission discipline:** the server enforces a **global** cap (`MAX_VALUES_COUNT = 1000`, counted across *all* property names) and `emitPropertyValue` **throws** once it's hit — for every plugin in the process, not just the offender. Plugins therefore emit only on meaningful state transitions and debounce flaps (error → ready → error within ~500 ms collapses to a single emission); pathological status churn is logged as a warning instead of emitted.

The orchestrator's service config defaults to `auto` (use discovery) with manual `tcp://host:port` overrides — so an off-boat GPU box or an existing Home Assistant add-on can be used instead of the sibling plugins.

### 3.2 Model management (offline-first)

"First use at sea with no internet" is a real failure mode. The **upstream images own model downloads** (D12) — on first container start they fetch models into the plugin's `signalkDataMount` volume, where they survive container recreation. The plugin's responsibilities:

- **Surface it:** `app.setPluginStatus` reports "starting — first start downloads ~150 MB" until ready. Progress is coarse by design; we do not parse container logs.
- **Gate readiness on the protocol, not the container:** the plugin reports `ready` (status text + `wyoming-service` emission) only once a Wyoming `describe` request returns a valid `info` response — which proves models are present *and* the service actually answers.
- Approximate sizes documented in each plugin README: whisper tiny ≈ 75 MB / base ≈ 150 MB / small ≈ 500 MB (int8 variants smaller); piper voice ≈ 60 MB; openWakeWord models ≈ 1–5 MB.

### 3.3 Error surfacing & health

- **Health checks are protocol-native:** each owning plugin sends a periodic Wyoming `describe` ping and requires a valid `info` response (same mechanism as the §3.2 readiness gate). The `info` response's protocol version is validated (target: Wyoming protocol **1.x**; versions outside 1.x log a loud warning but do not block operation) — images are pinned, but upstream protocol drift should be loud, not mysterious.
- Service unreachable / unhealthy → SignalK notification `notifications.voice.<service>` (state `alarm`), plus plugin status text.
- `say()` with piper down → immediate error result (REST 503 / PUT failure / rejected promise), never a silent drop (see §4.2 for partial-failure semantics).
- All containers use container-helper restart policies; offline Docker-pull failures are non-fatal per helper conventions.

---

## 4. `signalk-wyoming` (orchestrator) — detailed spec

### 4.1 SignalK paths (under `vessels.self`)

Custom `voice.*` branch (outside the SignalK schema — normal plugin practice):

| Path | Value | Notes |
|------|-------|-------|
| `voice.command` | `{ id, text, satellite, language, wakeWord?, durationMs? }` | One delta per utterance (D6). `id` is a UUID for correlating replies. No confidence field — the Wyoming `Transcript` event doesn't carry one (D6). `$source` = `signalk-wyoming.<satelliteId>` so source-based filtering also works. To reply to the originating satellite: `say({ text, targets: [command.satellite] })`. |
| `voice.satellites.<id>.connected` | `boolean` | |
| `voice.satellites.<id>.state` | `'idle' \| 'listening' \| 'transcribing' \| 'speaking'` | |
| `voice.say` | write-only PUT target | See §4.2 |
| `voice.muted` | `boolean`, PUT-able | D14. `true` suppresses the notification bridge and `priority: 'normal'` announcements; `urgent` (including `emergency` notifications) plays through. Defaults to `false`; not persisted across restarts. |

### 4.2 The `say()` surface (all three delegate to one internal function)

```ts
say(opts: {
  text: string,
  targets?: string[],   // satellite ids; omit for all satellites
  voice?: string,       // piper voice override (22.05 kHz voices only, §2.6)
  priority?: 'normal' | 'urgent'
}) => Promise<{ ok: boolean, queued: string[], errors?: { satellite: string, error: string }[] }>
```

Semantics (shared by all three surfaces):

- `targets` lists satellite ids; omitting it means all satellites. (`zones` — named satellite groups — is v1.x; it will be a **separate field** from `targets`, so adding it is backward-compatible and a satellite id and a zone name never compete in one namespace.)
- The promise resolves on **enqueue**, not playback completion. `queued` lists the satellites the audio was queued to; `errors` lists per-satellite failures (disconnected, queue full). `ok` is `true` iff every effective target was queued.
- **Partial failure resolves** (`ok: false`, both arrays populated) — it never rejects. Callers who care check `errors`; fire-and-forget callers aren't punished for one dead satellite.
- It rejects (REST 503 / PUT failure) only when **nothing** could be queued: TTS unavailable, or zero reachable targets.
- `text` is capped at **500 characters**; longer input is truncated with `…` and a logged warning — one malformed notification can't monopolize the queue.
- While `voice.muted` is `true` (D14): `priority: 'normal'` calls resolve `{ ok: false, queued: [], suppressed: 'muted' }` — nothing queued, not an error; `urgent` bypasses mute.
- `wait: true` (resolve on playback completion, for node-red sequencing) is reserved for v1.x — the field is honored-or-rejected, never silently ignored. In v1 it rejects with `{ ok: false, error: "wait:true is not supported in v1; poll voice.satellites.<id>.state" }`.

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
   Emitting an API object (not say-*events*) is deliberate: PropertyValues replays history, which would re-speak stale messages; replaying an API handle is instead a feature — late-loading plugins get it automatically. The emitted object is a **stable facade**: `say` checks plugin state internally and rejects with a clear "signalk-wyoming is stopped" error while the plugin is disabled, and the plugin re-emits on every start. Consumers keep the latest emission (§3.1 convention), but a stale handle held across a restart still fails safely instead of calling into a dead closure.

### 4.3 Notification bridge (core v1)

Config:

| Field | Default | Notes |
|-------|---------|-------|
| `enabled` | `true` | |
| `minState` | `alarm` | speak `alert`/`warn`/`alarm`/`emergency` at or above this |
| `requireSoundMethod` | `true` | only speak notifications whose `method` includes `sound` |
| `includePaths` / `excludePaths` | `[]` | glob patterns on the notification path |
| `targets` | all | satellite ids (§4.2 semantics) |
| `announceActiveOnStartup` | `true` | see startup behavior below |
| `cooldownSeconds` | `60` | per-path flap protection: minimum interval before re-speaking the same notification path; `0` disables |

Behavior:

- Speak on state *transitions* into qualifying states — no re-speak of unchanged notifications; escalation to a higher state re-speaks.
- **Flap protection:** the per-path cooldown suppresses re-speaking the same notification path within `cooldownSeconds` — a bouncing sensor toggling normal↔alarm speaks once a minute, not once a second. Escalation to a *higher* state bypasses the cooldown (a flap should not mute an emergency).
- **Startup:** alarms already active when the plugin starts are exactly what a user rebooting the server needs to hear. After a fixed 10 s settle delay (lets the notification tree repopulate), each qualifying active notification is spoken once **through the normal bridge path**, exactly as if it had just transitioned — no bespoke summary machinery. Disable via `announceActiveOnStartup: false`.
- `emergency` maps to `priority: 'urgent'`. Spoken text is the notification's `message`, falling back to a path-derived phrase: strip the `notifications.` prefix, take the last 2–3 segments, split camelCase/snake_case, join with spaces, capitalize (`notifications.navigation.anchor.alarmState` → "Anchor alarm state"; `notifications.bilge.forward.highWater` → "Forward high water").
- While `voice.muted` is `true` (D14), bridge announcements are suppressed — except `emergency`, which maps to `urgent` and plays through. Quiet hours and repeat/nag policies are v1.x (§9).

### 4.4 Satellites config

```
satellites: [
  { id: 'cockpit', name: 'Cockpit', host: '10.10.10.21', port: 10700,
    wakeWords?: ['ok_nabu'] }            // satellite wake mode only in v1 (D15)
]
localSatellite: {
  enabled: false,                      // D1: opt-in, off by default
  micDevice: 'auto', sndDevice: 'auto',// populated via control-endpoint enumeration
  wakeWords?: [],
  audioMode: 'alsa' | 'pulse-socket',  // §7: headless vs desktop hosts
  feedbackSounds: true
}
services: { asr: 'auto'|uri, tts: 'auto'|uri, wake: 'auto'|uri }
defaults: { language: 'en', voice: /* piper voice, 22.05 kHz only (§2.6) */ }
advanced: {                              // §2.4/§2.5 tunables; defaults shown
  silenceMs: 800, maxUtteranceMs: 10000, minUtteranceMs: 300,
  wakeDedupMs: 2000, pipelineTimeoutMs: 30000
}
```

Satellite `id`s must match `^[a-zA-Z0-9_-]+$` (validated at config load, with a clear error) — an `id` becomes a SignalK path segment (`voice.satellites.<id>`) and a REST URL component (`/api/satellites/:id/test`).

**Local satellite container lifecycle:** started on plugin start, stopped in the plugin's `stop()` hook — disabling the orchestrator never leaves an orphaned open microphone. Restart policy is `unless-stopped`: on a SignalK/host restart the container comes back on its own and the orchestrator reconnects; if the orchestrator crashes without its `stop()` hook running, the satellite keeps running and is re-adopted on the next plugin start.

Degraded modes are first-class: TTS-only (no whisper — announcements only, the recommended starter install), STT-only (no piper — commands published, no spoken replies). A wake-enabled satellite without openwakeword available → config-time warning + `notifications.voice.wake` at runtime.

### 4.5 Webapp

One webapp, three screens. This is the answer to "audio config is frustrating":

1. **Status** — satellites (connection/state), services (health, model info), recent commands/announcements log.
2. **Audio setup** — device **dropdowns** (populated from the satellite image's control endpoint, §6), *record 3 s & play back* button, *play tone* button, live VU meter (websocket). No free-text ALSA device strings unless the user opens "advanced".
3. **Test** — type-and-say box (target picker, voice picker populated from piper's `info` response via `GET .../api/services`), **record-and-transcribe** STT test (record a few seconds via the satellite control API (§6), run the WAV through whisper, display the transcript — makes STT testable before any wake word exists, with no browser-audio or HTTPS requirements), wake-word test with live detection feedback. Displays **per-utterance transcription latency** — the real-hardware benchmark for choosing a whisper model (D10).

Config editing uses SignalK's standard plugin-config UI in v1; a friendlier custom editor is a v1.x candidate (§9). Browser push-to-talk is deferred to stretch alongside the browser-satellite idea it amounts to — `getUserMedia` needs HTTPS plus its own capture/resample/streaming path.

---

## 5. Service plugins — config specs

Common to all three (via container-helper `buildConfig()`): image tag (default pinned, `auto` supported), port, restart policy, resource limits (memory cap especially — whisper), data mount for models. Each emits `wyoming-service` per §3.1. Recommended default: bind whisper/piper to localhost/docker-network only (§8).

### 5.1 `signalk-whisper`

| Param | Default | Notes / stretch |
|-------|---------|-----------------|
| `model` | `tiny-int8` | `base-int8` recommended for Pi 5 / x86 — the webapp Test screen's latency display guides the choice (D10) |
| `language` | `en` | `auto` supported but costs both speed and accuracy on small models (D10) |
| `initialPrompt` | shipped nautical prompt ("genoa", "windlass", "gybe", …) | user-editable; cheapest accuracy win available, so it's v1, not stretch (D10). README documents it with examples to add: vessel name, local port names, boat-specific gear |
| `port` | 10300 | |
| — | | stretch: `beamSize`, `computeType`, GPU |

### 5.2 `signalk-piper`

| Param | Default | Stretch |
|-------|---------|---------|
| `voice` | `en_US-lessac-medium` (22.05 kHz voices only in v1, §2.6) | multiple preloaded voices; per-message `voice` override honored from `say()` |
| `port` | 10200 | |
| — | | `lengthScale` (speech rate), streaming synthesis |

### 5.3 `signalk-openwakeword`

| Param | Default | Stretch |
|-------|---------|---------|
| `wakeWords` | `['ok_nabu']` | per-satellite wake words |
| `threshold` | 0.5 | |
| `triggerLevel` | 1 | |
| `port` | 10400 | |
| — | | custom `.tflite` model upload via webapp |

---

## 6. The satellite container image

**The one piece we build from scratch** (no upstream image exists; upstream pushes systemd installs). Published as `ghcr.io/hoeken/wyoming-satellite` (D8) — deliberately SignalK-agnostic, usable standalone on any Docker host (cockpit Pi, or even by Home Assistant users; a small contribution back to the Wyoming ecosystem). The image README's first line states it is a containerization of the upstream project.

- **Contents:** upstream `wyoming-satellite` (pinned release) + `alsa-utils`, on a slim Debian/Python base. MIT, with attribution.
- **Arch:** `linux/arm64`, `linux/amd64`. No armv7 in v1 (D9); README says "open an issue if you need it".
- **Ports:** `:10700` Wyoming satellite protocol; `:10800` control API.
- **Single Wyoming client:** the satellite accepts one Wyoming connection at a time; further attempts are refused while one is held. This is a deliberate security property (§8, including the reconnect-window caveat) — whoever holds the connection owns the microphone, and the orchestrator's always-held connection occupies the slot, locking out rogue LAN clients.
- **Control API** (the audio-UX enabler, identical across all deployment scenarios):
  - `GET /devices` — parsed `arecord -l` / `aplay -l`
  - `POST /test/record` — record N seconds, return WAV
  - `POST /test/play` — `{ type: 'tone', frequency?: 440, durationMs?: 2000 }` (defaults: 440 Hz sine, 2 s) or `{ type: 'wav', data: '<base64>' }`
  - `GET /vu` — websocket/SSE stream of mic RMS levels
  - `GET /health`
- **Env config:** `MIC_DEVICE`, `SND_DEVICE`, `WAKE_URI`, `WAKE_REFRACTORY_SECONDS` (default 3.0 — shorter than upstream's 5.0 for conversational follow-up commands), `VAD`, `NOISE_SUPPRESSION`, `AUTO_GAIN`, `MIC_VOLUME`, `AWAKE_WAV`/`DONE_WAV` (defaults baked in, overridable via data mount).
- Runs upstream's noise-suppression / auto-gain — the Python audio stack we chose not to reimplement in Node (D2). **`VAD` is a no-op when `WAKE_URI` is set** — upstream disables it in wake mode (§2.4/D7); it applies only to standalone VAD-mode use of the image (no wake service).

---

## 7. Audio configuration strategy

Principle: **audio never touches the SignalK process.** Whisper/piper/openwakeword are pure network services; all capture/playback happens in satellite containers (or remote satellites), which our image + control API make testable from the webapp.

| Deployment | Local-satellite approach |
|------------|--------------------------|
| SignalK native or containerized, **headless host** (Pi OS Lite — the common boat server) | `/dev/snd` passthrough, `audio` group. Raw ALSA, no sound server to fight. **Default path.** |
| **Desktop host** (OpenPlotter / Pi OS desktop, PipeWire owns devices) | `audioMode: pulse-socket` — mount the host sound-server socket instead of `/dev/snd`. Documented recipe; contention warning surfaced in webapp if `/dev/snd` mode fails. |

**Hardware recommendation (documented prominently):** a USB conference speakerphone (Anker PowerConf, Jabra Speak) — onboard DSP does echo cancellation / AGC / noise suppression in hardware, better than any software path, and it's one cable. Remote satellites: ship a tested "boat satellite" recipe (Pi Zero 2 W + speakerphone + our image or upstream installer).

---

## 8. Security

- REST/PUT respect SignalK's access control (write permission for `say`, admin for config). Webapp config screens require admin.
- **Wyoming has no authentication, and a satellite is an open live microphone.** Any client that can reach a satellite's `:10700` can connect and stream cabin audio — treat every satellite port like a baby monitor, and say so bluntly in the READMEs. Mitigations:
  - Our satellite image accepts a **single Wyoming client** at a time, and the orchestrator's always-held connection occupies that slot (§6) — a rogue client on the LAN finds the mic busy. **Honest gap:** the slot is held only while the TCP connection is live; upstream clears its `server_id` on disconnect and lets the next client take over, so a rogue client can seize the mic during the reconnect window after a drop. Mitigations: the orchestrator's first reconnect attempt is near-immediate (backoff ramps only on repeated failure); VLAN/firewall isolation of satellite ports; v1.x candidate: shared-secret handshake validation in our image.
  - whisper/piper bind to localhost/docker network by default (only the orchestrator needs them).
  - openwakeword must be LAN-reachable for remote satellites — satellite wake mode is the only v1 mode (D15) — called out in the config UI.
  - Documentation ships a firewalling + WireGuard/VLAN recipe for marina wifi and multi-AP boats.
  - TLS/auth on Wyoming links: out of scope v1.

---

## 9. Roadmap

**M0 — Foundations (prerequisites, other repos — signalk-container-helper is ours and developed in parallel, so these are coordination items, not external risks):**
- signalk-container + helper: `devices: ['/dev/snd']`, `groupAdd: ['audio']` in `buildConfig()`; hot-plug handled properly (`device-cgroup-rule` + `/dev/snd` bind-mount rather than static `--device`) — generally useful beyond audio (serial/GPS dongles). The plugins pin the minimum signalk-container-helper version that ships these (exact version set when M0 closes).
- Satellite image repo + multi-arch CI + control API.
- Mock Wyoming server test package (§10) — needed before the first line of orchestrator code (D13).
- npm names reserved — 0.0.1 placeholders published without the `signalk-node-server-plugin` keyword, so they stay out of the app store until a functional release.

**M1 — "The boat talks"** (useful with zero microphones): `signalk-piper`; orchestrator with `say()` core (REST + PUT + PropertyValues), `voice.muted` (D14), local satellite (output-only), **notification bridge**, status paths, webapp Status + basic Test screens.

**M2 — "The boat listens":** `signalk-whisper`; pipeline engine + energy-gate endpointer, with a spike validating it against real boat audio under the D7 go/no-go (<10% false-endpoint rate: engine on; engine off + wind; motoring into chop — failing pulls silero into v1); webapp record-and-transcribe and record/playback screens; `voice.command` publishing. (Satellite record → whisper makes STT testable before wake words exist.)

**M3 — "Hands-free":** `signalk-openwakeword`; satellite wake mode (D15); feedback sounds; wake test UI.

**M4 — "Whole-boat":** remote satellites hardened (reconnect/backoff soak testing), queue polish, Pi satellite recipe docs.

**v1.x candidates:** quiet hours + repeat/nag policy for the bridge (building on `voice.muted`, D14); `say({ wait: true })` (resolve on playback completion); silero VAD endpointer in the orchestrator, if the M2 go/no-go didn't already pull it into v1 (D7); central wake mode for satellites that can't run wake streaming (D15); zones (named satellite groups — a separate `say()` field, backward-compatible); webapp config editor (the JSON-schema auto-UI degrades at this schema size); shared-secret handshake in the satellite image (§8); priority queue refinement; per-satellite voices; mDNS "scan for satellites"; custom wake-word model upload.

**Stretch:** browser satellite webapp (`getUserMedia` → websocket satellite; zero audio config on any tablet — needs HTTPS; subsumes browser push-to-talk, the same capture path); `role: satellite-only` mode; native in-process local satellite (bare-metal desktop optimization behind the `Satellite` seam); streaming TTS; Snapcast as an announce target; intents/LLM assistant as a **separate plugin** consuming `voice.command` + `signalk-wyoming.api`; GPU whisper.

---

## 10. Testing strategy

Built test-driven, with tests at every level (D13). A voice pipeline that fails mysteriously is undebuggable for end users, so correctness has to be established *below* the audio layer:

| Level | What | How |
|-------|------|-----|
| **Unit** | Notification-bridge state machine (transitions, cooldown, startup replay), queue / priority / interruption rules (§2.5), endpointer, target resolution, config validation | Plain Node tests with fake timers; no I/O |
| **Protocol** | Orchestrator's Wyoming client, pipeline flows end-to-end, `describe` health checks, satellite reconnect/backoff | **Mock Wyoming server** — the protocol is JSONL headers + PCM payloads; a scriptable fake (canned transcripts, injectable delays/disconnects) is ~100 lines. Published as a shared dev package used by all four plugins. |
| **Integration** | Service plugins boot their real images, models load, `describe` succeeds; satellite image control API (record/play/VU assertions) | CI with Docker on amd64 every merge; periodic arm64 runs |
| **Hardware / manual** | Real mics, speakers, echo, engine noise | The webapp Test screens (§4.5) *are* the manual rig — record-and-transcribe, record/playback, wake test, latency display |

Every PR runs unit + protocol suites; integration runs on merge; a release requires the integration suite green on arm64.
