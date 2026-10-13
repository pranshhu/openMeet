# Changelog

All notable changes to openMeet are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Security fixes are listed here too, crediting whoever reported them unless they'd
rather not be named. To report one, see [SECURITY.md](SECURITY.md).

## [Unreleased]

### Added

- The sync file says that a call-audio copy holds the noise-suppressed sound of a guest
  who had noise suppression on for the call.
- Noise suppression for the call: on a computer, tick **Noise suppression** in the
  microphone menu and the others hear you with the browser's noise suppression on.
  Your recordings stay raw.
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
- 50 and 60 fps in the lobby's frame-rate picker on cameras that can deliver
  them, recorded at a higher bitrate (the bitrate picker shows it), with a note
  about the larger files and the heavier load.
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
- **Levels**, in the call's control bar: a fader for each other person sets how
  loud your browser plays them. Only you hear the difference; what the others
  hear and every recording are unchanged.
- **Levels** shows a meter beside each fader: how loud that person arrives,
  whatever their fader is set to.
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
- A camera switched to during the call keeps the frame rate picked in the
  lobby.
- The lobby shows the frame rate the camera delivers exactly (29.97 rather than a
  rounded 30) and says when it is not the rate picked.
- A bitrate choice in the lobby: Standard, High or Maximum (4K has Standard
  only). Your camera and its backup are recorded at the level you pick, and the
  disk estimates follow it.
- The lobby's size figures (per-hour estimates, bitrate labels, storage and
  folder checks) follow a camera that delivers 50 or 60 fps.
- A Stereo choice in the lobby for a person with a stereo microphone, remembered
  in that browser. Without it audio is recorded in mono.
- The host can set a guest as not recorded before a take, from the arrow beside
  **Record**: that guest stays in the call, their browser records nothing and the
  host saves no file from them, from the next take on; a backup of an earlier take
  that they send back is still offered to the host, and everyone is told who is
  not recorded.
- A computer can present a photo or a video file to the call, from the arrow
  beside **Present**. It is shown, and recorded during a take, the way a shared
  screen is.
- A media board pad can loop: press **Loop** under it and it repeats until it is
  stopped. The switch works on a pad that is already playing.
- A media board pad can fade: press **Fade** under it and it comes in over a
  second and a half when fired and goes out the same way when stopped. A second
  click cuts it.
- The host's screen counts down the three seconds before a take: "Recording
  starts in 3".
- Everyone in the call sees the countdown before a take, not only the host.
- A person who presents a video from a computer hears it too. A phone and a
  Present-only device stay silent, so the sound is not picked up again by a
  microphone.
- A presented video is sent to the call as video, at its own frame rate, instead
  of at the few frames a second a shared screen gets. A presented photo and a
  shared screen are unchanged.
- The lobby asks whether you are on headphones or speakers. On speakers you can
  turn echo cancellation on for your own microphone; your recording is then
  processed audio, not raw. The answer is remembered in that browser.
- The host sees on each person's name tag whether they said headphones or
  speakers in the lobby, and whether their echo cancellation is on.
- The session summary and `sync.json` say which files were recorded with echo
  cancellation on, and a microphone switched during the call keeps that choice.
- **Test your mic** in the lobby's readiness panel: five seconds of your own
  microphone are recorded, played back to you and deleted. The clip never leaves
  the browser.
- A **check link** for a room (**Copy check link** in the host's lobby, or `?check=1`
  on the invite link): a guest tests camera, microphone and connection ahead of the
  call, on the lobby's own checks, without joining the room.
- **Copy result** under the lobby's readiness checks: the checks as plain text, with
  the names of your camera and microphone, to paste into a message to the host. It
  goes to the clipboard and nowhere else.
- Ready sounds on the media board: **Chime**, **Rimshot** and **Soft bed** go
  on the board as pads with one click. They are made in the browser, so no
  audio file is downloaded, and the bed arrives set to loop and fade.
