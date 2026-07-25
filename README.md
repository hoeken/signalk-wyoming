# signalk-wyoming

> **Status: ALPHA.** This SignalK Wyoming system is 100% vibecoded slop. I
> don't have the right hardware yet to test it, so I'm putting it out there
> for people to test in the meantime. It _should_ work. File issues for
> anything that doesn't.

## What is this?

An offline voice assistant for your boat, built on
[Signal K](https://signalk.org) and the
[Wyoming protocol](https://github.com/rhasspy/wyoming) (the voice ecosystem
behind Home Assistant's Assist). It gives your boat a voice and ears:

- **The boat talks** — spoken announcements to speakers around the boat.
  Your anchor alarm, dead-man's switch, or any other plugin can say
  _"Anchor alarm: drag detected"_ out loud, on every speaker or just the
  cockpit one.
- **The boat listens** — say a wake word ("okay nabu"), speak a command,
  and the transcribed text is published to Signal K for other plugins to
  act on.

Everything runs in containers **on the boat** — no cloud account, no
internet required after the first model download.

This plugin is the **orchestrator** of a small family. It connects the
pieces: routes announcements, runs the wake-word → speech-to-text pipeline,
manages your microphone/speaker devices (satellites), and ships a webapp
for status and audio testing.

| Plugin                                                                 | Role                             | Needed for                            |
| ---------------------------------------------------------------------- | -------------------------------- | ------------------------------------- |
| **signalk-wyoming** (this one)                                         | Orchestrator, satellites, webapp | everything                            |
| [signalk-piper](https://github.com/hoeken/signalk-piper)               | Text-to-speech (Piper)           | announcements ("the boat talks")      |
| [signalk-whisper](https://github.com/hoeken/signalk-whisper)           | Speech-to-text (Whisper)         | voice commands ("the boat listens")   |
| [signalk-openwakeword](https://github.com/hoeken/signalk-openwakeword) | Wake word detection              | hands-free listening ("okay nabu, …") |

Audio in/out happens through **satellites** — devices running the
[wyoming-satellite image](https://github.com/hoeken/wyoming-satellite)
(`ghcr.io/hoeken/wyoming-satellite`) or an upstream wyoming-satellite
install — anywhere on the boat network. A mic/speaker plugged into the
Signal K server box itself works too: enable the built-in **local
satellite** and the plugin runs the container for you.

## Requirements

- **Signal K server** on Node **≥ 24**.
- **[signalk-container](https://www.npmjs.com/package/signalk-container)**
  with a working docker or podman runtime. All voice services run as
  containers managed through it — you never touch docker yourself. When
  Signal K itself runs in a container, services launch as sibling
  containers via the host Docker socket; the Signal K container needs no
  audio access.
- Enough RAM for the services you install:

| Component           | Approx. resident RAM                             |
| ------------------- | ------------------------------------------------ |
| whisper `tiny-int8` | ~400–500 MB (`base-int8` ~700 MB)                |
| piper (one voice)   | ~150 MB                                          |
| openwakeword        | ~100 MB                                          |
| satellite container | ~50 MB                                           |
| orchestrator        | negligible (runs inside Signal K's Node process) |

A **TTS-only install** (piper + this plugin — the recommended starter) runs
comfortably alongside Signal K on a Pi 4 / 2 GB. The **full stack** (all
four plugins + a local satellite) wants a Pi 4/5 with 4 GB. Container
memory caps keep a misbehaving service from starving the boat server.

## Quick start (TTS-only — "the boat talks")

The recommended first install needs zero microphones:

1. Install **signalk-container** (and configure its runtime), then
   **signalk-piper** and **signalk-wyoming** from the Signal K App Store.
   Enable all of them.
2. signalk-piper starts the Piper container; the first start downloads the
   voice (~60 MB — its plugin status shows progress). This plugin discovers
   it automatically — nothing to configure.
3. Give the orchestrator a speaker — either:
   - enable the **Local satellite** in the plugin config (mic/speaker on
     the server box; set the microphone device to `none` for output-only), or
   - add a **remote satellite**: any device on the network running the
     satellite image, entered by host/port in the config panel.
4. Open the webapp (Signal K admin UI → Webapps → **Voice (Wyoming)**), go
   to **Test**, type something, press _Say it_.
5. Make it useful — from any other software:

   ```bash
   curl -X POST http://localhost:3000/plugins/signalk-wyoming/api/say \
     -H 'Content-Type: application/json' \
     -d '{"text": "Anchor alarm: drag detected", "priority": "urgent"}'
   ```

Add **signalk-whisper** later for voice commands (test them from the
webapp's record-and-transcribe — no wake word needed), and
**signalk-openwakeword** for hands-free wake words.

## Configuration

The plugin ships a graphical configuration panel (Server → Plugin Config →
_Voice (Wyoming)_): live satellite and service status, a remote-satellite
editor, wake-word checkboxes listing what your wake service actually
offers, a voice dropdown listing your installed Piper voices, and — for the
local satellite container — a version dropdown plus one-click update
check/apply. On servers without custom-panel support you get a plain
settings form with the same options.

### Remote satellites

One entry per mic/speaker device on the network:

| Setting                                          | Default | Notes                                                                                                                                                                           |
| ------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                             | —       | Required; letters/digits/`_`/`-`. Names the satellite everywhere: `voice.satellites.<id>`, REST URLs, announcement targets. `local` is reserved.                                |
| `name`                                           | the id  | Display name.                                                                                                                                                                   |
| `host` / `port`                                  | —/10700 | Where the satellite listens.                                                                                                                                                    |
| `wakeWords`                                      | none    | Wake word models this satellite listens for (e.g. `okay_nabu`). Leave empty for an announce-only speaker.                                                                       |
| `hasControlApi` (+ `controlPort`, default 10800) | off     | Turn on when the satellite runs [our image](https://github.com/hoeken/wyoming-satellite) — unlocks the webapp Audio screen, record/play tests and record-and-transcribe for it. |

### Local satellite

A mic/speaker plugged into the Signal K server box; the plugin runs the
satellite container for you. Off by default.

| Setting                                       | Default        | Notes                                                                                                             |
| --------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `micDevice` / `sndDevice`                     | `auto`         | ALSA device strings — find them on the webapp **Audio** screen. `auto` = image default; mic `none` = output-only. |
| `wakeWords`                                   | none           | As above.                                                                                                         |
| `audioMode`                                   | `alsa`         | `alsa` for headless boxes (/dev/snd passthrough); `pulse-socket` for desktop hosts (set `hostPulseSocket`).       |
| `feedbackSounds`                              | on             | Awake/done chimes on wake-word interactions.                                                                      |
| `noiseSuppression` / `autoGain` / `micVolume` | image defaults | Audio tuning, under "Audio tuning" in the panel.                                                                  |
| `tag`                                         | `auto`         | Satellite image version. `auto` runs the pinned, tested release and follows plugin updates.                       |

### Services

Where the voice services live. `auto` (the default) finds the sibling
plugins on this server automatically. Set a manual `tcp://host:port` URI to
use a service running elsewhere — an off-boat GPU box, or a Home Assistant
Wyoming add-on, can stand in for any of them (`asr` 10300, `tts` 10200,
`wake` 10400).

### Defaults & advanced

| Setting             | Default | Notes                                                                                                                                                  |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `defaults.language` | `en`    | Spoken language code.                                                                                                                                  |
| `defaults.voice`    | —       | Default Piper voice for announcements (22.05 kHz voices only); empty uses the TTS service's own.                                                       |
| `advanced.*`        | sane    | Endpointing and pipeline timing knobs (silence detection, utterance limits, wake dedup, timeouts). Leave alone unless commands cut off too early/late. |

## Using it

### Announcements — three ways in

- **REST**: `POST /plugins/signalk-wyoming/api/say` with
  `{text, targets?, voice?, priority?}` (see the curl example above).
- **Signal K PUT** to `voice.say` — a plain string or the same options
  object.
- **From another plugin**, in-process with no HTTP round-trip — see
  [DEVELOPERS.md](DEVELOPERS.md#the-in-process-say-api).

`priority: "urgent"` jumps every queue, interrupts whatever is playing, and
bypasses mute — use it for alarms. Normal announcements queue per satellite
and respect the `voice.muted` switch. Failures are loud: if nothing could
be played you get an error back, never a silent drop.

### Voice commands

Say a wake word, speak, pause. The transcribed utterance is published as
one delta on **`voice.command`** — build your own automations on top with
any plugin or client that subscribes to it (a command-handling plugin can
answer back through `say()`).

### Signal K paths

Under `vessels.self`:

| Path                              | Value                                                     | Notes                                                                                                 |
| --------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `voice.command`                   | `{id, text, satellite, language, wakeWord?, durationMs?}` | one delta per utterance; `$source` = `signalk-wyoming.<satelliteId>`                                  |
| `voice.satellites.<id>.connected` | `boolean`                                                 |                                                                                                       |
| `voice.satellites.<id>.state`     | `idle \| listening \| transcribing \| speaking`           |                                                                                                       |
| `voice.say`                       | write-only PUT target                                     | value: a plain string or the `say()` options object                                                   |
| `voice.muted`                     | `boolean`, PUT-able                                       | `true` suppresses `normal` announcements; `urgent` plays through. Defaults to `false`; not persisted. |

Problems surface as notifications under `notifications.voice.*` (e.g. a
wake word configured with no wake service installed, or a service going
down mid-flight).

### REST API

All routes under `/plugins/signalk-wyoming`; they respect Signal K access
control (read access for GETs, write for POSTs; image-update routes are
admin-only).

| Method & path                                      | Body / result                                                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/say`                                    | `{text, targets?, voice?, priority?}` → `202` `{ok, queued, errors?, suppressed?}`; `503` when nothing could be queued   |
| `GET /api/satellites`                              | `[{id, name, connected, state, host, port, hasControlApi, queueDepth}]`                                                  |
| `GET /api/services`                                | `{asr, tts, wake}` → each `{uri, status, source, plugin?}`; `wake` gains `models` (available wake-word names) when ready |
| `GET /api/voices`                                  | piper voices `[{name, languages, description}]`; `503` until TTS is available                                            |
| `POST /api/satellites/:id/test`                    | queue a test tone → `202`                                                                                                |
| `GET /api/satellites/:id/devices`                  | audio devices `{capture: [{card, device, id, name}], playback: [...]}` (`404` if the satellite has no control API)       |
| `POST /api/satellites/:id/record`                  | `{seconds?}` (1–10) → `audio/wav` (briefly pauses the satellite)                                                         |
| `POST /api/satellites/:id/play`                    | `{type: 'tone', frequency?, durationMs?}` or `{type: 'wav', data: base64}`                                               |
| `GET /api/satellites/:id/vu`                       | SSE stream of `{rms, peak}` mic levels                                                                                   |
| `POST /api/transcribe`                             | `{satellite, seconds?}` (1–10 s) → record → whisper → `{text, latencyMs}`; `503` until STT is available                  |
| `POST /api/mute`                                   | `{muted: boolean}` → `{muted}` (same switch as the `voice.muted` PUT)                                                    |
| `GET /api/log`                                     | recent events `[{at, kind, data}]`                                                                                       |
| `GET /api/events`                                  | SSE: `state`, `command`, `announcement`, `detection`, `service`, `error`                                                 |
| `GET /api/versions`                                | local-satellite image versions `{versions: [{tag, prerelease?}]}` (works while the plugin is disabled)                   |
| `GET /api/update/check` / `POST /api/update/apply` | local-satellite image updates (admin)                                                                                    |

`say()` semantics (all three surfaces): the call succeeds when the
announcement is **queued**, not when it finishes playing; partial failure
returns `ok: false` with per-satellite errors; text is capped at 500
characters.

## The webapp

Signal K admin UI → Webapps → **Voice (Wyoming)** (`/signalk-wyoming`).
Three screens, live-updated:

- **Status** — services (discovery status, addresses, wake models),
  satellites (connection, state, queue depth, test-tone button), and a
  recent activity log (announcements, commands, detections, errors).
- **Audio** — for satellites running our image: list the device's
  microphones and speakers (pick one to get the device string for the
  plugin config), _record 3 s & play back_, _play tone_, and a live VU
  meter. Recording briefly pauses the satellite (~2 s) to free the mic.
- **Test** — type-and-say (target select, voice picker, urgent, mute
  toggle), **record-and-transcribe** (test speech-to-text before any wake
  word exists — the latency figure it shows is the practical benchmark for
  choosing a whisper model), and a live wake-word detection feed.

Works over plain LAN HTTP; requests ride your Signal K session — if you see
"not authorized", log in via the Signal K admin UI.

## Updates & offline use

- The **local satellite container** updates from the plugin config panel:
  pick a version from the dropdown (or leave `auto` to follow tested
  releases) and use _Check for updates_ / one-click apply. The version list
  comes from GitHub and keeps showing the last list it saw when you're
  offline.
- The voice services (piper/whisper/openwakeword) update the same way from
  **their own** plugin panels.
- After first setup nothing needs the internet: models and images are on
  the boat. Do first starts and version changes **while you have
  connectivity** — a never-downloaded model can't load at sea, and the
  plugins will tell you so rather than sit silent.

## Security — read this

**Wyoming has no authentication, and a satellite is an open live
microphone.** Any device that can reach a satellite's port `10700` can
connect and stream cabin audio — treat every satellite port like a **baby
monitor**:

- Our satellite image accepts a **single client** at a time, and the
  orchestrator's always-held connection occupies that slot — a rogue LAN
  client finds the mic busy. **Honest gap:** the slot frees on disconnect,
  so a rogue client can seize the mic during the reconnect window after a
  drop (the first reconnect attempt is near-immediate to shrink it).
- whisper/piper stay on localhost by default — only this plugin needs
  them. openwakeword must be LAN-reachable for remote satellites.
- Keep satellite ports away from marina wifi: firewall them, or put
  satellites on their own VLAN or WireGuard network.
- The REST/PUT surfaces respect Signal K access control; there is no
  TLS/auth on the Wyoming connections themselves.

## When things are missing (degraded modes)

Partial installs are normal and supported:

- **TTS-only** (no whisper): announcements work; record-and-transcribe
  answers `503` with a hint. The recommended starter.
- **STT-only** (no piper): voice commands work; `say()` fails with "TTS
  unavailable".
- **Wake words configured but no wake service**: a plugin-status warning
  and a `notifications.voice.wake` alarm; clears by itself when
  openwakeword appears.
- **Service goes down mid-flight**: `notifications.voice.<service>` alarm +
  plugin status; announcements fail loudly, pipelines time out cleanly.
- **Local satellite without audio-device support**: current
  signalk-container releases can't pass `/dev/snd` through yet — the plugin
  starts the container anyway, detects the empty device list, and says so
  plainly in the plugin status and webapp instead of failing silently.

## Development

Technical documentation — code layout, architecture, the protocol library
and mock server, the in-process `say()` API for plugin authors, config
panel build notes — lives in [DEVELOPERS.md](DEVELOPERS.md). The full
design spec is [SPEC.md](SPEC.md); design rationale in
[DECISIONS.md](DECISIONS.md).

## License

Apache-2.0 © hoeken. The
[wyoming-satellite image repo](https://github.com/hoeken/wyoming-satellite)
is MIT (it packages upstream MIT code).
