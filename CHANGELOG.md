# Changelog

All notable changes to openMeet are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Security fixes are listed here too, crediting whoever reported them unless they'd
rather not be named. To report one, see [SECURITY.md](SECURITY.md).

## [0.1.0] - 2026-09-29

The first public release.

### Added

**Recording**
- Each participant's camera and microphone recorded in their own browser and streamed
  peer-to-peer to the host's disk, one full-quality MP4 per person. No media server, no
  upload, no server-side copy.
- An uncompressed 24-bit WAV master per person, next to the MP4.
- Screen shares recorded as their own track, one file per sharing stretch, with the
  shared tab's audio (when the browser offers it) and a crash-safe backup on the sharer.
- Capture quality presets from 720p to 4K, with raw audio (echo cancellation, noise
  suppression and automatic gain control off).
- Host-driven recording: one press of Record captures everyone in the room.
- An in-browser backup of every participant's own recording and WAV master, kept on disk
  in the browser so it survives a crashed tab, and listed in the lobby for download. If
  browser storage is unavailable or fails, the backup carries on in memory and says so.
- Guest recording that resumes by itself after a dropped connection, from the last
  acknowledged chunk, into the same files.
- A slow or stalled upload doesn't stop a guest's recording: it keeps recording and
  catches up, and End & save waits while the guest's tail is still arriving. If the
  unsent backlog passes 256 MiB, live streaming stops for that take and the rest is in
  the guest's own backup, which the session summary points to.
- A warning to the host, before pressing Record, when a participant's browser can't
  record MP4 or a WAV master.

**During the session**
- Up to 4 recorded participants plus 2 unrecorded slots, connected peer-to-peer. The
  unrecorded slots are shared by producers (add `?producer=1` to the invite link: in
  the call, never recorded) and Present-only screens.
- Teleprompter, chapter markers, and a media board for stingers and ad reads.
- Several takes in one session behind a single folder prompt.
- A green room that checks mic level, codec, free disk space and TURN reachability
  before joining.
- Chat, presence and screen share, with a pop-up for each new chat message while the chat
  panel is closed.
- Switch camera and microphone during the call. In Chromium this works mid-take and the
  recording carries on in the same files; Safari and iPhone switch between takes.
- "Present only": join from a second device (a laptop) just to share its screen while a
  phone carries your face and voice. It takes no recorded seat (it uses one of the
  unrecorded slots); its screen is recorded.
- Phones, which can't share a screen from a browser, present a photo, a video or the rear
  camera instead.

**Call UI**
- A lobby that shows a blocked, missing or busy camera or mic in the preview, with
  Try again.
- Status screens for a full room, a room taken over from another tab or device, an
  unreachable server, and leaving the call (with Rejoin, and the take's downloads when
  there are any); a 404 page for unknown addresses.
- The lobby preview and your own camera tile are mirrored on screen; recordings are not.

**Afterwards**
- A session summary beside the stage (a sheet on phones), with one-click Record another
  take: it starts recording again in the same folder, with no second prompt.
- `sync.json` with the start-time offset between tracks, a SHA-256 integrity verdict,
  and `ffmpeg` commands for remuxing and for pairing each video with its WAV master,
  downloaded from the session summary.
- `chapters.txt` when markers were dropped.

**Hosting**
- Runs on a free Cloudflare account (Pages, Worker, Durable Object, D1), with a
  one-command installer and optional self-hosted TURN.
- An optional sponsor wall on the landing page, backed by the instance owner's own
  Polar account. Off unless configured; without it the landing page is the plain one.

### Known gaps

- After a full reconnect, a screen share comes back for everyone and keeps recording in a
  new numbered segment; the interrupted segment's tail is only in the sharer's screen
  backup, and the session summary marks that segment "ended early".
- Opening the room as host in a second tab during a take hands the call to the new tab.
  The first tab's files end at the takeover, and the rest of each guest's part exists
  only in that guest's backup.
- The media board, if first opened during a take, isn't in that take's MP4; its pads
  still play live and drop chapter markers. The WAV master is mic-only by design.
- Clock sync needs the host to be recording within ~8 s of the guest; otherwise tracks
  are aligned by waveform.
- Anyone with a room's invite link can mint short-lived TURN credentials (rate-limited
  to 20 per minute per IP).