- A site can ship recordings of its own as ready sounds for the media board:
  put the file in `apps/web/public/sounds/` and list it, with its license, in
  `apps/web/lib/sound-files.ts`. A file is downloaded only when someone adds
  its sound to their board. This repository ships none.
- The host can copy the **producer link** and the **Present-only link** from an
  arrow beside **Copy invite link**, in the waiting room and in the call, each
  with a line saying what it is, instead of adding `?producer=1` or `?present=1`
  by hand.
- **Stop incoming video**, in the call's camera menu, for a weak connection: the
  other participants stop sending you their camera and shared screen. You still
  hear everyone, they still see you, and no recording is affected. It stays off
  for someone who joins later, after a reconnect, and for a screen share that
  starts while it is on. A line above the stage says it is on, and a screen
  someone presents is covered by a note; both offer **Show video**.
- Private messages: in the chat panel, choose one person under **To** and the
  message reaches only them. Both screens mark it as private, and it is left out
  of the take's chat file.
- The host can turn a participant's microphone off, from **People** in the call's
  control bar. That person is told at once and turns it back on with their own
  microphone button; during a take their recording has no sound until they do.
- The host can remove a participant, from **People** in the call's control bar,
  after a confirmation. The room keeps that tab out until everyone has left; what
  the person recorded stays in the host's folder up to the removal, and in their
  own browser's backup beyond it. The screen that tells them they were removed offers the
  backups their tab holds as downloads. Removed during a take, their **Stop and save**
  saves the recording at once. Their page then becomes that screen, with the backup links.
- Keyboard shortcuts in the call: **A** switches the microphone, **V** the camera,
  **C** opens chat and **T** the teleprompter. The **?** button in the top bar, or
  the **?** key, lists them. No key does anything while you type in a field.
- **Alt+R** presses Record for the host and **Alt+S** presses End & save while a take
  runs (Option on a Mac). Neither does anything while its button is greyed out or
  not on screen.
- The single-key shortcuts (**A**, **V**, **C**, **T**, **M**, **N** and **?**) can be
  turned off, for people whose speech input types letters: untick **Single-key
  shortcuts** in the list the **?** button opens. The browser remembers the choice,
  and **Alt+R** and **Alt+S** stay on. The list names **N** as well.
- While the single-key shortcuts are turned off, no button names one in its tooltip or
  its name, and the list says they are off. The lobby has the same tick box, so it can
  be reached on a window too narrow to show the **?** button.
- Record alone: a host with nobody else in the room presses **Continue alone** in the
  waiting room and records from the call screen. Anyone who joins during the take is
  recorded from then on.
- The teleprompter's editor shows how long the script takes to read aloud.
- The host can send their teleprompter script to everyone else in the call, from
  the teleprompter's editor. Each person uses it in their own teleprompter or
  ignores it, and nobody's own script is replaced without their click.
- A chapter marker can carry a typed note: during a take press **N**, or the pencil
  button beside the marker button, type and press Enter. The note is that marker's
  line in the chapters file and its label in `sync.json`, and a take that is resumed
  or recovered after a reload keeps it. The host's own note is placed at the moment the
  note field opened. A note with no space in it, such as a pasted link, wraps in the
  summary's chapter list.
- A speaker picker, in the lobby and in the call (the arrow beside the mic button):
  everyone's voice, a presented screen, the media board's pads and a video you
  present play through the output chosen. The choice is remembered per browser,
  and a chosen speaker that is unplugged falls back to the system default.
- **Send a file to the host**, in the call's chat: anyone but the host picks a photo, a
  document, slides, an audio or a video file of up to 100 MB, and the host is asked
  before any of it is sent. A file the host accepts goes peer-to-peer into the recording
  folder as `shared_<name>_<file name>`, checked against what was sent; one that is
  stopped, cut off or fails the check is not kept. Other file types are refused on both
  sides.
- `sync.json` gains a `recordingNotice` section: when the host's browser announced
  the take, everyone the room listed then or who joined while it ran, and when each
  one's own recording channel reached the host, which shows their browser had been
  told. A note in it says what each line proves and what it does not. Nothing more
  is kept on the server.
