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
  relays each msg to every other peer — SDP/ICE carrying `to` go to that one peer only — stamped
  with `from: Role`, `fromPeerId`, and `fromName` on chat/presence/marker).
- D1 holds **metadata only** (rooms, sessions, participants, recordings) — never bytes.
- TURN bytes (symmetric NAT) are SRTP/SCTP-encrypted, opaque to operators.

---

## Wire protocol (`packages/protocol`)

**Two transports, two ack mechanisms — do not conflate:**
- **WS signaling** (`ws-messages.ts`): `ClientMessage` (15 variants) ↔ `ServerMessage` (18).
  Relay types `webrtc-offer|webrtc-answer|ice-candidate|chat|presence|marker|recording-started|
  recording-stop|recording-capability` exist in *both* unions; server adds `from: Role`, plus
  `fromPeerId` on all but `recording-started|stop`. `peer-recorded` is in both unions too, but it is
  **not a relay**: only the host's is acted on, and the Room sends its own to every joined peer with
  no `from`. `recording-countdown` (`seconds`) is in both unions as well: the Room passes on only
  the host's, to everyone else, with no `from`; it is a cue for the screen and starts nothing.
  SDP/ICE take an optional `to` (peerId) so
  the DO can address one peer in a mesh. Type guards `isClientMessage`/`isServerMessage` validate **only the
  `type` discriminant**, not payload shape.
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
going back to the host). WS close codes: `4001` capacity-full,
`4002` invalid slug, `4003` known-but-expired room (the DO distinguishes the two),
`4005` invalid message, `4006` replaced (another host connection took over).

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
  as not recorded, at most 16, emptied when the session ends) and reloaded in the constructor via
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
- `peer-recorded` is **acted on only from the host**, only while no take is running and only for a
  joined guest that sent a client id; the DO remembers the guest by that id — until the host
  changes its mind, or the session ends — and flags it to later joiners and on a reconnect, then
  sends `peer-recorded` to every joined peer, the host included.
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
  `replaced` (4006: another tab/device took the host seat), `left` (Rejoin + Back to home, plus
  download links for sync.json/chapters.txt/backups when a take was finalized on the way out; a host
  holding those gets a `beforeunload` prompt, since Rejoin reloads), `error`; the terminal ones
  release camera/mic unless a take is live. `peer-left` (the mesh emptied, or `room-closed`) renders
  WaitingRoom ("Everyone else left"): the tab stays in the room, camera on, and resumes when someone
  joins. `Lobby` uses a `handedOffRef` so unmount doesn't stop the MediaStream handed to `useRoom`
  (ownership transfer — load-bearing). `Lobby` **requires a name** (Join gated; the name field is a
  form, so Enter joins) + has mic/camera device pickers (`changeDevice` re-acquires with the chosen
  `deviceId`, new-stream-before-stop-old). A blocked/missing/busy camera or mic shows in the preview
  with Try again; a producer's lobby opens no camera or mic and joins with a zero-track stream.
  Leftover backups are listed in the join panel, beside Join, and a guest whose backup is of this
  room can choose it with **Send to host**; the choice is handed to the hook on join.
  A host's interrupted takes of this room are listed there as **Unsaved recording**, with Save
  to folder and Delete; both are disabled while a save runs, and a save that left something out
  says so in an alert and keeps the row.
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
- **`components/Stage.tsx`** — Google Meet focused layout. Derives mode from feeds:
  `solo` (local fills), `focused` (big spotlight + tap-to-swap corner PiP), `grid` (3+ people, equal
  tiles), `presenting` (screen spotlight + camera column on desktop, other people first and you last /
  floating peer PiP on mobile; a desktop screen sharer sees a "You're presenting" placeholder with a
  Stop presenting button, no self-mirror; whoever presents a rear camera or a photo/video gets that
  feed back as a viewfinder via `localScreenStream`). `CallStage` renders `<Stage>` (not a grid),
  keeps optimistic mic/cam + `spotlight` local state; tiles show `localName (You)` / `peerName`
  (role fallback). Responsive: `h-[100dvh]`, control bar `flex-wrap` + safe-area, mobile chat is a
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
  `components/BackupNotice.tsx` shows returned backups in the same flow above the stage: the
  host's Save to folder / Not now on an offer, the percent and a Stop while bytes move, a stalled
  transfer's own line with Dismiss, and the saved or failed verdict on both sides, with offers
  held back while a take records or saves.

