# TODO

## Retire the version-1 `say()` API

Today there are two parallel ways to make a satellite speak:

- `say()` — `POST /api/say`, the `voice.say` PUT, the in-process
  `signalk-wyoming.api` property. Speech only, resolves on enqueue, runs on
  its own code path in `src/say.ts` (`createSay`). Its announcements never
  reach the delivery tracker.
- `announce()` — `POST /api/announcements`, the `voice.announce` PUT, the
  in-process `signalk-wyoming.announcements.api` property. Speech and
  sounds, per-satellite delivery state, wait/cancel, `delivery` events.

Everything should end up on `announce()`. Plan:

1. **Make `say()` a thin wrapper over `announce()`.** `createSay` builds a
   `{kind: "speech", text, voice?}` request, calls the announcement service
   and maps the snapshot back to the enqueue-time `SayResult` shape
   (`{ok, queued, errors?, suppressed?}`). Delete the duplicate
   validation/mute/target logic in `src/say.ts` and the unused
   `AnnouncementService.say()` method. No behavior change for callers;
   `say()` announcements become visible in delivery tracking.
2. **Mark the old surfaces deprecated in code.** Add `Deprecated` to the
   `voice.say` meta description and the `/api/say` route docs, and log one
   debug line per start when the `signalk-wyoming.api` property has
   subscribers. Done in docs already (README, DEVELOPERS.md, CHANGELOG).
3. **Move first-party callers.** The Test page's say form, signalk-piper /
   signalk-openwakeword examples, and any alert-center plugin should call
   `announce()`. Update the README quick start curl example.
4. **Remove `say()`** in a later major/minor release once the companion
   plugins have shipped on `announce()`: drop `/api/say`, `voice.say`, the
   `signalk-wyoming.api` property and `src/say.ts`; keep
   `MAX_SAY_TEXT_CHARS` wherever the speech validation lands.

Naming is settled: `announce()` stays the single real API for both kinds of
content (a `play()` rename was considered and rejected — it reads wrong for
speech and the per-target states, the `delivery` event kind and the docs
already use the announcement vocabulary). If a sound-specific convenience
is wanted, add `playSound(soundId, options)` as a wrapper over `announce()`
rather than a second implementation.