- After an interrupted take the `recordingNotice` record starts again when the take
  is resumed and names the guests whose recordings had reached the host before the
  interruption; a take saved from the crash copy lists those guests only.
- **Raise hand**, in the call's control bar: a mark appears on your tile for everyone
  until you lower it, and someone who joins later sees it too. Nothing of it is
  recorded. A phone held upright shows the hands and has no button.
- Quick reactions, from the arrow beside **Raise hand**: a thumbs up, applause, a laugh
  or a heart shows on your tile on everyone's screen for about three seconds, without
  a sound. Nothing of it is recorded.
- **Add to calendar**, in the host's lobby: pick a start time and download a
  calendar file (.ics) or open Google Calendar with the entry filled in. The entry
  is one hour long and carries the room link and a short checklist for the guest
  (browser, headphones, a quiet room). It is made in the browser: nothing about it
  is stored or sent to the server.
- **Add to calendar** says until when the room stays open (30 days after its last
  call) and makes no entry for a session that would end after that.
- **Pop out**, in the call's camera menu on a computer: one other person's
  picture floats in a small window that stays on top of your other windows. Put
  it just under your webcam and looking at them is looking at the lens. Their
  sound, the speaker you chose, Levels and every recording are unchanged. The
  window closes by itself when that person leaves or reconnects and while
  incoming video is stopped.
- **Framing guide**, on the lobby's camera preview on a computer: a
  rule-of-thirds grid to frame yourself by. It is drawn on your own screen only
  and is never in a recording.
- A **rundown** for the host: write the show's segments in the call, one per line, and
  step through them during a take, one press a segment. Each segment that starts is a
  chapter marker with its name, so the take's chapters file is the rundown with the
  real times. It is kept in the host's browser, one per room, and never sent to anyone.
  A line can end in a planned length (`Interview 20:00`): the running segment's clock
  counts against it and says by how much the segment is over.
  Any segment can be started next from the list beside the button, which is how a take
  resumed after a reload goes on with its rundown.
- When part of a guest's recording did not reach the host during a take, the guest's
  page offers its backup to the host as soon as the host ends the take, with no
  rejoin; the host gets the usual **Save to folder** question.
- **Send my recording later**, in a guest's camera menu, for a weak connection: the
  take stays on the guest's device while it records, so it does not compete with the
  call, and is offered to the host when the take ends.
- **Microphone only**, under the lobby's preview: join with your microphone and no
  camera. For a person who has no camera, whose camera is blocked or busy, or whose
  computer struggles with video. Pressing it again opens the camera as well. It is off
  while the camera and microphone are still being opened.
- A person who joined with the microphone only is heard by everyone and shown by their
  initial, and is recorded like everyone else: the WAV master, and an MP4 under the usual
  name that holds their compressed audio and no picture; their in-browser backup is the
  same pair. Their camera button is off for that call, and its menu says how to
  get a camera: leave and join again. The session summary and `sync.json` (`audioOnly`)
  name such files as audio only, print no pairing or frame-rate command for them, and
  name a guest's once that guest's recording has finished cleanly.
- A lossless **FLAC copy** of each WAV master, usually a smaller file: `sync.json` (`flac`)
  and the session summary give an `ffmpeg` command per WAV that writes a FLAC beside
  it, and one that checks the copy against the WAV (two equal MD5 lines) before the
  WAV is deleted. openMeet still records WAV, and converts and deletes nothing itself.
  A take saved from a crash copy lists the host's WAV, and its commands, only when the
  file is in the folder.
- The `.json` note beside a returned WAV backup holds the same two `ffmpeg` commands for
  that file: one writes a lossless FLAC copy, one checks it before the WAV is deleted.
- `sync.json` gains a `clock` section: for each guest, the clock estimate its start
  offset comes from, the round trip that bounds its error and when the host received it.