### Call orchestration (`hooks/useRoom.ts`)
State machine `RoomPhase`: `checking→lobby→waiting→connecting→in-call→recording→finalizing→done`
(+ `not-found|peer-left|left|full|replaced|error`). **`waiting`** = joined but alone; → `connecting` when the peer is
present (`role-assigned` peerCount≥2 or `peer-joined`); → `in-call` on remote media. Transitions are
guarded on `s.phase==='waiting'` so a reconnect can't downgrade `in-call`. `RoomState` also holds
`localName`, `remotePeers` (per peer: name from `peer-joined`, stream, presence, role,
`notRecorded`), `notRecorded` (this peer: the host set it as not recorded, so its capture never
starts), `capabilities` (per-peer MP4/WAV from `recording-capability`), `backupTransfers` (a guest's returned
backups, shown as offers on the host), `remoteScreenStream`, `screenSharing`,
`micWarning` (this participant's own mic, from `SwitchableMedia`'s `onMicWarning`: `'silent'`, `'clipping'` or
null; `CallStage` shows it as a note that can be dismissed until the next take starts),
`countdownEndsAt` (when the countdown before a take ends, on this tab's clock, else null).
Holds all subsystem singletons in refs. `join`: `getTurnCred` → `buildIceServers` → `SignalClient` →
register handlers → `connect`. Wires signal→`peer.handleSignal`, chat/presence/peer-left, host
channel rebind. `toggleScreenShare`: adds the screen track on its **own** stream id (not the camera
stream); stop = `removeTrack` + renegotiate, idempotent. `onDataChannel` routes a `backup` channel to
`BackupIntake` before the camera fall-through; accepting reuses or sets the session's recording folder.
`sendBackups` queues one `BackupSend` per leftover backup file and `startPeer` attaches every
unfinished send to each new connection to the host. `recordWithCountdown` is the Record click: it
asks for the folder when the session has none, counts `RECORD_COUNTDOWN_S` seconds (`CallStage`
draws `RecordingCountdown` over the stage and keeps Record disabled), then calls `startRecording`.
A take that took the room while it counted (a resume) keeps it, and `resumeRecording` never counts
down. The host sends `recording-countdown` as its count starts; every other tab counts from the
cue's arrival on its own clock, for at most `RECORD_COUNTDOWN_S`, and takes the count down on
`recording-started`. A lost cue costs the count, never the take.

- `lib/signal.ts`: `SignalClient` — sends `join` on open, type-guards inbound, 30s ping, **exponential
  backoff reconnect** (`backoff.ts`: `min(1000·2^n, 30000)`). `send` **drops** if not OPEN (no queue).
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
- `lib/ice.ts`: stub detection `username==='stub' && credential==='stub'` (or no credentials) →
  bare STUN entry. If `getTurnCred` itself fails, `join` falls back to that same STUN stub.

### Recording engine (`lib/*`, `hooks/recording-controller.ts`)
- `recorder.ts` `ChunkRecorder`: `MediaRecorder` @ 2s timeslice; assigns `idx`/`offset`
  **synchronously** in `ondataavailable`, serializes `blob.arrayBuffer()` via a `tail` promise
  chain to preserve order; skips empty blobs.
- `chunk-sender.ts` (guest egress): `sendChunk` → `hash.update` → `buffer.add` → `enqueueOrSend`.
  Backpressure: `bufferedAmount>16MiB` → queue, drains at ≤8MiB (hysteresis). The pause half exists
  (`setPaused`, `onBackpressure`) but no take-time caller passes the hook — the three `new
  ChunkSender` calls in `recording-controller.ts` pass none — so no recorder is ever paused by it.
  Each chunk is split into ≤64 KiB fragments (`DC_MAX_MESSAGE_BYTES`), each with its
  own header `idx`/`offset`; `rawSend` = one fragment's two-frame header+payload. Ack truncates
  retransmit buffer. `rebind(channel)` moves the sender onto a new channel after a reconnect.
  `drain()` polls 100ms until empty or 30s cap.
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
  A failed write is retried once and then the rest of the take continues in RAM with a warning
  banner. `stop()` returns the disk-backed `File` assembled from chunk Files by reference. After a
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
  a resume gives the host's own WAV the same repair through `copyBackupInto`. A take reopened from that journal replays the parts into the same folder files
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
  `openmeet-<slug>-take<n>-sync.json`). After a take the host's summary is a column beside the stage
  (a sheet on phones) that shares that side with chat; "Record another take" runs `newTake` then
  `recordWithCountdown` in one click (same folder, no second prompt). With nobody left to record, that
  button copies the invite link instead and the summary stays. The summary's file list leaves out a
  guest WAV that was never opened, host files a host companion never opened, empty guest screen
  segments (deleted) and the first guest's camera file when no guest sent into it (deleted); every
  file it lists shows its verdict and, when it was checked, its size (a file that was never created
  has no check, so no size); one that holds no bytes reads Empty, and one warning says so whenever
  any file is not complete. Clock-sync needs the host to be
  recording within ~8s of the guest, else it degrades (offset null → "align by waveform").
