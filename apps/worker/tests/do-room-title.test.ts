import { describe, it, expect } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { ServerMessage } from '@openmeet/protocol';

// Seeded straight into D1: POST /api/rooms is rate-limited across the test run.
async function seedRoom(slug: string, hostToken: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO rooms (slug, host_token, created_at, expires_at, consumed) VALUES (?, ?, ?, ?, 0)'
  )
    .bind(slug, hostToken, Date.now(), Date.now() + 3_600_000)
    .run();
}

async function openWs(slug: string): Promise<WebSocket> {
  const res = await SELF.fetch(`https://test/ws/r/${slug}`, {
    headers: { Upgrade: 'websocket' },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  return ws as unknown as WebSocket;
}

function ofType<T extends ServerMessage['type']>(heard: ServerMessage[], type: T) {
  return heard.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 80 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
}

const settle = () => new Promise((r) => setTimeout(r, 150));

/** Join the room and keep everything this socket is sent. */
async function enter(slug: string, displayName: string) {
  const ws = await openWs(slug);
  const heard: ServerMessage[] = [];
  ws.addEventListener('message', (e) => heard.push(JSON.parse(e.data as string) as ServerMessage));
  ws.send(JSON.stringify({ type: 'join', displayName, userAgent: 'ua' }));
  await until(() => ofType(heard, 'role-assigned').length > 0);
  expect(ofType(heard, 'role-assigned')).toHaveLength(1);
  return { ws, heard };
}

const presence = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'presence', micOn: true, camOn: true, screenSharing: false, ...extra });

describe('Room DO: a title in presence', () => {
  it('passes a title on with presence, trimmed', async () => {
    const slug = 'ttl-pass-aaa';
    await seedRoom(slug, 'tok-ttl-pass');
    const a = await enter(slug, 'A');
    const b = await enter(slug, 'B');

    b.ws.send(presence({ title: '  Founder  ' }));
    await until(() => ofType(a.heard, 'presence').length === 1);

    expect(ofType(a.heard, 'presence')[0]).toMatchObject({
      micOn: true,
      camOn: true,
      screenSharing: false,
      title: 'Founder',
      from: 'guest',
      fromName: 'B',
    });
    expect(ofType(b.heard, 'presence')).toEqual([]);

    a.ws.close();
    b.ws.close();
  });

  it('relays presence without the field when the title is not one', async () => {
    const slug = 'ttl-junk-aaa';
    await seedRoom(slug, 'tok-ttl-bad');
    const a = await enter(slug, 'A');
    const b = await enter(slug, 'B');

    const junk = ['x'.repeat(61), 7, '   ', {}, null];
    for (const title of junk) b.ws.send(presence({ title }));
    await until(() => ofType(a.heard, 'presence').length === junk.length);
    await settle();

    const heard = ofType(a.heard, 'presence');
    expect(heard).toHaveLength(junk.length);
    for (const m of heard) expect(m).not.toHaveProperty('title');
    for (const w of [a, b]) expect(ofType(w.heard, 'error')).toEqual([]);

    a.ws.close();
    b.ws.close();
  });
});