- A guest's browser measures the clock difference to the host again as its recording
  stops. `sync.json` (`clock`) then gives a start and an end offset for that guest, how
  far the two computers' clocks moved in between and within what error. It compares
  the computers' clocks, not how the audio or video in a file keeps time.
  Its note says what a computer clock that is set during a take shows as.
- A take resumed after a host reload keeps each guest's clock estimate from before the
  reload as its start, so `sync.json` (`clock`) covers the whole take, and a take saved
  from its crash copy says when its estimate was taken.
- **Pause** for the host during a take. The take is saved and closed exactly as with
  End & save, so nothing is recorded during the break and the part so far is safe on
  disk. The page reads "Paused", and **Continue** records the next part as a new take
  in the same folder, after the usual countdown and with the recording notice shown
  again. A paused session is one take per part, not one file with a gap in it.

### Changed

- Audio is recorded at 48 kHz for everyone. A microphone that runs at another
  rate (44.1 kHz, or 16 kHz over Bluetooth) is resampled, so every WAV master
  and camera MP4 has the same sample rate.
- After a take, one warning says how many files are not complete, replacing the
  single integrity line about the guests' camera files and the "ended early"
  notes. In the sync file, `integrity` and `guests[].integrity` carry the new
  wording; the `endedEarly` flags are unchanged.
- Each camera backup is encoded at the same bitrate as the file it backs up
  (it was 5 Mbps at every resolution).
- Audio is recorded in mono by default, which halves the uncompressed master
  (about 518 MB per hour per person). A take started with the media board open
  has a two-channel audio track in its camera MP4, so stereo pads keep their
  stereo; the voice is the same on both channels and the WAV master stays mono.
- The host's recording files carry the host's name after the role:
  `host-ana_<id>.mp4` instead of `host_<id>.mp4`.
- The recording folder is asked for with write access when it is chosen, so the
  browser does not ask again when the first file is saved; and if the browser
  later refuses to write to that folder, the next Record asks for a folder again.
- After **Record** is pressed the take starts three seconds later, and Record
  cannot be pressed again meanwhile. The recording folder is asked for first.
- **Record another take** is offered when everyone else has left too, and records the
  host alone, in place of the Copy invite link the summary showed then. A host with
  nobody else in the room can present, and the screen is recorded to its own file.
- Clock sync keeps asking until the host answers, instead of giving up after about
  eight seconds, and carries on over a reconnect. A guest whose first seconds went
  unanswered gets a start offset in `sync.json`, where it said to align by waveform.
- A media board opened during a take is recorded in that take: pads fired from
  then on are in its camera MP4 and its backup, where they used to be recorded
  only from the next take. The WAV master still holds the microphone alone.
  What a pad plays while your microphone is off is not recorded in that one
  take, and the board says so while it is off.

### Fixed

- Browser storage that does not answer cannot hold up a guest's stop:
  the backup waits five seconds for it, then continues in memory with the usual
  warning. A screen backup held in memory says so as the camera backup does, and
  a guest whose backup is in memory only is told to download it, not to rejoin.
- The lobby lets go of a camera or microphone that arrives after Join, Present
  only or leaving the page, and of one opened twice in development. After
  Microphone only, answering "Headphones or speakers?" does not bring back the
  camera error from the first try, and Try again asks for the microphone alone.
  Join is off while any capture change is being opened, and a press of Join
  that came before the change waits: press it again once the preview is back.
  While the microphone reopens, the lobby keeps showing Microphone only.
- The WAV recording from a computer that stalls during a take stays as long as
  the MP4. Frames that were only late used to get silence added in front of
  them, which made the WAV longer than the take.
- A screen file of the second take or later ends in `_take<n>`, as the other
  files of that take do: `host_screen_<id>_take2.mp4`,
  `guest_screen_<id>_2_take2.mp4`.
- A take ended while someone was presenting could show their screen recording
  as incomplete, or a "Recording failed" line, though the file was whole. The
  screen file reads complete and the summary is written.
