## What and why

<!-- What changes, and what problem it solves. Link the issue if there is one. -->

## Verification

<!-- Tick what you actually ran. Please don't tick things you didn't. -->

- [ ] `pnpm -r typecheck`
- [ ] `pnpm -r test`
- [ ] `NEXT_PUBLIC_API_BASE=https://ci.invalid pnpm build`
- [ ] Added or updated tests covering this change
- [ ] Not testable by unit tests — manual verification described below

### Does this touch media, WebRTC, recording or the call UI?

CI **cannot** verify any of those — `getUserMedia`, `getDisplayMedia` and
`RTCPeerConnection` don't run headless. If yes, describe the two-browser test
you ran: which browsers, which side you sat on, and what you observed.

<!-- e.g. "Chrome 141 host + Chrome 141 guest profile, same machine. Recorded
     3 min, both MP4s played back in sync, sync.json offset was 412ms." -->

## Anything reviewers should look at closely

<!-- Tradeoffs you're unsure about, or a corner you'd like a second opinion on. -->
