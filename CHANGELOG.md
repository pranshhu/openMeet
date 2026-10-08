# Changelog

All notable changes to openMeet are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Security fixes are listed here too, crediting whoever reported them unless they'd
rather not be named. To report one, see [SECURITY.md](SECURITY.md).

## [Unreleased]

### Added

- Opening the room in a second tab of the host's browser while a recording is
  running asks before that tab takes the call over, instead of ending the first
  tab's files.
- A sound when a recording problem appears during a take, and a system
  notification when the tab is in the background.
- Keep the screen awake during a take via Screen Wake Lock, prefix the document
  title with `● REC ` while hidden, and warn when the tab was in the background
  or the battery is low.
- A notice during a take when the device is not keeping up: audio was skipped, or
  the browser reports its video encoder limited by the processor.
- Low-power mode, offered when the device is struggling during a take: the others
  get a smaller live picture and the recording is unchanged.
- A public demo environment: `[env.demo]` in `apps/worker/wrangler.toml`, deployed with
  `pnpm --filter @openmeet/worker run deploy:demo` (migrations with `db:migrate:demo`).
  Self-host installs never read it.
- Take session files saved directly into the recording folder next to recordings:
  sync JSON (start-time offsets and remux commands), chapter markers (if marked), and
  in-call chat from the take window.
- Frame-rate choice in the lobby (24, 25, 29.97 or 30 fps), remembered per
  browser.
- `sync.json` gains a `frameRate` section: the frame rate cameras are asked for by
  default and, where known, the rate each one reported, plus two `ffmpeg` commands per
  video file, one that measures how variable its frame rate is and one that
  re-encodes it to a constant frame rate.
- Every file of a take gets its own size and verdict in the session summary and the
  sync file: complete, complete but not verified, or incomplete with what is missing
  and where the backup is. WAV masters and screen recordings are checked against
  what the guest sent, as camera files are.
- Aligned copies: `sync.json` (`aligned`) and the session summary give an `ffmpeg`
  command for each file that starts after the host's, except call-audio copies, which
  carry their own `offsetMs`; it writes a copy starting at the host's start, so every
  track can be placed at 00:00. WAV copies get real silence; MP4 copies are not
  re-encoded.
- A note during the call when your own microphone has sent no sound for 10
  seconds (unplugged, muted on the device, wrong input) or keeps clipping.
  Turning the mic off in the app does not count, and the note can be
  dismissed.
- A live track panel during a take: beside the Recording pill, the host sees every
  participant's camera, WAV and screen file growing and which one has stopped getting
  data, and each guest sees whether their own tracks are reaching the host or how much
  is still waiting to be sent.
- The host keeps a call-audio copy of each recorded guest's live audio in the
  recording folder (`call<n>_<id>.m4a`): a call-quality fallback for a guest
  track that stops arriving or ends short, listed in the session summary and in
  `sync_<id>.json`.
- After the browser closes on a take, the lobby lists it as **Unsaved recording** and
  **Save to folder** rebuilds the files and their sync file from the browser’s copy.
- While a take runs the guests' bytes are also kept in this browser, so a crash
  loses at most the last seconds, and a take that cannot keep that copy, or loses
  it part-way, says so on screen until it ends and records as usual.
- A guest can send a leftover backup straight to the host: press **Send to host**
  in the lobby and join. It travels peer-to-peer into the host's recording folder,
  is checked by SHA-256 and saved as `backup_<name>_<kind>_<time>` with a note on
  how to align it.
- Coming back to a room where the guests are still connected, the host is offered
  **Resume recording** to continue the interrupted take under the same id, or
  **Save what was recorded** to rebuild it in the folder instead.
- After a resume the host's own camera and WAV master are recorded to a second
  file (`host_<id>_resumed.mp4`/`.wav`); the part before the crash is copied into
  the folder from the take's backup in the background and listed once it is there.
- An interrupted or resumed take's `sync.json` names the files of the host's own
  track that reached the folder, each with its offset from the start.
- A guest's file from a resumed take is still checked against what that guest
  sent when the crash copy kept the checksum state of the bytes it holds; when
  it did not, the file reads "not verified" and says why, and a file with a
  known hole reads "Incomplete".

### Changed

- Audio is recorded at 48 kHz for everyone. A microphone that runs at another
  rate (44.1 kHz, or 16 kHz over Bluetooth) is resampled, so every WAV master
  and camera MP4 has the same sample rate.
- After a take, one warning says how many files are not complete, replacing the
  single integrity line about the guests' camera files and the "ended early"
  notes. In the sync file, `integrity` and `guests[].integrity` carry the new
  wording; the `endedEarly` flags are unchanged.

### Fixed

- A take that loses its crash copy part-way keeps saying so in its own status
  line until the take ends; the banner that first said it is shared, and the
  next message replaced it. A warning that arrives after a take has ended is
  not shown over the saved take.
- After **Resume recording**, the screen recordings from before the reload are
  put back in the folder from the crash copy and listed in the summary and
  `sync_<id>.json` with their size and sharer; one that cannot be rebuilt whole
  reads Incomplete.
- A call-audio copy started after a resume takes a file name the folder does not
  already hold, so the copy from before the reload is not replaced.
- A resumed file reads Incomplete when nothing arrived for it after the reload
  or the host gave up waiting for a missing piece, where it read as rebuilt.
- The crash copy names the person sharing a screen by their display name.
- **Resume recording** keeps what the folder already holds of a guest's file.
  A page that reloads saves each file a few seconds ahead of the crash copy, and
  the resume opened over it; those bytes are now carried into the continued
  file. A file that cannot be carried is left as it is and named on screen.
