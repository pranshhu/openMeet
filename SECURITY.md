# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Report it privately through GitHub's private vulnerability reporting:
<https://github.com/pranshhu/openMeet/security/advisories/new>. That is the only
channel for security reports.

Please include what the issue is, how to reproduce it, and what an attacker
could achieve. A proof of concept helps a lot.

This is a small volunteer-maintained project, not a funded product. Expect an
acknowledgement within about a week. There is no bug bounty. Fixes ship on a
best-effort basis, and you'll be credited in the release notes unless you'd
rather not be.

## Trust model

Worth understanding before deciding whether something is a vulnerability.

**Recording bytes never touch a server.** Each peer records its own local track.
The guest streams chunks to the host over a WebRTC DataChannel, and the host
writes them straight to local disk via the File System Access API. There is no
upload, no object storage, and no server-side copy — by design, and it's also
why the project costs nothing to run.

**The server sees metadata only.** The Cloudflare Worker and its Durable Object
handle REST and WebSocket signaling. The Durable Object is a dumb relay: it
forwards SDP and ICE between peers and never inspects them. D1 stores
room, session, participant and recording metadata — never media.

**TURN relay traffic is opaque to the operator.** When symmetric NAT forces a
relay, the bytes crossing it are SRTP/SCTP-encrypted end to end. A TURN operator
sees packet sizes and timing, not content.

**A room holds up to 4 recorded participants plus 2 unrecorded slots.** The caps
are per role: a 5th recorded participant is rejected even when an unrecorded slot
is free (`MAX_RECORDED_PEERS` in `packages/protocol/src/constants.ts`), and so is
a 3rd unrecorded one (`MAX_PRODUCERS` in `apps/worker/src/do/Room.ts`). The
unrecorded slots are shared by producers and Present-only screens. Both flags are
client-declared and nothing authenticates them, so anyone with the link can join
as a producer (in the call, never written to a file) or as a Present-only screen
(no camera or mic, but its screen is recorded to the host's disk).

**Rooms live 30 days, and every join pushes the expiry out another 30.** A link
that stays in use never lapses. A room is marked `consumed` on first join, but
nothing reads that flag, so the link keeps working as long as a slot is free.
Treat an invite link as a live secret, not a one-time ticket.

**Chat and presence pass through the server in plaintext.** Only recording bytes
and A/V are peer-to-peer. Chat is relayed by the Durable Object — it is not
persisted, but it is not end-to-end encrypted either.

**The signaling socket accepts only the site's own origin.** A WebSocket handshake
whose `Origin` isn't the deployment's `PAGES_ORIGIN` gets a 403, so another website
can't open a socket into a room from a visitor's browser. A client that sends no
`Origin` (not a browser) is let through; the room slug still gates it.

**The web app ships security headers.** `apps/web/public/_headers` gives every page a
Content-Security-Policy, `X-Frame-Options: DENY` (no framing), a Permissions-Policy
that keeps camera, microphone and screen capture to the site itself, `nosniff` and a
strict referrer policy. The static export needs inline scripts, so the CSP restricts
where code, fonts and media load from rather than blocking inline script.

**Display names and user agents are stored in D1 and never deleted.** There is no
retention policy or cleanup job today.

## Known limitations

These are documented rather than hidden. Reports about them are welcome, but
they're already known:

- **The host token is a bearer credential.** A room never has two hosts: the
  newest connection that proves the token becomes host and the previous host tab
  is closed (code 4006). That is what lets a host reconnect or switch tabs, and it
  also means a leaked token lets its holder take the host seat over.
- **`POST /api/turn-cred` is unauthenticated.** Any valid, unexpired room slug
  mints credentials — the invite link is the only credential, so share it only
  with participants. Rate-limited to 20 requests per minute per IP
  (`TURN_CRED_LIMITER`); harmless while TURN runs in STUN-only stub mode, and
  bounded once relay credentials are live.
- **Room-creation rate limiting is per Cloudflare location**, not global
  (10 per minute per IP, `ROOM_CREATE_LIMITER`), and fails open if the binding
  is missing — a speed bump rather than a hard limit.
- **Room slugs carry ~47 bits of entropy** and are the sole capability for
  joining a room as a guest. Treat an invite link as a secret.

## Scope

**In scope:** the Worker and Durable Object (`apps/worker`), the web client
(`apps/web`), the shared protocol (`packages/protocol`), and the D1 schema.

**Out of scope:** vulnerabilities in Cloudflare's platform (report those to
Cloudflare), browser vulnerabilities, and anything requiring an attacker to
already control the host's machine or browser profile.
