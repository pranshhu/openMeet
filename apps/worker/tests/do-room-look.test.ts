import { describe, it, expect } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { ServerMessage } from '@openmeet/protocol';

// Seeded directly in D1: POST /api/rooms is rate-limited across the whole run.
async function seedRoom(slug: string, hostToken: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO rooms (slug, host_token, created_at, expires_at, consumed) VALUES (?, ?, ?, ?, 0)'
  )
    .bind(slug, hostToken, Date.now(), Date.now() + 3_600_000)
    .run();
}

async function openWs(slug: string): Promise<WebSocket> {
  const res = await SELF.fetch(`https://test/ws/r/${slug}`, { headers: { Upgrade: 'websocket' } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  return ws as unknown as WebSocket;
}

function waitForRoleAssigned(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    const onMsg = (e: MessageEvent) => {
      if ((JSON.parse(e.data as string) as ServerMessage).type !== 'role-assigned') return;
      ws.removeEventListener('message', onMsg);
      resolve();
    };
    ws.addEventListener('message', onMsg);
  });
}

// Joins the room and keeps everything the socket is sent, so a test can assert
// on what it did NOT get.
async function enter(slug: string, displayName: string, extra: Record<string, unknown> = {}) {
  const ws = await openWs(slug);
  const heard: ServerMessage[] = [];
  ws.addEventListener('message', (e) => heard.push(JSON.parse(e.data as string) as ServerMessage));
  const assigned = waitForRoleAssigned(ws);
  ws.send(JSON.stringify({ type: 'join', displayName, userAgent: 'ua', ...extra }));
  await assigned;
  return { ws, heard };
}

const looks = (heard: ServerMessage[]) => heard.filter((m) => m.type === 'look');
const settle = () => new Promise((r) => setTimeout(r, 150));

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 80 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
}

describe('Room DO: the host sends a look', () => {
  it("passes on only the host's look, to everyone else in the room, and keeps nothing", async () => {
    const slug = 'lok-host-aaa';
    await seedRoom(slug, 'tok-lok-host');
    const h = await enter(slug, 'H', { hostToken: 'tok-lok-host' });
    const a = await enter(slug, 'A');
    const p = await enter(slug, 'P', { producer: true });

    a.ws.send(JSON.stringify({ type: 'look', accent: 'red' }));
    p.ws.send(JSON.stringify({ type: 'look', accent: 'red' }));
    await settle();
    for (const w of [h, a, p]) expect(looks(w.heard)).toEqual([]);

    h.ws.send(JSON.stringify({ type: 'look', accent: 'red' }));
    await until(() => [a, p].every((w) => looks(w.heard).length > 0));
    await settle();
    for (const w of [a, p]) expect(looks(w.heard)).toEqual([{ type: 'look', accent: 'red' }]);
    expect(looks(h.heard)).toEqual([]);

    // Nothing is kept: a person who joins afterwards is not sent it.
    const late = await enter(slug, 'L');
    await settle();
    expect(looks(late.heard)).toEqual([]);

    [h.ws, a.ws, p.ws, late.ws].forEach((w) => w.close());
  });

  it('passes on only the named fields, and no accent that is not on the list', async () => {
    const slug = 'lok-badd-aaa';
    await seedRoom(slug, 'tok-lok-bad');
    const h = await enter(slug, 'H', { hostToken: 'tok-lok-bad' });
    const a = await enter(slug, 'A');

    h.ws.send(JSON.stringify({ type: 'look', accent: 'url(x)', extra: 'x' }));
    h.ws.send(JSON.stringify({ type: 'look', accent: 7 }));
    h.ws.send(JSON.stringify({ type: 'look' }));
    h.ws.send(JSON.stringify({ type: 'look', accent: 'pink', extra: 'x' }));
    await until(() => looks(a.heard).length >= 4);
    await settle();
    expect(looks(a.heard)).toEqual([
      { type: 'look' },
      { type: 'look' },
      { type: 'look' },
      { type: 'look', accent: 'pink' },
    ]);

    [h.ws, a.ws].forEach((w) => w.close());
  });
});

// The first 24 bytes of a PNG: signature, the IHDR chunk header, width, height.
function logoOf(width: number, height: number): string {
  const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(width), ...be32(height)];
  return 'data:image/png;base64,' + btoa(String.fromCharCode(...head)) + 'AAAA';
}

describe('Room DO: the host sends a logo with the look', () => {
  it('passes a good logo on to a guest, and keeps nothing', async () => {
    const slug = 'lok-logo-aaa';
    await seedRoom(slug, 'tok-lok-logo');
    const h = await enter(slug, 'H', { hostToken: 'tok-lok-logo' });
    const a = await enter(slug, 'A');

    const logo = logoOf(160, 80);
    h.ws.send(JSON.stringify({ type: 'look', accent: 'red', logo }));
    await until(() => looks(a.heard).length > 0);
    await settle();
    expect(looks(a.heard)).toEqual([{ type: 'look', accent: 'red', logo }]);

    const late = await enter(slug, 'L');
    await settle();
    expect(looks(late.heard)).toEqual([]);

    [h.ws, a.ws, late.ws].forEach((w) => w.close());
  });

  it('passes the look on without a logo whose header says 20000 wide, or that is no PNG', async () => {
    const slug = 'lok-logo-bad';
    await seedRoom(slug, 'tok-lok-lbad');
    const h = await enter(slug, 'H', { hostToken: 'tok-lok-lbad' });
    const a = await enter(slug, 'A');

    h.ws.send(JSON.stringify({ type: 'look', accent: 'blue', logo: logoOf(20000, 20000) }));
    h.ws.send(JSON.stringify({ type: 'look', logo: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }));
    h.ws.send(JSON.stringify({ type: 'look', logo: 7 }));
    await until(() => looks(a.heard).length >= 3);
    await settle();
    expect(looks(a.heard)).toEqual([{ type: 'look', accent: 'blue' }, { type: 'look' }, { type: 'look' }]);

    [h.ws, a.ws].forEach((w) => w.close());
  });

  it("passes on nobody's logo but the host's", async () => {
    const slug = 'lok-logo-gst';
    await seedRoom(slug, 'tok-lok-lgst');
    const h = await enter(slug, 'H', { hostToken: 'tok-lok-lgst' });
    const a = await enter(slug, 'A');
    const b = await enter(slug, 'B');

    a.ws.send(JSON.stringify({ type: 'look', logo: logoOf(10, 10) }));
    await settle();
    for (const w of [h, a, b]) expect(looks(w.heard)).toEqual([]);

    [h.ws, a.ws, b.ws].forEach((w) => w.close());
  });
});
