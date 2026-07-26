# v0.2.1

Nothing to reconfigure. The one behavior change: with the local satellite's
version set to `auto`, new satellite releases now install automatically
instead of waiting for a plugin update.

## Changed

- **`auto` local-satellite version now follows satellite releases
  directly.** Previously `auto` ran a release pinned inside the plugin, so
  satellite fixes waited on a plugin update. It now runs the floating
  `latest` image with digest tracking: when a new satellite release is
  published, the container updates on the next periodic check (skipped
  silently while offline). "Check for updates" now compares against the
  version the running satellite actually reports. Pick an explicit version
  from the panel's dropdown to stay pinned.
- **Renamed to "Voice Orchestrator (Wyoming)"** in the Plugin Config list,
  and the App Store listing now recommends the companion plugins
  (signalk-piper, signalk-whisper, signalk-openwakeword).
- **More accurate "no audio devices" warning.** It no longer blames the
  container manager unconditionally — a host without a sound card reads the
  same — and it points at signalk-container's Deployment Doctor for the
  passthrough fix when the manager is the cause.

# v0.2.0

Nothing to reconfigure — existing settings carry over unchanged. The plugin
now depends on signalk-container-helper 0.2.1 or later, which is installed
automatically with the update.

## Added

- **New graphical configuration panel.** Server → Plugin Config → _Voice
  (Wyoming)_ is now a real panel instead of the bare settings form. You can
  see at a glance which satellites are connected and which voice services
  were found, edit remote satellites as cards instead of raw JSON fields,
  tick wake words from a list of what your wake service actually offers,
  and pick the default announcement voice from a dropdown of your installed
  Piper voices. On servers without custom-panel support you keep the plain
  settings form, which works exactly as before.
- **Pick the local satellite version before enabling.** The panel's version
  dropdown lists the published satellite image versions and works even
  while the plugin is disabled. If the version list can't be fetched — say,
  offshore — the panel keeps showing the last list it saw.
- **"Check for updates" now works for the local satellite container.** The
  plugin registers with signalk-container's update detection, so the check
  and one-click apply in the panel report real results instead of an error.
  (`GET /api/versions` is new; see the README's REST API table.)

## Changed

- **README rewritten for users** — what the system is for, how to set it
  up, and how to use it, with the deep technical material moved to
  [DEVELOPERS.md](DEVELOPERS.md).

# v0.1.1

## Fixed

- **A stuck transcription now always cleans up properly.** Previously, when
  the speech-to-text service hung mid-utterance, an internal timeout race
  could mask the cleanup path; the pipeline now reliably aborts and frees
  the satellite for the next command.
- **Test-suite reliability on macOS** (no runtime impact).

## Changed

- **Local satellite image**: the `auto` version now runs release `0.1.1` of
  `ghcr.io/hoeken/wyoming-satellite`.
- **README**: added an alpha-status disclaimer — the system is untested on
  real hardware so far; please file issues.

# v0.1.0

Initial release of **signalk-wyoming** — an offline voice assistant
orchestrator for Signal K, built on the
[Wyoming protocol](https://github.com/rhasspy/wyoming) (Whisper, Piper,
openWakeWord). Everything runs in containers on the boat: no cloud, no
internet required after first model download.

## Features

- **Spoken announcements (`say()`)** via three surfaces: `POST /api/say`, a
  PUT-able `voice.say` path, and an in-process API for other plugins — with
  per-satellite queues, `urgent` priority (jumps the queue, bypasses mute),
  and a `voice.muted` switch.
- **Voice command pipeline**: wake word → speech-to-text, publishing one
  delta per utterance to `voice.command` with `$source`
  `signalk-wyoming.<satelliteId>`; wake dedup, silence-based endpointing,
  and pipeline timeouts.
- **Satellite management**: remote satellites
  (`ghcr.io/hoeken/wyoming-satellite` or upstream) with automatic
  reconnect, plus an optional local-satellite container for a mic/speaker
  on the server box. Connection and state published under
  `voice.satellites.<id>`.
- **Service discovery**: finds the sibling signalk-piper / signalk-whisper
  / signalk-openwakeword plugins automatically, with manual URI overrides
  (e.g. an off-boat GPU box).
- **Webapp** (Status / Audio / Test): live service and satellite status,
  audio device listing, record-and-playback, VU meter, type-and-say, and
  record-and-transcribe for STT testing before any wake word exists.
- **Degraded modes are first-class**: TTS-only (the recommended starter
  install), STT-only, and service-down alarms via `notifications.voice.*` —
  failures are loud, never silent.
- **Reusable protocol library**: Wyoming framing, typed events, and a TCP
  client exported as `signalk-wyoming/protocol`, plus a scriptable mock
  server (`signalk-wyoming/mock`) used across the plugin family's tests —
  no real audio or containers needed to test.

## Requirements

- Signal K server on Node >= 24.
- [signalk-container](https://www.npmjs.com/package/signalk-container) as
  the container runtime manager (declared via `signalk.requires`).
