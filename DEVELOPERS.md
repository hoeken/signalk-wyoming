# Developing signalk-wyoming

Technical reference for contributors and for developers integrating with
the plugin. User-facing documentation lives in [README.md](README.md); the
full architecture (topology, pipeline flows, concurrency rules) is
[SPEC.md](SPEC.md) §2, with design rationale in
[DECISIONS.md](DECISIONS.md).

## Code layout

| Path                          | Contents                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/index.ts`                | Plugin factory: config, discovery, say() core, satellites, local container, `voice.*` paths, SSE hub |
| `src/config.ts`               | Config parse/validate + the JSON-schema fallback for the plugin config UI                            |
| `src/api.ts`                  | The REST contract (`registerApiRoutes`) — every route in one place                                   |
| `src/pipeline.ts`             | Wake → ASR pipeline engine (`voice.command` publication)                                             |
| `src/announcements.ts`        | Generic speech/sound requests, idempotency, delivery state, wait/cancel and lifecycle events         |
| `src/queue.ts` / `src/say.ts` | Per-satellite queues and the backwards-compatible say() contract                                     |
| `src/sounds.ts`               | Built-in sounds and bounded persistent PCM WAV library                                               |
| `src/satellite.ts`            | Remote satellite client (claim-aware reconnect, keepalive)                                           |
| `src/local-satellite.ts`      | Local satellite `ManagedContainer` + image version fetching                                          |
| `src/discovery.ts`            | `wyoming-service` PropertyValues discovery (spec §3.1)                                               |
| `src/protocol/`               | Wyoming protocol library (subpath export, see below)                                                 |
| `src/mock/`                   | Scriptable mock Wyoming server (subpath export, see below)                                           |
| `src/configpanel/`            | React source for the Admin UI configuration panel (built into `public/`)                             |
| `public/`                     | Hand-written webapp (vanilla ES modules, no build step) + the built config-panel bundle              |
| `test/`                       | Vitest suites: mock-server e2e + fake-timer unit suites                                              |

## Commands

```sh
npm install
npm run build                 # tsc → dist/, then webpack → public/ (config panel)
npm test                      # typecheck (tsconfig.test.json) + vitest
npm run test:watch            # vitest watch mode
npm run ci-lint               # eslint + prettier --check
npm run format                # prettier + eslint --fix
```

**No real audio or containers are needed for tests** — everything runs
against the in-package mock server and fakes.

## The protocol library and mock server

The stable Wyoming protocol pieces are exported as subpaths and consumed by
the sibling service plugins as **devDependencies** for their protocol tests
(their production code embeds a tiny self-contained describe ping instead):

- **`signalk-wyoming/protocol`** — byte-exact framing
  (`encodeEvent`/`EventDecoder`), typed events, TCP client
  (`WyomingConnection`, `probeWyoming`).
- **`signalk-wyoming/mock`** — `MockWyomingServer` with scriptable
  asr/tts/wake/satellite roles, injectable delays/disconnects/malformed
  frames, and an event log.

## The in-process `say()` API

> **Deprecated in a future release.** `say()` (this property, `/api/say`
> and the `voice.say` PUT) predates the announcement API and runs on its own
> code path in `src/say.ts`, so its announcements are not delivery-tracked.
> New code should use the [delivery-aware announcement
> API](#the-delivery-aware-announcement-api) with
> `content: {kind: "speech", text}`. See `TODO.md` for the migration plan.

The same `say()` behind REST and PUT is published in-process via
PropertyValues (SPEC §4.2.3) — an anchor-alarm or notification-bridge
plugin makes the boat speak with no HTTP round-trip:

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

Semantics (all three surfaces): the promise resolves on enqueue, never on
playback; partial failure resolves with `ok: false` + per-satellite
`errors`; text is capped at 500 characters; `wait: true` is reserved for
v1.x and rejects loudly.

## The delivery-aware announcement API

New integrations should subscribe to the separate
`signalk-wyoming.announcements.api` PropertyValue. It does not change the
version-1 `say()` contract:

```js
app.onPropertyValues("signalk-wyoming.announcements.api", (values) => {
  const api = values.at(-1)?.value;
  if (!api) return;

  api
    .announce({
      requestId: "anchor-alarm-42", // stable across retries
      content: { kind: "sound", soundId: "alarm" },
      targets: ["cockpit"],
      priority: "urgent",
    })
    .then(async ({ id }) => {
      const terminal = await api.waitForAnnouncement(id, {
        timeoutMs: 30000,
      });
      // Inspect terminal.targets.cockpit.state before acknowledging upstream.
    });
});
```

The version-1 object contains `announce`, `getAnnouncement`,
`waitForAnnouncement`, `cancelAnnouncement`, and `onAnnouncementEvent`.
`content` is either `{kind: "speech", text, voice?}` or
`{kind: "sound", soundId}` (a built-in or an uploaded sound). Speech requires
a discovered TTS service; sounds go straight to the satellite and therefore
work without Piper.

The same service sits behind `POST /api/announcements` and the
`voice.announce` PUT (`src/paths.ts`), which also accepts a bare sound id and
`{soundId | text, …}` shorthands and answers 200 once a target is queued,
503 when every target failed. Completed request IDs/results are retained
in a bounded, time-limited in-memory store so a retry does not duplicate
playback.

The orchestrator promotes a target to `played` only after the satellite sends
the standard Wyoming `played` event. If confirmation never arrives within the
audio duration plus a grace period, `play()` resolves `{confirmed: false}` and
the target records `unknown` — the connection stays up, since satellites before
wyoming-satellite 1.4.1 never send `played` at all. A cancelled stream waits
only for the buffered lead it already sent (plus grace), so a late `played`
from it cannot acknowledge the next stream. This is application-level proof
from the satellite process, not proof that physical sound left the speaker.

## Config panel build

The panel is a webpack **Module Federation remote** built by
`webpack.config.cjs` (`.cjs` because the package is ESM) from
`src/configpanel/` into `public/`, following the Signal K
`signalk-plugin-configurator` convention and built on the shared
[`signalk-container-helper/ui`](https://github.com/hoeken/signalk-container-helper)
components. The JSON-schema form (`buildSchema`/`buildUiSchema` in
`src/config.ts`) remains the fallback on servers without panel support —
keep the two in sync when adding settings.

Gotchas:

- Because this package has `"type": "module"`, the Signal K server injects
  the panel as `<script type="module">` and the Admin UI expects an **ESM
  federation container** (`import()` + get/init exports). A classic
  `var`-library remote loads silently into module scope and the panel dies
  with "Module is not available" — hence `experiments.outputModule: true`
  and `library: { type: "module" }` in the webpack config.
- `public/` also carries the hand-written webapp, so the webpack output
  uses `clean: false` and only the generated files
  (`remoteEntry.js`, `*.mjs`) are gitignored.

Verify the container shape after a build:

```sh
node -e 'import("./public/remoteEntry.js").then((m) => console.log(typeof m.get, typeof m.init))'
# → function function
```

## Image versions & update detection

The local satellite image (`ghcr.io/hoeken/wyoming-satellite`) publishes an
image tag (bare semver) for every `v*` git tag; the repo has **no GitHub
Releases**, so:

- `GET /api/versions` (feeds the panel's version dropdown) reads the GitHub
  **tags** API — `fetchSatelliteVersions` in `src/local-satellite.ts`. The
  route registers outside the running-flag guard so the dropdown works
  while the plugin is disabled.
- The `ManagedContainer` registers with signalk-container's update service
  using a **custom** version source (latest stable tag from the same
  fetch) — the helper's stock `githubReleases` source would see nothing.
  `currentTag` reports the resolved tag (`auto` → the
  `LOCAL_SATELLITE_PINNED_TAG` constant); bump that constant deliberately
  and test against the new image before releasing.

## Publishing note

Until `signalk-wyoming` is on npm, the sibling repos reference it as
`file:../signalk-wyoming` devDependencies — those must flip to a semver
range before any of them publish, and their standalone CI stays red until
then.

## Releasing

```sh
npm run release    # tags v<package.json version> and pushes the tag
```

`prepublishOnly` runs `build` + `test`, so a broken tree cannot be
published.
