# Unreleased

Nothing to reconfigure — existing settings carry over unchanged. The plugin
now depends on signalk-container-helper 0.2.1 or later.

## Added

- **New graphical configuration panel.** Server → Plugin Config → _Voice
  (Wyoming)_ is now a real panel instead of the bare settings form: live
  orchestrator status (satellite connections and discovered asr/tts/wake
  services), a remote-satellite editor with per-satellite wake-word
  checkboxes driven by the running wake service's advertised models, a piper
  voice dropdown fed by `/api/voices`, and — for the local satellite
  container — an image-version dropdown plus one-click update check/apply.
  Built on the shared `signalk-container-helper/ui` building blocks as an
  ESM Module Federation remote. On servers without custom-panel support you
  keep the plain settings form, which works exactly as before.
- **`GET /api/versions`** — published `ghcr.io/hoeken/wyoming-satellite`
  image tags (from the repo's GitHub tags), feeding the panel's version
  dropdown. Deliberately usable while the plugin is disabled, so you can
  pick a version up front; if GitHub is unreachable — say, offshore — the
  panel keeps showing the last version list it saw.
- **Update detection for the local satellite container** — the
  ManagedContainer now registers with signalk-container's update service
  (latest stable image tag from GitHub), so `GET /api/update/check` reports
  real results and the panel's "Check for updates" works.

# v0.1.1

## Fixed

- **Pipeline**: the ASR finish backstop timeout now gets headroom beyond the session watchdog's deadline, so the watchdog always wins the race to abort a hung transcription — previously the backstop could fire first and mask the watchdog's cleanup path.
- **Tests**: the mock-server test helper now waits for the server to register an accepted connection before returning, fixing a hang on macOS where an immediate server→client send could vanish.

## Changed

- **Local satellite**: pinned container tag bumped to `ghcr.io/hoeken/wyoming-satellite:0.1.1`.
- **README**: added an alpha-status disclaimer — the system is untested on real hardware so far; please file issues.

# v0.1.0

Initial release of **signalk-wyoming** — an offline voice assistant orchestrator for Signal K, built on the [Wyoming protocol](https://github.com/rhasspy/wyoming) (Whisper, Piper, openWakeWord). Everything runs in containers on the boat: no cloud, no internet required after first model download.

## Features

- **Spoken announcements (`say()`)** via three surfaces: `POST /api/say`, a PUT-able `voice.say` path, and an in-process PropertyValues facade for other plugins — with per-satellite queues, `urgent` priority (jumps the queue, bypasses mute), and a `voice.muted` switch.
- **Voice command pipeline**: wake word → speech-to-text, publishing one delta per utterance to `voice.command` with `$source` `signalk-wyoming.<satelliteId>`; wake dedup, energy-gate endpointing, and pipeline timeouts.
- **Satellite management**: remote satellites (`ghcr.io/hoeken/wyoming-satellite` or upstream) with claim-aware reconnect and keepalive, plus an optional local-satellite container for a mic/speaker on the server box. Connection and state published under `voice.satellites.<id>`.
- **Service discovery**: auto-discovers the sibling signalk-piper / signalk-whisper / signalk-openwakeword plugins, with manual URI overrides (e.g. an off-boat GPU box).
- **Webapp** (Status / Audio / Test): live service and satellite status over SSE, ALSA device enumeration, record-and-playback, VU meter, type-and-say, and record-and-transcribe for STT testing before any wake word exists.
- **Degraded modes are first-class**: TTS-only (the recommended starter install), STT-only, and service-down alarms via `notifications.voice.*` — failures are loud, never silent.
- **Reusable protocol library**: byte-exact Wyoming framing, typed events, and a TCP client exported as `signalk-wyoming/protocol`, plus a scriptable mock server (`signalk-wyoming/mock`) used across the plugin family's tests — no real audio or containers needed to test.

## Requirements

- Signal K server on Node >= 24.
- [signalk-container](https://www.npmjs.com/package/signalk-container) as the container runtime manager (declared via `signalk.requires`).
- At least one Wyoming service (signalk-piper for TTS is the recommended start) and an audio endpoint (local or remote satellite).

**Security note:** Wyoming has no authentication — a satellite is an open live microphone. Firewall or VLAN-isolate satellite ports; see the README's Security section.
