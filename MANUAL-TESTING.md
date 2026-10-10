# Manual test checklist

Everything automation cannot prove. Tick each box as you verify it; write the
result in the Notes column so a half-finished pass is still useful to the next
person.

**Why this exists:** `pnpm test` passes on code that cannot record at all. It
has done so twice in this project's history — once when every chunk exceeded the
DataChannel message limit, and once when the deployed bundle called `localhost`.
A green suite means the units behave; it says nothing about whether a recording
lands on disk.

---

## Setup

You need **two separate browser profiles** (not two tabs — the host token lives
in `localStorage`, so a second tab of the same profile is also the host).

```bash
pnpm install
pnpm --filter @openmeet/worker db:migrate:local
pnpm --filter @openmeet/worker dev     # terminal 1 → :8787
pnpm --filter @openmeet/web dev        # terminal 2 → :3000
```

- **Host:** normal Chrome window. Click **New Room**.
- **Guest:** a second Chrome profile, or Incognito, opening the invite link.

Record with **Chromium**: Chrome, Edge, Arc or Opera (Brave hosts only after
enabling brave://flags/#file-system-access-api). Firefox can't record. Safari can't
host, and a Safari guest is recorded as video only (no WAV).

Keep DevTools **Console open on both sides** for every test below. Most of the
bugs this checklist targets are silent by nature — the console is where they
show up first, if at all.

### Inspecting the output

```bash
ffprobe -v error -show_entries format=duration,size \
  -show_entries stream=codec_name,width,height,sample_rate \
  -of default=noprint_wrappers=1 <file>
```

For a WAV, check the header's declared size matches the file:

```bash
python3 - <<'EOF'
import struct, os, sys
f = sys.argv[1] if len(sys.argv) > 1 else input('wav path: ')
d = open(f,'rb').read(48)
print('declared data =', struct.unpack('<I', d[40:44])[0])
print('actual data   =', os.path.getsize(f) - 44)
EOF
```

---

## 1 — The basics

| # | Test | How | Expect | ✅ | Notes |
|---|---|---|---|:--:|---|
| 1.1 | Room creation | Click **New Room** | Lands on `/r/<slug>/`, no console errors | ☐ | |
| 1.2 | Green room | Look at the pre-join panel | Mic meter moves when you speak; disk hours shown; "This browser can record MP4" | ☐ | |
| 1.3 | Join gate | Try Join with an empty name | Button disabled | ☐ | |
| 1.4 | Two-way call | Guest opens the invite link and joins | Both see each other's video and hear audio | ☐ | |
| 1.5 | Mic / camera toggles | Toggle each on both sides | Remote tile updates within a second | ☐ | |
| 1.6 | Chat | Send both directions | Arrives both ways | ☐ | |
| 1.7 | Chat pop-up | Close the chat panel on one side, send from the other | A pop-up with the sender and message for a few seconds; the Chat button shows an unread dot (its tooltip reads 'Chat, N unread'); opening chat clears both | ☐ | |
| 1.8 | Blocked camera in the lobby | Block camera and mic for the site, reload the room | The preview says "Camera and mic are blocked", with **Try again**. Allow both again, click **Try again**: the preview comes back without a reload | ☐ | |
| 1.9 | 404 page | Open `/no-such-page` | "Page not found" with a link home — not a blank page | ☐ | |

## 2 — Recording, the happy path

| # | Test | How | Expect | ✅ | Notes |
|---|---|---|---|:--:|---|
| 2.1 | Only the host can start | Look at the guest's control bar | **No** Record button; a line saying the host starts recording | ☐ | |
| 2.2 | Consent notice | Host clicks **Record** | Guest sees "This call and chat are now being recorded" toast **and** a persistent REC pill | ☐ | |
| 2.3 | Guest auto-starts | Watch the guest after 2.2 | Guest's own bar shows recording controls — nobody clicked anything there | ☐ | |
| 2.4 | One folder prompt | Watch the host | Exactly **one** folder picker, not two; the browser's question about saving to that folder comes with it, and nothing more is asked when the files are created | ☐ | |
| 2.5 | Files appear | Record ~60 s, click **End & save** | `host-<your name>_*.mp4`, `host-<your name>_*.wav`, `guest_*.mp4`, `guest_*.wav`, `call1_*.m4a` | ☐ | |
| 2.6 | All of them play | Open each in a video player | All play; the guest MP4 is the one that crossed the network | ☐ | |
| 2.7 | Integrity | Read the summary screen | "Every file is complete."; each guest file reads "Complete. Matches what <name> sent (SHA-256)." | ☐ | |
| 2.8 | WAV is honest | Run the python snippet above on both WAVs | `declared data == actual data` | ☐ | |
| 2.9 | Alignment | Read the summary | An offset in ms, not "align by waveform" | ☐ | |
| 2.10 | Durations match | `ffprobe` each file | Within ~1 s of how long you recorded | ☐ | |
| 2.11 | Call copy has the guest's voice | Play `call1_*.m4a` from the take above (VLC, or drop it on a browser tab) | The guest is audible from start to end, at call quality | ☐ | |
| 2.12 | Folder access taken back | After a take, use the browser's site settings (the icon in the address bar) to remove openMeet's access to the recording folder, then press **Record another take**, and after the message press **Record** again | The first press says permission to write to that folder was denied; the second opens the folder picker, and the take records into the folder chosen there | ☐ | |
| 2.13 | Countdown | On a fresh browser profile, host clicks **Record** and chooses a folder | The folder prompt comes first; then the host's screen reads "Recording starts in 3", 2, 1 with Record greyed out, and only then the Recording pill appears; nothing else is asked when the take starts | ☐ | |
| 2.14 | Countdown for everyone | With a guest and a producer in the call, host clicks **Record** | All three screens read "Recording starts in 3", 2, 1; then the guest sees the red notice and the REC pill. A guest who joins during the count sees no count and is recorded from the start of the take | ☐ | |

## 3 — Data loss (the ones that matter most)

Each row here is a bug that shipped. All of them failed **silently** — the UI
kept saying "Recording".

| # | Test | How | Expect | ✅ | Notes |
|---|---|---|---|:--:|---|
| 3.1 | Guest wifi drop | Record 30 s. Disable the guest's wifi ~5 s, re-enable. Record 30 s more. **End & save** | Host keeps the call (no "the other person left" screen). Files still play | ☐ | |
| 3.2 | Guest closes the tab mid-recording | Record 30 s, close the guest tab, host clicks **End & save** | Host's own files are complete. Guest file is partial but **plays** | ☐ | |
| 3.3 | Host closes the tab mid-recording | Record 30 s, close the host tab entirely | Every file is non-zero — **including both WAVs**. This is the one that used to leave 6 of 8 files empty | ☐ | |
| 3.4 | Leave instead of End & save | Record 30 s, host clicks **Leave call** | Files are still finalized and play | ☐ | |
| 3.5 | Long recording | Record **5+ minutes** | No gaps or freezes mid-file. Scrub through the whole guest MP4 | ☐ | |
| 3.6 | Very long WAV *(optional, slow)* | Record **4+ hours** | WAV reports its real duration, not ~51 min | ☐ | |
| 3.7 | Disk pressure | Fill the host disk to near-full, then record | A visible disk error — not a silent stop | ☐ | |
| 3.8 | Return a backup | Guest records a take, host ends it, guest leaves, reopens the link, presses **Send to host** on the row and joins; host presses **Save to folder** | `backup_…mp4` and `backup_…json` in the folder; the mp4 plays; both sides say saved and verified | ☐ | |
| 3.9 | Return a backup across a reconnect | During a large transfer, turn the guest's network off for 10 s | The transfer continues and still verifies | ☐ | |
| 3.10 | Save from the lobby after a host crash | Record 30 s, close the host tab, reopen the room, press **Save to folder** on the **Unsaved recording** row | The guests' files and the host's own copies land in the folder with `sync_…json` beside them; the 2.8 snippet on each WAV prints `declared data == actual data` | ☐ | |
| 3.11 | **Resume recording** | With the guests still connected, reload the host tab and press **Resume recording** in the in-call notice | The same take id is re-announced, and the host's copies of the guests' files continue from where they stopped; after the take the folder holds `host-<your name>_<id>.mp4` and `host_<id>_resumed.mp4`, and the summary lists both, the markers placed before the reload, and any screen recording from before it | ☐ | |
| 3.12 | Guest tab through the host's reload | Keep the guest tab open while the host reloads and resumes | The guest's next fragments land after the resume, and its own backup is untouched | ☐ | |
| 3.13 | Save to a folder that is too small | After a host crash (as in the row *Save from the lobby after a host crash*), press **Save to folder** and pick a folder on a drive with less free space than the row's size | The lobby names the files that were not saved and the **Unsaved recording** row stays; a second **Save to folder** into a folder with room puts every file there and the row goes | ☐ | |
| 3.14 | Save instead of resuming | With a guest still connected, reload the host tab mid-take, join again and press **Save what was recorded** | The files land in the folder and the notice goes; the guest's page leaves **Recording** by itself. Pressing **Resume recording** or **Save what was recorded** twice does nothing the second time | ☐ | |
| 3.15 | Screen share across a resume | A guest is sharing a screen when the host tab is reloaded; the host joins again and presses **Resume recording** | The host is told that person's screen is not recorded until they stop and share again; after they do, and after **End & save**, the screen file from before the reload and the new one are both in the folder and in the summary | ☐ | |

## 4 — Multiple takes

| # | Test | How | Expect | ✅ | Notes |
|---|---|---|---|:--:|---|
| 4.1 | Second take | After a take, click **Record another take** | Record is greyed out for three seconds and recording starts, with **no** second folder prompt | ☐ | |
| 4.2 | Take 2 filenames | Look at the folder | `*_take2.*`; take 1's files untouched | ☐ | |
| 4.3 | Guest is in take 2 | Check `guest_*_take2.mp4` | Exists and plays. *(This silently failed once — the guest sat out every take after the first)* | ☐ | |
| 4.4 | Summary survives | After ending take 2 | Summary still lists both takes with durations | ☐ | |
| 4.5 | Summary beside the stage | After **End & save**, look at the host's screen | The summary opens as a column beside the call (a sheet on a phone); the call stays visible; closing it and reopening from the Summary button works; **Download sync.json** and **Download chapters** save files | ☐ | |
| 4.6 | Nobody left to record | Guest leaves, then look at the summary | Its main button reads **Copy invite link** instead of Record another take, and the summary stays open | ☐ | |

## 5 — Screen share

Not covered by the automated test at all.

| # | Test | How | Expect | ✅ | Notes |
|---|---|---|---|:--:|---|
| 5.1 | Share appears | Guest clicks **Present screen** | Host sees the screen in the spotlight | ☐ | |
| 5.2 | Recorded as its own track | Share during a recording, then End & save | A `*_screen_*.mp4` exists and plays | ☐ | |
| 5.3 | Repeated shares | Start/stop sharing 3× during one recording | 3 numbered screen files, none overwritten | ☐ | |
| 5.4 | Already sharing when Record is pressed | Start sharing, *then* Record | Screen file exists from the start | ☐ | |
| 5.5 | Sharing when the recording ends | Share, then End & save without stopping | Screen file is finalized and plays | ☐ | |
| 5.6 | Phone presents a photo or video | Join from a phone as a guest, tap **Present**, pick **A photo or video** | Everyone sees it in the spotlight; the phone sees it too. During a recording it lands as a `guest_screen_*.mp4` | ☐ | |
| 5.7 | Phone presents its rear camera | Tap **Present**, pick **Rear camera**, then stop presenting | Everyone sees the rear camera; stopping brings the face camera back | ☐ | |
| 5.8 | Present only, laptop + phone | Phone joins as a guest. A laptop in another profile opens the invite link, chooses **Present only** and picks a screen. Host records ~30 s | The laptop has no camera tile; its screen shows as "*name* (Presenting)". The folder has the phone's files plus a `guest_screen_*.mp4` from the laptop, and no camera or WAV file from the laptop | ☐ | |
| 5.9 | Computer presents a photo or video | On a computer, click the arrow beside **Present**, pick **A photo or video** and choose a video with sound; then do the same with a photo during a recording | Everyone else sees it in the spotlight and hears the video; the presenter sees it labelled "What you're presenting"; **Stop presenting** ends it. The photo shown during the recording lands as a `*_screen_*.mp4` | ☐ | |
| 5.10 | Presenter hears a presented video | With headphones on, present a video with sound from a computer; then from a phone; then from a laptop joined with **Present only** | The computer hears the video; the phone and the Present-only laptop show it in silence. Everyone else hears it each time | ☐ | |

## 6 — Mesh (3–4 people)

Also not covered automatically. Needs 3 browser profiles.

| # | Test | How | Expect | ✅ | Notes |
|---|---|---|---|:--:|---|
| 6.1 | Three-way call | Host + 2 guests | Everyone sees everyone; grid layout | ☐ | |
| 6.2 | Separate files per guest | Record, End & save | `guest_*` **and** `guest2_*` — both play. *If one file is corrupt, two streams were interleaved* | ☐ | |
| 6.3 | Host joins **last** | Both guests join an empty room first, host joins last, then records | All files land on disk. *This silently produced nothing before* | ☐ | |
| 6.4 | **Screen share reaches everyone** | With 4 in the room, one person presents | **All three** others see it. *Only one did before* | ☐ | |
| 6.5 | Four-way is smooth | 4 people, all cameras on, someone presenting | No jitter or lag. Upload stays ~4 Mbps, not ~16 | ☐ | |
| 6.6 | Capacity | Try a 5th recorded participant | "This room is full" screen with **Try again** | ☐ | |
| 6.7 | Producer | Join with `?producer=1` on the invite link | No camera or mic; can chat and present; never recorded; doesn't take a recorded seat | ☐ | |
| 6.8 | Unrecorded slots are shared | Fill both unrecorded slots (two producers, or one producer and one Present-only screen), then add a third | The third gets "This room is full" | ☐ | |
| 6.9 | Producer and Present-only links | As host, alone in the waiting room, click the arrow beside **Copy invite link**. Press **Copy producer link** and open what was copied in a second profile; press **Copy Present-only link** and open that in a third. Press Escape. Repeat the first step on a phone | The panel says what each link is and "To record someone, send the invite link."; after a press it reads "Producer link copied." The first link opens "Join as a producer", the second "Ready to present?". Escape closes the panel. On the phone the panel is inside the screen, no text is cut off and the arrow is as tall as **Copy invite link** | ☐ | |
| 6.10 | Producer and Present-only links in the call | Host and one guest in a call, not recording. Click the arrow beside **Copy invite link** in the top bar, press **Copy Present-only link**, open what was copied in a third profile and share a screen. Then start a take. Repeat the first step with the host on a phone | The link opens "Ready to present?" and the screen appears as "*name* (Presenting)". The guest's top bar has no arrow. During the take the host's top bar has neither **Copy invite link** nor the arrow. On the phone the top bar keeps its height and the panel is inside the screen | ☐ | |

## 7 — Connection failure

| # | Test | How | Expect | ✅ | Notes |
|---|---|---|---|:--:|---|
| 7.1 | Half-open socket | Record, then suspend the laptop ~2 min, resume | Reconnects by itself. **End & save** still works | ☐ | |
| 7.2 | Worker restart | Restart `wrangler dev` mid-call | Client reconnects; chat works again after | ☐ | |
| 7.3 | Expired / bad room | Open `/r/aaa-bbbb-ccc/` | "Room not found or expired" — not a spinner | ☐ | |
| 7.4 | Fatal close mid-recording | Record, then stop `wrangler dev` entirely | Call stage **stays**, with a banner. **End & save** still saves | ☐ | |
| 7.5 | ICE failure | Join from two networks with no TURN configured | A clear "could not connect" message, not an endless spinner | ☐ | |
| 7.6 | Host opens a second tab | Not recording, open the room again in a second tab of the host's profile | The first tab shows "You joined from another tab or device" with **Use this tab instead** | ☐ | |
| 7.7 | Leaving | After a take, host clicks **Leave call** | "You left the call" with **Rejoin**, **Back to home** and download links for sync.json, chapters and backups; closing the tab asks first | ☐ | |
| 7.8 | Host opens a second tab mid-take | Recording, open the room again in a second tab of the host's profile and press **Join now** | A dialog says another tab is recording this room. **Cancel** leaves the first tab recording; after **End & save** there, **Join now** goes straight in. (**OK** takes the call over: the first tab shows the End & save banner) | ☐ | |
| 7.9 | Host opens a second tab mid-take (Present only) | Recording, second tab of the host's profile, **Present only**, pick a tab | A dialog asks; **Cancel** stops the share | ☐ | |
| 7.10 | Signalling restart with a call running | With a take running, restart `wrangler dev` | Both pages reconnect by themselves and the call comes back with one tile per person | ☐ | |
| 7.11 | One side reconnects | With a call running, move the guest's computer from Wi-Fi to a phone hotspot (or back) | The call is back within a few seconds on both sides, one tile per person, and no "Negotiation failed" message | ☐ | |

## 8 — Extras

| # | Test | How | Expect | ✅ | Notes |
|---|---|---|---|:--:|---|
| 8.1 | Teleprompter | Open it, type, play, drag it | Scrolls; drag works; position survives a reload | ☐ | |
| 8.2 | Markers | Press **M** a few times while recording | Count rises; `chapters.txt` lists them | ☐ | |
| 8.3 | Markers ignore typing | Type "m" in chat | No marker added | ☐ | |
| 8.4 | Media board | Load an audio file, fire it | Guest hears it; a marker is dropped | ☐ | |
| 8.5 | WAV master is clean | Check the WAV after 8.4 | Contains the mic **only** — no board audio baked in | ☐ | |
| 8.6 | Quality picker | Pick 720p, record, `ffprobe` | Output really is 720p | ☐ | |
| 8.7 | Device switch | Change mic in the lobby | Preview keeps working | ☐ | |
| 8.8 | Camera switch mid-take | Chromium: record, switch camera from the call's camera menu, record on | Recording doesn't stop; the MP4 plays through the switch without corruption, even if the resolution changed; a frame rate picked in the lobby is kept | ☐ | |
| 8.9 | Mic switch mid-take | Chromium: record, switch to a mic with a different sample rate (a Bluetooth headset is usually 16 or 24 kHz), record on | MP4 and WAV both play at normal speed and pitch through the switch; each WAV's duration matches its own MP4 | ☐ | |
| 8.10 | Switch mid-take on Safari / iPhone | Record, try to switch camera or mic on that side | "Switch after this take"; the take carries on; switching works once it ends | ☐ | |
| 8.11 | Track panel | Host and one guest, record, click **Tracks OK** in the top bar | The host's Camera and WAV master say **OK**, the guest's say **Receiving**, each size grows about every 2 s; opening it moves nothing; **Esc** closes it | ☐ | |
| 8.12 | Track panel stays quiet when nothing is wrong | During a take: mute the guest's mic for 30 s, turn the guest's camera off for 30 s, share a screen that does not change for 30 s | The indicator reads **Tracks starting** for a moment when the share begins and **Tracks OK** otherwise | ☐ | |
| 8.13 | Track panel flags a stalled track | During a take, disable the guest's wifi for 30 s, then re-enable it | Within about 20 s the indicator reads **Check tracks** and the guest's rows read **Not receiving for …** (or give way to one row at 0.0 MB while the guest reconnects); it returns to **Tracks OK** once the guest is back. A guest that rejoins faster than every 15 s restarts its own row, so it shows **Tracks starting** instead | ☐ | |
| 8.14 | Track panel on a phone | Join as a guest from a phone about 360 px wide, get recorded, tap the mark beside the clock | The top bar stays on one line; the list opens under it, inside the screen | ☐ | |
| 8.15 | Guest's track panel | As the guest in a take, open the indicator; then disable the guest's wifi for 30 s and re-enable it | Camera and WAV master read **Reaching the host**; within about 20 s of the drop they read **Not reaching the host for …**; once reconnected they return to **Reaching the host** (after a moment of **… MB still to send**) | ☐ | |
| 8.16 | Track alert over the open panel | Record, open the track list, then pull the recording folder's drive (or fill it) on a phone about 360 px wide | The red banner is fully readable above the open list | ☐ | |
| 8.17 | Frame-rate picker | Pick 25 fps in the lobby, record 30 s, `ffprobe` the MP4 | The lobby's "Capturing" line read `@ 25fps`; `avg_frame_rate` is about 25 | ☐ | |
| 8.18 | Bitrate picker | In the lobby pick **Bitrate: High**, join, record 30 s of a moving picture, End & save; do the same at **Standard**; `ffprobe -v error -select_streams v:0 -show_entries stream=bit_rate` each camera MP4. Do it once on each of Linux, macOS and Windows | The High file holds about 1.5 times the video bitrate of the Standard file, on both the host's and the guest's file. Note the figure itself per system: on Linux a 30 fps file holds about half the figure the picker names (see Known limitations) | ☐ | |
| 8.19 | 50 / 60 fps | On a camera that offers it, pick 1080p and 60 fps, record 30 s, `ffprobe` the MP4 and open it in an editor | The lobby showed the cost note; `avg_frame_rate` is about 60 and the video bit rate is well above a 30 fps take's (about 1.5 times where the encoder uses the real frame rate, about 3 times on Linux); it plays and scrubs. A camera capped at 30 lists no 50 or 60 | ☐ | |
| 8.20 | Do not record | As host with two guests, open the arrow beside **Record**, untick one guest, record 30 s, End & save | That guest reads "The host has set you as not recorded…"; everyone else reads "<name> is not being recorded."; the folder has no file and no call copy from that guest, and their chat lines are not in `chat_*.txt`; their browser offers no backup | ☐ | |
| 8.21 | Do not record, after a host reload | Record with two guests, reload the host tab mid-take, join again | While "Recording was interrupted" is shown there is **no** arrow beside Record; it returns after **Resume recording** and End & save (or after **Save what was recorded**) | ☐ | |
| 8.22 | Media board loop | Load a clip a few seconds long, press **Loop** under it, fire it, wait three times its length, then click the pad. Fire it again and press **Loop** off while it plays | It repeats and stays lit until the click, and the guest hears it repeat; with Loop off it runs to its end and stops. During a recording, one marker per fire | ☐ | |
| 8.23 | Media board fade | Press **Fade** under a pad, fire it, click it to stop; then fire it again and click it twice | It comes in and goes out over about a second and a half and stays lit until it is silent; the second click cuts it at once. The guest hears the same | ☐ | |
| 8.24 | Stop incoming video | Two people in a call, cameras on. One opens the arrow beside the camera button and ticks **Stop incoming video**; after 10 s opens it again and unticks it. Repeat on a phone | Ticked: that person sees the other as an initial with the name tag and still hears them; the other still sees and hears that person, and in `chrome://webrtc-internals` on the other's side the outbound video to that person stops growing. Unticked: the picture is back within a few seconds. On the phone the item is the first line of the menu, in sight without scrolling | ☐ | |
| 8.25 | Stop incoming video during a take | Host and one guest record. The guest ticks **Stop incoming video** for about 20 s and unticks it; then the host does the same; End & save | The take never stops and no banner appears; every file reads complete in the summary; the folder holds one `call1_*` file for the guest, not two | ☐ | |
| 8.26 | Incoming video stays stopped | Three profiles. One ticks **Stop incoming video**; then a third person joins; then one of the others reloads and joins again; then restart `wrangler dev` and wait for the call to come back; then one of the others presents a browser tab that plays sound | Each newcomer is an initial from the first moment and is heard; after the restart every tile is an initial again without touching the menu. When the tab is presented the stage changes to the presenting layout, the presented picture is not shown and the tab's sound is heard. In `chrome://webrtc-internals` on that person's side no inbound video stream receives bytes. Unticking brings every picture back | ☐ | |
| 8.27 | Stop incoming video, with a presentation | Two people. One ticks **Stop incoming video**; only then the other presents a browser tab that plays sound. Then press **Show video** in the spotlight. Repeat on a phone about 360 px wide and press the **Show video** in the line above the stage instead | A line above the stage reads "Incoming video is off. You still hear everyone, and the recording is not affected." The spotlight shows the screen's name, "Incoming video is off, so you can’t see it." and **Show video**, and the tab's sound is heard. Either **Show video** brings the screen and the cameras back and removes the line. On the phone the line wraps inside the screen and nothing scrolls sideways | ☐ | |
| 8.28 | Ready sounds | With the browser's network panel open, open the media board with nothing loaded. Click **+ Chime**, **+ Rimshot** and **+ Soft bed**, fire each, then click Soft bed to stop it. Repeat on a phone, this time adding **+ Soft bed** while a recording runs | Each click adds one pad and its button goes away; no network request is made. The guest hears three rising notes, then two drums and a cymbal, then a quiet chord; Soft bed arrives with **Loop** and **Fade** lit, repeats with no click where it loops, and fades out when stopped. None of them is too loud over a voice. During a recording each fire drops a marker with the sound's name. On the phone "Ready sounds" is on a line of its own with the three buttons under it, and adding Soft bed during the recording brings up no "struggling to keep up" notice; with five files of your own loaded first, the row is the first thing in the list of pads, scrolls with them, and the board reaches no higher on the screen than it does without the row | ☐ | |
| 8.29 | Ready sound from a file | In a scratch checkout put a short audio file in `apps/web/public/sounds/`, list it in `apps/web/lib/sound-files.ts`, build and serve the site. With the network panel open, open the media board, add the three computed sounds, then click the file's button. Tick **Disable cache** in the network panel, delete the file from the served folder, reload and click its button again | The file's button comes after **+ Soft bed**. The network panel shows no request under `/sounds/` until that button is clicked and exactly one after; the pad shows the file's length and the guest hears it. With the file gone the panel reads "Could not add …" and the button stays | ☐ | |
| 8.30 | Marker with a note | Host and guest record. Host presses **N**, types "great answer", Enter; clicks the pencil button beside the marker button, types "cut this", clicks **Add**; presses **N** then Escape; types "n" and "m" in chat. The guest adds one note the same way. End & save | The field opens empty with the cursor in it and closes each time; the marker count rises once per note and not for Escape or the chat letters; `chapters_<id>.txt` has a line ending "great answer", one ending "cut this" and the guest's; `sync_<id>.json` lists them under `markers`; the summary shows them under Chapters | ☐ | |
| 8.31 | Marker note on a phone | Join as a guest from a phone about 360 px wide, get recorded, tap the pencil button, type a note, tap **Add** | The field is one line across the top of the stage, inside the screen, with the keyboard below it; the control bar keeps two rows; the host's chapters file has the note | ☐ | |
| 8.32 | Marker note after a reload | Record with a guest, add a note, reload the host tab, join, press **Resume recording**, add a second note, End & save. Then record again, add a note, reload, and press **Save to folder** in the lobby | Both notes are in the chapters file of the resumed take; the lobby's save writes a chapters file with the note | ☐ | |
| 8.33 | A note marks the moment it was started | As host, record; when the timer reads 0:10 press **N**, wait until 0:20, type a note, Enter. Have the guest do the same at 0:30 and 0:40. Then, as host, add a note that is a pasted link of about 150 characters. End & save | In `chapters_<id>.txt` the host's note is at 0:10 or 0:11; the guest's is at about 0:40. In the summary the link wraps inside the Chapters list, and the summary does not scroll sideways | ☐ | |
| 8.34 | Long pad name | Load an audio file whose name is about 210 characters long into the media board, fire it during a take, reload the host tab and press **Save to folder** in the lobby | The chapters file the save writes has that marker, with the first 200 characters of the name | ☐ | |
| 8.30 | Speaker picker | On a computer with two outputs (speakers and headphones), in a call with a guest who talks: open the arrow beside the mic button and pick the other output under **Speaker**. Have the guest present a screen with sound. Reload the tab, join again and open the arrow | The guest's voice moves to the chosen output at once, and so does the sound of the screen they present; nothing is heard on the other output when the screen share starts or stops; the select is the first line of the menu. After the reload it still shows the chosen output and the call plays there. A recording made meanwhile is unchanged | ☐ | |
| 8.31 | Speaker in the lobby | On a computer with two outputs, pick the other one in the lobby's **Speaker** row, join a call with a guest who talks, and open the arrow beside the mic button. Repeat the lobby on a phone | The guest is heard on the chosen output from the first word, and the menu's select shows the same output. On the phone the row is one full-width line under Microphone, or absent where the browser cannot switch outputs | ☐ | |
| 8.32 | Chosen speaker goes away | In a call with two guests who talk, choose headphones as the speaker; have one guest leave and present a screen from the other, then open the arrow beside the mic button. Then unplug the headphones or switch them off | After the guest left and the screen started, the select still shows the headphones and the call still plays there. After the unplug the voice comes back on the system default within a second or two and the select shows **System default**. No banner, and a take that is recording goes on | ☐ | |
| 8.33 | Pads and a presented video on the chosen speaker | On a computer with two outputs, choose the one that is not the system default as the speaker. Open the media board and fire a pad; present a video with sound from the arrow beside **Present**. Switch the speaker while each plays, during a take. Then fire a pad with **System default** chosen | Each is heard on the chosen output and moves with the switch, with no echo of your own voice; with the system default it is heard at once, with no delay you notice. The guest hears both throughout, and the take's host MP4 and screen file play through the switches without a gap | ☐ | |
| 8.34 | Levels | Three people in a call. One clicks **Levels** in the control bar and drags one person's fader to 20%, to 0% and back to 100%; then leaves it at 20% and clicks **Hide levels**. Repeat on a phone about 390 px wide | That person gets quieter, silent and back for this listener only; the other two hear each other as before. Hidden, the level holds and the button carries a dot. On the phone the panel is above the control bar and inside the screen, each fader is easy to drag, and the bar still has two rows | ☐ | |
| 8.35 | Levels during a take | Host and one guest record. The host sets the guest's fader to 20% for about 20 s, then back to 100%; End & save | The take never stops and no banner appears; the guest's `guest_*.mp4`, `guest_*.wav` and `call1_*` file are equally loud all the way through, with no dip where the fader was down | ☐ | |
| 8.36 | Level meters | Three people in a call. One opens **Levels** while the others talk in turn, then drags a talking person's fader to 0%, then mutes that person's mic on their side | Each bar moves when its person talks and falls back when they stop; at 0% the bar still moves although nothing is heard; a muted person's bar stays empty. After **Hide levels** and **Levels** again the bars move again | ☐ | |

## 9 — Deploy

| # | Test | How | Expect | ✅ | Notes |
|---|---|---|---|:--:|---|
| 9.1 | Installer, local | `sh install.sh --local` | Clones, installs, migrates, prints run instructions | ☐ | |
| 9.2 | Installer, deploy | `sh install.sh` on a clean machine | Logs in, provisions, prints a live URL | ☐ | |
| 9.3 | Re-run is safe | Run it twice | Reuses what exists; no duplicates | ☐ | |
| 9.4 | Build guard | `pnpm build` with no `NEXT_PUBLIC_API_BASE` | Fails loudly with the command to run | ☐ | |
| 9.5 | Deployed build talks to the Worker | Open the deployed site, console open | **No** `localhost:8787` requests | ☐ | |
| 9.6 | Sponsor wall off | No Polar values set; open `/` | The plain landing page (headline, New Room, footer). `$WORKER/api/sponsors` returns `{"checkoutUrl":null,"sponsors":[],"available":1}` | ☐ | |
| 9.7 | Sponsor wall on | Set the three Polar values (a sandbox token with `POLAR_API_BASE` works), approve a sponsor who paid ≥ $25; open `/` and `/?sponsored=1` | A second column with the wall; the sponsor's tile appears (within 10 min); the open area links to the checkout; `?sponsored=1` shows the thank-you note | ☐ | |

## 10 — Security

| # | Test | How | Expect | ✅ | Notes |
|---|---|---|---|:--:|---|
| 10.1 | Guest cannot forge integrity | From the guest console, send `recording-completed` for the host's `recordingId` | D1 row unchanged (message is ignored; guests write nothing to D1) | ☐ | |
| 10.2 | Malformed slug | `curl -i "$WORKER/ws/r/NOT_A_SLUG" -H "Upgrade: websocket"` | 400, no Durable Object created | ☐ | |
| 10.3 | Recordings API needs the host token | `curl "$WORKER/api/recordings/<id>"` with no auth (the id must be the host's recording id; any other id is 404) | 401 | ☐ | |
| 10.4 | CORS is single-origin | Request with a wrong `Origin` | No CORS headers back | ☐ | |

---

## Known limitations — not bugs, do not file

- **Recording needs Chromium.** Firefox can't record. Safari can't host, and a
  Safari guest is recorded as video only (no WAV). Brave hosts only after enabling
  brave://flags/#file-system-access-api.
- **A camera file can hold less than the bitrate its level names.** The figure in the
  lobby ("up to 5 Mbps") is what the encoder is asked for. Chrome on Linux has only a
  software H.264 encoder, which spends that figure over 60 frames a second whatever the
  camera delivers: a 30 fps file holds about half of it, a 24 fps file about 40%.
  Not measured on macOS or Windows.
- **Phones can't share a screen.** They present a photo, a video or the rear
  camera; a real screen comes from a second device joined with **Present only**.
- **Mid-take camera or mic switching needs Chromium.** Safari and iPhone switch
  between takes.
- **A screen share across a full WebSocket reconnect continues in a new numbered
  segment.** Camera and WAV resume into the same files; the interrupted segment's
  tail is only in the sharer's screen backup, and the summary marks it incomplete.
- **A second host tab mid-take asks before it takes the call over.** If the host
  joins there anyway, the first tab's files end there; the rest of each guest's
  part is only in that guest's backup.
- **The media board, if first opened during a take, isn't in that take's MP4.**
  Pads still play live and drop markers; the next take includes them.
- **A take with the media board open has two audio channels in its camera MP4,**
  also when the lobby says Mono, so stereo pads keep their stereo. The voice is
  the same on both channels, and the WAV master stays mono.
- **Clock sync needs the host recording within ~8 s of the guest.** Otherwise
  `sync.json` has no offset and says to align by waveform.
- **WAV past 4 GiB** (~4 h 08 m at 24-bit/48 kHz stereo) declares a clamped
  size. It plays in full; the header just cannot express the real number
  without RF64.
- **No TURN configured** means two people behind strict NATs cannot connect.

## When something fails

1. Grab **both** consoles — most failures here are silent on one side.
2. Note the exact ordering (who joined first, who pressed what, when).
3. `ffprobe` every file produced, including the 0-byte ones.
4. Keep the folder — a partial file is evidence.
5. File it with the row number from this document.
