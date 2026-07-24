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