- A media board shown again after everyone else left and came back is not
  taken for one opened during that take: the call screen remembers it, so the
  "mic only" line is not shown under the pads when the pads are in the take.
- A guest's own backup stops recording the moment a take ends. When the
  guest's stream to the host had died, the backup used to keep recording for up
  to 30 seconds after the take while the stream waited to be sent.
- Files downloaded from the screen shown after leaving a call are named for the
  room, the take and the person, like the ones downloaded in the call, and a
  name written with combining marks (Devanagari, Thai, Arabic) stays whole in a
  download name.
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
- A take in which no guest was recorded no longer leaves an empty
  `guest_<id>.mp4` in the recording folder, or warnings about it in the
  summary.
- A guest whose recording had started in their own browser but had not yet reached
  the host is no longer left with the camera on behind a screen that says the room
  is gone, full, or that the host removed them. That recording is ended and its
  backup kept.
- A guest who joined after the host's connection to the room had dropped and come back
  during a take was not recorded, and was not told the call was being recorded. The
  host's page says the take is still running as soon as it is back.
- A media board pad whose file name is longer than 200 characters keeps its chapter
  marker in a take that is resumed or recovered after a reload, and keeps its label
  when a guest fires it. The label is cut to 200 characters.
- In a call of three or more, the first other person's tile shows that person:
  their own camera and their own sound. When a later person's camera arrived
  before the first person's, the tile showed that later person, who was then
  seen in two tiles and heard twice, until the first person's own camera
  arrived, or for good if it never did. In a call of any size, after this tab
  reconnected, that tile kept the picture of a connection that had closed
  until a camera arrived again.
- When someone leaves a call, everyone still in it keeps their tile. With a
  Present-only device listed ahead of the people still on camera, the first of
  them was not drawn at all, and so neither seen nor heard in that tab, until
  any person's camera reached that tab again. No file was affected.
- In a call of three or more, a person whose camera has not reached this tab
  yet has a tile with their initial under their own name, wherever the room
  lists them. The first tile takes its name and its microphone and camera
  badges only from the person it shows: for a moment after a join it could
  show those of a Present-only device listed before that person.
- A tab the room has closed for good (the host removed it, another tab took its
  place, the room was full or is gone) does not connect to the room again in the
  background. A host tab that was taken over during a take stays out instead of
  taking the call back, and a guest in that state who presses **Stop and save** gets
  their backup links instead of a "Recording" label that never cleared.
- After the host reloads and resumes a take, **End & save** does not wait for a guest
  whose stream had stopped because it fell too far behind: the guest's page says so
  again when the host's page asks, and the file reads as stopped, not as missing its end.
- A guest's WAV that was cut off (a take saved after the host's browser crashed, or a
  guest who dropped out) declares whole samples only, because a header that counts part
  of a last sample makes `ffmpeg` print `Invalid PCM packet` for every command run on
  that file, the FLAC check among them. This holds for a guest cut off again after a
  resume too.
- **M** and **N** do nothing while a list has the keyboard. A letter typed to choose from a
  list, the chat's **To** list among them, used to add a chapter marker or open the note
  field as well.
- Pressing **Join now** while the lobby was still opening a camera or microphone you
  had just asked for joined you with a stream that went silent a moment later, and left
  the new capture open. You join with what is open at that moment, and nothing stays
  open behind you.
- A guest's WAV in a take that was resumed after a reload declares all the audio the
  file holds when that guest never sent again. A header that counts only the part the
  crash copy held makes players, editors and the FLAC copy stop a few seconds early.
- A take saved from the lobby after a crash in its first seconds has a guest WAV that
  declares its audio. When the crash copy held only the first part of the file, the WAV
  kept its placeholder header, which declares no audio at all.
- Clock sync takes no estimate from an exchange during which the guest's computer clock
  was set back. A guest whose clock was corrected at such a moment, in the few seconds
  of measurement, got an alignment offset in `sync.json` wrong by half the correction,
  which can be seconds. That guest gets the estimate from before the correction, or
  none, and the file then says to align by waveform.

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
