# signalk-wyoming

> **Status: ALPHA** This SignalK Wyoming system is 100% vibecoded slop. I don't have the right hardware yet to test it, so I'm putting it out there for people to test in the meantime. It _should_ work. File issues for anything that doestn.

An offline voice assistant for your boat, built on [Signal K](https://signalk.org) and the [Wyoming protocol](https://github.com/rhasspy/wyoming) (the voice ecosystem behind Home Assistant's Assist: Whisper, Piper, openWakeWord). This plugin is the **orchestrator** of a small family: it routes spoken announcements to speakers around the boat (`say()`), runs the wake-word → speech-to-text pipeline, publishes voice commands to `voice.command`, manages satellite (mic/speaker) devices, and ships a webapp for status and audio testing. Everything runs in containers on the boat — no cloud, no internet required after first model download.

The full architecture (topology diagram, pipeline flows, concurrency rules) lives in **[SPEC.md](SPEC.md)** §2; design rationale in **[DECISIONS.md](DECISIONS.md)**.

## The plugin family

| Plugin                                                                 | Role                                                                             | Default port            | Standalone?                                           |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------- |
| **signalk-wyoming** (this repo)                                        | Orchestrator: pipelines, satellite manager, TTS routing, `voice.*` paths, webapp | 10700/10800 (satellite) | needs ≥1 of the services below + an audio endpoint    |
| [signalk-piper](https://github.com/hoeken/signalk-piper)               | Text-to-speech (Wyoming Piper)                                                   | 10200                   | ✅ usable by any Wyoming client, incl. Home Assistant |
| [signalk-whisper](https://github.com/hoeken/signalk-whisper)           | Speech-to-text (Wyoming faster-whisper)                                          | 10300                   | ✅                                                    |
| [signalk-openwakeword](https://github.com/hoeken/signalk-openwakeword) | Wake word detection (Wyoming openWakeWord)                                       | 10400                   | ✅                                                    |

Audio endpoints are **satellites** — devices running [our containerized wyoming-satellite image](https://github.com/hoeken/wyoming-satellite) (`ghcr.io/hoeken/wyoming-satellite`) or upstream `wyoming-satellite` installs — anywhere on the boat LAN. The orchestrator can also run a **local satellite** container for a mic/speaker plugged into the Signal K server box itself.

## Requirements

- **Signal K server** on Node **≥ 24**.
- **[signalk-container](https://www.npmjs.com/package/signalk-container)** — the container runtime manager (this plugin declares it via `signalk.requires`). All services run as Docker/Podman containers managed through it and [signalk-container-helper](https://github.com/hoeken/signalk-container-helper). When Signal K itself runs in a container, services launch as sibling containers via the host Docker socket — the Signal K container needs no audio access.
- RAM budget (resident, per SPEC §1.4):

| Component           | Approx. resident RAM                             |
| ------------------- | ------------------------------------------------ |
| whisper `tiny-int8` | ~400–500 MB (`base-int8` ~700 MB)                |
| piper (one voice)   | ~150 MB                                          |
| openwakeword        | ~100 MB                                          |
| satellite container | ~50 MB                                           |
| orchestrator        | negligible (runs inside Signal K's Node process) |

**TTS-only install** (piper + orchestrator — the recommended starter) runs comfortably alongside Signal K on a Pi 4 / 2 GB. **Full stack** (all four plugins + local satellite): Pi 4/5 with 4 GB. Container memory caps keep a misbehaving service from OOMing the boat server.

## Quick start (TTS-only — "the boat talks")

The recommended first install needs zero microphones:

1. Install **signalk-container** (and configure its runtime), then **signalk-piper** and **signalk-wyoming** from the Signal K App Store. Enable both plugins.
2. signalk-piper starts the Piper container; first start downloads the voice (~60 MB — plugin status shows progress). The orchestrator discovers it automatically (`services.tts: "auto"`).
3. Give the orchestrator an audio endpoint — either:
   - enable **Local satellite** in the plugin config (mic/speaker on the server box; set `micDevice: "none"` for output-only), or
   - add a **remote satellite**: any device on the LAN running `ghcr.io/hoeken/wyoming-satellite` (or upstream wyoming-satellite), entered as `{id, host, port}` — add `hasControlApi: true` when it runs our image so the webapp Audio screen and record-and-transcribe can reach its control API.
4. Open the webapp (Signal K admin UI → Webapps → **Voice (Wyoming)**), go to **Test**, type something, press _Say it_.
5. From anywhere else:

   ```bash
   curl -X POST http://localhost:3000/plugins/signalk-wyoming/api/say \
     -H 'Content-Type: application/json' \
     -d '{"text": "Anchor alarm: drag detected", "priority": "urgent"}'
   ```

Add **signalk-whisper** later for voice commands (test them via the webapp's record-and-transcribe — no wake word needed), and **signalk-openwakeword** for hands-free wake words.

## Configuration

Edited in the Signal K plugin config UI (Server → Plugin Config → _Voice (Wyoming)_). Shape and defaults (see `src/config.ts`):

```js
{
  satellites: [                 // remote satellites the orchestrator connects to
    {
      id: 'cockpit',            // required; ^[a-zA-Z0-9_-]+$ — becomes voice.satellites.<id>
                                // and a REST URL segment ('local' is reserved)
      name: 'Cockpit',          // display name (default: id)
      host: '10.10.10.21',      // required
      port: 10700,              // Wyoming satellite port
      wakeWords: ['okay_nabu'], // openWakeWord model names; empty = announce-only
      hasControlApi: true,      // satellite runs our image → webapp Audio screen,
      controlPort: 10800        //   record/play tests, record-and-transcribe
    }                           //   (setting controlPort alone implies hasControlApi)
  ],
  localSatellite: {             // mic/speaker on the Signal K server box
    enabled: false,             // opt-in, off by default
    micDevice: 'auto',          // ALSA device string ('none' = no microphone);
    sndDevice: 'auto',          //   find strings on the webapp Audio screen
    wakeWords: [],
    audioMode: 'alsa',          // 'alsa' (/dev/snd, headless hosts) | 'pulse-socket' (desktop)
    feedbackSounds: true,       // awake/done sounds on wake interactions
    hostPulseSocket: '/run/user/1000/pulse/native',  // pulse-socket mode only
    noiseSuppression: undefined, // 0-4 (image default when unset)
    autoGain: undefined,        // 0-31 dbFS
    micVolume: undefined,       // multiplier
    tag: 'auto'                 // ghcr.io/hoeken/wyoming-satellite tag; 'auto' = pinned release
  },
  services: {                   // 'auto' = discover from the sibling plugins;
    asr: 'auto',                //   or a manual URI, e.g. 'tcp://gpubox:10300'
    tts: 'auto',                //   (lets an off-boat GPU box or a Home Assistant
    wake: 'auto'                //   add-on stand in for the sibling plugins)
  },
  defaults: {
    language: 'en',
    voice: ''                   // default piper voice (22.05 kHz voices only);
  },                            //   '' = the TTS service's configured voice
  advanced: {                   // endpointing + pipeline tunables
    silenceMs: 800,             // end-of-utterance silence
    maxUtteranceMs: 10000,
    minUtteranceMs: 300,
    wakeDedupMs: 2000,          // first wake detection wins; others ignored this long
    pipelineTimeoutMs: 30000,
    wakeRefractorySeconds: 3.0  // satellite image wake refractory
  }
}
```

## Signal K paths

Under `vessels.self` (SPEC §4.1):

| Path                              | Value                                                     | Notes                                                                                                |
| --------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `voice.command`                   | `{id, text, satellite, language, wakeWord?, durationMs?}` | one delta per utterance; `$source` = `signalk-wyoming.<satelliteId>`                                 |
| `voice.satellites.<id>.connected` | `boolean`                                                 |                                                                                                      |
| `voice.satellites.<id>.state`     | `idle \| listening \| transcribing \| speaking`           |                                                                                                      |
| `voice.say`                       | write-only PUT target                                     | value: a plain string or the `say()` opts object                                                     |
| `voice.muted`                     | `boolean`, PUT-able                                       | `true` suppresses `normal` announcements; `urgent` plays through. Defaults to `false`; not persisted |

## REST API

All routes under `/plugins/signalk-wyoming`; they respect Signal K access control (read for GETs, write for POSTs; image-update routes are admin-only).

| Method & path                                      | Body / result                                                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/say`                                    | `{text, targets?, voice?, priority?}` → `202` `{ok, queued, errors?, suppressed?}`; `503` when nothing could be queued   |
| `GET /api/satellites`                              | `[{id, name, connected, state, host, port, hasControlApi, queueDepth}]`                                                  |
| `GET /api/services`                                | `{asr, tts, wake}` → each `{uri, status, source, plugin?}`; `wake` gains `models` (available wake-word names) when ready |
| `GET /api/voices`                                  | piper voices `[{name, languages, description}]`; `503` until TTS is available                                            |
| `POST /api/satellites/:id/test`                    | queue a test tone → `202`                                                                                                |
| `GET /api/satellites/:id/devices`                  | control-API proxy → `{capture: [{card, device, id, name}], playback: [...]}` (`404` if the satellite has no control API) |
| `POST /api/satellites/:id/record`                  | `{seconds?}` (1–10, control-API limit) → `audio/wav` (proxied; briefly pauses the satellite)                             |
| `POST /api/satellites/:id/play`                    | `{type: 'tone', frequency?, durationMs?}` or `{type: 'wav', data: base64}` (proxied)                                     |
| `GET /api/satellites/:id/vu`                       | SSE stream of `{rms, peak}` mic levels (proxied)                                                                         |
| `POST /api/transcribe`                             | `{satellite, seconds?}` (1–10 s) → record via control API → whisper → `{text, latencyMs}`; `503` until ASR is available  |
| `POST /api/mute`                                   | `{muted: boolean}` → `{muted}` (same switch as the `voice.muted` PUT)                                                    |
| `GET /api/log`                                     | ring buffer of recent events `[{at, kind, data}]`                                                                        |
| `GET /api/events`                                  | SSE: `state`, `command`, `announcement`, `detection`, `service`, `error`                                                 |
| `GET /api/update/check` / `POST /api/update/apply` | local-satellite image updates (admin)                                                                                    |

## The `say()` API for other plugins

The same `say()` behind REST and PUT is also published in-process via PropertyValues (SPEC §4.2.3) — an anchor-alarm or notification-bridge plugin makes the boat speak with no HTTP round-trip:

```js
// In another Signal K plugin:
app.onPropertyValues("signalk-wyoming.api", (values) => {
  const latest = values.at(-1)?.value; // {version: 1, say}
  if (!latest) return;
  latest
    .say({
      text: "Anchor alarm: drag detected",
      priority: "urgent", // jumps every queue, bypasses mute
      targets: ["cockpit"], // omit for all satellites
    })
    .then((result) => {
      // resolves on ENQUEUE: {ok, queued: ['cockpit'], errors?, suppressed?}
    })
    .catch((err) => {
      // rejects only when NOTHING could be queued (TTS down, no targets,
      // or "signalk-wyoming is stopped" — the facade stays safe across restarts)
    });
});
```

Semantics (all three surfaces): promise resolves on enqueue, never on playback; partial failure resolves with `ok: false` + per-satellite `errors`; text is capped at 500 characters; `wait: true` is reserved for v1.x and rejects loudly.

## Webapp

Signal K admin UI → Webapps → **Voice (Wyoming)** (`/signalk-wyoming`). Three screens, live-updated over SSE:

- **Status** — services table (discovery status, URIs, wake models), satellites table (connection, state, queue depth, test-tone button), recent activity log (announcements, commands, detections, errors).
- **Audio** — for satellites running our image: device enumeration (`arecord -l`/`aplay -l` as dropdowns — pick one to get the ALSA device string to paste into the plugin config), _record 3 s & play back_, _play tone_, live VU meter. Recording/VU briefly pause the satellite (~2 s) to free the mic device. The webapp cannot write plugin config in v1 (SPEC §4.4).
- **Test** — type-and-say (target multi-select, voice picker, urgent, mute toggle), **record-and-transcribe** (STT testing before any wake word exists, with per-utterance latency — the real-hardware benchmark for choosing a whisper model), and a live wake-word detection feed.

Works over plain LAN HTTP (no `getUserMedia`/HTTPS requirements); requests ride the Signal K session — if you see "not authorized", log in via the Signal K admin UI.

## Security — read this

**Wyoming has no authentication, and a satellite is an open live microphone.** Any client that can reach a satellite's `:10700` can connect and stream cabin audio — treat every satellite port like a **baby monitor**. Mitigations:

- Our satellite image accepts a **single Wyoming client** at a time, and the orchestrator's always-held connection occupies that slot — a rogue LAN client finds the mic busy. **Honest gap:** the slot frees on disconnect, so a rogue client can seize the mic during the reconnect window after a drop (the orchestrator's first reconnect attempt is near-immediate to shrink it).
- whisper/piper bind to localhost/docker network by default — only the orchestrator needs them. openwakeword must be LAN-reachable for remote satellites.
- Isolate satellite ports from marina wifi: firewall them, or put satellites on their own VLAN / WireGuard network.
- REST/PUT surfaces respect Signal K access control; TLS/auth on the Wyoming links themselves is out of scope for v1.

## Degraded modes (first-class)

- **TTS-only** (no whisper): announcements work; record-and-transcribe returns `503` with a hint. The recommended starter install.
- **STT-only** (no piper): voice commands publish to `voice.command`; `say()` rejects with "TTS unavailable".
- **Wake words configured but no wake service:** plugin-status warning + `notifications.voice.wake` alarm; clears when openwakeword appears.
- **Service down mid-flight:** `notifications.voice.<service>` alarm + plugin status; `say()` fails loudly (never a silent drop); pipelines abort after `pipelineTimeoutMs`.
- **Local satellite without `/dev/snd` support:** current signalk-container releases can't pass audio devices through yet — the plugin starts the container anyway, detects the empty device list, and reports it plainly in the plugin status and webapp instead of failing silently.
- `voice.muted` suppresses normal announcements; `urgent` always plays.

## Development

```bash
npm install
npm run build     # tsc → dist/
npm test          # typecheck tests + vitest
npm run ci-lint   # eslint + prettier --check
npm run format    # prettier --write + eslint --fix
```

- **No real audio or containers needed for tests.** The Wyoming protocol implementation and a scriptable mock server live in this package and are exported as subpaths:
  - `signalk-wyoming/protocol` — framing (`encodeEvent`/`EventDecoder`), typed events, TCP client (`WyomingConnection`, `probeWyoming`);
  - `signalk-wyoming/mock` — `MockWyomingServer` with scriptable asr/tts/wake/satellite roles, injectable delays/disconnects/malformed frames, and an event log.

  The sibling service plugins consume these as **devDependencies** for their protocol tests (their production code embeds a tiny self-contained describe ping instead).

- **Publishing note:** until `signalk-wyoming` is on npm, the sibling repos reference it as `file:../signalk-wyoming` devDependencies — those must flip to a semver range before any of them publish, and their standalone CI stays red until then.
- The webapp (`public/`) is vanilla ES modules with no build step; it is linted/formatted with the same eslint/prettier setup (browser globals).
- Layout: `src/` (orchestrator modules — `api.ts` is the REST contract, `pipeline.ts` the wake→ASR engine, `queue.ts`/`say.ts` the announcement rules), `test/` (vitest; mock-server e2e + fake-timer unit suites), `public/` (webapp).

## License

Apache-2.0. The [wyoming-satellite image repo](https://github.com/hoeken/wyoming-satellite) is MIT (it packages upstream MIT code).