- `screen.ts`: `getDisplayMedia({video:true, audio:true})` — video and tab/system audio when available. A photo or a video file is presented through a canvas (`presentFile`): a computer picks it from the arrow beside Present, a phone from the Present menu, which also offers the rear camera (`presentRearCamera`). A phone's real screen comes from a second device joined with "Present only". A presented video's sound goes to the call; `presentFile(file, monitor)` also plays it on the presenting device when `monitor` is set, which `toggleScreenShare` does on a computer that is not a present-only device. A presented video's track is marked `contentHint = 'motion'` in `presentFile`, and `PeerConnection.addTrack` marks a track as a screen (`'detail'`) only when it carries no hint, so the clip is sent with the camera's budget at its own frame rate; a photo and a shared screen stay capped at `SCREEN_MAX_FPS`.
- `recording-controller.ts`: HOST `startHostRecording` is handed **one folder**
  (asked for once a session by `useRoom.recordWithCountdown`, before the countdown; it asks itself
  only when handed none; later takes reuse it and get a `_take<n>` suffix) and opens
  `host_<id>.mp4`, `host_<id>.wav` (when PCM capture works) and slot 0's `guest_<id>.mp4` up front.
  A host companion running `startHostRecording` with an empty camera/mic stream skips host camera MP4,
  WAV, and their backups, while still opening the folder and recording guests and screens. Guest companions
  record only screen segments on `recording-started` without camera, WAV, or backup recorders.
  Every other guest file opens lazily per slot when that guest's channel arrives (`guest_<id>.wav`,
  `guest2_<id>.*`, `guest3_…`), as does each screen segment (`host_screen_<id>.mp4`,
  `guest_screen_<id>_2.mp4`, …). Also starts the host's `BackupRecorder` and stamps `hostStartMs`.
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
  take already recording when the board is first opened keeps a mic-only MP4 (a running
  `MediaRecorder` can't swap tracks); its pads still play live and drop chapter markers, and the
  board says so for that take. A pad set to loop (`setLoop`) repeats until it is stopped, and
  the switch reaches a pad that is already playing. Each pad plays through a gain node of its
  own: one set to fade (`setFade`) comes in over `PAD_FADE_S` when fired and goes out over it
  when stopped, counts as playing until it is silent, and is cut by a second stop. The mix
  destination keeps the browser's default of two channels, so the MP4 (and backup) of a take with
  the board open has a two-channel audio track even when the microphone is recorded in mono: a
  stereo pad keeps its stereo and the voice is the same on both channels. The WAV master follows
  `recordedChannels` either way.
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
   guest that keeps sending cannot hold the save open.
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
   connections that message opened are negotiated on it. When sharing screen, a reconnect finishes
   the old screen segment and starts a new numbered segment on the rebuilt connection, with each
   segment backed up locally in OPFS. Host rebinds new channel to existing receiver, found by a
   stable key (see below), not by the DO's fresh-per-socket peerId.
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
- **Stable stream for mid-take device switching (`lib/switchable-media.ts`)**:
  Removing or adding a track on a `MediaStream` that a running `MediaRecorder` is recording throws
  `InvalidModificationError` and kills the take. Furthermore, Chrome's AAC MP4 muxer and our `PcmRecorder`
  (WAV master) lock their sample rate on the first frame, so switching directly to a mic with a different
  sample rate (e.g. 44.1 kHz, 24 kHz, or 16 kHz Bluetooth) would corrupt both files.
  To solve this, `useRoom.join` constructs `SwitchableMedia` which wraps the lobby stream into ONE stable
  output stream handed to everything (preview, PeerConnection, ChunkRecorder, BackupRecorder, and WAV).
  It is skipped for companions AND producers, which join with no camera or mic (wrapping an empty
  stream would conjure a blank video track and a silent audio track).
  - Video is a persistent `MediaStreamTrackGenerator({ kind: 'video' })` fed via `MediaStreamTrackProcessor`;
    switching cameras cancels the old reader and pumps frames from the new camera without changing the stable
    video track ID or interrupting the recorder (with `avc3` carrying updated SPS/PPS across resolution changes).
    Real camera settings are delegated from the real track. A switched-to camera is asked for the
    frame rate the lobby camera was asked for (read once from that track's `getConstraints()`).
  - Audio is an `AudioContext` at 48 kHz (`WAV_SAMPLE_RATE`) recording one channel, or two when stereo
    was asked for at join and the microphone has two (`recordedChannels` in `lib/media.ts`),
    routing mic -> `MediaStreamAudioSourceNode` -> `MediaStreamAudioDestinationNode`; switching mics swaps
    the source node into the destination node, and Web Audio resamples smoothly with no track ID change.
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
  only from its own new take.
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
- **Media board opened mid-take:** that take's MP4 (and backup) has no pad audio — a
  running `MediaRecorder` can't swap tracks. Pads still play live and drop chapter
  markers; takes started later include them. The WAV master is mic-only by design.
- **The media board is empty after a reload.** Pads are held in memory, so a pad that was
  looping stops when the tab reloads and the files have to be added again. A board opened
  after **Resume recording** is opened mid-take, so that take's MP4 has no pad audio.
- **A looping pad cannot be stopped from the waiting room.** When everyone else leaves and
  the tab shows "Everyone else left", there is no media board on screen; the pad plays on
  until someone joins and the call is back, or until Leave.
- **Clock sync needs the host recording within ~8 s of the guest** (`ClockSync.run`
  timeout); otherwise the offset is null and `sync.json` says to align by waveform.
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
- **The producer and Present-only links are offered only to the host, in the waiting
  room and in the call's top bar before a take.** The lobby and the take summary offer
  the plain invite link alone, and during a take and after one the top bar has neither.
  Each is still the invite link plus `?producer=1` or `?present=1`.
