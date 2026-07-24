# signalk-wyoming

> **Status: RFC.** This is a design under community review — nothing is functional yet. The npm package is a 0.0.1 placeholder reserving the name. **Read [SPEC.md](SPEC.md) and tell us what you think** via [issues](https://github.com/hoeken/signalk-wyoming/issues).

An offline voice assistant for your boat, built on [Signal K](https://signalk.org) and the [Wyoming protocol](https://github.com/rhasspy/wyoming) (the voice ecosystem behind Home Assistant's Assist: Whisper, Piper, openWakeWord).

- **The boat talks:** any plugin, node-red flow, or API client can speak through satellites anywhere on the boat via a simple `say()` API (anchor alarms, engine warnings, arrival announcements — whatever your plugins send).
- **The boat listens:** wake-word-triggered voice commands are transcribed and published to a subscribable Signal K path (`voice.command`) for anything to consume.
- **Fully offline.** No cloud. Everything runs in containers on the boat.

## The plugin family

| Plugin | Role | Standalone? |
|--------|------|-------------|
| [signalk-wyoming](https://github.com/hoeken/signalk-wyoming) | Orchestrator: pipelines, satellite manager, TTS routing, `voice.*` paths, webapp | needs the services below |
| [signalk-whisper](https://github.com/hoeken/signalk-whisper) | Speech-to-text (Wyoming Whisper) | ✅ usable by any Wyoming client, incl. Home Assistant |
| [signalk-piper](https://github.com/hoeken/signalk-piper) | Text-to-speech (Wyoming Piper) | ✅ |
| [signalk-openwakeword](https://github.com/hoeken/signalk-openwakeword) | Wake word detection (Wyoming openWakeWord) | ✅ |

All services run as containers managed through signalk-container / [signalk-container-helper](https://github.com/hoeken/signalk-container-helper). Audio endpoints are [wyoming-satellite](https://github.com/rhasspy/wyoming-satellite) devices around the boat — including an optional "local satellite" on the server box itself.

## Read the spec

**[SPEC.md](SPEC.md)** covers the architecture, plugin configuration, the `voice.*` path schema, the `say()` API surface, audio configuration strategy, and the roadmap. **[DECISIONS.md](DECISIONS.md)** records the design decisions (and why) plus the RFC history. [IDEA.md](IDEA.md) is the original ideation doc, kept for provenance.

Feedback is very welcome — especially from anyone who has fought boat audio, runs Signal K in a container, or uses Wyoming satellites with Home Assistant.

## License

Apache-2.0
