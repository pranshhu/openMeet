/**
 * Two-browser recording smoke test.
 *
 * Drives a real host and a real guest through an actual call and an actual
 * recording, then decodes what landed on disk. Everything the product does is
 * exercised for real: getUserMedia, WebRTC negotiation, MediaRecorder,
 * chunking, the DataChannel, ChunkReceiver, FileWriter and the sync sidecar.
 *
 * ONE thing is stubbed — showDirectoryPicker, because a native OS dialog cannot
 * be automated. It is replaced with navigator.storage.getDirectory(), which
 * returns a FileSystemDirectoryHandle with the identical API, so FileWriter and
 * the whole write path run completely unmodified.
 *
 * Requires REAL Google Chrome (channel: 'chrome'). Playwright's bundled
 * Chromium has no H.264 encoder. Note that Chrome on Linux has no AAC encoder
 * either, so the picked codec is the Opus fallback candidate — that is expected
 * and is why RECORDING_MIME_CANDIDATES exists.
 *
 * Run from the repo root. Playwright is not a workspace dependency; this
 * installs it into apps/web/e2e/node_modules only, without touching any
 * package.json:
 *
 *   npm i --prefix apps/web/e2e --no-save playwright
 *   apps/web/e2e/node_modules/.bin/playwright install chrome   # skip if Google Chrome is installed
 *   pnpm --filter @openmeet/worker db:migrate:local
 *   pnpm --filter @openmeet/worker dev         # terminal 2: API + signaling on :8787
 *   pnpm --filter @openmeet/web dev            # terminal 3: web on :3000
 *   node apps/web/e2e/two-browser-recording.mjs
 *
 * Or point it at your own deployment (this creates real rooms there):
 *
 *   BASE=https://your-deploy.pages.dev RECORD_MS=20000 node apps/web/e2e/two-browser-recording.mjs
 *
 * Exits non-zero on failure. Writes the recordings next to this file for
 * inspection with ffprobe.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

// Defaults to a local dev server.
const BASE = process.env.BASE ?? 'http://localhost:3000';
const RECORD_MS = Number(process.env.RECORD_MS ?? 12000);
const OUT = new URL('./recordings/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

// The ONLY stub. OPFS hands back a real FileSystemDirectoryHandle with the same
// getFileHandle/createWritable API the native picker returns, so FileWriter,
// ChunkReceiver and the whole write path run completely unmodified.
const STUB_PICKER = `window.showDirectoryPicker = () => navigator.storage.getDirectory();`;

const log = (who, msg) => console.log(`[${who}] ${msg}`);

const browser = await chromium.launch({
  channel: 'chrome',
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

async function makePeer(name) {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  await ctx.addInitScript(STUB_PICKER);
  const page = await ctx.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || /openMeet/.test(t)) log(name, `console<${m.type()}> ${t.slice(0, 200)}`);
  });
  page.on('pageerror', (e) => log(name, `PAGEERROR ${e.message.slice(0, 200)}`));
  return { ctx, page };
}

async function join(page, who, displayName) {
  await page.getByPlaceholder('Your name').fill(displayName);
  await page.getByRole('button', { name: 'Join now' }).click();
  log(who, 'clicked Join');
}

const host = await makePeer('host');
const guest = await makePeer('guest');

// --- Host creates the room exactly like a user does, so it gets the token ---
await host.page.goto(BASE + '/');
await host.page.getByRole('button', { name: 'New Room' }).click();
await host.page.waitForURL(/\/r\/[a-z]{3}-[a-z]{4}-[a-z]{3}\//, { timeout: 20000 });
const roomUrl = host.page.url();
log('host', `room ${roomUrl}`);

await host.page.waitForSelector('text=Ready to join?', { timeout: 20000 });
await join(host.page, 'host', 'Host Tester');

await guest.page.goto(roomUrl);
await guest.page.waitForSelector('text=Ready to join?', { timeout: 20000 });
await join(guest.page, 'guest', 'Guest Tester');

// --- Both must reach the call stage (remote media arrived) ---
for (const [who, p] of [['host', host.page], ['guest', guest.page]]) {
  await p.getByRole('button', { name: 'Leave call' }).waitFor({ timeout: 45000 });
  log(who, 'in call');
}

// --- Only the host has a Record button now ---
const guestHasRecord = await guest.page.getByRole('button', { name: 'Start recording' }).count();
log('guest', `Record buttons visible: ${guestHasRecord} (expected 0)`);

await host.page.getByRole('button', { name: 'Start recording' }).click();
log('host', 'clicked Record');

// The guest must be told, and must start capturing on its own.
await guest.page.waitForSelector('text=This call is now being recorded', { timeout: 15000 });
log('guest', 'saw the recording notice');
await guest.page.getByRole('button', { name: /Mark this moment/ }).waitFor({ timeout: 15000 })
  .then(() => log('guest', 'guest phase == recording'))
  .catch(() => log('guest', 'WARNING: guest never reached phase=recording'));

await host.page.waitForTimeout(RECORD_MS);

await host.page.getByRole('button', { name: 'End & save recording' }).click();
log('host', 'clicked End & save');
await host.page.waitForSelector('text=/Saved|files on the/', { timeout: 60000 });
log('host', 'finalized');
await host.page.waitForTimeout(3000);

// --- The sync sidecar carries the sent-vs-written digests ---
const sync = await host.page.evaluate(async () => {
  const a = [...document.querySelectorAll('a')].find((x) => x.download.endsWith('sync.json'));
  if (!a) return null;
  return JSON.parse(await (await fetch(a.href)).text());
});
if (sync) writeFileSync(OUT + 'sync.json', JSON.stringify(sync, null, 2));

// --- Pull every file the host wrote out of OPFS ---
const names = await host.page.evaluate(async () => {
  const dir = await navigator.storage.getDirectory();
  const out = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file') out.push({ name, size: (await handle.getFile()).size });
  }
  return out;
});

console.log('\n=== files written by the host ===');
for (const { name, size } of names) {
  // Slice-wise base64: String.fromCharCode(...bigArray) blows the stack.
  const parts = [];
  const STEP = 512 * 1024;
  for (let at = 0; at < size; at += STEP) {
    parts.push(await host.page.evaluate(async ([n, from, to]) => {
      const dir = await navigator.storage.getDirectory();
      const f = await (await dir.getFileHandle(n)).getFile();
      const bytes = new Uint8Array(await f.slice(from, to).arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 8192) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      }
      return btoa(s);
    }, [name, at, Math.min(at + STEP, size)]));
  }
  writeFileSync(OUT + name, Buffer.concat(parts.map((b) => Buffer.from(b, 'base64'))));
  console.log(`  ${name.padEnd(45)} ${(size / 1024).toFixed(0)} KB`);
}
console.log('written to', OUT);

// --- Assertions ---
const fail = [];
const byExt = (e) => names.filter((f) => f.name.endsWith(e));
if (byExt('.mp4').length !== 2) fail.push(`expected 2 mp4, got ${byExt('.mp4').length}`);
if (byExt('.wav').length !== 2) fail.push(`expected 2 wav, got ${byExt('.wav').length}`);
for (const f of names) if (f.size < 100_000) fail.push(`${f.name} is only ${f.size} B`);

console.log('\n=== sync sidecar ===');
if (!sync) {
  fail.push('no sync.json — the host never produced a sync report');
} else {
  // `integrity` is the overall line. It reads "Every file is complete." only
  // when every file's verdict is complete, and a guest's file is complete only
  // when its sender finished and BOTH digests match: the only proof its bytes
  // crossed the DataChannel unaltered.
  console.log('  integrity  ', sync.integrity);
  console.log('  alignment  ', sync.alignment);
  console.log('  offset     ', sync.timeline?.guestMinusHostMs, 'ms');
  if (sync.integrity !== 'Every file is complete.') {
    fail.push(`not every file is complete: ${sync.integrity}`);
    for (const v of sync.verification ?? []) {
      if (v.status !== 'complete') fail.push(`${v.file}: ${v.detail}`);
    }
  }
  for (const w of sync.warnings ?? []) console.log('  warning    ', w);
}

if (fail.length) {
  console.error('\nFAILED:');
  for (const f of fail) console.error('  - ' + f);
  await browser.close();
  process.exit(1);
}
console.log('\nPASS');
await browser.close();
