# Contributing to openMeet

Thanks for taking a look. openMeet is a small-group recording studio (up to 4 recorded participants) that runs
entirely in the browser — the hard parts are WebRTC, `MediaRecorder`, and
writing bytes to disk without corrupting them. This guide covers what you need
to know that isn't obvious from reading the code.

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Prerequisites

| | |
|---|---|
| Node | ≥ 20.11 |
| pnpm | 9.12.0 (pinned via `packageManager`) |
| Browser | **A Chromium browser** for anything touching recording |

**The browser requirement is not optional, and it is the #1 source of confusion.**
Recording writes MP4, and which codecs `MediaRecorder` can actually encode **varies
by operating system**, even between builds of the same Chrome version. Firefox
can't record. Safari can't host, and a Safari guest is recorded as video only (no
WAV).

Measured on Chrome 151:

| | Linux (.deb *and* snap) | macOS / Windows |
|---|---|---|
| H.264 (`avc1.42E01F`) | ✅ | ✅ |
| AAC-LC (`mp4a.40.2`) | ❌ | ✅ |

**On Linux there is no AAC encoder** — in the official `.deb` as well as the
Chromium snap. H.264 itself is present everywhere. The app therefore probes at
startup and takes the first codec pair it can encode, preferring H.264+AAC and
falling back to H.264+Opus. Both stay in the MP4 container.

Practical consequence: on Linux your recordings are **Opus-in-MP4**, which some
editors (notably Resolve) import unevenly. Remux with the `ffmpeg` command in
`sync.json` if your editor complains.

If recording is unavailable the Record button is disabled with a reason — that is
the check working, not a bug.

## Setup

```bash
pnpm install
pnpm --filter @openmeet/worker db:migrate:local   # create the local D1
```

Then run both halves in separate terminals:

```bash
pnpm --filter @openmeet/worker dev   # Worker + Durable Object -> :8787
pnpm --filter @openmeet/web dev      # Next.js -> :3000
```

Open http://localhost:3000, click **New Room**, and paste the invite link into a
second browser profile to join as the guest.

## Checks

Both must pass before a PR is mergeable — CI runs them on every pull request:

```bash
pnpm -r typecheck   # strict tsconfig; this is the real safety net
pnpm -r test        # the vitest suites for worker, web and protocol

# NEXT_PUBLIC_API_BASE is inlined at build time, so the production build refuses
# to run without it. Any non-resolving host works for a compile-only check.
NEXT_PUBLIC_API_BASE=https://ci.invalid pnpm build
```

There is deliberately **no linter**. The `tsconfig` is strict
(`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`,
`noFallthroughCasesInSwitch`) and catches nearly everything ESLint would, and
formatting is handled by `.editorconfig`. If you find a real class of bug that
only a linter catches, open an issue and make the case.

## What CI cannot verify

**A green check does not mean the call works.** `getUserMedia`,
`getDisplayMedia` and `RTCPeerConnection` cannot run headless, so none of the
following is covered by any automated test:

- the live call connecting at all
- recording, chunk transfer, and the files landing on disk
- screen share
- the call UI and its responsive layouts

If your change touches media capture, the peer connection, the recording
pipeline or the call UI, **you must smoke-test it manually with two browser
profiles before it can be merged** (see [MANUAL-TESTING.md](MANUAL-TESTING.md)), and say so in your PR. Unit tests here mock
the browser APIs; they prove the logic, not the integration.

## Repo-specific traps

These will bite you if you don't know them. There are more in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

- **Static export is production-only by design.** `next.config.ts` sets
  `output: 'export'` only when `NODE_ENV === 'production'`, because dev needs
  runtime slug resolution for `/r/[slug]`. Don't enable it unconditionally.
- **Negotiation is presence-gated.** Local tracks are added — which triggers the
  SDP offer — only once the other peer is actually present. Moving
  `setLocalStream` back into `startPeer` deadlocks every call: the Durable
  Object drops messages addressed to an absent peer, so the first peer offers
  into an empty room and then rejects the second peer's offer as a glare
  collision.
- **The chunk header is JSON-over-string, not a packed binary struct.** Each
  chunk is *two* ordered DataChannel sends: a JSON string header, then the
  binary payload. A chunk header must never contain a `type` key — that's how
  the receiver tells control messages from headers.
- **There are two unrelated ack mechanisms.** Recording acks flow over the
  DataChannel. The WebSocket `recording-ack` message exists in the protocol
  types but nothing produces or consumes it; `recording-completed` is likewise
  kept in the protocol only for older tabs.
- **`@openmeet/protocol` is consumed as raw TypeScript source**, resolved via
  tsconfig `paths` plus a vitest `alias`. Breaking either breaks every consumer.
- **Time units differ by field.** Every D1 timestamp is in milliseconds
  (`recordings` too, since `0002_recordings_ms.sql`); the TURN credential TTL
  is in seconds.

## Pull requests

- Branch off `main`; one logical change per PR.
- Include a test for non-trivial logic. Fixing a bug? Add the test that would
  have caught it.
- If the change can't be covered by a test (media paths), describe the manual
  verification you did.
- Keep the diff focused. Spotted something unrelated? Open an issue instead.

## Issues

File issues here on GitHub using the templates.

For security vulnerabilities, do **not** open a public issue. See
[SECURITY.md](SECURITY.md).

## Deploying the public demo (maintainers)

The demo at https://openmeet.pages.dev is the `[env.demo]` section of
`apps/worker/wrangler.toml`: the same `openmeet-worker` script, pointed at the
demo's D1 database, Pages origin and Polar product. Everything in that section is
a public identifier. Its three secrets live on the Worker, never in a file:

```bash
pnpm --filter @openmeet/worker exec wrangler secret put TURN_APP_ID --env demo
pnpm --filter @openmeet/worker exec wrangler secret put TURN_API_TOKEN --env demo
pnpm --filter @openmeet/worker exec wrangler secret put POLAR_ACCESS_TOKEN --env demo
```

To deploy `main`:

```bash
pnpm --filter @openmeet/worker run db:migrate:demo   # first, only if the deploy adds a migration
pnpm --filter @openmeet/worker run deploy:demo
NEXT_PUBLIC_API_BASE=https://openmeet-worker.pranshu11111.workers.dev pnpm --filter @openmeet/web build
pnpm --filter @openmeet/worker exec wrangler pages deploy ../web/out --project-name openmeet --branch main
```

wrangler runs from `apps/worker`, hence `../web/out`. A plain `wrangler deploy`
and `install.sh` never read `[env.demo]`, which is why neither may run against the
demo:

> **Never run `install.sh` or a plain `wrangler deploy` while logged in to the demo's
> Cloudflare account.** Both deploy the same `openmeet-worker` script with the
> top-level template config, and `install.sh`'s default Pages project name is
> `openmeet`, the demo's own, so either overwrites the live demo. Deploy the demo only
> with the commands above, and try a self-host install on a different account.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE) that covers this project.