- A resumed file whose rebuild stopped short reads Incomplete in the summary and
  `sync_<id>.json`, where it read "Complete. Matches what the guest sent".
- A recovered or resumed take keeps each guest's start offset, so
  `sync_<id>.json` gives the alignment where it said to align by waveform.
- After a resume the host's files from before the reload are listed only once
  their copy is in the folder, each with its size.
- Two screen shares that start together after a resume get a file each, and a
  share is refused, and said so, when the folder has no free name for it.
- After a host reload, **Resume recording** and **Save what was recorded** run
  once and one at a time: a second click, or pressing the other button or Record
  while one is still working, does nothing.
- A take that is resumed keeps the markers placed before the reload, anything
  the resume itself reported stays on screen, a guest whose connection arrives
  while the resume is running is still recorded, and the host keeps a call-audio
  copy of the guests it resumed.
- When the host saves an interrupted take instead of resuming it, the guests'
  recording stops and each is pointed to the backup their own browser kept:
  at once for a save from the call, and when the host next joins the room for a
  save or a delete from the lobby.
- A screen share that was already running when the host reloaded is named on the
  host's screen after a resume, because it is recorded again only once that
  person stops sharing and shares again. The line stops naming them once
  their new share is being recorded.
- Browser storage that stops answering during a take no longer holds back the
  guests' recordings: after 15 seconds crash protection stops for that file, the
  call says so, and the recording carries on.
- A guest file that continued after a host reload is checked against the right
  bytes when browser storage was slow before the crash, instead of being
  reported as damaged.
- A lost fragment no longer leaves a silent hole in a live recording: the host
  asks the guest to resend from the last fragment it has.
- Two screen shares starting at the same moment no longer write into one file.
- A file that received nothing is no longer shown as complete: an empty frame
  from a guest no longer moves a file's size, so its verdict reads Empty.
- After a take, the recording's metadata row holds the size of the host's own
  file instead of the first guest file's size and checksum, and the host's
  backups are kept when its own camera file or WAV master came out empty.
- The track list no longer says a file is OK when nothing reached the disk: it
  reads the host's own rows from what was written, keeps a red alert readable
  above the open list, ages a stalled reading into **Check tracks**, names a
  blank guest row, and refuses an oversized channel label from a guest.
- After a reconnect the host tells the guest where its file ends as soon as the
  channel is attached, and counts only the bytes that actually arrived.
- A guest who left before the take ended is still named on their files and in
  the sync file, and a guest WAV master that was opened but received nothing is
  listed with its size and verdict like every other file.
- A guest left alone in the room when the host drops is told to keep the tab
  open and that the host can resume this recording, instead of being told to
  press a button guests do not have; when the host does resume, the guest's file
  continues instead of splitting in two.
- A call-audio copy whose write or close failed is no longer listed in the session
  summary and the sync file, and one guest's reconnects can no longer spend every
  other guest's files; the sync file says when the file limit was reached.
- When the signalling service restarts and every socket rejoins under a new peer
  id, the call comes back by itself: connections to ids the room no longer lists
  are dropped instead of being negotiated a second time, which threw and left
  both sides on "Connection lost" with a ghost tile.
- Ending a take no longer waits on a guest that keeps sending data: each guest
  file is closed two minutes after the stop at the latest, however much is still
  arriving.
- A backup that failed to arrive can be sent again without the host dismissing
  it first.
- When one person's connection to the service drops and returns, the call comes
  back at once instead of after half a minute.
- A returned backup that stalled is dismissed, and one still running stopped,
  while other transfers keep arriving, and a backup the host saved is announced
  at once instead of waiting for the rest.
- Resuming a take no longer logs a database error on the server.
- **Save to folder** on an unsaved recording keeps the browser's copy when a file
  could not be written in full or the sync file failed, and names what was not
  saved, instead of removing the copy and reporting it saved. It also rebuilds
  files the copy holds without a note, and a WAV master that a closed or reloaded
  page left in the folder with a header declaring no audio gets a header that
  matches its length when the recording is saved or resumed.
- A lobby opened in another tab no longer removes the crash copy of a take that
  has not written its first bytes, and does not save or delete a recording
  another tab is continuing. A take whose crash copy stopped part-way is not
  offered **Resume recording** after a reload.

### Security

- A recording channel is accepted only when its label key is letters, digits and
  hyphens (at most 64), and one person's screen shares can use at most 12 of a
  take's 48 crash-copy entries, so one participant cannot use up the others'.
- A Save takes only the offers that were listed when it was pressed: an offer
  that arrives, or changes size, while the folder prompt is open waits for the
  next Save.
- Malformed markers, chat or guest metadata can no longer make the host's take
  end in failure.
- Security headers on every page Cloudflare Pages serves (`apps/web/public/_headers`):
  a Content-Security-Policy, `X-Frame-Options: DENY`, `Referrer-Policy`,
  `X-Content-Type-Options` and a Permissions-Policy limiting camera, microphone, screen
  capture and fullscreen to the site itself.
- The signaling WebSocket refuses a handshake whose `Origin` isn't the deployment's
  `PAGES_ORIGIN` (403), so another website can't open a socket into a room from a
  visitor's browser.
- A room URL with a percent-encoded character could leave the room unable to start its next session.
- Only the authenticated host can write or change recording metadata rows in D1;
  unauthenticated writes over WebSocket are ignored.
- A guest can no longer make the host open an unbounded number of recording files by
  opening channels under made-up keys: a take opens at most eight guest slots and one
  connection may introduce two keys, after which the extra channels are refused.
- A wrong acknowledgement from the host can no longer stop a guest's recording from
  streaming to the host.
- CI scans every push and pull request for leaked secrets and known-bad code patterns, and its actions are pinned to exact commits.

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
