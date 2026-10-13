# openMeet — Architecture and contributor guide

Open-source, self-hostable, studio-quality remote recording. Riverside.fm alternative for
**up to 4 recorded participants + 2 unrecorded producers** (full mesh, no SFU). Pure browser P2P WebRTC; each peer's local track is recorded
and the bytes are written to the **host's local disk** (File System Access API). Recording
bytes never touch any server — zero cloud-storage cost. Runs entirely on a free Cloudflare
account (Pages + Worker + Durable Object + D1). MIT licensed.


---

## Monorepo layout

pnpm workspace (`pnpm@9.12.0`, node ≥ 20.11). Workspaces: `apps/*`, `packages/*`.

| Package | What |
|---|---|
| `apps/worker` | Cloudflare Worker — Hono REST (`/api/*`) + `Room` Durable Object (WS signaling) + D1 |
| `apps/web` | Next.js 16 (App Router, React 19, Turbopack, Tailwind v4). Static export in **prod only** |
| `packages/protocol` | Shared TS: WS message unions, chunk header + DC control messages, all tuning constants. Consumed as **raw TS source** (no build step) via tsconfig `paths` + vitest `alias` |
| `migrations` | D1 SQL (`0001_init.sql`, `0002_recordings_ms.sql`) |

`tsconfig.base.json` is strict: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`verbatimModuleSyntax`, `isolatedModules`, `noFallthroughCasesInSwitch`.

### Commands
```bash
pnpm install
pnpm --filter @openmeet/worker db:migrate:local   # apply D1 migrations to local
pnpm --filter @openmeet/worker dev                 # wrangler dev -> :8787
pnpm --filter @openmeet/web dev                    # next dev --turbopack -> :3000
pnpm -r test                                       # all vitest suites
pnpm -r typecheck
pnpm --filter @openmeet/worker run deploy          # wrangler deploy (web is a static export; install.sh deploys it to Pages, or by hand per README Self-hosting)
pnpm --filter @openmeet/worker run deploy:demo     # wrangler deploy --env demo: the maintainers' public demo (openmeet.pages.dev); full steps in CONTRIBUTING
pnpm --filter @openmeet/worker run db:migrate:demo # D1 migrations on the demo database, before a deploy that adds one
```
`NEXT_PUBLIC_API_BASE` (default `http://localhost:8787`) points web at the Worker; `WS_BASE`
is derived by swapping `http`→`ws`. **No linter** (there is no `lint` script).

---

## Architecture (data flow)

```
GUEST browser  ──WebRTC PeerConnection (media tracks + recording DataChannel)──▶  HOST browser
   getUserMedia                                                                     getUserMedia
   MediaRecorder ──chunks──▶ DataChannel "recording" ──▶ ChunkReceiver ──▶ FileWriter ──▶ host disk
   BackupRecorder (OPFS chunk files, safety net)                                    (own track -> disk + own BackupRecorder)
        │                                                                                  │
        └──────────────── WS signaling (SDP/ICE/chat/presence) ────────────────────────────┘
                                          │
                       Cloudflare Worker (REST) + Room Durable Object (WS hub, per slug) + D1 (metadata only)
```

- Worker = stateless REST. `Room` DO = per-slug WS hub; **dumb relay** (never inspects SDP/ICE;
  relays each msg to every other peer — SDP/ICE carrying `to`, and every `private-message`, go to
  that one peer only — stamped with `from: Role`, `fromPeerId`, and `fromName` on
  chat/presence/marker/private-message).
- D1 holds **metadata only** (rooms, sessions, participants, recordings) — never bytes.
- TURN bytes (symmetric NAT) are SRTP/SCTP-encrypted, opaque to operators.

---

## Wire protocol (`packages/protocol`)

**Two transports, two ack mechanisms — do not conflate:**
- **WS signaling** (`ws-messages.ts`): `ClientMessage` (20 variants) ↔ `ServerMessage` (22).
  Relay types `webrtc-offer|webrtc-answer|ice-candidate|chat|presence|marker|recording-started|
  recording-stop|recording-capability` exist in *both* unions; server adds `from: Role`, plus
  `fromPeerId` on all but `recording-started|stop`. `peer-recorded` is in both unions too, but it is
  **not a relay**: only the host's is acted on, and the Room sends its own to every joined peer with
  no `from`. `recording-countdown` (`seconds`) is in both unions as well: the Room passes on only
  the host's, to everyone else, with no `from`; it is a cue for the screen and starts nothing.
  `peer-mute` (`peerId`) is in both unions too: the Room hands only the host's to that one peer,
  as a bare `{type}`, and that peer's own page turns its microphone off. `peer-remove` (`peerId`)
  is client-only and host-only: the Room closes that socket with `4007` and announces `peer-left`.
  `private-message` (`to`, `text`) is in both unions and is addressed, not relayed to the room:
  the Room sends it to the one joined peer whose id is `to`, stamped `from`, `fromPeerId` and
  `fromName`, and to nobody else. It is a type of its own, not a `chat` with a `to`, so a Room
  that does not know it drops it instead of sending it to everyone.
  SDP/ICE take an optional `to` (peerId) so
  the DO can address one peer in a mesh. Type guards `isClientMessage`/`isServerMessage` validate **only the
  `type` discriminant**, not payload shape.
  `recording-capability` also carries the sender's lobby answer, `listening` (one of
  `LISTENING_CHOICES`: `headphones`, `speakers`, `speakers-ec`). The Room passes it on only
  when it is one of those codes, and the page that receives it checks again.
  `presence` carries `handRaised` only while a hand is up: the Room passes the field on only
  when it is exactly `true`, and a page reads nothing else as a raised hand. It also
  carries `title`, the sender's own text for their name tag: the Room passes it on, trimmed,
  only when `titleFrom` accepts it (a string of 1 to `MAX_TITLE_LENGTH` = 60 units once
  trimmed), and a page checks it again.
  `reaction` (`reaction`: one of the codes in `REACTIONS`) is a relay type in both unions too,
  stamped `from` and `fromPeerId`; the Room drops one whose code is not on the list.
