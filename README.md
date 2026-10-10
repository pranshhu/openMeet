# openMeet

Studio-quality remote recording that never uploads your footage.

Each person's camera and microphone are recorded locally at full quality and streamed
peer-to-peer to the **host's own disk**. No media server, no cloud bucket, no upload
step, no storage bill — the recording exists on the host's machine and nowhere else.
Self-hostable on a free Cloudflare account. MIT licensed.

> **Requires a Chromium browser** — Chrome, Edge, Arc or Opera on desktop (Brave works as host only after enabling brave://flags/#file-system-access-api).
> The host needs the File System Access API to write files, and every recorded
> participant needs `MediaRecorder` MP4 support. Firefox can do neither, so a Firefox
> guest joins the call but isn't recorded. Safari can't host; a Safari guest is recorded
> as video only (no uncompressed WAV), which is untested. Phones present a photo/video or the
> rear camera; a real screen comes from a second device joined with "Present only".

## Live demo

Try it at **<https://openmeet.pages.dev>** before you self-host. It is deployed from
`main`. Recordings go straight to the host's own disk, as on any instance; nothing is
uploaded, and the server keeps only room metadata. That includes display names and user
agents, which are kept in the demo's database (see [SECURITY.md](SECURITY.md#trust-model)
for retention).

It's one shared public instance on Cloudflare's free-tier limits, so it can hit them.
For real work, [run your own](#get-your-own-instance). The sponsor wall on its landing
page funds the project.

---

## Why this exists

Every hosted recording tool meters the same thing: how much footage you can pull back
out. That's because storing and serving multitrack video is their real cost, so it's
what they charge for.

openMeet has no such cost, because it has no storage. Bytes go from `MediaRecorder`,
over a WebRTC DataChannel, to the host's disk via the File System Access API. The
server sees signalling messages and a few rows of metadata — never a frame of video.

That also means the privacy story is structural rather than promised: there's no
retention policy to trust, because there's nothing retained.

---

## What you get

**Recording**
- Separate full-quality file per participant — nobody's track is degraded by anyone
  else's connection
- **Uncompressed 24-bit WAV** master per person, alongside the MP4, at 48 kHz
  whatever rate the microphone itself runs at — mono unless that person picks
  Stereo in the lobby
- Screen share recorded as its **own** track, one file per sharing stretch, with the
  shared tab's audio (when the browser offers it) and a crash-safe backup on the sharer
- Selectable capture quality: 720p / 1080p / 1440p / 4K, at 24, 25, 29.97 or
  30 fps, and 50 or 60 where the camera offers them
- Raw audio — echo cancellation, noise suppression and AGC are all **off** (see
  [Headphones](#headphones-really))
- Host-driven: the host presses Record once and everyone in the room is captured,
  except anyone the host has set as not recorded
- A three-second countdown on everyone's screen before each take

**During the session**
- Up to **4 recorded participants**, plus 2 unrecorded slots shared by **producers**
  (who run the session without appearing in any file) and **Present-only** screens —
  see [Producers and Present only](#producers-and-present-only)
- Teleprompter, chapter markers, and a media board for stingers, ad reads and looping
  music beds
- A typed note on a chapter marker: press **N** during a take, type a few words and
  press Enter, and the note is that marker's line in `chapters.txt`
- Three ready sounds on the media board (a chime, a rimshot and a soft looping bed),
  made in your browser: nothing to bring and nothing downloaded
- Multiple takes in one session, without a second folder prompt
- Green room: mic level, codec, free disk and TURN reachability checked before joining
- Chat with a pop-up for each new message while the panel is closed, presence, and
  screen share; a photo or a video file can be presented too (phones present those or
  the rear camera)
- Switch camera or mic mid-take without breaking the files (Chromium; on Safari and
  iPhone, switch between takes)
- A sound when a recording problem appears during a take, and a system
  notification when the tab is in the background
- A note in the call when your own microphone has sent no sound for 10 seconds
  (unplugged, muted on the device, wrong input) or keeps clipping
- Screen kept awake during a take, REC badge when the tab is hidden, and
  warnings if the tab was in the background or the battery is low
- A notice during a take when this device is struggling to keep up, with a low-power
  mode that sends the others a smaller live picture and leaves the recording alone
- **Stop incoming video** on a weak connection: the others stop sending you their
  cameras and shared screens, you still hear everyone, and your recording goes on
- A live track panel during a take: every camera, WAV and screen file with its size
  growing, and a warning when one stops getting data

**Afterwards**
- A session summary beside the stage, with one-click **Record another take**
- `sync.json` with the start-time offset between tracks, the size of every file and a
  verdict on whether it is complete, and ready-to-run `ffmpeg` commands for remuxing,
  for pairing each video with its WAV master and for aligned copies that start at
  00:00, downloaded from the summary
- `chapters.txt` if anyone dropped markers

**Optional**
- A sponsor wall on the landing page, backed by your own Polar account. Off unless
  you configure it — see [Sponsor wall](#sponsor-wall-optional)

---

## How it works

```
GUEST browser  ──WebRTC (media tracks + recording DataChannels)──▶  HOST browser
  getUserMedia                                                        getUserMedia
  MediaRecorder ──chunks──▶ DataChannel ──▶ ChunkReceiver ──▶ FileWriter ──▶ host disk
       │                                                                  │
       └────────── WebSocket signalling (SDP/ICE/chat/presence) ──────────┘
                                    │
              Cloudflare Worker (REST) + Durable Object (per-room hub) + D1 (metadata)
```

Chunks carry an absolute byte **offset**, not a sequence number, so the receiver writes
each one straight to its final position. Nothing is reassembled in memory on either
side, and retransmits are idempotent. The browser puts a file in the folder only when it
is closed, so a take cut short by a crash is rebuilt from a copy kept in the browser: see
[If the host's browser crashes](#if-the-hosts-browser-crashes).

| Package | What |
|---|---|
| `apps/worker` | Cloudflare Worker — REST API, `Room` Durable Object (WebSocket hub), D1 |
| `apps/web` | Next.js app — landing, lobby, call UI, recording engine |
| `packages/protocol` | Shared types: WS messages, chunk headers, tuning constants |
| `migrations` | D1 schema |

---

## Get your own instance

```bash
curl -fsSL https://raw.githubusercontent.com/pranshhu/openMeet/main/install.sh | sh
```

One command, start to finish. It clones the repo, installs everything, opens a browser
to log you in to Cloudflare, creates the D1 database, deploys the Worker, creates the
Pages project, builds the web app against your own Worker URL, and deploys it. You end
up at `https://<your-project>.pages.dev`.

**All you need is a Cloudflare account** — the free tier covers it — plus `git`,
Node ≥ 20.11 and pnpm. If pnpm is missing, the installer enables it with corepack
when your Node ships corepack; otherwise install it first with `npm i -g pnpm@9`.
wrangler comes in with the dependencies; apart from that pnpm shim, the installer puts nothing
on your PATH.

You'll be asked one question: what to name the project. Safe to re-run — every step
reuses whatever it already created. If your Cloudflare login can see more than one
account, name the one to use:

```bash
curl -fsSL https://raw.githubusercontent.com/pranshhu/openMeet/main/install.sh | CLOUDFLARE_ACCOUNT_ID=<account-id> sh
```

### Just want to try it first?

```bash
curl -fsSL https://raw.githubusercontent.com/pranshhu/openMeet/main/install.sh | sh -s -- --local
```

Sets up a checkout in `./openMeet` to run on localhost. No Cloudflare account,
nothing deployed. Then, in two terminals:

```bash
cd openMeet && pnpm --filter @openmeet/worker dev   # API + signalling on :8787
cd openMeet && pnpm --filter @openmeet/web dev      # web app on :3000
```

Open <http://localhost:3000>, click **New Room**, allow camera and mic, then open the
invite link in a second browser profile. Both peers join a live P2P call; the host gets
a **Record** button.

<details>
<summary>Or by hand</summary>

```bash
git clone https://github.com/pranshhu/openMeet.git && cd openMeet
pnpm install
pnpm --filter @openmeet/worker db:migrate:local
```
</details>

---

## Self-hosting

The [installer above](#get-your-own-instance) does all of this for you. This section is
what it's doing, for anyone who'd rather run the steps themselves or is deploying from
CI where the interactive login isn't available.

Everything fits inside Cloudflare's free tier. TURN relay is the only metered resource,
and only calls that can't find a direct path use it at all.

<details>
<summary>The same thing by hand — and what the script is doing</summary>

Run these from a checkout where `pnpm install` has finished.

**0 — Log in**

```bash
pnpm --filter @openmeet/worker exec wrangler login
```

In CI, skip the login: export `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
instead, and wrangler uses them.

**1 — Create the database and apply the schema**

```bash
pnpm --filter @openmeet/worker exec wrangler d1 create openmeet_db
```

Paste the printed `database_id` into `apps/worker/wrangler.toml`, then:

```bash
pnpm --filter @openmeet/worker db:migrate:remote
```

**2 — Create the Pages project and point the Worker at it**

```bash
pnpm --filter @openmeet/worker exec wrangler pages project create <your-pages-project> --production-branch main
pnpm --filter @openmeet/worker exec wrangler pages project list
```

The list shows the project's `*.pages.dev` domain; Cloudflare may add a suffix if
the name is taken. In `apps/worker/wrangler.toml`, set `PAGES_ORIGIN` to that exact
origin (`https://<domain>`). CORS is strict single-origin — scheme and host must match
exactly, or every browser request is blocked.

**3 — Deploy the Worker**

```bash
pnpm --filter @openmeet/worker run deploy
```

**4 — Build and deploy the web app**

`NEXT_PUBLIC_API_BASE` is **inlined into the bundle at build time**, so it goes on the
build command, not on the host:

```bash
NEXT_PUBLIC_API_BASE=https://<your-worker>.workers.dev pnpm --filter @openmeet/web build
pnpm --filter @openmeet/worker exec wrangler pages deploy ../web/out --project-name <your-pages-project> --branch main
```

Get this wrong and every symptom is silent — the deploy succeeds, every asset serves
200, the page renders, and the only evidence is `ERR_CONNECTION_REFUSED` in a browser
console. The build refuses to run without the variable, so that mistake can't ship.

wrangler runs from `apps/worker`, hence `../web/out`. `--branch main` makes it the
production deployment rather than a preview.

</details>

Either way, `apps/worker/wrangler.toml` ends up holding your own database id and
origin. Keep them out of commits, especially on a public fork:
`git update-index --skip-worktree apps/worker/wrangler.toml`. If a later `git pull` refuses
because upstream changed that file, run `git update-index --no-skip-worktree
apps/worker/wrangler.toml`, stash your edit, pull, then reapply it and skip it again.

### TURN — optional, but the difference between "connects" and "doesn't"

The installer does **not** set this up: it needs credentials only you can create.
Without TURN, two people behind symmetric NATs cannot connect at all. Either let
Cloudflare mint credentials:

```bash
pnpm --filter @openmeet/worker exec wrangler secret put TURN_APP_ID      # the TURN key's Token ID
pnpm --filter @openmeet/worker exec wrangler secret put TURN_API_TOKEN   # the TURN key's API token
```

…or bring your own, which removes the last metered dependency — see
[Self-hosted TURN](#self-hosted-turn) below.

### Sponsor wall (optional)

Off by default. Until it's configured, the landing page is the plain one: the
headline, **New Room**, and a link to the source. Nothing is fetched from Polar.

Turned on, the landing page gets a second column: a treemap of the sponsors you've
approved, each tile's area proportional to what they've paid and showing their logo
or name (linked to their site if they gave one), and the unclaimed area linking to
your checkout. It runs on **your own** [Polar](https://polar.sh) account, so the money
goes to you. To reword the wall's text, edit `apps/web/components/SponsorWall.tsx`
and `apps/web/app/page.tsx`.

To turn it on:

1. **In Polar**, create a product for sponsorships and a checkout link for it. Give
   the checkout custom fields with these exact keys: `sponsor_name` (required — a
   sponsor without one never shows), `sponsor_website` and `sponsor_logo_url` (both
   `https://` only; anything else is dropped). Optionally set the checkout's success
   URL to `https://<your-site>/?sponsored=1`, which shows the sponsor a thank-you note.
2. **In `apps/worker/wrangler.toml` `[vars]`**, set `POLAR_PRODUCT_ID` to the
   product's id and `SPONSOR_CHECKOUT_URL` to the checkout link. Neither is a secret.
3. **Create a read-only Polar access token** with only the `orders:read` and
   `customers:read` scopes, and store it as a Worker secret, never in a file:

   ```bash
   pnpm --filter @openmeet/worker exec wrangler secret put POLAR_ACCESS_TOKEN   # paste the token at the prompt
   ```
4. **Redeploy the Worker:** `pnpm --filter @openmeet/worker run deploy`.

The wall stays off until all three values are set. After that:

- **Nobody appears until you approve them.** In Polar, set `sponsor_approved` to
  `true` in the customer's metadata.
- **A sponsor needs at least $25 in total**, across their paid orders for the
  product, net of refunds.
- **Changes can take up to about 20 minutes to show** — the Worker caches the wall for
  10 minutes, and a returning visitor's browser can keep its copy another 10.
- **The Worker never passes on emails or amounts** — only each sponsor's name,
  links and relative tile size.
- **The wall and footer link read "Sponsor openMeet".** To collect under your own
  name, change that text in `apps/web/app/page.tsx` and
  `apps/web/components/SponsorWall.tsx`.
- To test against Polar's sandbox, set `POLAR_API_BASE = "https://sandbox-api.polar.sh"`
  in `[vars]` and use a sandbox token.

**Privacy:** with the wall on, every visitor's browser loads each sponsor's logo
straight from the URL the sponsor gave (with no referrer), so that host sees the
visitor's IP address. Look at a sponsor's logo URL before you approve them.

### Ready sounds of your own (optional)

The media board offers three ready sounds that are made in the browser. To offer
recordings of your own beside them (a jingle, applause), put each audio file in
`apps/web/public/sounds/`, list it in `apps/web/lib/sound-files.ts` with the license
that lets you hand it out and where it came from, then build and deploy the site as
usual. A file is downloaded only when someone adds its sound to their board. Keep
each file at 1 MiB or less: `pnpm -r test` fails on a larger file, on a file in the
folder that is not listed, and on an entry with no license or source.

---

## Recording notes

### Headphones, really

openMeet captures raw audio: echo cancellation, noise suppression and automatic gain
control are all **off**. That processing is baked irreversibly into the master and is
exactly what a studio recorder exists to avoid. The trade is that anyone listening on
speakers is echoed into the other person's file. Every serious remote-recording tool
makes the same trade.

### Producers and Present only

A room has 4 recorded seats plus 2 unrecorded slots, and the unrecorded slots are
shared by these two:

- **Producer.** Add `?producer=1` to the invite link
  (`https://<your-site>/r/<room>/?producer=1`). A producer joins with no camera or
  mic, sees and hears everyone, can chat and present, and is never recorded. The host's
  **Copy invite link** always copies the plain link; the arrow beside it, in the
  waiting room and in the call, copies this link and the Present-only link.
- **Present only.** On a computer, choose **Present only** in the lobby (or open the
  invite link with `?present=1`) to join just to share that device's screen, with no
  camera or mic. It's for a phone-plus-laptop setup: the phone carries your face and
  voice, the laptop the screen. The screen is recorded; it takes no recorded seat.

### What lands on disk

All in the one folder the host picks, per take:

| File | Contents |
|---|---|
| `host_<id>.mp4` / `guest_<id>.mp4` | H.264 video + compressed audio |
| `host_<id>.wav` / `guest_<id>.wav` | Uncompressed 24-bit PCM master — **edit from this** |
| `guest2_<id>.*`, `guest3_<id>.*` | The same pair for the third and fourth participant |
| `host_screen_<id>.mp4` / `guest_screen_<id>.mp4` | One per screen-share stretch; later stretches get `_2`, `_3`, … |
| `call<n>_<id>.m4a` | The host's own copy of a recorded guest's live call audio, at call quality: a fallback for a guest track that stops arriving or ends short. It starts once that guest's own camera recording reaches the host, so a guest whose recording never starts gets no copy. One per stretch of a guest's connection, numbered in the order they start; `.webm` where the browser cannot encode MP4 audio |
| `sync_<id>.json` | Start-time offsets, a size and a verdict for every file, and remux commands |
| `backup_<name>_<kind>_<UTC start>.<ext>` | A guest's leftover backup, sent to the host from the lobby; its `.json` beside it says how to align it and that its SHA-256 matched |
| `chapters_<id>.txt` | Chapter markers (when marked) |
| `chat_<id>.txt` | Chat log from the take window (when messages sent); leaves out the messages of anyone set as not recorded |

`<id>` is new for every take, and files from the second take on also
end in `_take<n>` (`host_<id>_take2.mp4`, `sync_<id>_take2.json`). `sync.json` names whose screen each
screen file is. The host's files carry the host's name after the role, cut down to letters, digits
and hyphens: `host-ana-maría_<id>.mp4`, `host-ana-maría_screen_<id>.mp4`. The MP4's audio track is
the convenience copy; the WAV is the master.

Codec is probed at runtime, never assumed. H.264 + AAC where available; on Linux there
is no AAC encoder in any Chrome build, so H.264 + Opus is used instead. Both are MP4,
recorded as `avc3` (in-band parameter sets, so a resolution change mid-recording — a
shared window resized, a camera switching mode — doesn't corrupt the file) and re-tagged
to `avc1` by the remux commands below, which is what editors expect.

---

## Recording and consent

The host starts recording for everyone. From the arrow beside Record the host can
set a guest as not recorded before a take: that guest stays in the call, and their
camera, microphone, screen and chat messages are left out of every take until the
host changes it or everyone has left the room — their browser records nothing and
the host saves no file from them, from the next take on, though a backup of an
earlier take that they send back is still offered to the host. Everyone in the
call is told who is not recorded. A recorded participant who listens on speakers,
or who shares a screen with its sound or with the call window on it, can still
pick up that guest's voice or picture. Participants see a pre-join disclosure, a
three-second countdown before each take, and an on-screen notice and REC pill.
Files (including in-call chat) land only on the
host's disk, plus a backup in each participant's own browser storage and a crash copy of
each take's guest recordings in the host's browser storage, removed when the take ends
cleanly (see [If the host's browser crashes](#if-the-hosts-browser-crashes)); nothing is
uploaded. During a take the host also records each recorded guest's live call audio
into the host's folder, a copy that starts only after that guest's browser has begun
its own recording. **The host is responsible for getting consent where the law requires
it** (all-party-consent jurisdictions, GDPR).

---

## After the session

`sync_<id>.json`, `chapters_<id>.txt` and `chat_<id>.txt` are saved in the recording
folder next to the recordings. The session summary beside the stage also provides
download links (**Download sync.json**, **Download chapters**, saved as
`openmeet-<room>-take<n>-sync.json` and `…-chapters.txt`). If the host leaves the call,
the screen that follows offers them too.

1. **Remux:** Run the `+faststart` remux commands in `sync.json` (`seekability`) so clips are seekable:
   `ffmpeg -i "<file>.mp4" -c copy -tag:v avc1 -movflags +faststart "<file>_seekable.mp4"`
2. **Timeline:** Import everything and offset each guest clip by its `offsetMs` in `timeline.guests` (`timeline.guestMinusHostMs` in a two-person session); screen segments carry their own offset in `timeline.screenSegments`. For a take whose host reloaded, `hostParts` lists the host's own files, each with its offset from the start. If an offset is null, align by waveform.
   Or run the aligned-copy commands first (`aligned` in `sync.json`, also under Editor
   commands in the summary): each writes an `_aligned` copy that starts at the host's
   start, so the copies and the host's files all go at 00:00. WAV copies get real silence;
   MP4 copies are not re-encoded (the delay is stored in the file), and an editor that
   ignores it still needs the offset. Call-audio copies are listed under
   `callCopies.files`, each with its own `offsetMs`; they were recorded on the host, so
   no clock sync applies.
3. **Backups:** A participant's own backup copy comes from a separate recorder and the offset does not apply to it.
   Leftover backups are listed in the lobby, with Download and Delete. A guest can reopen the room link in the same
   browser, press **Send to host** on a backup there and join while the host is in the room; the host presses
   **Save to folder** in the in-call notice, and the file lands in the recording folder as
   `backup_<name>_<camera|audio|screen>_<UTC start>.<ext>` (`_2`, `_3` when that name is taken), with a `.json`
   beside it once its SHA-256 matched. The offsets in `sync_<id>.json` do not apply to it — its own `.json` says how
   to align it. A returned backup with no `.json` beside it did not finish. A guest's backup is never deleted
   automatically — their browser can't know the host's file was saved — so it stays until they delete it.
   The host's own backup is cleared at their next lobby visit after a take that ended cleanly.
4. **Constant frame rate (only if needed):** The files can have a variable frame rate. `sync.json` (`frameRate`) lists the rate cameras are asked for by default and, where known, the rate each one reported, with two commands per video file: `measure` shows how much the frame intervals vary, and `conform` re-encodes the file to a constant rate. Conforming is not lossless and is slow; run it only if an editor drifts or refuses a file.

### If the host's browser crashes

Chrome keeps File System Access writes in a temporary file until the file is closed, so
after a crash the host's files are missing or empty. The lobby then lists the take as
**Unsaved recording**: **Save to folder** rebuilds the guests' files from this browser's
crash copy, copies in the host's own camera file and WAV master from its backups, and
writes `sync_<id>.json` and the chapters beside them. If a file cannot be written in full
(a full disk, a folder that lost permission), the lobby names it and keeps the recording
listed, so it can be saved again; the browser's copy is removed only once everything it
holds is in the folder. The last few seconds before
the crash may be missing (up to about eight when it comes in the first seconds of a
take), and a guest's own backup still holds the rest — the participant
copies are listed in the openMeet lobby with **Download**, or **Send to host** to return
one while the host is in the room. If the guests are still in the call, the host does not
have to save at all: **Resume recording** in the in-call notice continues the same take
under its own id, and the guests' files carry on from where they stopped. What the folder
already held of each file is kept, the chapter markers from before the reload stay, and
screen recordings from before it are put back and listed. Each guest's file is still checked
against what that guest sent when the crash copy kept the checksum state for it; otherwise
it reads "not verified" and says why, and a file with a known hole reads "Incomplete". A
screen share that was already running when the host reloaded is recorded again only once
that person stops sharing and shares again; the host is told whose it is. The host's own
camera and WAV master become a second file after a resume, `host_<id>_resumed.mp4` and
`host_<id>_resumed.wav`; the part before the crash is copied into the folder from the take's
backup in the background and listed in the summary once it is there; it comes from the host's
own backup, so its camera file can end a few seconds before the reload. If the host presses
**Save what was recorded** instead, the guests' recording stops and each is pointed to the
backup their own browser kept; after a save or a delete from the lobby that happens when the
host next joins the room. While a take
runs, the guests' bytes are also kept in this browser every few seconds, so the copy is a
few seconds behind, usually three to four and up to about eight at the very start of a
take; a take that cannot keep that copy, or loses it part-way, says so on screen until the
take ends and records as usual. A take whose copy stopped part-way is not offered in the call after
a reload; the lobby still lists what the copy holds. The copy is removed when the take
ends cleanly, and kept for the lobby when a file could not be closed.

An unsaved recording holds the guests' camera, microphone and screen recordings, their
names and the chapter markers, in this browser on the host's computer and nowhere else. It
stays there until it is saved or deleted in the lobby of the room it was recorded in, or
until the site's data is cleared in the browser.

---

## Self-hosted TURN

TURN relay is the one metered resource: 1,000 GB/month free from Cloudflare, then
$0.05/GB. A fully-relayed recording burns roughly 5–7 GB/hour, because the recording
DataChannel shares the PeerConnection — so the chunks relay too.

To depend on Cloudflare for nothing in the media path, point the Worker at your own
[coturn](https://github.com/coturn/coturn):

```bash
pnpm --filter @openmeet/worker exec wrangler secret put TURN_URLS        # turn:turn.example.org:3478,turns:turn.example.org:5349
pnpm --filter @openmeet/worker exec wrangler secret put TURN_USERNAME
pnpm --filter @openmeet/worker exec wrangler secret put TURN_CREDENTIAL
```

These take precedence over the Cloudflare mint. `TURN_URLS` is comma-separated;
username and credential may be omitted for a STUN-only list.

<details>
<summary>Minimal <code>turnserver.conf</code></summary>

```
listening-port=3478
tls-listening-port=5349
realm=turn.example.org
lt-cred-mech
user=openmeet:CHANGE_ME
cert=/etc/letsencrypt/live/turn.example.org/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.org/privkey.pem
min-port=49160
max-port=49200
no-multicast-peers
```

Open 3478/udp+tcp, 5349/tcp and the 49160–49200/udp relay range. TLS on 5349 matters —
it gets through firewalls that block UDP entirely.
</details>

**The trade:** self-hosted TURN means running a server with real bandwidth, which is
the cost Cloudflare was absorbing. Recording bytes still never touch it as *storage* —
a relay forwards, it doesn't keep.

---

## Status and limitations

Working and verified end-to-end with a real two-browser recording (see
`apps/web/e2e/two-browser-recording.mjs`): the call, host-driven recording, per-person
MP4 and WAV files, chunk transport with a matching SHA-256 on both sides, and clock
sync between tracks. Screen-share recording, three- and four-person calls with
producers, and a guest's recording resuming after a full reconnect have also been
exercised end-to-end in real Chrome.

Known gaps, listed below:

- **Screen share reconnect starts a new segment rather than appending to the old file.**
  A guest's camera and WAV recording pick up again by themselves, from the last acknowledged
  chunk, into the same files on the host's disk. A screen share comes back for everyone and
  recording continues in a new numbered segment; the interrupted segment's tail is only in
  the sharer's screen backup, and the session summary marks that segment incomplete.
- **Taking the call over in a second tab during a take ends the first tab's files.**
  A second tab in the host's browser asks before it joins while a recording is running.
  If you join there anyway, the first tab's files end at the takeover (it shows "Press
  End & save to keep this recording"), and the rest of each guest's part exists only in
  that guest's in-browser backup. The new tab records only from its own new take.
- **The media board, if first opened during a take, isn't in that take's MP4.** A
  running recorder can't swap its audio track, so pads still play live and drop chapter
  markers, but their audio reaches the MP4 only from the next take. The WAV master is
  mic-only by design.
- **Clock sync needs the host to be recording within ~8 s of the guest.** Otherwise
  `sync.json` has no offset and says to align the tracks by waveform.
- Anyone with a room's invite link can mint short-lived TURN credentials
  (rate-limited to 20 per minute per IP) — the invite link is the only
  credential, so share it only with participants.

See [SECURITY.md](SECURITY.md) for the trust model and how to report a vulnerability.

---

## Tests

```bash
pnpm -r typecheck
pnpm -r test
```

CI runs both plus a build on every pull request. Note that **a green check does not
mean the call works** — `getUserMedia` and `RTCPeerConnection` can't run headless, so
the media paths are covered only by the two-browser test, which needs real Chrome.
To run it from the repo root (Playwright is not a workspace dependency, so this
installs it into `apps/web/e2e` without touching any `package.json`):

```bash
npm i --prefix apps/web/e2e --no-save playwright
apps/web/e2e/node_modules/.bin/playwright install chrome   # skip if Google Chrome is installed
pnpm --filter @openmeet/worker db:migrate:local
pnpm --filter @openmeet/worker dev   # terminal 2
pnpm --filter @openmeet/web dev      # terminal 3
node apps/web/e2e/two-browser-recording.mjs
```

It exits non-zero on failure and leaves the recordings in `apps/web/e2e/recordings/`.
[MANUAL-TESTING.md](MANUAL-TESTING.md) covers what it doesn't.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the checks to run, and the
repo-specific traps worth knowing before your first change.

## License

[MIT](LICENSE)