- **DataChannel control** (`chunk-header.ts`): `DataChannelControlMessage` = `ack` |
  `resume_query` | `resume_offset` | `recording-finalized` | `clock_ping` | `clock_pong` |
  `recording_meta` (last three = recording clock-sync) | `backup_offer` (opens a `backup#<name>`
  channel and carries the file size and the sender's key). Recording acks flow here, **not**
  over WS.
- `Role = 'host'|'guest'|'producer'`, `RecordingKind = 'camera'|'screen'`. A producer (≤2 per
  room, `?producer=1` → `join.producer`) is recvonly and never recorded; a companion (`?present=1`
  or lobby "Present only" → `join.companion`) joins to share its screen with no camera/mic, plays
  no remote audio, and shares the 2 unrecorded slots with producers (does not use a recorded seat;
  role is still host/guest); the DO enforces the per-role caps at `join`. "Present only" is never
  offered to a producer: `?producer=1` wins over `?present=1`. `role-assigned` (peers)
  and `peer-joined` echo `companion?: boolean` and `notRecorded?: boolean` (the host set that guest
  as not recorded; `role-assigned` carries it for the joining connection too).

**Chunk wire format** — each chunk = **TWO ordered DataChannel sends**: (1) a JSON **string**
header `{idx,offset,size,ts}` (`encodeChunkHeader` = `JSON.stringify`), then (2) the binary
`ArrayBuffer` payload. It is **NOT a packed binary struct.** Channel `binaryType` must be
`'arraybuffer'`. `decodeChunkHeader` rejects `idx|offset|size` that aren't non-negative safe
integers and a `ts` that is negative or non-finite; returns a field-whitelisted copy.

**Constants** (`constants.ts`): `CHUNK_TIMESLICE_MS=2000`, `DC_BUFFERED_HIGH_WATERMARK=16MiB`,
`DC_BUFFERED_LOW_WATERMARK=8MiB`, `STREAM_BACKLOG_CAP_BYTES=256MiB` (un-acked bytes of one file
after which a guest stops streaming it), `ACK_EVERY_N_CHUNKS=5` (counted in 64 KiB fragments),
`ACK_EVERY_N_MS=10000`, `WS_HEARTBEAT_INTERVAL_MS=30000`, `DRAIN_HARD_CAP_MS=30000`,
`ROOM_TTL_MS=30d` (extended on every join), `TURN_CRED_TTL_S=43200` (12 h, **seconds**, unlike every `*_MS`; must outlast a session — the client never refreshes TURN credentials and Cloudflare drops a relayed call soon after its credential expires),
`RECORD_COUNTDOWN_S=3` (seconds counted down on screen before a take starts), `RECORDING_MIME='video/mp4;codecs=avc3.42E01F,mp4a.40.2'` (H.264 baseline 3.1 + AAC-LC, in-band params).
Recording quality: `RECORDING_VIDEO_WIDTH=1920`/`HEIGHT=1080`/`FRAME_RATE=30` (capture, `ideal`),
`RECORDING_VIDEO_BPS=5_000_000`, `RECORDING_AUDIO_BPS=160_000` (encode; the 1080p entry of
`lib/quality.ts` `QUALITY_PRESETS` (720p–4K), from which a screen segment's `ChunkRecorder` gets the
bitrate for the actual track via `presetForTrack`, and the camera `ChunkRecorder` and
`BackupRecorder` via `cameraVideoBps`: that preset at the level picked in the lobby (`BITRATE_LEVELS`:
Standard x1, High x1.5, Maximum x2, never past `MAX_VIDEO_BPS`), times 1.5 when the track delivers
more than 40 fps (`presetAt`), under the same ceiling; capture constraints in
`lib/media.ts` `RECORDING_CONSTRAINTS`). `FRAME_RATE` is only the default: each person picks a
rate in the Lobby (`FRAME_RATES` in `lib/quality.ts`, kept in `localStorage` as `om_fps`) and
`cameraConstraints` asks the camera for it. The picker lists only the rates the camera's
capabilities reach (`supportedFrameRates`), so 50 and 60 appear on few cameras. The
lobby's size figures follow the rate the camera delivers through `presetAt`.
DC names: `recording` (camera MP4) and `recording-audio` (WAV master), each optionally keyed
`recording#<key>` / `recording-audio#<key>` (see gotchas); one channel per screen-share segment,
`recording-screen-<n>` (the host matches the prefix); `backup#<file name>` (one leftover backup
going back to the host); `backup#file-<uuid>` (one file a participant picked to send the
host: the same channel and messages, with the file's own name in its `backup_offer`).
WS close codes: `4001` capacity-full,
`4002` invalid slug, `4003` known-but-expired room (the DO distinguishes the two),
`4005` invalid message, `4006` replaced (another host connection took over), `4007` removed (the
host removed this participant, and the same tab is refused until the session ends).

---

## Worker (`apps/worker`)

### REST (`src/index.ts` Hono app, `src/api/*`)
- `POST /api/rooms` → 201 `{slug, host_token, expires_at}` + `Set-Cookie host_token__<slug>` (HttpOnly,
  SameSite=Lax, Path=/, Secure only over https). Generates 32-byte hex `host_token`, slug
  (3-4-3 lowercase, ~47 bits, 5-retry collision loop → 503 `slug_exhausted`). IP rate limit
  10/60s → 429 via the `ROOM_CREATE_LIMITER` rate-limit binding (per Cloudflare location, not
  global; fails open if the binding is missing).
- `GET /api/rooms/:slug` → 200 `{slug, expires_at, consumed}` | 404 `invalid_slug|not_found|expired`.
- `POST /api/turn-cred` `{slug}` → the operator's own `TURN_URLS` (+ `TURN_USERNAME`/
  `TURN_CREDENTIAL`) if set; else mints a Cloudflare Realtime TURN cred if `TURN_API_TOKEN`+
  `TURN_APP_ID` set; else STUN-only **stub** (`username/credential='stub'`). **No host auth on
  this route** — a valid room slug is the only credential, rate-limited to 20/60s per IP
  (`TURN_CRED_LIMITER`, same shape as `ROOM_CREATE_LIMITER`). Mint failure → 502 (`turn_unavailable`).
- `GET|PATCH /api/recordings/:id` → host-token auth, cookie or `Authorization: Bearer` (does
  **not** check room expiry).
  PATCH validates field values (400 `invalid_field` on bad fields, 200 on no-op);
  setting status to `finalized` stamps `finalized_at` with server time.
- `GET /api/sponsors` → 200 JSON sponsor wall data read from Polar (`POLAR_ACCESS_TOKEN`,
  `POLAR_PRODUCT_ID`, `SPONSOR_CHECKOUT_URL`, optional `POLAR_API_BASE`). Filtered to customers
  with `metadata.sponsor_approved` (`true` or `"true"`) and total ≥ 2500 cents ($25). Returns
  normalized weights (never absolute amounts) and available space. Cached for 10 minutes
  (`caches.default`, `max-age=600`). Unconfigured or Polar errors degrade gracefully to 200
  empty shape (errors cache for 60s); never logs or returns tokens, emails, or amounts.
- `*  /ws/r/:slug` → 400 on a bad slug format; **403 when an `Origin` header is present and isn't
  `PAGES_ORIGIN`** (`isAllowedOrigin`, `lib/cors.ts` — CORS doesn't cover WebSocket handshakes;
  a missing Origin is non-browser tooling and the tests, so it's allowed) →
  `ROOM_DO.idFromName(slug)` → forwards raw request (cookie included) to DO.

### Room Durable Object (`src/do/Room.ts`)
One instance per slug. `fetch`: requires `/ws/r/` path (404) + `Upgrade: websocket` (426);
looks up room (missing → accept then close `4002`, expired → `4003`); host auth via cookie or token presented in WS `join`; capacity guard (4 recorded + 2 unrecorded producers/companions; the peer past capacity is closed with `4001`).
- **Uses the WebSocket Hibernation API** (`state.acceptWebSocket` + `webSocketMessage` /
  `webSocketClose` / `webSocketError`, not `server.accept()` + `addEventListener`) — the DO can be
  evicted from memory between messages and lose nothing. Per-peer state (`role`, `displayName`,
  `userAgent`, `joined`, `peerId`, `ordinal`, `participantId`) lives in a `PeerAttachment` on each
  WebSocket (`serializeAttachment`/`deserializeAttachment`, re-saved after every mutation), not an
  instance `Map`; `allPeers()` derives the live socket list from `state.getWebSockets()` (skipping
  sockets flagged `left: true`) instead, and `joinedPeers()` narrows it to the sockets whose `join`
  was admitted — the room itself, which is all that relays, broadcasts and `peerCount` look at, and
  what session end counts. A socket that hasn't joined, or was refused at the cap, gets its own
  `join`/`ping` answered and nothing else; one flagged `left` (replaced, or after its own `leave`)
  has every message dropped. `slug`/`hostToken`, `sessionId`/`recording`, and
  `nextOrdinal` are cached on the instance for convenience but persisted to DO storage (keys
  `room`, `session`, `nextOrdinal`; `session` also holds the client ids of the guests the host set
  as not recorded, at most 16, emptied when the session ends, and those of the tabs the host
  removed, kept the same way) and reloaded in the constructor via
  `blockConcurrencyWhile`, so a woken instance picks up exactly where the evicted one left off.
  The client's `{"type":"ping"}` heartbeat is answered `{"type":"pong"}` by
  `setWebSocketAutoResponse` without waking the DO; the `ping` case in the message switch stays as
  a fallback.
- **Expiry is enforced mid-call by `alarm()`, not only at connect.** Every successful `join` arms
  `storage.setAlarm(expiresAt)` for the same `expiresAt` just passed to `touchRoom`. `alarm()`
  re-reads the room row: if it still exists and `expires_at > Date.now()` (a later join extended
  it), it re-arms for that new `expires_at` and returns; otherwise it closes every socket from
  `allPeers()` with `WS_CLOSE_EXPIRED_SLUG`/`'expired_slug'` and, if a session is open, ends it
  (`endSession(…, 'expired')`, best-effort `.catch`) and clears `sessionId`/`recording`. This is
  what stops a room that lapses mid-call from running on until everyone happens to leave —
  connect-time expiry alone only ever guards the *next* connection.
- `join` (first one lazily creates `sessionId` + `insertSession` + `markRoomConsumed`, then
  per-peer `insertParticipant`) → replies `role-assigned`, broadcasts `peer-joined`.
- Relays `webrtc-offer|answer` and `ice-candidate` to the peer named in `to` (everyone else when
  `to` is absent), and `chat`, `presence`, `marker`, `recording-capability` via `broadcastExcept`
  (every other peer), stamped `from`/`fromPeerId`. `ping`→`pong` (sender only).
  `leave`→broadcast `peer-left` + close 1000.
- `presence` is relayed with `handRaised: true` only when the sender's field is exactly
  `true`; any other value is left out. `title` goes on, trimmed, only when `titleFrom`
  accepts it, and a presence with a bad title is still relayed without the field. Nothing
  is kept.
- `reaction` is relayed to every other joined peer (`broadcastExcept`, stamped
  `from`/`fromPeerId`) when its code is one of `REACTIONS`, and dropped otherwise; only
  `type`, the code and the stamp are passed on. Nothing is kept and nothing is counted: each
  page that receives reactions takes one a second from one sender (`takeReaction` in
  `apps/web/lib/reactions.ts`), and `useRoom().sendReaction` sends no more than that.
- `private-message` goes to **one socket**: the joined peer whose id is `to`, never the sender and
  never the room. A `to` that names nobody else in the room (someone who left, the sender itself,
  a socket that has not joined, a value that is not an id) matches no peer and the message is
  dropped; it never falls back to `broadcastExcept`. Any joined peer may write to any other. The
  text is passed on as sent, like `chat`; nothing is stored and the sender is not answered.
- `recording-started` is **relayed from every joined peer** (it is what starts every guest's capture,
  except one the host set as not recorded), but **persisted to D1 only by the host**
  (`insertRecording`, capped at 256 rows per session).
  A take announced again under its own id — a host resuming after a reload — keeps the row it
  already has, file name and start time from the first announcement, and spends no second slot.
  `recording-stop` is **relay-only** (host → guests, "wind down now"). `recording-completed` is
  **ignored** (kept in protocol for older tabs; the DO does not consume it). The DO tracks
  `recording: boolean` and reports it in `role-assigned` so a peer joining mid-recording catches up.
- `recording-countdown` is **passed on only from the host**, and only with a finite
  `seconds`, to every other joined peer. Nothing is kept and `recording` does not change:
  the take starts with `recording-started`.
- `script` (`text`, in both unions like `recording-countdown`) is the host's teleprompter
  script. It is **passed on only from the host**, to every other joined peer and with no
  `from`, and only when `text` is a string of at most `MAX_SCRIPT_LENGTH` (50,000) UTF-16
  units. Nothing is kept, so a peer that joins later is not sent it.
- `peer-recorded` is **acted on only from the host**, only while no take is running and only for a
  joined guest that sent a client id; the DO remembers the guest by that id — until the host
  changes its mind, or the session ends — and flags it to later joiners and on a reconnect, then
  sends `peer-recorded` to every joined peer, the host included.
- `peer-mute` is **passed on only from the host**, to the one joined peer it names and never back
  to the sender, as `{type:'peer-mute'}`. Nothing is kept, a take changes nothing about it, and
  the Room turns no microphone on or off: the page that receives it does, and can turn it back on.
- `peer-remove` is **acted on only from the host**, for a joined peer that is not a host, during
  a take as outside one: the DO remembers that peer's client id (`session.removed`, the newest 16),
  closes the socket with `WS_CLOSE_REMOVED`/`'removed'` and runs `onClose(ws, 'removed')`, so
  everyone else gets `peer-left` with that reason. A later `join` that presents a remembered id is
  closed with the same code before it is seated; one that proves the host token is never refused.
- `webSocketClose`/`webSocketError` share one `onClose(ws)` helper, idempotent via the
  attachment's `left` flag: `markParticipantLeft`; if `joinedPeers().length===0 &&
  !anyHostPresent() && sessionId` → `endSession` (`host-left`/`guest-left`). The host check keeps
  the session and its `recording` flag across a cookie-path host reconnect, which replaces the old
  socket before the new one has joined. Rooms are reusable (TTL is extended on join, not
  one-shot; each gathering starts a new session).

### lib + db
- `lib/token.ts`: `generateHostToken` (256-bit hex), `timingSafeEqualHex` (custom constant-time;
  length-check early-return is acceptable — token length is public).
- `lib/cookie.ts`: cookie name `host_token__<slug>` (per-room), Max-Age = `ROOM_TTL_MS/1000`.
- `lib/cors.ts`: **strict single-origin** — headers only when `Origin === PAGES_ORIGIN`
  (`isAllowedOrigin`, also the `/ws/r/:slug` Origin check).
  `handlePreflight` 204s with method/header hints. Change `PAGES_ORIGIN` per deploy.
- `lib/slug.ts`: `crypto.getRandomValues`, `bytes%26` (minor modulo bias, non-security-critical).
- `db/queries.ts`: parameterized D1 CRUD; `updateRecordingProgress` builds SET from a fixed
  allowlist (injection-safe), early-returns if no fields. `markRoomConsumed`/`endSession`/
  `markParticipantLeft` idempotent-guarded.
- **Schema** (`migrations/0001_init.sql`): `rooms`(PK slug, host_token, expires_at, consumed) →
  `sessions`(FK room_slug) → `participants`(FK session_id) → `recordings`(FK session_id +
  participant_id). D1 timestamps are uniformly ms (TURN TTL stays seconds).
- `wrangler.toml`: D1 `DB` (db `openmeet_db`, top level ships placeholders, not a prod UUID), DO `ROOM_DO`→`Room`
  (`new_sqlite_classes`), rate-limit bindings `ROOM_CREATE_LIMITER` (10/60s) / `TURN_CRED_LIMITER`
  (20/60s), `PAGES_ORIGIN` var, secrets `TURN_API_TOKEN`/`TURN_APP_ID` (or, for self-hosted TURN,
  `TURN_URLS`/`TURN_USERNAME`/`TURN_CREDENTIAL`).
  `[env.demo]` is the maintainers' public demo (openmeet.pages.dev): same script name
  `openmeet-worker`, real D1 `openmeet` id, demo `PAGES_ORIGIN` and Polar vars — public
  identifiers only; its secrets are set with `wrangler secret put --env demo`. wrangler does not
  inherit `vars`/`d1_databases`/`durable_objects`/`unsafe` into an env, so the section repeats them
  (`[[migrations]]` and `[observability]` are inherited). `install.sh`'s sed rewrites only lines
  before the first `[env.` header, so self-host installs never touch it.

---

## Web (`apps/web`)

### Routes / UI (all components are `'use client'`; layouts are server)
- `/` → `app/page.tsx` (Landing). "New Room" → `createRoom()` → `window.location.href =
  '/r/${slug}/'` (**trailing slash required** for static export).
- `/r/[slug]` → `RoomPage` unwraps `params: Promise` via React `use()` → `<RoomView>`.
  `app/r/[slug]/layout.tsx` is **server** (hosts `generateStaticParams` placeholder shell;
  real slug resolved client-side; `public/_redirects` rewrites every `/r/*` to that shell on Pages).
- Unknown paths → `app/not-found.tsx` (exported as `out/404.html`).
- `next.config.ts`: `output:'export'` **only when `NODE_ENV==='production'`** — dev intentionally
  skips it so `/r/[slug]` resolves at runtime. **Don't unconditionally enable export.**
- `public/_headers` (copied into `out/` like `_redirects`): Pages security headers on `/*` — CSP
  (`script-src 'self' 'unsafe-inline'` for the export's inline bootstrap scripts; `connect-src
  'self' https: wss:` stays generic because each deploy's Worker URL differs), `X-Frame-Options:
  DENY`, `Referrer-Policy`, `nosniff`, `Permissions-Policy` (camera/mic/display-capture/fullscreen
  self only). A new external script/font/frame, or a `blob:` worker or AudioWorklet, needs a CSP change.
- `RoomView` switches on `state.phase` → Lobby / WaitingRoom (also for `connecting`, with a spinner
  and any connection warning, and for `peer-left`) / CallStage, plus light status screens
  (`components/StatusScreen.tsx`: SiteHeader, message, next step) `not-found`, `full` (4001),
  `replaced` (4006: another tab/device took the host seat), `removed` (4007: the host removed
  this participant; Back to the lobby + Back to home, plus **Download your backup** and
  **Download your WAV backup** when this tab holds the backup of a recording it saved, drawn by
  the same `FileLinks` as the `left` screen's), `left` (Rejoin + Back to home, plus
  download links for sync.json/chapters.txt/backups when a take was finalized on the way out; a host
  holding those gets a `beforeunload` prompt, since Rejoin reloads), `error`; the terminal ones
  release camera/mic unless a take is live. `peer-left` (the mesh emptied, or `room-closed`) renders
  WaitingRoom ("Everyone else left"): the tab stays in the room, camera on, and resumes when someone
  joins. A host whose browser can record gets **Continue alone** in the waiting room, alone or
  after everyone left (never while connecting, never on a present-only device). `RoomView`
  keeps that choice while the tab stays in the room (`alone`) and from then on renders
  `CallStage` for `waiting`, `connecting` and `peer-left` too, drawn as `in-call`, so
  Record, the countdown, the teleprompter and the media board are there with nobody else in
  the room. The hook's phase is not changed by it.
  `Lobby` uses a `handedOffRef` so unmount doesn't stop the MediaStream handed to `useRoom`
  (ownership transfer — load-bearing).
  A capture that `reacquire` was still opening when the stream was handed over is stopped as
  it arrives and the handed-over stream is left alone, and Join hands over the capture the
  `MediaManager` holds at that moment, so the call never gets a stream the lobby stops and no
  capture stays open behind it. A capture that the first preview, Try again or `reacquire` was
  still opening is stopped as it arrives after any hand-over (Join or Present only), and so is
  one that arrives for a run of the mount effect that was cleaned up (`mmRef` is cleared then).
  Join is off for as long as `reacquire` is opening a capture (the `reopening` state draws the
  button disabled and the line under it reads as it does with the preview down; the form's
  submit checks `reopeningRef`, so Enter does nothing either), so a person who presses
  Microphone only, or presses it again for the camera, and then Join joins with the capture that
  arrives, or with the earlier preview when it is refused. Join also does nothing when the seat
  question is answered while the echo-cancellation answer has stopped the microphone and its
  replacement has not arrived (`micStoppedRef`), and the person presses Join again once the
  preview is back; Try again asks for the microphone alone when Microphone only is on.
  `Lobby` **requires a name** (Join gated; the name field is a
  form, so Enter joins). Directly under it the main join form has an optional **title** field
  (`maxLength` `MAX_TITLE_LENGTH`; not on the producer or Present-only screens, and hidden with
  the form on the check page); Join does not depend on it. It also has mic/camera device pickers (`changeDevice` re-acquires with the chosen
  `deviceId`, new-stream-before-stop-old). Under the name the join panel asks **Headphones or speakers?**
  (`LISTENING_CHOICES` in `@openmeet/protocol`, wording in `lib/listening.ts`, kept in `localStorage` as
  `om_listening`). **Speakers, echo cancellation on** opens the microphone again with
  `echoCancellation: true` (`micConstraints`); noise suppression and gain control stay off. For that one
  change the microphone is stopped before it is asked for, because a browser can give a second capture of
  an open microphone the processing of the first; the preview is taken down with it, so Join is off until
  the new one is open, and stays down with Try again when it cannot be opened. The camera, microphone,
  quality and frame-rate pickers are off for as long as the preview is down, so only Try again and
  **Microphone only** open a capture then. **Microphone only** is off while a preview is being
  opened and none has failed (`!stream && !previewError`), and Try again does nothing while
  `reopeningRef` is set, so neither asks for a capture beside one on its way. A change of camera,
  microphone, quality, frame rate or echo cancellation made while another is being opened is not
  taken (`reopeningRef`), so a second capture is never asked for meanwhile. The select shows what the
  microphone reports (`getSettings().echoCancellation`, anything but `false` counting as on), not what was
  asked for. Its hint tells a guest that the host sees the answer; a host is not told so, because the
  host's own answer is shown to nobody. A blocked/missing/busy camera or mic shows in the preview
  with Try again; a producer's lobby opens no camera or mic and joins with a zero-track stream.
  **Microphone only**, a button under the preview, opens the microphone alone
  (`chooseMicOnly` calls `reacquire` with the camera choice `NO_CAMERA`, for which
  `cameraConstraints` returns `false`), so a person with no camera, or with one that is
  blocked or busy, joins as a recorded participant; pressed again it opens the first listed
  camera as well. While the preview holds no video track it shows the person's initial, and
  the camera toggle, the framing guide and the camera, quality, bitrate and frame-rate
  pickers are hidden. With no preview at all (the microphone is being opened again) the mode
  is the choice, `camId === NO_CAMERA`: the pickers stay hidden, the button stays pressed and
  the placeholder reads "Allow microphone".
  The lobby's readiness panel (`PreflightPanel`) carries **Test your mic**
  (`components/MicTest.tsx`, `lib/mic-test.ts`): an audio-only `MediaRecorder` on the previewed
  microphone for five seconds, played back from an object URL that is revoked when the clip
  ends. Leaving the lobby aborts it, so that recorder never runs into the call.
  Leftover backups are listed in the join panel, beside Join, and a guest whose backup is of this
  room can choose it with **Send to host**; the choice is handed to the hook on join.
  A host's interrupted takes of this room are listed there as **Unsaved recording**, with Save
  to folder and Delete; both are disabled while a save runs, and a save that left something out
  says so in an alert and keeps the row.
  `?check=1` on the room link (`isCheckLink` in `RoomView`; the host's **Copy check link** in the
  lobby builds it) renders the same `Lobby` with `checkOnly`: preview, pickers and readiness
  panel, with the join form hidden and the backup and unsaved-recording lists left out, so a
  guest can test a device ahead of the call. It never calls `join`. A link that also carries
  `producer=1` or `present=1` is that link, and `check` is ignored.
  `WaitingRoom` (post-join, alone, connecting, or after the peer left): self-cam (initial avatar when
  the camera is off) with mic/cam toggles + role-aware copy + host Copy invite link + Leave;
  CallStage's status bar keeps the host's Copy invite link during `in-call`.
  Beside both an arrow (`components/RoleLinks.tsx`) opens a panel that copies the producer link
  and the Present-only link (the plain link plus `?producer=1` or `?present=1`, the flags
  `RoomView` reads) and says what each is. The panel is placed from the row it sits in (the
  caller's `menuClassName`), not from the arrow, so it stays on a phone's screen. The lobby preview and the
  local camera tile (WaitingRoom and call) are mirrored via `VideoTile` `mirror` — display only, the
  recordings are not; a rear camera, a screen or a remote tile never is. Producers get no mic/cam
  controls and no media board in the call.
  `components/PeoplePanel.tsx` is the host's list of everyone else in the call, opened by
  **People** in the control bar and laid out like the media board (on a phone the two share a
  place, so opening one closes the other): a row per person with **Mute**, which a producer
  and a present-only device do not get. A person the host muted sees their own mic button off
  and a `role="status"` line that says so, and during their own capture that their recording
  has no sound until they turn it back on.
  Each row also has **Remove**, which asks in the row itself before it calls
  `useRoom().removePeer` (a blocking dialog would stall the tab that writes the take), with
  **Cancel** focused and last, at the row's right end where Remove was; during a take, and
  while an interrupted take can still be resumed, the question says that a recorded
  person's recording here ends.
- **`components/Stage.tsx`** — Google Meet focused layout. Derives mode from feeds:
  `solo` (local fills), `focused` (big spotlight + tap-to-swap corner PiP), `grid` (3+ people, equal
  tiles), `presenting` (screen spotlight + camera column on desktop, other people first and you last /
  floating peer PiP on mobile; a desktop screen sharer sees a "You're presenting" placeholder with a
  Stop presenting button, no self-mirror; whoever presents a rear camera or a photo/video gets that
  feed back as a viewfinder via `localScreenStream`). `CallStage` renders `<Stage>` (not a grid),
  keeps optimistic mic/cam + `spotlight` local state; tiles show `localName (You)` / `peerName`
  (role fallback). While one other person is on the stage, their tile is drawn once their own camera
  stream has arrived (`solo` until then); with two or more, every person listed has a tile, an
  initial until their stream arrives. Responsive: `h-[100dvh]`, control bar `flex-wrap` + safe-area,
  mobile chat is a
  full sheet with the control bar hidden while open. `VideoTile` takes `fit` (cover/contain) +
  `className` to fill the spotlight or size a PiP. During a take, `useTakeGuard` holds a screen
  wake lock, prefixes the tab title with `● REC ` while hidden, and surfaces calm notices if the
  tab was backgrounded or the battery drops to 10%. `useOverloadWatch` polls `useRoom().readLoad`
  every 5 s while a take records (audio the WAV recorder had to pad, and whether the browser
  reports a live encoder as limited by the CPU) and shows a notice for the rest of the take once
  the device is not keeping up; the notice offers low-power mode (`useRoom().setLowPower`), which
  makes `sendEncoding` send a quarter-size camera picture at the floor bitrate and a shared screen
  at 4 fps on every connection, leaves every recorder alone, and stays on until turned off.
  Switching the mode starts the readings over, and while it is on only lost audio counts.
  The camera menu's **Stop incoming video** (`useRoom().setIncomingVideoOff`,
  `state.incomingVideoOff`) is the other mode a tab keeps for itself: every connection stops
  taking the other side's video, and `CallStage` shows the other people as initials (`camOff`)
  while it is on. The call's sound, what this tab sends and every recorder are left alone.
  While it is on a row above the stage says so with **Show video**, and `Stage` (`onShowVideo`)
  lays a note with the same button over a screen someone else presents: over the tile, not in
  its place, because that tile plays the shared sound.
  `components/BackupNotice.tsx` shows returned backups in the same flow above the stage: the
  host's Save to folder / Not now on an offer, the percent and a Stop while bytes move, a stalled
  transfer's own line with Dismiss, and the saved or failed verdict on both sides, with offers
  held back while a take records or saves.
  `components/FileNotice.tsx` does the same for a file a participant picked to send the host
  (`kind: 'file'`), in words of its own: the host's question names the senders, each file as
  it will be called in the folder and the total size, and its Save to folder and Not now
  answer only the files that row shows; the sender's rows say waiting, sending, paused while
  its own take records, saved or not saved. `BackupNotice` skips those items.
  `components/SendFile.tsx` is **Send a file to the host**, above the message box in
  `ChatPanel` on every page but the host's: it picks one file and refuses, with the reason
  under the button, a type that is not on the list, an empty file and one over 100 MB
  (`sharedFileProblem` in `lib/shared-file.ts`). The host's page makes the same checks again
  when the offer arrives.
- **Speaker** (`lib/speaker.ts`, `hooks/use-speaker.ts`): one output device per browser plays
  the call, kept in `localStorage` as `om_speaker`; `''` is the system default. The call's
  microphone menu starts with a **Speaker** `<select>` (`components/SpeakerRow.tsx`) of the
  outputs the browser names (`speakersIn`: none where `setSinkId` is missing, which hides the
  row), and `setSpeaker` stores the choice. The lobby has the same choice as a row under its
  microphone picker, filled once when the preview starts (`listSpeakers`). Every `VideoTile`
  that is not muted follows it (`followSpeaker` calls `setSinkId` on its `<video>`), so the
  other people's cameras and a presented screen move together, and a tile mounted later starts
  on it. A chosen device that the browser refuses, or that is not listed any more after a
  `devicechange` (`dropIfGone`, listening while a tile follows the choice or a picker shows
  it), puts the choice back on the system default: the browser plays nothing through an
  output that has gone away and does not move the sound by itself. An empty list changes
  nothing, because without microphone permission the browser names no output.
  `playLocally(stream)` plays a stream on this device through an `<audio>` element that
  follows the choice: the media board's pads and a presented video's monitor use it and
  connect nothing to their graph's own output, because the browser suspends a graph whose
  output device goes away, and those graphs also feed the call and the recordings. Nothing in
  `hooks/` or `lib/` that records reads a media element, so no file depends on the choice.
- **`components/LevelsPanel.tsx`** — **Levels** in the control bar (not on a present-only device,
  which plays nobody) opens a strip between the stage and the bar with a fader for each person
  who has a tile. `CallStage` keeps the values (`volumes`, 0 to 1 by `peerId`) and gives each to
  that person's `StageFeed.volume`; `VideoTile` sets it as the `volume` of its `<video>`. It is
  this tab's playback only: nothing is sent, and no recorder, backup or call-audio copy reads a
  tile's element. While someone is below full volume the button carries a dot.
  Each row also has a meter of what arrives from that person, read before the fader: while the
  panel is on screen one `AudioContext` of its own holds a `MediaStreamAudioSourceNode` and an
  `AnalyserNode` per stream, connected to nothing else, and a 100 ms timer writes each bar
  straight to the DOM. Hiding the panel closes the context.
- **Raise hand** — a button in the call's control bar (`CallStage`; not for a producer or a
  present-only device, which have no tile; below the `sm` width, where a phone's bar is full
  while a take runs, it is shown only while the hand is up, so that a hand can always be
  lowered). `useRoom().setHandRaised` keeps the choice in a ref and in
  `state.handRaised` and sends it with `presence` as `handRaised: true`; the field is left
  out while the hand is down. Presence is sent again to everyone who joins and after a
  reconnect, so a late joiner sees a hand that is already up. `PresenceBadge` draws the
  mark on that person's tile, first and in the accent colour, and `CallStage` gives the
  person's own tile the same mark. The names of the people who have a tile and a raised
  hand are put in the status bar's live region for screen readers ("Hand raised: …").
  Nothing of it reaches a recorder, a file or the crash copy.
- **Name tag title** — the text from the lobby's title field. `Lobby` hands it to
  `chooseTitle` (`lib/name-tag.ts`, held in a module value like `lib/listening.ts` and typed
  per visit, kept nowhere); `joinedTitle()` gives `CallStage` the text for the person's own
  tile, and `titleField()` is spread into the `presence` that `sendPresence` sends, so it
  goes again to everyone who joins and after a reconnect. A page keeps what it receives on
  that person's `RemotePeer.title`, read through `titleFrom` by `applyRemotePeerPresence` on
  every presence, so a presence without a valid title leaves the person with none.
  `CallStage` gives each camera feed its title (`StageFeed.title`, passed on by `feedProps`);
  a screen tile has none. `VideoTile` draws it as a second line of its own inside the name
  tag, smaller and dimmer, and the tile is a CSS container: below 224 px wide (the corner
  picture, a phone's floating picture, the narrow side column) the line is hidden by a
  container query, with no measuring in script. The tag's tooltip holds the name and the
  title. The title is drawn only as text, and reaches no file, the People panel, chat or the
  waiting room.
- **Send my recording later** — a ticked item in a guest's camera menu, under **Stop
  incoming video** (`CallStage`; not for the host, whose files are written directly, and
  not for a guest the host set as not recorded or whose browser cannot record, who have
  nothing of their own to hold back). It calls `useRoom().setSendLater`; while
  `state.sendLater` is on a `role="status"` row above the stage says that the recording
  stays on this device during a take and goes to the host after it. The item is disabled
  while a take is being saved, and while a take records once it is ticked, because that take
  cannot be streamed again; unticked it can be ticked during a take. What a deferred take
  does is under `setSendLater` in "Call orchestration" and under `defer()` in the
  `chunk-sender.ts` bullet; it reaches the host afterwards as a returned backup, offered by
  the guest's page when the host ends the take.
- **Reactions** (`components/ReactionMenu.tsx`, `components/ReactionBadge.tsx`,
  `lib/reactions.ts`) — the arrow in one pill with Raise hand opens a row of four (`REACTIONS`
  in the protocol: thumbs up, applause, laugh, heart). `ReactionMenu` keeps its own open
  state, as `RoleLinks` does; its pill has no `data-picker-container`, so it and the device
  menus close each other. The arrow and the row are hidden below the `sm` width by their own
  classes, also while a raised hand keeps the pill there: the row would leave a narrow
  screen. `useRoom().sendReaction` puts the choice in `state.reactions` under
  `OWN_REACTION` and sends `reaction`; one that arrives is put there under its sender's peer
  id. `takeReaction` is the one gate for both: a code this build knows, one a second from one
  sender, the rest dropped before any state changes. `CallStage` draws an entry on that
  person's tile as `ReactionBadge` (`key` = the time it was taken), which removes itself
  `REACTION_SHOWN_MS` (3 s) after that time with a timer of its own, so a tile drawn again
  shows what is left of a reaction or nothing. The pictures are elements of the page: no
  recorder, file or crash copy holds one.
- **`components/MarkerNote.tsx`** — a chapter marker with a typed note. `useMarkerNote` holds
  whether the field is open for the take that is running and listens for **N** (ignored while
  typing, as **M** is); the pencil button beside the marker button opens it too. `MarkerNote` is
  the field: it sits where the stage's notices go (`toastPlace`) and before them in the page, so
  the recording notice is drawn over it, and on a phone it hides with the control bar while chat
  is open. Enter hands the trimmed note to `onMark`, the entry the marker button and the media
  board use, so a note has no path of its own: it is the marker's label in `chapters_<id>.txt`,
  `sync_<id>.json`, the summary and the crash copy's `take.json`. The field takes at most
  `MAX_MARKER_LABEL_LENGTH` characters (`lib/sync-report.ts`): the length the host accepts from
  another participant, and the length the crash copy reads back.
  `useRoom().addMarker(label, at)` cuts every label this page makes to that length (a media
  board pad's file name can be longer) and places the host's own note at `at`, the moment its
  field opened, because typing takes seconds; nothing of `at` is sent, so a guest's note is
  placed when it reaches the host, like every relayed marker.
- **`components/Shortcuts.tsx`** is the call's keyboard and the list of its keys, mounted last in
  `CallStage`'s status bar. A key is not wired to an action: a bare letter typed outside a field
  presses the button that carries it in `aria-keyshortcuts` (`ControlButton`'s `shortcut`: **A**
  microphone, **V** camera, **C** chat, **T** teleprompter), so a button that is disabled or not on
  screen has no key; one that is in the document but not displayed is skipped (`checkVisibility`). A
  held key, and a letter pressed with Shift, Ctrl or Cmd, is left alone. The **?** button (from `sm`
  up) and the **?** key open the list. **M** (marker) keeps its own handler in `CallStage` and
  **N** (marker with a note) its own in `useMarkerNote`; both are only listed.
  **Alt+R** is carried by Record and **Alt+S** by the host's End & save: two chords, so
  the key that starts a take can never end one, each under whatever keeps its button off or away.
  With Alt held the letter is read from `keyCode`, because Option+R types ® on a Mac: `keyCode` is
  the letter the layout has on that key, or the key's place on a layout without Latin letters.
  `code` is the place alone, and Colemak has R where QWERTY has S.
  The single keys (A, V, C, T, M, N and **?**) can be turned off, for a person whose speech input
  types letters. `hooks/use-single-keys.ts` keeps one choice per browser in `localStorage` as
  `om_single_keys`: `'0'` is off, and anything else, nothing stored or a storage that refuses is on.
  Each of the three listeners (`Shortcuts`, the **M** effect in `CallStage`, `useMarkerNote`) asks
  `singleKeysOn()` as a key arrives, so a change is in force for the next key. Escape closes the
  list and, when the keyboard was in it, hands focus back to the **?** button. The list holds the
  tick box (`useSingleKeys`, `setSingleKeys`), and `Lobby` has the same box last in the panel of
  each of its three screens, because the **?** button is not shown below 640 px (the check
  page, `checkOnly`, joins no call and leaves the box out). While the keys
  are off, `ControlButton` leaves a one-character `shortcut` out of `aria-keyshortcuts` and of the
  tooltip, the two marker buttons drop the key from their names, and the list dims its single-key
  rows and says they are off. Alt+R and Alt+S are chords and stay on.
- **`components/Rundown.tsx`** — the host's running order for a show. **Show rundown** in the
  control bar (`hasRundown`: only for a host who can record, a present-only one included)
  shows a strip between the stage and the bar, where the Levels strip goes. Outside a take
  it is an editor: one segment per line (`parseRundown`, `lib/rundown.ts`), saved on every
  change to `localStorage` under `om_rundown_<slug>` and never sent. During a take it shows
  the running segment and one button, **Start** for the first segment and **Next** for each
  following one. Starting a segment calls `onMark` with its name, the entry the marker button
  uses, so a segment has no path of its own: it is a chapter marker in `chapters_<id>.txt`,
  `sync_<id>.json`, the summary and the crash copy. Nothing starts by itself when a take
  does. `CallStage` keeps the component mounted while the strip is hidden, so the place in
  the show survives hiding it; the place is dropped when the take ends.
  A line may end in a planned length in minutes and seconds (`Interview 20:00`), which
  `parseRundown` takes off the name, so the marker carries the name alone and the length is
  in no file. The running segment has a clock (`SegmentClock`: one render a second, and only
  while the strip is shown) that counts from the segment's start, kept in `Rundown`, against
  that length and says by how much the segment is over.
  The list beside the button chooses another segment to start next (`picked`). Choosing
  starts nothing, because a keyboard moves through a list one row at a time and a row passed
  on the way must not become a marker; the choice is dropped when a segment starts and when
  the take ends.
- **Pop out** (`hooks/use-pop-out.ts`) — the camera menu lists **Pop out <name>** for each
  other person who has a camera tile. `popOut(stream, onEnd)` gives the stream to a muted
  `<video>` of its own, which is never put in the page, and asks the browser for its floating
  (Picture-in-Picture) window once the first frame has come. The person's tile is not
  involved: it keeps playing the sound, so the chosen speaker and the Levels fader apply as
  before, the window survives a change of layout, and nothing that records reads either
  element. `usePopOut` holds the stream that floats; popping out someone else moves the
  window, and leaving the call screen closes it. `CallStage` hands it the streams of the
  people on camera, and none while incoming video is stopped; once the stream that floats is
  not among them (that person left, or a connection was rebuilt) the window is closed and is
  not opened again without a click. A window that did not open, because the browser refused
  it or no first frame came within 3 s (`FIRST_FRAME_MS`), shows as the `deviceError` line.
  The items are not offered on a phone (`isPhone()`: the lens is beside the picture there),
  where `document.pictureInPictureEnabled` is false, while incoming video is stopped, or for
  a person whose stream has not arrived; a producer and a present-only device have no camera
  menu. `public/_headers` needs nothing for it: `Permissions-Policy` does not name
  `picture-in-picture`, which is therefore allowed, and no new document is opened.
- **`components/FramingGuide.tsx`** — on a computer the lobby preview carries **Framing
  guide**: a button that lays a rule-of-thirds grid over the preview while the camera is on.
  The page draws the lines over the tile and the component is given no stream, so nothing of
  them reaches a recording or another participant. Not rendered on a phone (`isPhone()`),
  where the preview shows a band of a tall picture.
- **`components/CalendarInvite.tsx`** — **Add to calendar**, the last thing in the lobby's join
  panel, in the browser that holds the room's host token (`Lobby`'s `isHost`), and not on the
  check page (`checkOnly`), which joins no call. The host picks a
  start (`<input type="datetime-local">`, read on that computer's clock) and gets two links,
  both built in the page by `lib/calendar-invite.ts`: a `data:` address that downloads
  `openmeet-<slug>.ics` (`buildIcs`: one event of `SESSION_MS`, one hour, in UTC, its lines
  folded at 75 octets) and Google Calendar's form filled in (`googleCalendarUrl`). Both hold
  the plain invite link and `inviteText`: a short checklist for the guest and a line about
  recording. Nothing is stored and nothing about the entry is sent to the Worker: the room
  knows no date.
  At each opening the panel asks `getRoom` for the room's `expires_at`, takes it as no later
  than `ROOM_TTL_MS` from now, and says it. A session whose hour would end after it gets a
  line saying so and no link, and so does an answer that is not a time.
- **Pause** — the host's button beside End & save while a take records (`CallStage`). It
  is End & save by another name: it calls the same `onEnd`, so the take is closed, checked
  and saved, every guest is stopped by `recording-stop` and the Room's `recording` flag is
  cleared. `CallStage` keeps one flag (`paused`) from that press until a take records
  again, and the flag changes words only: the status bar reads "Paused. Continue starts a
  new take." before the saved verdict, and only with a summary that is not the one the
  page held at the press (`summaryAtPause`), so never over a save that failed; Record
  reads **Continue** and the summary's main button **Continue recording**.
  Continue is `recordNextTake`: `newTake`, the countdown, then a take with a new id whose
  files end in `_take<n>`. No recorder is paused (`ChunkRecorder.pause` has no caller),
  nothing is sent that End & save does not send, and the Room knows nothing of it.

### Call orchestration (`hooks/useRoom.ts`)
State machine `RoomPhase`: `checking→lobby→waiting→connecting→in-call→recording→finalizing→done`
(+ `not-found|peer-left|left|full|replaced|removed|error`). **`waiting`** = joined but alone; → `connecting` when the peer is
present (`role-assigned` peerCount≥2 or `peer-joined`); → `in-call` on remote media. Transitions are
guarded on `s.phase==='waiting'` so a reconnect can't downgrade `in-call`. `RoomState` also holds
`localName`, `remotePeers` (per peer: name from `peer-joined`, stream, presence, role,
`notRecorded`), `notRecorded` (this peer: the host set it as not recorded, so its capture never
starts), `capabilities` (per-peer MP4/WAV from `recording-capability`), `backupTransfers` (a guest's returned
backups, shown as offers on the host), `remoteScreenStream`, `screenSharing`,
`micWarning` (this participant's own mic, from `SwitchableMedia`'s `onMicWarning`: `'silent'`, `'clipping'` or
null; `CallStage` shows it as a note that can be dismissed until the next take starts),
`countdownEndsAt` (when the countdown before a take ends, on this tab's clock, else null).
The lobby's answer to "headphones or speakers" reaches the hook through `chooseListening`
(`lib/listening.ts`), the way the bitrate level does through `chooseBitrate`, and rides on
every `recording-capability` this tab sends (`listeningField`); `capabilities` keeps each
peer's, and the host's name tags show it (`LISTENING_TAG`).
`hostMuted` is true from the moment a host's `peer-mute` turned this participant's microphone
off until they turn it back on: the handler does what `setMic(false)` does (track off,
`presence` sent), writes `micOnRef` itself, and does nothing for a host or a microphone that is
already off; `setMic(true)` clears the flag. `mutePeer(peerId)` is the host's side: it only
sends `peer-mute`, and the panel follows that person's `presence`.
`removePeer(peerId)` only sends `peer-remove`; the host's state follows the Room's `peer-left`.
On the removed side `phaseOnFatalClose` turns `4007` into the `removed` phase, or holds a take
that is running, as it does for every terminal close, with a banner that names the host. A held
close also sets `peerRecording` to false: the host's `recording-stop` cannot reach a closed tab, so
the "Recording" label follows this tab's own `phase` from there and a guest's saved take draws its
backup links. A guest's capture that has started but not reached `recording` (its channel to the
host has not opened) cannot be held, having no call screen: on any terminal close it is ended
first through `endRecording({ internal: true })`, its backup kept, and the terminal screen follows.
On a removal (`4007`) the close handler also tells the take's camera, WAV and screen senders to
`giveUp()`: every other page closes its side of the connection on `peer-left` and this tab has no
socket to make a new one, so nothing queued can reach the host. **Stop and save** therefore waits
for no drain, and the track readout shows those tracks as stopped. The handler also writes
`removedRef` itself, and the guest branch of `endRecording` reads it to end on `removed`
instead of `done`: the removed screen shows with the backup links, and the effect that lets
go on a terminal screen closes the connections and releases camera and microphone.
`remoteStream` is the camera stream of the first other person who has a tile (`isStagePeer` in `lib/stage-peers.ts`:
not a producer and not a Present-only device, which send no camera) and of nobody else: null until that stream arrives,
and null again from this tab's reconnect until a camera arrives on a rebuilt connection. `newTake` goes back to
`in-call` while such a person is listed and to `waiting` otherwise.
Holds all subsystem singletons in refs. `join`: `getTurnCred` → `buildIceServers` → `SignalClient` →
register handlers → `connect`. Wires signal→`peer.handleSignal`, chat/presence/peer-left, host
channel rebind. `toggleScreenShare`: adds the screen track on its **own** stream id (not the camera
stream); stop = `removeTrack` + renegotiate, idempotent. A host can present with nobody connected:
its screen file is written to the folder, so only a guest needs the connection to the host.
`onDataChannel` routes a `backup` channel to
`BackupIntake` before the camera fall-through; accepting reuses or sets the session's recording folder.
`acceptBackups` saves the offered backups, or, handed the picked files a row showed, those
files; `declineBackups` turns down the backups and `declineFiles` the files it is handed, so
one answer never covers the other kind.
`sendBackups` queues one `BackupSend` per leftover backup file and `startPeer` attaches every
unfinished send to each new connection to the host.
A guest's `endRecording` calls it too, with the backups of the take that just ended
(`takeBackupFiles` in `hooks/backup-return.ts`: the camera's, the WAV master's and each screen
stretch's, only those whose directory opened in browser storage, eight at most), when the host's
`recording-stop` ended a take whose streams did not all drain and the host has not set this
guest as not recorded. `state.backupQueued` says so,
and the guest's done line reads "Your backup of this take holds all of it and was offered to
the host." in place of the advice to rejoin.
`sendFile` queues one for a file picked in chat (`shared`), on the same list and held by the
same `hold`, but with no `after`: a picked file does not wait behind a backup the host has not
answered. It does nothing on the host's own page.
`setSendLater(on)` is a guest's choice to defer its takes (`state.sendLater`, and
`sendLaterRef`, which the callback writes itself). A take that starts while it is on is
deferred as soon as its streams exist (`deferGuestStreams`, after the camera and WAV backups'
`whenOpen()`); turned on during a take it defers that take at once. It cannot be turned off
while a take it deferred still records, and neither way while a take is being saved; a host
or a present-only device is not given it. When the camera backup has no directory in browser
storage the take is streamed, the choice is taken back and the recording banner says why.
`recordWithCountdown` is the Record click: it
asks for the folder when the session has none, counts `RECORD_COUNTDOWN_S` seconds (`CallStage`
draws `RecordingCountdown` over the stage and keeps Record disabled), then calls `startRecording`.
A take that took the room while it counted (a resume) keeps it, and `resumeRecording` never counts
down. The host sends `recording-countdown` as its count starts; every other tab counts from the
cue's arrival on its own clock, for at most `RECORD_COUNTDOWN_S`, and takes the count down on
`recording-started`. A lost cue costs the count, never the take.
`sendScript(text)` sends the host's teleprompter script as `script` and returns whether it went
out. Every other tab keeps the newest one the Room passes on in `incomingScript`, when it is a
non-blank string of at most `MAX_SCRIPT_LENGTH` units, until `dismissIncomingScript` (the
person took it or turned it down); nothing else in the state changes.

`CallStage` hands the three to `components/Teleprompter.tsx`, each person's own script overlay
(not on a present-only device; its text is kept in `localStorage` per room and is in no file).
A host's editor has **Send to everyone**, with a line saying whether it went out. Everyone
else is offered what arrives: a dot on the teleprompter button while the panel is closed, and
**Use it** / **Ignore** inside it; their own text changes only on **Use it**, and either
answer clears the offer. The editor shows a script's reading time at 150 words a minute
(`readingMinutes`).

- `lib/signal.ts`: `SignalClient` — sends `join` on open, type-guards inbound, 30s ping, **exponential
  backoff reconnect** (`backoff.ts`: `min(1000·2^n, 30000)`). `send` **drops** if not OPEN (no queue).
  It returns whether the message went out.
  After a terminal close code or `close()` it opens no socket again: `reconnect()`, which
  `useRoom` calls on a connection's second `failed`, returns at once.
- `lib/peer.ts`: `PeerConnection` — **perfect negotiation**; politeness is per pair by join
  `ordinal` (the lower ordinal is impolite), never by role. `onnegotiationneeded`→offer; impolite
  drops colliding offer; `ondatachannel` passes only recording channels (label base `recording` /
  `recording-audio` / `backup`, or prefix `recording-screen`). Guest **creates** the recording
  DataChannels;
  host **receives** them; the guest also creates one `backup#<file name>` channel per returned backup
  (`createBackupChannel`). `ontrack` routes any stream from a peer flagged `screenOnly` (producers or
  companions) to `onRemoteScreen`, never as camera, so a producer's screen share is never mistaken
  for a camera feed and hidden. For normal peers, the first stream is camera
  (`onRemoteStream`) and any distinct stream id is shared screen (`onRemoteScreen`, with
  `onRemoteScreenEnded` on track end). Companions have no camera tile; their screen shows in presenting
  mode labelled "Name (Presenting)". `removeTrack(track)` for stop-sharing.
  `setIncomingVideoOff(off)` sets the receive half of every video transceiver (`sendrecv` to
  `sendonly`, `recvonly` to `inactive`, and back) and never an audio one; the change is
  negotiated like any other, and the far browser then stops encoding and sending that video
  to this connection, so no message of ours has to ask it.
  While it is off the same is applied just before every offer and every answer this side
  makes, so a camera that is added, a person who joins or a screen that starts being shared
  is turned down in that very description; `syncSendQuality` (`useRoom`) tells each new or
  rebuilt connection, from a ref the switch writes itself.
- `lib/ice.ts`: stub detection `username==='stub' && credential==='stub'` (or no credentials) →
  bare STUN entry. If `getTurnCred` itself fails, `join` falls back to that same STUN stub.
- Chat: `sendChat(text, to?)` sends `chat` to the room or, with `to` (a peerId),
  `private-message` to one person, and adds the sender's own line to `state.messages` at once.
  A private line carries `private` (plus `toPeerId` and `toRole` on the sender's side: who it went
  to, by id and by the Room's role). `PrivateMark` draws the mark in the chat list and in the
  pop-up from that flag, never from the name: "Private · from Host", "from a producer" or "from a
  guest" by the Room's role when the sender's id is not known, "from Guest 1" or "from Producer 2"
  by the number this page gave that id, or "to Guest 1" on the sender's own line. A line for
  everyone starts with `PublicMark`, the words "To everyone:" read out and not drawn, in the list
  and in the pop-up: the mark is told from a name by its box, which a screen reader does not read,
  so the first words of every line are the page's.
  `chatSenderLabel` is the name alone. `buildChatLog` leaves the line out of
  `chat_<id>.txt`, whichever side the host was on. Its text is checked on arrival like `chat`: a
  string of at most `MAX_CHAT_MESSAGE_LENGTH`.
  `ChatPanel` offers the choice under **To** when there are two or more other people
  (`recipients`, from `CallStage`: everyone else but present-only devices). Each reads as the
  page's own words first, `Host: Ana`, `Guest 1: Bob` or `Producer 2: Pat`, then the name the
  person chose, cut to 16 characters. A number is given the first time the page meets a person
  and stays with that id for as long as the page is in the room (`chatNumbers` in `RoomView`,
  handed to `CallStage`, which is unmounted while the page shows "Everyone else left"), so
  no one else is given it when someone leaves or reconnects; a person who reconnects arrives under
  a new id and gets a new number. The name sits in a `<bdi>` element wherever other words follow
  it. The choice lives in `RoomView` (`chatTo`, handed to `CallStage` with `onChatTo`), because
  the panel unmounts when chat closes and the call screen while the page shows "Everyone else left",
  and stays until it
  is changed. `openChat` moves it only from Everyone: to the sender of the newest private message
  among those that arrived while chat was closed, once per message, if that person is still in the
  call. A person already chosen is never replaced, and a message for everyone that arrived after it
  changes nothing. When the chosen id is gone from the list (they left, or reconnected under a new
  id) the panel sends nothing until the sender chooses again; it never falls back to everyone.

### Recording engine (`lib/*`, `hooks/recording-controller.ts`)
- `recorder.ts` `ChunkRecorder`: `MediaRecorder` @ 2s timeslice; assigns `idx`/`offset`
  **synchronously** in `ondataavailable`, serializes `blob.arrayBuffer()` via a `tail` promise
  chain to preserve order; skips empty blobs.
  `mimeForStream(stream, mime)` is what both `ChunkRecorder` and `BackupRecorder` start
  their `MediaRecorder` with: for a stream with no video track (a person who joined with no
  camera) it is the first `audio/mp4` entry of the call-audio list this browser supports, so
  that person's `host_<id>.mp4` / `guest_<id>.mp4` and its backup are MP4 files with one audio
  track, under the names, channel and verdict a camera file has. Nothing that reads a take's
  files by name (the crash copy, a resume, the lobby's save, a returned backup) tells them
  apart.
- `chunk-sender.ts` (guest egress): `sendChunk` → `hash.update` → `buffer.add` → `enqueueOrSend`.
  Backpressure: `bufferedAmount>16MiB` → queue, drains at ≤8MiB (hysteresis). The pause half exists
  (`setPaused`, `onBackpressure`) but no take-time caller passes the hook — the three `new
  ChunkSender` calls in `recording-controller.ts` pass none — so no recorder is ever paused by it.
  Each chunk is split into ≤64 KiB fragments (`DC_MAX_MESSAGE_BYTES`), each with its
  own header `idx`/`offset`; `rawSend` = one fragment's two-frame header+payload. Ack truncates
  retransmit buffer. `rebind(channel)` moves the sender onto a new channel after a reconnect.
  `drain()` polls 100ms until empty or 30s cap. `giveUp()` is for a far end that is gone for good
  (the host removed this tab): the queue is emptied, later chunks are not kept, `drain()` answers
  false at once and no finish signal follows; unlike the backlog cap it sends nothing and raises
  no error.
  `defer()` is for a person who chose to send the take afterwards: the queue and the
  retransmit buffer are emptied, later chunks are not kept, the far end is sent
  `stream-abandoned` and no error is raised. A stream that stopped at the backlog cap or by
  `defer()` sends `stream-abandoned` again for every `resume_offset` it is sent, because the
  receiver that says where its file stands can be a new one, in a host page that reloaded.
  `deferGuestStreams` (`recording-controller.ts`) calls `defer()` on a guest's camera, WAV
  and screen senders and marks the handles `deferred`, which `startScreenRecording` reads
  for a share that starts later; it refuses when the camera backup has no directory in
  browser storage. The WAV and a screen stretch are each deferred only when their own
  backup has a directory there; one whose backup has none goes on being streamed. A stretch
  that has begun to finish when its backup's storage answers is not deferred: its finish
  message is the one the host gets.
- `chunk-receiver.ts` (host ingress): pairs binary frame with prior string header; a live receiver
  takes only the next wire index — a lower one is a replay and is dropped, a higher one is dropped
  and `resume_offset` is sent so the guest resends from the last fragment written, at most once
  every 2 s, and after five such answers leave the gap unfilled the asking stops and the gap is
  reported once; the extents are the frame that arrived, not the size its header claims, and a
  fragment starting more than 64 MiB past the bytes the guest actually sent is refused and reported
  once, so the file cannot run more than that past what really arrived —
  while a bounded receiver with `maxBytes` still **drops `header.idx <= lastIdx`**;
  `writer.write(offset, data)`; `maxBytes` holds a sender to a size it declared; a bounded receiver
  also refuses a chunk whose declared size is not its payload's length, takes chunks only in order
  and stops at its first refusal; acks every 5 fragments / 10s (with a journal file attached, after
  each journal commit instead, so an ack means the bytes are in a closed journal part; a commit
  window holds at most 8 separate runs of bytes, so a sender that scatters its offsets further is
  acknowledged from the folder write for the runs the journal did not take; a journal that fails,
  or a commit that does not answer within 15 s, falls back to the folder-write ack for that file
  with one warning, and the take goes on); `answerResume` replies
  `resume_offset{lastByte,lastIdx}` and runs on every channel bind, so an attached guest learns
  where the file ends without having to ask.
- `fs-writer.ts` `FileWriter`: `openIn(dir, name)` inside the one folder from
  `pickRecordingDirectory` (`showDirectoryPicker` with `mode: 'readwrite'`: write access is
  granted when the folder is chosen, so creating a file later needs no click) → all writes
  **chained through `writeTail`** (host own-track writes are fire-and-forget; serialization
  prevents interleaved corruption). `QuotaExceededError`→`DiskFullError`.
- `retransmit-buffer.ts`: FIFO keeping every chunk that was not acked; it stores a `cap` and never
  reads it, so no byte cap applies; always keeps ≥1 item; `truncate(idx)`, `since(idx)`.
- `sha256.ts` `StreamingSha256`: **true incremental FIPS 180-4 SHA-256** (O(1) memory — keeps only
  the 8-word state + a ≤64B remainder, does **not** retain chunks). `digestHex` finalizes on a clone
  so it stays idempotent / updatable. The running state is read when a commit is queued, together
  with the index it is filed under, and committed with that journal position, so a resumed file's
  digest still covers the whole take. Two independent digests
  (guest=sent, host=written) compared at finalize for every guest file (camera, WAV, each screen
  segment).
- `backup-recorder.ts`: a 2nd MediaRecorder over the same stream, on **both** host
  (`startHostRecording`) and guest (`beginGuestRecording`), plus a WAV master backup (its own
  `PcmRecorder` on the raw mic, `openmeet-backup-audio-…` / `openmeet-backup-host-audio-…`; the lobby
  labels it "(WAV)") → **writes committed per-chunk files** (`NNNNNN.part`) to an OPFS directory
  (`openmeet-backup-<ts>-<slug>`, host `openmeet-backup-host-<ts>-<slug>`; disk-backed, no picker) so
  backups survive tab crashes. Missing OPFS or `createWritable` is detected up front (RAM + warning).
  Storage that has not answered five seconds after `start()` is treated the same way: the wait
  ends, the copy is held in RAM with that warning, and an answer that comes later is ignored
  and the directory it created is removed, so `stop()` and `whenOpen()` never wait on it for
  longer and no empty backup directory stays in storage. A failed write is retried once and
  then the rest of the take continues in RAM with a warning
  banner. `stop()` returns the disk-backed `File` assembled from chunk Files by reference. A
  backup whose directory opened and whose chunks could not be written there is returned from
  memory as a `File` under that directory's name, so it can still be offered to the host; one
  that got no directory is a `Blob` with no name. After a
  clean host take (no recording error or connection warning, and neither the host's camera file nor
  its WAV master came out empty) `markFinalized()` drops a `finalized` marker and the next lobby's
  `findBackups()` deletes that directory. Guest backups are **never** auto-deleted (a guest can't know
  the host's file was saved); they stay listed in the lobby until deleted by hand. Each screen segment
  has its own backup (`openmeet-backup-screen-…`) fed the segment recorder's chunks via `writeChunk` —
  no second screen encode; the host's are finalized with its camera/WAV backups after a clean take.
  While a take runs, its guest files are also kept in a crash journal (`lib/take-journal.ts`): one
  directory per take (`openmeet-take-<startMs>-<slug>`) holding each file's acknowledged bytes in
  small closed parts. A journal whose part failed twice leaves a `dead` mark that the next open
  reads back, so a take whose crash copy stopped part-way is not offered for a resume.
  `findTakeJournals` lists what a crash left; a directory with no part and no usable record is
  removed, but not while a tab holds that room's take lock, because a live take's directory is
  empty until its first commit. The lobby's Save to folder is `saveRecoveredTake`
  (`lib/take-recovery.ts`): it rebuilds every file directory the journal holds, named in
  `take.json` or not (`fileNames`), copies in the host's own backups, writes the sync file, and
  removes the journal only when every part reached the folder and the sync file was written;
  otherwise the result says `kept` and names the files that fell short in `unsaved`. A folder
  file at least as long as its crash copy is kept as it is, except that a kept `.wav` whose
  header does not match its length gets its two size fields set from the length
  (`repairWavHeader`: the file's own handle opened with `keepExistingData`, the fields from
  `patchWavHeader`), because a page that closes commits its files with the placeholder header;
  a resume gives the host's own WAV the same repair through `copyBackupInto`.
  Wherever the host's page writes a WAV's size fields from a length (this repair, a file
  rebuilt from the crash copy, and End & save for a guest whose final header never came),
  `patchWavHeader` declares whole sample frames only: a guest's WAV arrives in 64 KiB
  pieces, so a file that was cut off can end part-way through a sample, and a decoder
  reports an error on a frame it cannot finish. The frame size is read from the file's own
  header (`wavFrameBytes`), and taken only when it agrees with the channels and the depth
  that header states.
  At End & save that length is the file's own (`FileWriter.size`) when it is more than the
  receiver saw: a file reopened after a reload has the folder's bytes carried into it, past
  the crash copy's end where its receiver starts.
  A take reopened from that journal replays the parts into the same folder files
  and seeds each receiver from them: the far-offset rule is measured from the resumed end, not from
  zero, and the hash state the commit stored beside its position lets the digest cover the part
  before the resume as well. A screen file already in the folder is never replaced — the resumed host
  probes for a free segment number instead — and screen notes are bounded at 48 while camera and WAV
  notes are never refused by that bound. A resumed take opens `host_<id>_resumed.mp4`/`.wav` for the
  host's own tracks; the first part is copied in from the take's backup in the background and
  enters `hostParts` (and the file checks, with its size) once that copy is in the folder.
  `resumeHostRecording` keeps what the folder already holds: after a reload the folder is a few
  seconds ahead of the crash copy (the closing page commits every file), so those bytes are carried
  into the reopened file before the crash copy is replayed over them; a file that cannot be carried
  is left untouched (`keptFiles`) and never reopened in that take. A replay that stops short marks
  the file (`shortFiles`): it gets no stored hash state and reads incomplete. A guest's clock-sync
  numbers reach its note through the receiver's `onMeta` and are read back at a resume or a save.
  The note also keeps when the estimate arrived (`clockAtMs`, stamped once by `noteClock`), a
  resumed receiver is seeded with the three numbers (`clockFrom`), so a report that arrives
  after the reload is the later one, and a save hands the time to the sync file.
  Guest screen notes are rebuilt from the crash copy and listed (`resumedScreens`); a call-audio
  copy opened after a resume asks the folder for a free number (`freeNumber`, shared with the screen
  files), and each number is claimed before it is asked about.
- `clock-sync.ts` `ClockSync` + `sync-report.ts` `buildSyncReport`: the two files start at independent
  click times, so the guest runs an NTP-style offset estimate over the recording DC (`clock_ping`↔
  `clock_pong`, min-RTT sample), then reports its recorder start on the **host clock** via
  `recording_meta`. Host (`ChunkReceiver`) answers pings + captures the meta (and hands the pair it
  accepted to its optional `onMeta`); at finalize the host
  builds a `sync.json` companion (start-offsets for editor alignment — `timeline.guestMinusHostMs`
  for the first guest, `guests[]` per guest slot, `screenSegments[]` with each segment's offset from
  the host start, with `sharer` display name on each entry, `callCopies.files[]`, each call-audio
  copy with its offset from the host start and the guest's name, and `hostParts[]`, each file of the
  host's own track with its offset from the start — a resumed take's own track is two files, and a
  file that continued after a reload reads "not verified" when the crash copy kept no hash state, so
  no single digest covers it — plus integrity verdicts,
  a size and a verdict for every file (`verification[]`: complete / unverified / incomplete, from
  `fileVerdict`), lossless `+faststart` remux and WAV-pairing commands, an `aligned` section:
  per file (except call-audio copies, which carry their own `offsetMs`), its delay from the host
  start and an `ffmpeg` command that writes a copy starting there,
  and a `frameRate` section: the default requested rate, each camera file's track-reported rate where known,
  and per video file a `measure` (ffmpeg `vfrdet`) and a re-encoding `conform` command), saved to the
  recording folder alongside chapters and chat sidecars and surfaced in the session summary as
  "Download sync.json" (downloaded as
  `openmeet-<slug>-take<n>-sync.json`). When someone's microphone ran with the browser's echo
  cancellation on, the report has an `echoCancellation` section naming that person's camera and
  WAV files, and the summary's rows for them read "echo cancellation on": the host's own from its
  microphone's settings at End & save, a guest's from the `listening` it announced, kept by peer id
  past `peer-left` (`echoPeersRef` in `useRoom`, at most 64 ids). After a take the host's summary is a column beside the stage
  (a sheet on phones) that shares that side with chat; "Record another take" runs `newTake` then
  `recordWithCountdown` in one click (same folder, no second prompt). It is offered with nobody else
  in the room too: the take that follows is the host's alone, and `RoomView` keeps the call screen up
  through the count. The summary's file list leaves out a
  guest WAV that was never opened, host files a host companion never opened, empty guest screen
  segments (deleted) and the first guest's camera file when no guest sent into it (deleted); every
  file it lists shows its verdict and, when it was checked, its size (a file that was never created
  has no check, so no size); one that holds no bytes reads Empty, and one warning says so whenever
  any file is not complete.
  A round of pings the host does not answer (it is not recording yet, or has not
  bound the channel) is followed by another five seconds later, sent on whatever channel is
  live (`ClockSync.sendOn`, called from `bindGuestChannel`), until one is answered or the
  guest's recording ends (`stop`, called from `endGuestRecording`); a guest with no answer by
  then has a null offset ("align by waveform").
  A round trip that reads below zero (`handlePong`) shows that the guest's clock was set back
  between a ping and its answer. The guest read its start before that, so no estimate measured
  from then on places it: the round ends there and reports the sample it already holds. With
  none it reports nothing, and that recording asks no more (`clockSetBack`): no later round,
  and `again` sends nothing. A guest that had reported no estimate by then has a null offset.
  `ChunkReceiver` keeps the first start it accepts, with the time it arrived (`clockAtMs`), and
  a later report of the same start beside it (`clockEnd`), never in its place.
  The round trip it holds is the one that came with that start; one reported without a
  usable start is taken only while none is held, and a message the receiver takes nothing
  from does not reach `onMeta`.
  `collectGuestReports` hands both on, and `lib/clock-drift.ts` `clockSection` writes the sync
  file's `clock` section from them: per guest the estimate its offsets come from (`start`), and,
  when a second one exists (`end`), how far the two computers' clocks moved in between
  (`movedMs` over `spanMs`, within `errorMs`: half the sum of the two round trips plus 4 ms).
  The section compares the system clocks (`Date.now()` on both sides) and says so; a guest with
  no estimate is not listed, and nothing about movement is written without two estimates that
  each carry a round trip.
  Its note says what a clock that is set during the take does: between a guest's two
  estimates it shows as a `movedMs` of that size or as no `end`, and does not move the offset
  of that guest's camera file and WAV; a guest that saw its own clock set back before it had
  an estimate is not listed; any other change before the first estimate moves that guest's
  offsets and shows in nothing.
  The second estimate is the guest's: `endGuestRecording` runs `ClockSync.again` (one round
  of three pings, three seconds at most, a fresh minimum) after the camera sender has drained
  and before `recording-finalized`, and skips it when that sender did not drain or its channel
  is not open. A take that is ended because the host started another one takes none:
  `handleGuestRecordingStarted` (`useRoom`) stops its clock sync first, so the new capture
  does not wait for an answer that cannot come.
  any file is not complete. Clock-sync needs the host to be
  recording within ~8s of the guest, else it degrades (offset null → "align by waveform").
  The report's `flac` section and the summary's Editor commands give two `ffmpeg` commands
  for each WAV master the report lists (the `fileList` rows of kind `audio`: the host's, each
  guest's, and the host's file from before a reload): `encode` writes a FLAC beside the WAV
  (`flacCmd`) and `check` decodes both and prints one MD5 line for each, hashed as PCM at
  `WAV_BIT_DEPTH` (`flacCheckCmd`); equal lines mean the FLAC holds every sample. No page
  encodes or decodes FLAC: the masters, their backups and the crash copy stay WAV.
  any file is not complete. A file recorded with no camera carries `audioOnly` in its file check
  (`collectFileChecks`: the host's own from `RecordingHandles.audioOnly`, set when its
  recorder is built with a microphone and no video track; a guest's from `audioOnly: true`
  in that guest's `recording-finalized` on the camera channel, which the receiver keeps as
  `senderAudioOnly` and takes only as the boolean `true`). `buildSyncReport` lists it as
  kind `audio-only` ("Audio only, no camera" in the summary), names it under `audioOnly`
  in the sync file, and leaves it out of `combine` and `frameRate`; its remux and aligned
  commands stay, since both copy streams as they are. Clock-sync needs the host to be
  recording within ~8s of the guest, else it degrades (offset null → "align by waveform").
- `notice-log.ts` `NoticeLog`: the host's record of who was told that a take was being
  recorded, written into `sync_<id>.json` as `recordingNotice` (`buildSyncReport` passes
  it through). `useRoom` makes one as `startRecording` announces the take, with everyone
  in `remotePeersRef`; an effect on `state.remotePeers` gives whoever is listed later a
  line (`listed`); and `onDataChannel` calls `confirmed` where a camera recording channel
  is bound, beside `setToldPeers`, and where a screen channel is. `endRecording` takes
  the log out of the ref as it starts, so a save that fails leaves none for a take
  resumed later in the same page. A line holds the name, the role, `presentOnly`,
  `setAsNotRecorded`, `listedAtMs` and `confirmedAtMs`, as offsets from `hostStartMs` on
  the host's clock. It holds only what the host's page can know: `SignalClient.send`
  drops a message while the socket is down, so `announcedAtMs` is not proof of delivery,
  and only a channel that arrived shows that a page was told. A guest set as not
  recorded is listed without a name, as its chat and markers are left out. A take keeps
  at most `MAX_NOTICE_PEOPLE` (64) lines and says `capped` past that. Nothing is sent to
  the Room, and nothing is added to D1 or to the crash copy.
  After an interruption the crash copy is read, never written: `peopleFromNotes` lists
  one guest per camera note that carries a channel key. `resumeRecording` starts a new
  log at its re-announcement with that list (`resumed`, `fromCrashCopy`) and confirms the
  connections in `told` that the room still lists, and `saveRecoveredTake` writes the
  list alone (`crashCopyNotice`).
- `screen.ts`: `getDisplayMedia({video:true, audio:true})` — video and tab/system audio when available. A photo or a video file is presented through a canvas (`presentFile`): a computer picks it from the arrow beside Present, a phone from the Present menu, which also offers the rear camera (`presentRearCamera`). A phone's real screen comes from a second device joined with "Present only". A presented video's sound goes to the call; `presentFile(file, monitor)` also plays it on the presenting device when `monitor` is set, which `toggleScreenShare` does on a computer that is not a present-only device. That device plays it through an element (`playLocally`), on the chosen speaker. A presented video's track is marked `contentHint = 'motion'` in `presentFile`, and `PeerConnection.addTrack` marks a track as a screen (`'detail'`) only when it carries no hint, so the clip is sent with the camera's budget at its own frame rate; a photo and a shared screen stay capped at `SCREEN_MAX_FPS`.
- `recording-controller.ts`: HOST `startHostRecording` is handed **one folder**
  (asked for once a session by `useRoom.recordWithCountdown`, before the countdown; it asks itself
  only when handed none; later takes reuse it and get a `_take<n>` suffix) and opens
  `host_<id>.mp4`, `host_<id>.wav` (when PCM capture works) and slot 0's `guest_<id>.mp4` up front.
  A host companion running `startHostRecording` with an empty camera/mic stream skips host camera MP4,
  WAV, and their backups, while still opening the folder and recording guests and screens. Guest companions
  record only screen segments on `recording-started` without camera, WAV, or backup recorders.
  Every other guest file opens lazily per slot when that guest's channel arrives (`guest_<id>.wav`,
  `guest2_<id>.*`, `guest3_…`), as does each screen segment (`host_screen_<id>.mp4`,
  `guest_screen_<id>_2.mp4`, …; from the second take on every name ends in `_take<n>`, as in
  `guest_screen_<id>_2_take2.mp4`). Also starts the host's `BackupRecorder` and stamps `hostStartMs`.
  The host's files carry the host's display name after the role (`host-ana_<id>.mp4`,
  `host-ana_screen_<id>.mp4`), cleaned by `safeNamePart` (`lib/file-names.ts`: letters, marks and
  digits of any script, lowercased, hyphens for the rest, 32 characters at most).
  After the folder writers are open it opens that take's crash journal and hands each guest receiver
  its journal file; when storage could not take one the handles say `unprotected` and the take
  records as before. `useRoom` mirrors that into `unprotectedRecording`, and sets the same flag
  when the take's warning callback hears the receiver's "Crash protection stopped" warning (one
  file's crash copy can stop on a commit that never answers while the journal lives) or finds the
  journal dead, so the take's own status line outlives the shared banner; a warning for a take
  that has ended is ignored. In the call, Resume and Save of an interrupted take share one
  in-flight flag (`recoveryBusy`: neither runs twice or beside the other, Record waits, and the tab
  holds the take lock from the click). The channels waiting for a resume are one camera and one
  audio entry per connection, never a producer's or a present-only device's, and no screen channel.
  A resume restores the take's markers from the notes, binds a channel that arrived while it ran,
  and marks the guests it bound as told so their call-audio copy starts. A save that removes the
  crash copy sends `recording-stop`, and a host that joins with no crash copy to continue stops
  guests still recording the old take, once per connection.
  While a take runs the host also keeps a **call-audio copy** of every guest who is being recorded
  (`syncCallCopies`, driven by one effect in `useRoom`): an audio-only `MediaRecorder` on the guest's
  incoming live track (`pickCallAudioMime`: AAC or Opus in MP4, else WebM/Opus), written to
  `call<n>_<id>.m4a`, one file per stretch of one guest's stream (a reconnect starts the next), at
  most `CALL_COPY_MAX_FILES` per take and `CALL_COPY_MAX_PER_PEER` per connection, so one guest's
  reconnects cannot spend the other guests' files; the first refusal is logged and recorded as
  `callCopiesCapped` in the sync file. Never for a producer, a companion or a guest whose browser
  cannot record. A guest's copy starts when that guest's camera recording channel arrives for the
  take, because a guest opens that channel from the handler that shows it the recording notice: the
  channel arriving is the proof the guest was told, and there is no second notice. It adds no video
  encoder, and its failures are logged, never raised as a recording error.
  Sender↔recorder backpressure cycle broken via `recorderRef` box. `rolePicker` defaults unknown
  role → `host`.
- `media-board.ts` `MediaBoard`: mic + pads mixed in Web Audio. Once opened, the mix replaces the
  raw mic on every peer connection (`replaceAudioTrack`) and in the MP4 + backup of every take
  started afterwards (`withBoardAudio`); the WAV master always records the raw mic (`micStream`). A
  take already recording when the board is first opened keeps the track it started with (a running
  `MediaRecorder` can't swap tracks), so the board hands its pads alone to
  `SwitchableMedia.mixIn`, which connects them to the stable track's destination node: that
  take's MP4 and backup record them from then on, in the take's own channel count, and
  `micStream` never carries them. The mix is built on `micStream`, not on the stable track, or it
  would carry every pad twice. While the microphone is off the stable track is off with it, so
  what a pad plays then is not in that take; where there is no stable stream (`isFallback`) no
  pad is (`MediaBoard.recordsInRunningTake` is false). The pads play live and drop chapter markers
  either way, and the board panel says which case applies while it does: its "This take keeps
  your mic only" line where no pad is in that take, and a `role="status"` line while the
  microphone is off (`CallStage` passes `midTake` and `micOffInTake`). `RoomView` holds the board
  this page made (`board`, handed to `CallStage` with `onBoard`), as it holds `chatTo`, so a call
  screen built again after "Everyone else left" shows the same board and a click that shows it
  is not the board being made during a take; only the click that makes it sets those lines.
  A pad set to loop
  (`setLoop`) repeats until it is stopped, and
  the switch reaches a pad that is already playing. Each pad plays through a gain node of its
  own: one set to fade (`setFade`) comes in over `PAD_FADE_S` when fired and goes out over it
  when stopped, counts as playing until it is silent, and is cut by a second stop. The mix
  destination keeps the browser's default of two channels, so the MP4 (and backup) of a take started
  with the board open has a two-channel audio track even when the microphone is recorded in mono: a
  stereo pad keeps its stereo and the voice is the same on both channels. The WAV master follows
  `recordedChannels` either way. The person who fires a pad hears it from a second
  destination node that only the pads feed, played by an element (`playLocally`) on the
  chosen speaker.
- `board-sounds.ts` `BOARD_SOUNDS`: the ready sounds the media board panel offers under "Ready
  sounds" (Chime, Rimshot, Soft bed). One is computed in the page when its button is clicked
  (`render`: sine tones and noise at `WAV_SAMPLE_RATE`), wrapped as a 24-bit mono WAV
  (`soundFile`, with `wavHeader` and `f32ToS24LE`) and handed to `MediaBoard.load` like a file
  the person picked, so it is a pad like any other. No audio ships for them and nothing is made
  before the click. Every partial of the bed is a whole number of cycles long, so it loops
  without a click, and its pad starts set to loop and fade. A sound already on the board is not
  offered again. The panel draws the row above an empty board's text and, once the board holds
  a pad, as the first item of the scrolling list, where it scrolls with the pads. On an empty
  board a row of many shipped recordings makes the panel taller (see Known gaps).
- `sound-files.ts` `SOUND_FILES`: recordings a deploy ships as further ready sounds, offered
  after the computed ones. An entry names a file in `apps/web/public/sounds/` (served at
  `/sounds/<file>`), the license it is handed out under and its source. `fetchSoundFile`
  fetches it when its button is clicked and never before, and `MediaBoard.load` makes the pad
  as for any file; a fetch or a decode that fails shows "Could not add …" and leaves the
  button. The list is empty in this repository. `tests/sound-files-manifest.test.ts` fails on
  a file in the folder that is not listed, a listed file that is missing, an entry with no
  license or source, a file over 1 MiB, and a name used twice or longer than 20 characters.
- `hooks/backup-return.ts` `BackupIntake`: host side of returned guest backups. Offers are keyed by
  the backup's file name, validated, and counted per sender (max 8 waiting, a moved offer included).
  An accepted backup can be restarted only by the key of the offer that created it; another key can
  take a name while it holds a waiting offer whose channel is gone, or a failed one whose file was
  already ended. The host can stop a running transfer (`stop`), which answers its sender and keeps
  the part that arrived. Nothing is written until the
  host accepts, and a Save covers only the offers that were on screen when it was clicked; each
  accepted file is opened under a free name that never replaces an existing file in the folder
  (`…_2.<ext>`). An accepted
  transfer is written through a `ChunkReceiver` bounded to the size its sender declared, and answers a
  `resume_query` only with the key of the offer that holds it. On the sender's finalize the file is
  closed first, then its digest and byte count are compared with the sender's, and a verified backup
  gets a `<name>.json` note beside it; a failed or cut-off transfer keeps the bytes that arrived with
  no note (an empty file is removed), and a dropped connection shows `stalled` until the sender asks
  where to resume on a new channel. `BackupSend` is the same backup from the guest's side: it offers
  its name, size and one key per item, reads nothing until the host's `resume_offset`, then streams
  1 MiB slices paced by `ChunkSender` backpressure and by the host's acks (16 MiB unacked is the
  ceiling), and calls it saved only when the host's digest and byte count match its own and it has
  sent the whole file. Sends go
  one at a time — each waits for the one before it (`after`) and for this guest's own take to end
  (`hold`) — and a dropped connection shows `stalled` instead of failing: `attachBackupSends`
  points every unfinished send at the rebuilt connection once it is connected, the send asks
  `resume_query` on the replacement channel and replays from the host's answer through
  `ChunkSender.rebind` + `resume`, and nothing goes out on that channel before the answer arrives.
  The same two classes carry a file a participant picks to send the host (`kind: 'file'`).
  `BackupSend` with `shared` travels under an id of its own, `file-<uuid>`, and puts the file's
  name in its offer. `BackupIntake` takes that id where it takes a backup's name, and turns the
  offer away before it is listed unless `sharedFileName` (`lib/shared-file.ts`) accepts the name
  (a string of at most 255 characters whose extension is on a fixed list of pictures, documents,
  slides, sound and video) and the size is at most `MAX_SHARED_FILE_BYTES` (100 MB). The file is
  opened as `shared_<sender>_<name>.<ext>`, both parts cut down by `safeNamePart`, and the host is
  shown that name, never the one the sender gave. It gets no note, and one that is stopped, cut
  off or fails its check is removed from the folder whole. `decline` takes the offers to turn
  down, so backups and picked files can be answered apart.
  The note beside a returned WAV backup also holds a `flac` entry: the `encode` and `check`
  commands of `lib/sync-report.ts` (`flacCmd`, `flacCheckCmd`) for the file's name in the
  host's folder. A camera or a screen backup's note has none.

---

## End-to-end flows (quick map)

1. **Room create/join/auth** — New Room → `POST /api/rooms` (token+cookie) → nav `/r/slug/` →
   `getRoom` → lobby → join → WS → DO assigns host (cookie match or token in join) / guest (invite link, no token)
   → `role-assigned` + `peer-joined`. Peer past capacity → close 4001.
2. **WebRTC signaling** — perfect negotiation over WS relay; guest creates DataChannel, host
   `ondatachannel`; ICE trickled in parallel; DO never inspects SDP.
3. **Recording happy path** — **host-driven**: only the host has a Record button (it owns the disk).
   Host click → the one folder prompt, then a three-second countdown (`recordWithCountdown`), shown
   to the others by WS `recording-countdown` →
   `startHostRecording` (opens `host_*.mp4` + `host_*.wav` +
   `guest_*.mp4`) → WS `recording-started` → DO relays → every guest shows the consent notice and
   auto-runs `beginGuestRecording` — a guest the host set as not recorded shows the notice and starts
   nothing — opening `recording` + `recording-audio` (+ `recording-screen-N`
   while presenting) → chunk-sender (2 frames, fragmented to 64 KiB) → DC → chunk-receiver →
   FileWriter at offset; acks every 5 fragments/10s (with a journal attached, after each journal
   commit instead); backpressure via watermarks.
   Stop: host sends `recording-stop` FIRST, then `endHostRecording` waits (≤45s without progress per
   file, `GUEST_TAIL_TIMEOUT_MS`, and ≤2 min in all, `GUEST_TAIL_HARD_CAP_MS`) for each guest's
   `recording-finalized` before closing writers — closing early truncates the guest's tail, and a
   guest that keeps sending cannot hold the save open. A guest screen segment whose channel is
   still open is waited for the same way; one whose channel has closed is not, and its writer was
   closed by that event. A channel that closes during the wait ends the wait for its file. A screen
   file that gave no finish signal within the limits, or whose channel closed without one, is
   listed as ended early. `FileWriter.close` closes the stream once and gives every caller that one result,
   so the channel's close and the end of the take can both ask for it.
   A guest's stop ends with one more clock-sync round, three seconds at most, before its
   `recording-finalized`.
   A take needs no guest: with nobody connected `startRecording` records the host's own
   tracks, slot 0's `guest_<id>.mp4` stays empty and is removed at the end, and a guest who
   joins meanwhile is started by `role-assigned.recording` like any late joiner.
4. **Resilience** — DC drop/reopen: `resume_query`→`resume_offset(lastIdx)`→replay
   `buffer.since(lastIdx)`; idempotent dedupe; the queue plus the retransmit buffer are unbounded
   until they pass `STREAM_BACKLOG_CAP_BYTES` (256 MiB), after which the stream is abandoned and the
   guest's own backup keeps the rest. A take also keeps a crash journal in browser storage: small
   closed parts, an ack meaning the journal already holds those bytes, so the lobby can rebuild a
   take from it after the tab closes. A resumed take continues each guest's file where the journal
   stopped, while the host's own camera and WAV become a second file (`host_<id>_resumed.*`).
   **Full WS reconnect rebuilds the PeerConnection; `startPeer` (`useRoom.ts`) calls
   `rebindGuestRecording` for the guest's connection to the host, which recreates the camera
   (and WAV, if present) recording DataChannels, `ChunkSender.rebind()`s the existing senders onto
   them (queue, retransmit buffer, hash and indices all survive), and fires `resume_query` on each
   `open`, holding the replay until the host reports its position (five seconds at most) — so the
   guest resumes streaming into the same host files from the last acked chunk with no gap.**
   `role-assigned` lists the whole room as it stands, so every connection to an id the
   Room no longer lists is closed there the way `peer-left` closes one — a Room that restarted never
   sends `peer-left` for the sockets it lost — and every connection it lists is rebuilt, because the
   far end closed its side when this tab's socket dropped and waits for a fresh offer; only the
   connections that message opened are negotiated on it. The Room drops its `recording` flag with
   the host's socket, so a host that gets `role-assigned` with `recording: false` while its own take
   runs sends `recording-started` again under the take's id: a guest already in the take ignores it,
   the Room keeps the row it has, and a guest who joins from then on is started. When sharing screen,
   a reconnect finishes the old screen segment and starts a new numbered segment on the rebuilt
   connection, with each segment backed up locally in OPFS. Host rebinds new channel to existing
   receiver, found by a stable key (see below), not by the DO's fresh-per-socket peerId.
5. **Aux** — chat + presence relayed by DO (`broadcastExcept`, never persisted; chat echoed
   optimistically client-side). Screen share = client-side `getDisplayMedia` → `addTrack` on a
   **dedicated stream id** → renegotiation → remote `ontrack` routes it to `onRemoteScreen` →
   `Stage` presenting mode renders it (+ a `presence` flag). Backup (host's or guest's own) → object
   URL → "Download your backup"; leftover backups are listed in the lobby (Download / Delete), where a
   guest can also pick one to return: the choice rides the join into `sendBackups`, travels as
   `backup#<name>` over the DataChannel, and lands on the host's **Save to folder**, which checks its
   SHA-256, writes `backup_<name>_<kind>_<time>` and puts a note file beside it saying how to align it.
6. **TURN/ICE** — `POST /api/turn-cred` → operator `TURN_URLS`, real Cloudflare TURN, or STUN-only
   stub; if the request fails, the client falls back to the STUN stub. **No symmetric-NAT
   detection / `iceTransportPolicy:'relay'`** — relies on native ICE fallback to the relay
   candidate; in stub mode (no relay) symmetric-NAT calls can't connect. Each connection gets one
   `restartIce()`: from the connect watchdog (`startConnectWatchdog`, ~10 s without `connected`) or
   the first `failed` state, whichever comes first (re-armed once connected). A second `failed`
   shows a can't-connect warning, worded by whether the TURN cred carries a `turn:`/`turns:` URL.
   The warning is cleared when the mesh empties, so it never greets the next person to join.

---

## Gotchas (read before changing)

- Next static export is **production-only** by design (dev needs runtime slug resolution).
- Chunk header is **JSON-over-string**, not binary; a chunk header must never contain a `type` key
  (receiver distinguishes control vs header by `type` presence).
- Two ack systems: DataChannel `ack` (`uptoIdx/uptoOffset`) vs WS `recording-ack` — the WS one and
  `recording-completed` (kept in protocol only for older tabs) are defined in protocol but **the DO
  never produces/consumes them**; real acks are DataChannel-side.
- **Host ingest is routed by SOURCE peer** (`bindHostGuestChannel`/`bindHostAudioChannel` take a
  `peerId`; `guestSlot`/`guestName` pick the file). Binding every guest to one receiver interleaves
  two H.264 streams into one unplayable MP4, which is the default case because one click starts every
  recorded guest. Slot 0 keeps the original `guest_<id>.*` names. A take opens at most eight guest slots
  (`MAX_GUEST_SLOTS`) and one connection may introduce at most two keys
  (`MAX_GUEST_SLOTS_PER_PEER`). Only the host binds these channels, and a producer or a
  present-only companion publishes no camera or mic, so neither can claim a guest slot. A recording
  channel arriving from a peer the host set as not recorded is closed before any file is opened
  (`isNotRecordedPeer`, in `useRoom`'s `onDataChannel`), so the host does not depend on that guest's
  browser staying quiet. The same check tags that peer's chat lines as they arrive, and drops its
  markers, so `buildChatLog` leaves them out of `chat_<id>.txt` while everyone in the call still sees
  them.
- **The slot key is the channel-label key, not the raw peerId, when one is present.** The DO mints a
  fresh `peerId` per socket, so a full WS reconnect changes it; if `bindHostGuestChannel`/
  `bindHostAudioChannel` keyed slots on `peerId` directly, a reconnected guest would land on a brand
  new slot/file/receiver with `lastIdx=-1` instead of resuming the one it already had open. Recording
  channel labels can carry a stable key after `#` (`recording#<key>`, `recording-audio#<key>` —
  `recordingChannelKind()` in `@openmeet/protocol` splits it out); the guest passes its own
  `recordingId` as that key from both `beginGuestRecording` and `rebindGuestRecording`, so the key
  survives the reconnect even though the peerId doesn't. `bindHostGuestChannel`/`bindHostAudioChannel`
  use `recordingChannelKind(channel.label).key ?? peerId` — old plain-label channels (no `#`) fall
  back to `peerId`, unchanged. `PeerConnection.ondatachannel` and `useRoom`'s `onDataChannel` routing
  both filter/compare on the label's `base`, not the full label, so a keyed label still matches.
- **A room never has two hosts (newest verified host wins)** — when a connection
  proves the host token (cookie path in `fetch` or token path in `join`), it becomes host
  first, and every other peer whose role is host is closed with `4006` (`WS_CLOSE_REPLACED`,
  `'replaced'`). This lets a reconnecting host or second tab take over. A take running in the
  replaced tab is not torn down (`phaseOnFatalClose` holds the phase and asks for End & save), but
  its files end there — see Known gaps. The Room itself never refuses a host. A second tab
  is asked earlier, in its own lobby: while a host's take is live its tab holds a Web Lock
  (`lib/take-lock.ts`), and `Lobby` asks before it hands the stream to `join` while another tab
  holds it. It asks the same lock again before it saves or deletes an unsaved recording, because
  its rows were read when the page opened. The host token exists only in the browser that created the room, so the tabs that
  can take the seat are the tabs that share that lock. Only a join through the lobby is asked:
  a tab already in the call that reconnects is not, and neither is a producer link.
- **Negotiation is presence-gated and joiner-offers** (`useRoom`): exactly one side offers first per
  pair — the joiner. On `role-assigned` when peers are present (`peerCount>=2`), the joiner adds its tracks
  (or recvonly audio/video transceivers if joining as a producer) and triggers the initial offer.
  Existing peers on `peer-joined` create the PeerConnection but do not add tracks up front; they call
  `setLocalStreamAfterFirstOffer(stream)`, which waits to add tracks until right after answering the joiner's
  first remote offer. This eliminates glare and candidate drops while preserving the presence gate
  (nobody offers into an empty room). The joiner also opens a `control` data channel before its first offer
  so every later recording channel opens without renegotiation (the first data channel on a connection is
  the only one that renegotiates, and that renegotiation would collide with the host's track offer and wedge the channels).
- Time units: D1 timestamps are uniformly ms (TURN TTL stays seconds).
- **Recording is Chromium + MP4 only (by design), and the codec is PROBED, never assumed.**
  Which codecs `MediaRecorder` can encode varies **by OS**, not by Chrome build. Measured on
  Chrome 151: **Linux has NO AAC-LC encoder — in the official `.deb` *and* the Chromium snap** —
  while H.264 is present in both. macOS/Windows have AAC. So `pickRecordingMime()`
  (`lib/recorder.ts`) walks `RECORDING_MIME_CANDIDATES` and takes the first supported entry:
  H.264+AAC first, H.264+Opus as the Linux fallback. **Never hardcode a mime string.**
  Each candidate is tried as **`avc3` before its `avc1` twin**: they are the same H.264
  bytestream, but `avc1` signals its parameter sets once, out-of-band, while `avc3`
  repeats them in-band on every keyframe. A resolution change mid-recording (a shared
  window resized, a camera switching mode) changes those parameter sets — under `avc1`
  every frame after the change decodes as garbage, under `avc3` it just decodes. The
  companion remux command (`sync-report.ts`) adds `-tag:v avc1` so the file an editor
  opens is always tagged `avc1`, whichever codec was actually recorded.
  Every candidate stays in the **MP4 container** on purpose — the host opens `guest_<id>.mp4`
  before the guest picks a codec, so a WebM fallback would put WebM bytes behind an `.mp4` name.
  Firefox can't record; Safari can't host, and a Safari guest is recorded as video only (no WAV);
  `recordCapability` and the lobby's browser notes say so before anyone records.
  WebM fallback was deliberately *not* added — WebM is a dead-end for video editors (no Final Cut
  import, flaky Premiere), and WebM→MP4 needs a lossy transcode.
- **Guest recording RAM is one timeslice, plus everything the host has not acked** — `sha256.ts`
  streams (incremental, O(1)) and `backup-recorder.ts` spills to OPFS, so the recorder itself holds
  one timeslice; but the retransmit buffer keeps every chunk that was not acked and reads no byte
  cap, and a backed-up DataChannel does not pause the recorder. The only bound is
  `STREAM_BACKLOG_CAP_BYTES` (256 MiB, `constants.ts`) checked in `ChunkSender.sendChunk`, after
  which that stream is abandoned and the guest's backup keeps the rest. A higher bitrate costs
  disk and upload, and fills that backlog sooner: about 85 s of a link that has stopped moving at
  the 4K preset's 25 Mbps, about 7 min at 1080p Standard (5 Mbps).
- `DiskFullError` surfaces as a `recordingError` **banner**, deliberately NOT `phase:'error'` —
  switching phase unmounts `CallStage`, which takes "End & save" with it, and that button is the
  only thing that closes the file handle. CallStage plays two short beeps and, if the tab is
  hidden and notifications are permitted, shows a system notification so the problem is noticed
  right away.
- Worker vitest `isolatedStorage:false` is intentional (SQLite DO + live WS hold SHM locks);
  reset DB state manually in tests.
- `@openmeet/protocol` resolves via tsconfig `paths` + vitest `alias` — breaking either breaks all
  consumers.
- **WAV master padding (`lib/pcm-recorder.ts`)**: `PcmRecorder` pads silence only for whole frames that
  both the jump in a frame's timestamp and the file's standing against the track's timestamps (`lagUs`)
  say are missing. The recorded track's timestamps do not drift against its samples; they step in
  render quanta, so a frame can be stamped up to 8 ms late and the next one early, and those steps
  cancel only when every gap is counted. A surplus is remembered for up to one second
  (`MAX_SURPLUS_FRAMES`). Silence added where nothing was missing is therefore bounded by the
  largest lateness the timestamps reach, so the WAV does not outgrow the take on a page that stalls.
- **Stable stream for mid-take device switching (`lib/switchable-media.ts`)**:
  Removing or adding a track on a `MediaStream` that a running `MediaRecorder` is recording throws
  `InvalidModificationError` and kills the take. Furthermore, Chrome's AAC MP4 muxer and our `PcmRecorder`
  (WAV master) lock their sample rate on the first frame, so switching directly to a mic with a different
  sample rate (e.g. 44.1 kHz, 24 kHz, or 16 kHz Bluetooth) would corrupt both files.
  To solve this, `useRoom.join` constructs `SwitchableMedia` which wraps the lobby stream into ONE stable
  output stream handed to the preview, PeerConnection, ChunkRecorder and the camera BackupRecorder,
  and a microphone-only stream (`micStream`) handed to the WAV master and its backup.
  It is skipped for companions AND producers, which join with no camera or mic (wrapping an empty
  stream would conjure a silent audio track). A lobby stream with a microphone and no camera is
  wrapped, and its stable stream holds the audio track alone: the video generator is left out,
  because a video track that never carries a frame would keep the other side's player silent.
  That person has no camera for the whole call, so `switchCamera` opens nothing while the
  stream has no video track and `CallStage` disables their camera button (`noCamera`).
  - Video is a persistent `MediaStreamTrackGenerator({ kind: 'video' })` fed via `MediaStreamTrackProcessor`;
    switching cameras cancels the old reader and pumps frames from the new camera without changing the stable
    video track ID or interrupting the recorder (with `avc3` carrying updated SPS/PPS across resolution changes).
    Real camera settings are delegated from the real track. A switched-to camera is asked for the
    frame rate the lobby camera was asked for (read once from that track's `getConstraints()`).
  - Audio is an `AudioContext` at 48 kHz (`WAV_SAMPLE_RATE`) recording one channel, or two when stereo
    was asked for at join and the microphone has two (`recordedChannels` in `lib/media.ts`),
    routing mic -> `MediaStreamAudioSourceNode` -> `MediaStreamAudioDestinationNode`; switching mics swaps
    the source node into the destination node, and Web Audio resamples smoothly with no track ID change.
    The same source feeds a second destination node with the same channel count, whose track is
    `micStream`: it carries the microphone and nothing else, follows a change of microphone the
    same way, and is switched off with the microphone. Without an audio graph (the fallback
    below) `micStream` is the stream itself.
    A switched-to microphone is asked for the echo cancellation the lobby microphone was asked
    for (read once from that track's `getConstraints()`, or from its settings when the browser
    gives no constraints back), so the lobby's answer holds for the whole call.
    When `SwitchableMedia` is given `onMicWarning` the mic source also feeds a `ChannelSplitterNode` and
    one `AnalyserNode` per channel, beside the path to the destination node and never in it; `watchMic`
    (`lib/mic-watch.ts`) polls them every 300 ms and reports `'silent'` once no channel has carried a
    sample above -80 dBFS for 10 s while the mic is on in the app (the raw track's `enabled`), reports
    `'clipping'` once three polls have seen a sample above 0.98 on any channel with no clean 10 s between
    them (0.98 is the level the lobby's `micCheck` uses, `MIC_CLIP_PEAK`), and `null` again when sound returns,
    the clipping clears or the mic is turned off; and the tap reads the microphone as it arrives, before the
    destination mixes channels.
  - **iOS Safari fallback**: where `MediaStreamTrackGenerator` is missing, raw tracks are kept directly,
    switching uses `PeerConnection.replaceCameraTrack` / `replaceAudioTrack` on senders (finding camera sender
    by current track to avoid colliding with screen share senders), and mid-take switching is refused with
    a "Switch after this take" prompt because iOS Safari cannot hot-swap tracks in MediaRecorder without breaking.
- **A `<video>` given a stream that lists a video track plays nothing, sound included, until that
  track's first frame.** When a connection is made while incoming video is stopped the track is
  taken out of the stream a few milliseconds after the tile was given it, and the frame never
  comes. `VideoTile` therefore listens for the stream's `removetrack` and gives the element the
  stream again while its `readyState` is still 0; an element that already plays is left alone,
  because loading it again would cut the sound.

---

## Known gaps

- **Screen share reconnect starts a new segment rather than appending to the old file.** Camera
  (and WAV) recording resumes into the same host files via `resume_query`. Screen share instead
  finishes the old segment on disconnect and starts a new numbered segment on the rebuilt
  connection, with each segment backed up locally in OPFS.
- **Taking the host seat over mid-take ends the first tab's files.** A second tab in the
  host's browser asks before it joins while a take is live. If the host joins there anyway,
  the new tab takes the host seat (4006 to the old one); the old tab keeps its phase and
  shows "Press End & save to keep this recording", but its files stop at the takeover, and
  the rest of each guest's part exists only in that guest's backup. The new tab records
  only from its own new take. The old tab opens no socket
  again, so it does not take the seat back. After its End & save it still shows the
  summary and offers **Record another take**, which would record that tab alone: nothing
  it sends reaches the room, and Leave call is the way on.
- **A guest whose tab the room closed during a take waits after Stop and save.** When a
  copy of the tab took its place (4006), or the room refused it after a reconnect (4001),
  the other people have closed their side of each connection. The save waits up to 30 s
  for a drain that cannot finish, then reads "Some of your recording may not have reached
  the host" with the backup links, and a connection warning can show below it. The backup
  holds all of it.
- **A screen share that is running when the host reloads is not recorded again until it is
  restarted.** Its channel arrived while no take was running and nothing binds it; the host is
  told whose share it is after the resume. The part before the reload is put back from the crash
  copy. The host's own screen, if it was presenting, is likewise recorded only from the next
  share, and the lobby's Save does not copy the host's own screen backup into the folder.
- **A screen recording that finished before a reload reads as rebuilt and as ended early.** The
  crash cut the take, so no finish signal for it was kept; the file itself is whole when the
  guest had stopped that share.
- **The host's own camera file from before a reload can end a few seconds early.** It is copied
  from the host's backup, which is written in two-second pieces, and it is listed as recorded on
  this computer; the audio master beside it runs to the reload.
- **A guest is not told that its running screen share is not being recorded after a resume;**
  only the host has that line. After a resume the host's timer starts again from 0:00.
- **After a save or a delete from the lobby the guests are stopped only when the host joins.**
  The lobby has no connection to the room, so until then a guest still reads that the host can
  resume, and keeps recording into its own backup.
- **Call-audio copies from before a reload are not listed in a resumed take's report.** The copy
  after the resume takes a new file name; the earlier file stays in the folder as the crash left it.
- **A file whose crash copy stopped on a commit that never answered still looks resumable.** Only
  a journal that gave up as a whole is marked; that file's guest was acknowledged from the folder
  write after the stop, so a resume of it cannot continue past the crash copy's end.
- **A crash copy can only be reached from the lobby of its own room.** If the room has expired
  the copy stays in browser storage until the site's data is cleared.
- **For a moment after Record, a lobby in another tab can remove an empty crash copy.** The take
  lock is held from the recording phase, and the copy's directory is created just before it; the
  take then says its crash protection stopped.
- **A flood of markers from other participants can keep the host's later markers out of the crash
  copy.** The notes hold at most `MAX_RELAYED_MARKERS` markers in all; the live take's own list is
  not affected, only what a resume or a save after a crash reads back.
- **A sharer who rejoins gets a new share of the screen entries in the crash copy.** The count of
  12 is kept per connection; the take's 48 still holds.
- **With several guests in the room, none is told when the host drops.** The "keep this tab
  open, the host can resume" line is shown to a guest left alone; with others still present the
  call simply continues, and their recordings carry on for a resume all the same.
- **Resume copies each guest file once more.** The folder's bytes are carried into the reopened
  file and the crash copy is replayed over them, so a long take takes a while to resume and needs
  the file's size free on the disk.
- **A resumed take's own track is two files, and openMeet does not join them.** The pre-crash part
  is recovered from the take's backup and the rest is written to `host_<id>_resumed.*`; both are
  listed with their offsets in `hostParts` and `aligned`, and an editor places them itself.
- **Media board opened mid-take, microphone off:** what a pad plays while the microphone is off
  is not in that take's MP4 or backup, because the track that take records is switched off with
  the microphone: a pad fired then, and the stretch of a looping pad that was already playing.
  A host's mute is the same switch and does the same.
  It still plays live and drops its chapter marker, and takes started later record it either
  way. In that take a pad has the take's channel count, so a stereo pad is mono unless stereo
  was chosen at join; and where there is no stable stream (`isFallback`) that take has no pad
  audio at all. The WAV master is mic-only by design.
- **The media board is empty after a reload.** Pads are held in memory, so a pad that was
  looping stops when the tab reloads and the files have to be added again. A board opened
  after **Resume recording** is opened mid-take: its pads are recorded in
  `host_<id>_resumed.mp4`, under the limits of the gap above.
- **A looping pad cannot be stopped from the waiting room.** When everyone else leaves and
  the tab shows "Everyone else left", there is no media board on screen; the pad plays on
  until someone joins and the call is back, or until Leave.
- **A level set in Levels is forgotten when its person reconnects, and on a reload.** It is
  kept by `peerId` in the call screen, and the Room gives a returning connection a new id, so
  that person plays at full volume again. A fader only turns a person down from full volume,
  and the sound of a shared screen or a presented video has no fader.
- **M does not mark a moment while a fader or a list has the keyboard.** The marker keys skip
  every `<input>` and every `<select>`, as they do the teleprompter's sliders; a list takes a
  typed letter to choose an option. The bookmark button still marks.
- **A level meter is drawn only while Levels is open.** It shows what arrives, so it does not
  move with the fader, and it has one colour: nothing marks a person who is clipping.
- **A ready sound plays at the level it was made at.** A pad has no volume of its own: Chime
  and Rimshot peak at about 0.4 of full scale and Soft bed at about 0.13, mixed over the
  voice. Like every pad, a ready sound is gone from the board after a reload and is added
  again with one click.
- **Nothing bounds the number of ready sounds a site lists.** Each shipped recording is one
  more button in `SOUND_FILES`. Once the board holds a pad the row scrolls with the pads. On
  an empty board on a phone about three buttons fit on a line and every further line makes
  the open board about 52 px taller; from the fourth line on it is taller than a full board
  of pads and can reach the top status bar.
- **A ready sound added twice.** A shipped recording is downloaded when its button is
  clicked. If the media board is closed and opened again before the download ends, the
  board offers that button again and does not show the new pad until it is opened once
  more or something else is added; a click in between adds the sound a second time.
- **A guest's offset is null when none of its clock-sync pings was answered before its
  recording ended:** the host never recorded while that guest did, or no answer came back
  within 1.5 s (`perPingTimeoutMs`) on a slow link. `sync.json` then says to align by
  waveform. An estimate that was sent into a connection as it dropped is not sent again.
- **A guest whose clock was seen set back before its first estimate has a null offset.**
  Its browser takes no estimate for the rest of that recording, because none would place
  the start it read earlier, and `sync.json` says to align by waveform. A new take
  measures afresh.
- **A computer clock that is set before a guest's first estimate can shift that guest's
  offsets by the size of the change.** A guest's start is read from `Date.now()` and placed
  on the host's clock by an estimate taken later, and the host's start is read the same
  way. A guest's page sees its own clock set back only when that happens between a ping
  and its answer. Set at any other moment after that computer's recording started and
  before the estimate, forward or back, a clock shifts that guest's offsets, and nothing
  in `sync.json` shows it: align by waveform a clip that sits wrong by a second or more.
  A clock set between a guest's two estimates does not move the offset of that guest's
  camera file and WAV.
- **A participant who rejoins gets a new id and a new share of the call-copy files,**
  so the take-wide limit can still be reached that way.
- Anyone with a room's invite link can mint short-lived TURN credentials
  (rate-limited to 20 per minute per IP) — the invite link is the only
  credential, so share it only with participants.
- A guest that leaves and rejoins gets a new `peerId` and so a fresh key allowance, so a
  determined guest can still use up the take's slots; a guest who reloads or joins late can
  then be refused, and their recording is kept only in that guest's own backup.
- Guest screen-share channels are not bounded per guest: each segment a guest opens becomes
  a file in the host's folder.
- **A returned backup is not held back during a take.** The host does not pause an incoming
  transfer while it records; a recorded guest's own tab waits, and a sender that does not wait
  makes the host write while it records.
- **A camera file can hold less than the bitrate its level names.** `cameraVideoBps` is what
  `MediaRecorder` is asked for, and `MediaRecorder` takes no frame rate. Chrome's software H.264
  encoder (the only one on Linux) gives each frame the asked figure divided by 60, so a file
  reaches the figure only at 60 fps: about half of it at 30 fps and 40% at 24 fps, measured on
  Chrome for Linux with a bare `MediaRecorder` as well as in the app. The levels keep their ratio
  (1 : 1.5 : 2). The lobby names the figure as "up to", and its size figures use it, so they
  overstate there. Not measured on macOS, Windows or a hardware encoder; asking for more to make
  up for it would double the files wherever the encoder does use the real frame rate.
- **After a reload the host's own files of the resumed part carry no name.** They are
  `host_<id>_resumed.*`; the part before the reload keeps the name it was written under, and both
  are listed in `hostParts`.
- **50 and 60 fps were checked with test cameras only.** No take from a real camera running at
  50 or 60 fps has been inspected (`MANUAL-TESTING.md` row 8.19). A camera that stops at 30 fps is
  never offered them.
- **A take saved from the lobby after a crash still lists the first guest's camera file when no
  guest was recorded.** The crash copy notes that file at Record; the save reports it as failed,
  nothing committed.
- **A take saved from the lobby after a crash holds what a guest sent before they were set as not
  recorded.** The lobby has no connection to the room; it rebuilds what the crash copy holds.
- **A guest whose browser blocks session storage is forgotten on a reload.** The Room remembers a
  guest set as not recorded by the tab's id, which lives in session storage (`lib/client-id.ts`);
  without it every reload is a new id, so the guest arrives as recorded and the host sets them
  again.
- **After a host reload the Room would accept a change to who is recorded while guests still
  capture the interrupted take.** Its `recording` flag is cleared when the last host socket
  leaves. The call screen does not offer the control while that take can still be resumed or saved
  (`resumeOffer`), so the host's page never sends it then. If the setting does arrive while a
  guest's browser is capturing, that capture ends there, as on the host's stop.
- **After a host reload a guest can read "Sent to the host." for a part the host never wrote.**
  Once the host is back but has not resumed, the guest's stream leaves its browser into a channel
  nothing reads yet. If the host then saves instead of resuming, the guest's page counts those
  bytes as sent. The host's summary says that file ended early, and the guest's own backup holds
  all of it.
- **A presented video keeps sounding while its presenter waits alone.** When everyone
  else leaves and the tab shows "Everyone else left", there is no Stop presenting on
  screen; on a computer the clip is heard until someone joins and the call is back, or
  until Leave.
- **Nobody is told that a participant has stopped incoming video.** The others still see
  that person's camera and get no sign that their own picture, or a screen they present, is
  not being watched. The choice is not remembered: a reload or a rejoin starts with video
  on. A producer and a Present-only device have no camera menu and so no such control.
  When everyone else leaves, the waiting screen says nothing about the mode; it is kept,
  and the line returns with the call.
- **A sender does not spend more on the people who still watch.** `sendEncoding` divides the
  live budget by everyone in the room, including a person who has stopped incoming video.
- **The producer and Present-only links are offered only to the host, in the waiting
  room and in the call's top bar before a take.** The lobby and the take summary offer
  the plain invite link alone, and during a take and after one the top bar has neither.
  Each is still the invite link plus `?producer=1` or `?present=1`.
- **A speaker that goes away, or that the browser refuses, is forgotten.** The call goes
  back to the system default at once, and plugging the device in again does not bring the
  choice back. A producer joins without microphone permission; a browser that refuses a
  remembered speaker for that reason forgets it for the next call as well.
- **The two warning beeps of a recording problem play on the system default output,**
  whatever speaker is chosen.
- **A pad, and a video heard by the person who presents it, reach that person through one
  more buffer than they reach the call.** An element fed from the audio graph plays them,
  so they follow the chosen speaker and the graph never depends on an output device. The
  delay on that one device was not measured.
- **A producer has no speaker picker.** It has no microphone menu, and without microphone
  permission the browser names no outputs. It hears the call on the system default, or on a
  speaker chosen earlier in the same browser. A Present-only device plays no call sound.
- **The lobby has no test sound for the speaker, and reads its list once.** The choice is
  first heard when someone speaks in the call, where the microphone menu can change it; an
  output plugged in while the lobby is open is listed after a reload.
- **Two tabs do not share a change of speaker while both are open.** Each reads the stored
  choice when it loads.
- **A marker or a note from a guest is lost while the host is not recording.** The host places
  every marker when it arrives and has no take to place it on after a reload and before
  **Resume recording**, or once it has dropped. One sent while that guest's own connection to
  the Room is down is lost too (`SignalClient.send` drops it). The guest's own count still rises.
- **A guest's note reaches every browser in the call.** It is a marker's `label`, and the Room
  passes a `marker` on to everyone else, as it does chat, and keeps nothing. Only the host's
  page keeps the note and no page shows it during the call. The host's own notes never leave
  its browser.
- **A note that is still being typed when the take ends is dropped.** The field closes with the
  take and nothing is marked before Enter. A reload of the page loses it the same way.
- **A producer, and a guest whose browser cannot record, have no marker controls.** The marker
  button, the note button and both keys are there only while this tab's own capture runs.
- **A guest's note is placed when it reaches the host, not when the guest began typing.** The
  host's own note is placed at the moment its field opened. A guest's clock is not trusted and
  the `marker` message carries no time, so a guest's note sits a few seconds after its moment.
- **A check link works only while its room does, and it is the invite link.** The checks
  run against the room, so an expired room shows "Room not found or expired"; opening a
  check link joins nothing and so does not extend the room's 30 days. Without `?check=1`
  it is the invite link, so it is exactly as private. The page starts on the browser's
  default camera and microphone, like the lobby, and no device choice is remembered for
  the day of the call.
- **Echo cancellation can only be chosen in the lobby.** The call has no control for it, and
  the host cannot switch it for a guest. A person who wants it on or off leaves and joins
  again, which ends their part of a running take.
- **Echo cancellation was checked with test microphones only.** No take from a person on real
  speakers has been listened to (`MANUAL-TESTING.md`, the echo cancellation row in section 8).
  Whether the browser still delivers two channels with it on is read from the microphone, not
  assumed: Stereo is offered only when the microphone reports two.
- **The lobby answer goes to every tab in the room.** Only the host's page shows it, on the
  name tag; the Room relays `recording-capability` to everyone, as it does the browser notes.
- **The answer on a name tag can be cut off.** A name tag truncates in a small tile; the whole
  text is in its tooltip. A guest on speakers gets no line of their own.
- **A take saved from its crash copy does not say whose audio was echo-cancelled.** The lobby's
  Save to folder and the call's Save what was recorded rebuild the report from the crash copy,
  which holds no such note. The files are the same; only the mark is missing.
- **After a resume, files from before the reload can miss the echo-cancellation mark.** The
  reloaded page knows only what was announced to it since: the host's own first file is never
  marked, and neither are the files of a guest who left before the reload.
- **The echo-cancellation mark does not reach a guest's own backup or the call-audio copy.**
  Both hold the same processed audio; the note in `sync.json` says so in words, and a returned
  backup's own `.json` does not mention it.
- **A script is sent once, to the people in the room at that moment.** Someone who joins
  afterwards is not sent it, and an offer nobody answered does not survive a reload of that
  person's page. The host sends it again, and everyone else is offered it again, also those
  who already used or ignored it. The host is not told who used it.
- **Using the host's script replaces the person's own for that room, with no way back.** The
  offer says so before the click, and shows the reading time but not the text. The reading
  time counts words by spaces, so a script in a language written without them reads as about
  a minute.
- **A take recorded alone is not listed as Unsaved recording after a crash.** The crash
  copy holds guests' bytes and writes its notes only with them, so with no guest its
  directory stays empty and the next lobby removes it. The host's own camera file and WAV
  master are listed there under Backups on this device. After a reload the folder's own
  `host…wav` keeps the placeholder header a closing page leaves, and nothing repairs it.
- **A guest who joins a take that is already running sees no countdown,** only the notice
  and the REC pill, and is recorded from that moment. The host cannot set that guest as
  not recorded until the take ends.
- **A host recording alone whose connection to the room drops is, for the Room, a room
  that emptied.** The session ends there, so the guests the host had set as not recorded
  are forgotten, as when everyone leaves.
- **Continue alone is not remembered.** After a reload the host is in the waiting room
  again, and the call screen is one press away.
- **The done screen has no Copy invite link.** The summary's main button records the next
  take whether or not anyone else is in the room; the address in the address bar is the
  invite link.
- **A guest who joined a running take a moment before the host's connection came back can
  get two files.** It learns the take's id from the host's first acknowledgement; announced
  again before that, the take looks new to it, so it ends its file and starts another.
- **While the host's connection to the room is down, a guest who joins is not recorded.**
  The Room has no host to ask; the guest is started when the host is back.
- **The shortcut keys are fixed and exist only on the call screen.**
  A bare letter is read as the keyboard layout types it, so a layout without Latin letters has
  no A, V, C, T, M or N. A letter typed while no field has focus is a key press: text typed
  after clicking outside the chat field switches the microphone and the camera. No key works
  while any input has focus, a teleprompter slider included. The waiting room has no keys.
  Below 640 px the **?** button and its list are not shown, and a key that presses a button
  does nothing while chat or the summary covers the control bar.
- **In a call on a window narrower than 640 px the single keys cannot be turned off or on.**
  The list is not shown there; the other tick box is in the lobby, a Leave and a Rejoin away.
  The list's tick box is an input, so right after it is ticked no key works until the keyboard
  leaves it (Escape closes the list). Two tabs do not share a change while both are open: each
  reads the stored choice when it loads. In a browser that blocks storage the choice lasts
  until the page is reloaded, so one made in the lobby holds for that call.
- **On a keyboard without Latin letters, Alt+R and Alt+S are the keys where QWERTY has R and
  S.** A desktop or a browser that takes one of the chords for itself never passes it to the
  page. A guest's "Stop and save" has no key.
- **Alt+R and Alt+S have not been run on a Mac.** They rely on Option+R and Option+S reaching
  the page with the key codes of R and S (`MANUAL-TESTING.md` rows 8.44 and 8.45).
- **A removed participant can come back in another tab.** The Room remembers the tab's id
  (`lib/client-id.ts`, session storage), and the invite link is still the only credential: a new
  tab, a private window or another browser is a new id, a client that sends no id is closed but
  cannot be remembered, and a browser that blocks session storage sends a new id on every load,
  so that tab gets back in by reloading. The list is the session's: when the last person leaves,
  or a host who is alone in the room reloads, it is emptied and the removed tab can join again.
- **A mute is a request.** The Room passes it on and the muted person's own page carries it out;
  a page that does not know the message, or was changed to ignore it, stays unmuted. Removal is
  what the Room enforces.
- **A host's mute turns off a microphone and nothing else.** That person's media board pads and
  the sound of a video they present keep playing, in the call and in their files; the host can
  ask, or remove them. A mute is not remembered either: after the muted person reloads, their
  microphone is as their lobby left it.
  The one exception is a take that was already running when that person first opened the
  media board: what a pad plays while they are muted is not in that take's MP4 or backup.
- **A person muted while their page still reads "Connecting…" sees the mic button there as
  on.** The waiting view keeps its own switch. The call screen shows it off, with the note, as
  soon as it appears, and one press there turns it back on.
- **A participant removed during a take keeps recording in their own browser.** Their page holds
  the call screen, as for any terminal close during a take, and says "The host removed you from
  this call. Press Stop and save my recording to keep this recording."; until they press it, or
  Leave, their camera and microphone go on into their own backup and nothing more reaches the
  host. On the host their files end at the removal and read incomplete (no finish signal), and
  End & save does not wait for them. A capture that had started but not yet reached the host
  is ended for them instead, and they get the removed screen; its backup is in their browser.
- **A removed participant who presses Leave call instead of Stop and save reads "You left
  the call".** The take is saved the same way and that screen offers the backup, but its
  **Rejoin** is refused: joining again from that tab ends on "The host removed you from
  this call".
- **A backup a removed participant was sending back stays stalled on the host.** The
  removed person still has it, listed in every lobby.
- **While a removed participant's save runs, the notice reads "Sending your last few
  seconds to the host."** Nothing is sent or waited for: the recorders and the backup
  stop, which takes a moment, and the removed screen follows.
- **A present-only device removed during a take gets no download link.** It has no camera
  backup. The backup of the screen it was presenting stays in that browser, and its lobby
  lists it.
- **Nobody else is told why a person left.** A removal reaches the other participants as an
  ordinary `peer-left`; its `reason` is `removed`, and no page reads it.
- **The People panel exists on the call screen only.** A host whose page still reads
  "Connecting…" cannot mute or remove the person it is connecting to, and a removal cannot be
  undone from the panel: the removed person opens the link in a new tab.
- **After a host reload the rundown has lost its place.** **Resume recording** brings back the
  take's markers, not the segment that was running: the strip is hidden and, shown, reads
  "Rundown not started" until the host chooses the segment the show had reached in the list
  beside the button and starts it. That start is one more marker with the segment's name,
  and the segment's clock counts from it.
- **A rundown is started by hand.** A take does not start its first segment, so that
  segment's marker is where the host pressed **Start**, and the chapter list opens with
  `0:00 Start` before it when the press came a second or more into the take.
- **A rundown cannot be changed during a take.** The editor is there between takes only, and
  only in the call: the lobby and the waiting room have none, so a host alone in the room
  cannot write one until someone else has joined. When everyone else leaves between takes
  and someone joins again, the strip is hidden; the text is kept.
- **The rundown is the host's alone, in one browser.** Guests and producers have none and
  never see the host's, and a host whose browser cannot record has none. It is in no file
  except as chapter markers. Another browser starts empty, a second tab of the same room
  reads it once, when its call screen opens, and a room's rundown stays in the browser
  after the room has expired, until the site's data is cleared.
- **The rundown times one segment at a time.** Nothing adds the segments up against the take's
  own clock, and a segment that runs over is said only in the strip, while it is shown: there
  is no sound and no notice. A length is written as minutes and seconds (`2:00`); written
  another way (`2 min`) it stays part of the segment's name, and one of an hour or more is
  shown with hours (`90:00` reads `1:30:00`). After a host reload the clock of the segment
  the host goes on with counts from the press that started it again, not from where that
  segment began.
- **Pop out floats one person, and never a shared screen.** The browser gives a page one
  such window: popping out a second person moves it. A screen someone presents has no item.
- **The popped-out window is the bare picture.** It has no name tag and no mic badge, and
  it does not show the initial a tile shows while that person's camera is off.
- **Someone who presents their entire screen shows the popped-out window too.** It lies on
  top of everything on that screen, so the call sees it and it is in that screen recording,
  a guest set as not recorded included. A shared tab or window does not contain it.
- **Pop out is not offered on a phone, to a producer or to a present-only device.** After
  a reload nobody is popped out, and the item is clicked again.
- **A popped-out window closes when its person reconnects, and is not opened again.** It
  holds that connection's stream, a rebuilt connection has a new one, and the browser
  opens such a window only on a click. The line about a window that did not open stays
  until the next pop out or the next camera or microphone switch.
- **The framing guide divides the preview, which is not always the whole picture.** The
  lobby preview is a 16:9 box that crops any other shape, so with a camera that gives 4:3
  the recording has a little more above and below than the lines show. The guide is not
  offered on a phone, is not remembered from one visit to the next, and the call has none.
- **A calendar entry is offered only in the host's lobby.** The waiting room and the call have
  no **Add to calendar**, and a host in a browser without the room's host token is a guest
  there. The entry is one hour long with a fixed title and text; the calendar that opens it
  can change them. A start in the past is accepted.
- **The room knows nothing of a calendar entry.** It shows no countdown and sends no reminder.
  The entry holds the invite link, so whoever can read the calendar can join the room, and
  **Open in Google Calendar** hands that link to Google. Opened from a calendar in another
  browser on the day, the link makes the host a guest with no Record button: the host token
  is only in the browser that made the room, which the panel says.
- **A session more than 30 days ahead cannot be put in a calendar from the lobby.** The entry
  is refused by the room's closing time as it stands, and a join only moves that to 30 days
  from the join. The host makes the entry within 30 days of the session, after joining the
  room once if it was last used longer ago than that.
- **A phone held upright has no Raise hand button.** With a take running, a recorded
  person's control bar there has no room for one more button without a third row, so the
  button is shown from 640 px of width up: on a computer and on a phone turned on its side.
  A narrower window still shows every raised hand. A hand raised in a wide window keeps its
  button when the window gets narrower, so that it can be lowered; during a take Leave is
  then on a third row until it is. A producer and a Present-only device have no button at
  any width: they have no tile to show it on.
- **A raised hand stays up until its owner lowers it.** Nobody else can lower it, speaking
  does not, and it is still up when the call comes back after everyone else left. A reload
  lowers it. Hands are not kept in order: the tiles show who, not who was first.
- **While a screen is presented in a window narrower than 768 px only the first other
  person has a tile,** so another person's raised hand is not on screen there. A screen
  reader still reads it out.
- **A reaction is not read out by a screen reader,** and it is drawn only on a tile. A
  producer and a Present-only device have no tile and no reactions menu, and a window
  narrower than 640 px (a phone held upright) has no menu either; it still shows the others'
  reactions. A person whose own tile is not on screen (a screen is presented in a window
  narrower than 768 px) sees nothing of a reaction they send.
- **A reaction sent while the sender's connection to the Room is down is lost.** It shows on
  the sender's own tile and reaches nobody else (`SignalClient.send` drops it), and nothing
  tells the sender. The same holds against a Worker deployed before reactions: it ignores
  the message.
- **The Room passes on every reaction it is sent.** The limit of one a second from one
  sender is kept by each page that receives them, as the limits on chat and markers are.
- **After an interruption the record of who was told keeps no times from before it.** The
  log is held in memory. A resumed take's `recordingNotice` starts at the resume and
  lists, under `fromCrashCopy`, the guests whose camera note in the crash copy carries a
  channel key; a take saved from its crash copy has only that list. A producer, a
  Present-only device or a guest set as not recorded who was there before the
  interruption and gone by the resume is in neither, and a guest whose camera file has
  parts but no note is not listed. A guest whose note had no key yet when the take was
  interrupted (the last seconds before it) is not listed either, and a resume does not
  take up that guest's waiting channel, so their line reads `confirmedAtMs: null`.
- **Only a recording channel shows that a page was told.** A producer, a Present-only
  device that is not presenting, a guest set as not recorded and a guest whose browser
  cannot record open none, so their lines in `recordingNotice` never get a
  `confirmedAtMs`. No acknowledgement is sent for them, and nothing shows that a person
  read the notice.
- **A person who reconnects has one line per connection in `recordingNotice`.** The Room
  gives a returning connection a new id and the record does not join the two. A take
  keeps 64 lines; past that it says `capped` and later connections have none.
- **A file sent from chat is judged by its name.** `lib/shared-file.ts` lists the extensions
  that may be sent and the host's page writes no other, but the bytes are not looked at: a
  file of a listed type can still be harmful to the program that opens it.
- **Only the host can be sent a file.** There is no way to send one to a guest, or from the
  host to anyone.
- **A file's sender cannot take the offer back,** and the host cannot stop one participant
  from offering again after **Not now**. The file's name and size are all that leaves the
  sender's device before **Save to folder**, and at most eight offers from one participant
  wait at a time.
- **The host is not asked about a file while its take records or saves.** The question
  appears when the take has ended. A file accepted before Record goes on arriving during the
  take when its sender's page records nothing (a producer, a guest set as not recorded, a
  guest whose browser cannot record), 100 MB at most; a sender whose page records, a guest's
  Present-only device included, waits for the take to end.
- **A file that was arriving when the host reloads is lost.** Its sender reads that the host
  did not save it, and sends it again. If the browser was killed before the page could end
  the file, an empty file of that name can stay in the folder.
- **A file sent from chat is in no take.** It is not listed in the session summary, the sync
  file or the chat log, and the crash copy holds none of it.
- **A sender who waits alone is told nothing of a file that is still offered.** Neither
  "Everyone else left" nor the waiting screen has a line for it. The offer is kept and
  reaches the host when the host is back.
- **A private message is not confirmed as delivered.** The sender's line appears the moment it
  is sent. If the other person left in that instant, if this tab's socket was down, or if the
  Worker or the other page is older than private messages, nobody receives it and nothing says
  so.
- **A private message is kept from the other people in the call, not from the signalling
  server or from a shared screen.** It passes through the Worker like every chat line, relayed
  and never stored. Its pop-up shows its text, so someone who shares their whole screen, or the
  window the call is in, shows it to the call, and a recording of that screen holds it. The
  chat file never does.
- **A person who reconnects has to be chosen again.** The Room gives a reconnecting tab a new
  id, so the chat panel says the person left or reconnected and sends nothing until someone is
  chosen. Under **To** a person reads as the page's own words and a number, `Guest 2`; someone who
  comes back gets a number nobody had, never another person's number, and a present-only device
  is not listed.
- **A private message that arrives while chat is open does not move To.** An answer goes where
  **To** says, to everyone if nobody is chosen. And chat opened on Everyone is addressed to the
  sender of the newest private message that arrived while chat was closed, if that person is
  still in the call; a person already chosen is not replaced. That also holds when a message for
  everyone arrived after the private one: an answer goes to that person alone until **To** is
  changed.
- **A number under To is this page's own.** `Guest 2` on one person's screen is not `Guest 2` on
  another's, and a person who reconnects gets a new number. A display name is still its owner's
  text and can say anything; the words before it are the page's, and they are the ones to trust.
- **A pause is a take boundary, not a gap in a file.** Pause takes the few seconds End &
  save takes, and Continue starts take n+1 after the countdown: one set of files and one
  sync file per part. `timeline.hostStartUnixMs` in each sync file places the parts on
  one timeline; nothing joins them.
- **Only the host's page says Paused.** A guest sees what follows any take: the Recording
  mark goes, then "Sent to the host." and the backup links, then the countdown and the
  notice when the host continues. The word is kept in the call screen: after a reload the
  host's button reads Record, and the next take's files carry no `_take<n>`. When the
  next take does not start, Record goes on reading Continue until one records.
  A guest whose page did not get the stop (its connection to the Room was down at that moment)
  keeps capturing into its own backup and reads Recording until the next take starts, as after
  End & save. In a tab that lost the host seat during its take, Pause saves that tab's files
  and Continue would record that tab alone.
- **Two buttons read Pause while a host's teleprompter scrolls.** The teleprompter's
  stops the script; the control bar's ends the take.
- **The rundown starts over after a pause,** as after every take: the host chooses the
  segment the show had reached in the list beside the button and starts it, which marks
  it in the new take.
- **Pause has no key.** Alt+S presses End & save, which saves the take the same way.
- **A guest whose first clock estimate arrives after a resume loses it if the host's
  browser closes again.** The receivers a resume builds do not write to the crash copy's
  notes, so a save after that second crash says to align that guest by waveform. A crash
  copy never holds a second estimate either: a take saved from one has no `end` in `clock`.
- **A real loss can be filled one frame short.** A gap is measured against the frame before it, and
  that frame's own timestamp can be up to 8 ms late. Measured in Chrome, 30 stalls that each lost 5
  frames got 135 of 150 frames of silence, so after many stalls the WAV is a little shorter than the
  MP4.
- **Where a track's timestamps run steadily early against its samples, real gaps go unfilled for a
  while.** The track the app records from showed no such drift. Where it happens, the surplus that
  builds up absorbs real gaps until it is used up, a second at most.
- **openMeet records no FLAC.** A FLAC copy of a WAV master is made afterwards, with the
  `ffmpeg` commands in the sync file, by whoever has the folder. A take still needs the
  WAV's full size on the host's disk and in each guest's upload while it records (24-bit
  at 48 kHz: about 520 MB an hour for a mono master, twice that in stereo). Nothing
  deletes a WAV; the person does, after the check.
- **A WAV that reads Empty still has FLAC commands.** As with its pairing command, the
  report lists them for every audio master it names. A WAV that holds only its header
  gives a FLAC with no samples and a check that prints two equal MD5 lines, those of no
  audio; `ffmpeg` says the file is missing only for a name that is not in the folder.
- **A WAV backup a participant downloads has no FLAC command on their screen.** Their
  page gives the file; the two commands are in the README.
- **A returned backup's two commands are only in its `.json` note.** There the quotes are
  escaped, and no screen shows the commands with a copy button.
- **A WAV cut off after it passed 4 GiB still makes `ffmpeg` print an error.** Its two
  size fields are 32 bits and cannot hold its length, so they declare the most they can
  hold, more than the file has, and the FLAC commands, like any other command on that
  file, report it.
- **Microphone only is not remembered.** A person with no camera presses it on every
  visit. While it is pressed the lobby's storage and folder figures still count a camera
  file, so they overstate what that person's recording needs. A person whose camera
  never started gets no Speaker row in the lobby after pressing it; the call's microphone
  menu has one.
- **A person who joined with the microphone only cannot turn a camera on in that call.**
  A running recorder cannot be given a video track, so the stream keeps the shape it was
  joined with. They leave and join again with a camera. The host is not told before a take
  that such a person has no camera: their tile shows an initial, as it does for a camera
  that is turned off. On a computer the others' camera menu still lists **Pop out** for
  that person; choosing it opens no window and shows the line about a window that did not
  open.
- **A file recorded with no camera sits in the camera file's place.** The health panel
  lists it as "Camera", a returned backup of it is named `…_camera_…`, the page shown after
  leaving calls its backup "Backup video", and a take saved from the lobby after a crash
  lists it as a camera file. Each is an MP4 that holds sound and no picture.
- **A guest with no camera whose browser cannot record a WAV master** (Safari) is recorded
  as that MP4 alone, plus the host's call-audio copy. Not tested: recording is
  Chromium-only.
- **A take saved from the lobby after a crash, and the host's own part from before a
  reload, list a file recorded with no camera as a camera file.** Neither has the file
  check that says otherwise, so the sync file of a take saved from the lobby still prints
  a pairing command for such a file, which `ffmpeg` refuses (the file has no video
  stream). The aligned-copy command for such a file is labelled "aligned copy of the
  video", because the label follows the file check, which these takes lack; the command
  itself works on it. A file whose check says it has no picture is labelled "aligned copy
  of the audio".
- **A guest's file recorded with no camera is named as audio only only when that guest's
  take finished cleanly.** The guest says so in its finish message. A guest that left
  early, that the host removed, whose stream was abandoned, or whose take was saved from
  the lobby after a crash never sent it, and its file is listed as a camera file. It is
  the guest's own word: a guest that says it for a file with a picture gets that one file
  listed as audio only.
- **A backup is offered by itself only after the host's stop.** A guest who leaves during a
  take, whose tab the room closed, or whose take a new take ended, keeps the backup in its
  lobby, with **Send to host**. A backup of which no chunk reached the disk (browser
  storage unavailable, or a directory that took none) is in memory only and is not in the
  lobby: the done line sends the guest to the download link and does not say to rejoin. The
  end of a take says only whether the camera and the WAV arrived: a screen recording that
  fell behind while those two arrived is not offered, and neither is a present-only
  device's. A guest the host set as not recorded offers nothing.
- **A backup offered after a take travels on the uplink the call is on.** It starts when
  the host presses **Save to folder**, waits while this guest's next take records, and is
  the whole take again, also when only its last seconds were missing on the host.
- **A guest with more than eight offers waiting is turned away.** After several takes the
  host has not answered, the next take's backups are refused and the guest reads that the
  backup was not saved on the host's computer; they stay listed in that guest's lobby.
- **A take sent later leaves the host with nothing of that guest until the backup is
  saved.** The host's `guest…mp4` and `.wav` for that guest stay in the folder empty (or end
  where the switch was turned on) and read Empty or Incomplete in the summary and the sync
  file, with the advice to ask for the backup. The whole take is the returned backup,
  `backup_<name>_…`, which the sync file does not list and whose own `.json` says to align
  it by waveform; the call-audio copy of that guest is on the host's timeline. If the guest
  leaves or closes the tab before the host has saved it, or the host answers **Not now**,
  the backup is only in that guest's lobby. If browser storage fails during such a take,
  the backup goes on in memory under the existing warning, and from there on that guest's
  camera and WAV are held nowhere else. A screen recording of such a take is held in memory
  the same way, with the same warning: until the host has saved the offer, closing the tab
  loses it.
- **No page offers a download of a screen backup that is held in memory only.** The done line
  has links for the camera and the WAV backup, and the lobby lists only backups on disk, so a
  screen backup whose storage was refused or did not answer is lost when the tab closes.
- **When every guest sends later, a host reload leaves no take to resume.** The crash copy
  writes its notes with the guests' bytes, and none arrived, so the host is offered neither
  **Unsaved recording** nor **Resume recording**. When the host is back the guests' pages
  stop by themselves and offer their backups, and the host's own camera and WAV from before
  the reload are in its lobby under **Backups on this device**. With one streamed guest, or
  a switch turned on during the take, the take resumes as usual.
- **Turned on during a take, Send my recording later does not call back what the browser
  already holds.** Up to 16 MiB a channel was handed to the browser before the switch and
  still goes out, and the host writes it.
- **Send my recording later is the guest's alone and is not remembered.** The host is not
  asked, and is told only by its track panel ("Stopped. Their backup has the rest."). A
  reload or a rejoin starts with it off, and a guest who reloads during a take is streamed
  again from there. A present-only device has no camera menu and so no switch, and neither
  has the waiting room: the choice is kept while a guest waits alone and its line is back
  with the call.
- **A take sent later is still encoded twice.** The recorder that feeds the stream keeps
  running with its output dropped, so the switch spares the connection, not the processor.
- **The host's track panel can misread a screen share of a take sent later.** The share's
  stop is said once, as soon as its backup's storage has answered, which can be before
  the host is reading its channel, and is not said again: the row then reads "Not
  receiving for …" instead of "Stopped. Their backup has the rest." No file is affected.
- **The summary does not say that a guest chose to send later.** That guest's rows read
  "Incomplete. The upload from <name> stopped before the end, so this file ends early. Their
  backup has the rest.", which is true of a stream that fell behind as well as of one kept
  back, so the two are not told apart.
- **A screen stretch that already reached the host whole is offered again.** After a take
  whose backups are offered, every screen stretch's backup is offered, also one whose stream
  was finished, and it travels a second time if the host saves it.
- **While a take sent later ends, the guest's notice reads "Sending your last few seconds
  to the host."** Nothing is sent then: the recorders and the backups stop, and the line
  about the backup follows. For as long as such a take records, the track panel's button
  reads "Check tracks", on the guest's page and on the host's.
- **A title is not remembered and cannot be changed in the call.** It is typed in the lobby
  for one visit; a person who wants another leaves and joins again.
- **A producer and a Present-only device have no title.** Their lobby has no field and they
  have no tile to show it on.
- **A small tile shows the name alone.** In a tile narrower than 224 px the title is hidden;
  its owner's tag still holds it in the tooltip.
- **A title is its owner's own text and nobody checks it.** Only its type and length are
  checked, and it is not in any file.
