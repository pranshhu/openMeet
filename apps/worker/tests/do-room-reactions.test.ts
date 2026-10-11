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
  return { ws, heard, peerId: ofType(heard, 'role-assigned')[0]!.peerId };
}

describe('Room DO: reactions', () => {
  it('passes a reaction on to everyone else, stamped with its sender, and not back', async () => {
    const slug = 'rct-pass-aaa';
    await seedRoom(slug, 'tok-rct-pass');
    const a = await enter(slug, 'A');
    const b = await enter(slug, 'B');
    const c = await enter(slug, 'C');

    b.ws.send(JSON.stringify({ type: 'reaction', reaction: 'clap' }));
    await until(() => [a, c].every((w) => ofType(w.heard, 'reaction').length > 0));
    await settle();

    for (const w of [a, c]) {
      expect(ofType(w.heard, 'reaction')).toEqual([
        { type: 'reaction', reaction: 'clap', from: 'guest', fromPeerId: b.peerId },
      ]);
    }
    expect(ofType(b.heard, 'reaction')).toEqual([]);

    [a.ws, b.ws, c.ws].forEach((w) => w.close());
  });

  it('drops a code it does not know, and passes on nothing but the code', async () => {
    const slug = 'rct-junk-aaa';
    await seedRoom(slug, 'tok-rct-junk');
    const a = await enter(slug, 'A');
    const b = await enter(slug, 'B');

    for (const reaction of ['party', '', 'CLAP', 7, null, {}, ['clap']]) {
      b.ws.send(JSON.stringify({ type: 'reaction', reaction }));
    }
    b.ws.send(JSON.stringify({ type: 'reaction' }));
    // A known code, sent with things that must not travel with it.
    b.ws.send(
      JSON.stringify({ type: 'reaction', reaction: 'heart', text: 'x'.repeat(5000), from: 'host', fromPeerId: 'spoofed' })
    );
    await until(() => ofType(a.heard, 'reaction').length > 0);
    await settle();

    expect(ofType(a.heard, 'reaction')).toEqual([
      { type: 'reaction', reaction: 'heart', from: 'guest', fromPeerId: b.peerId },
    ]);
    for (const w of [a, b]) expect(ofType(w.heard, 'error')).toEqual([]);

    [a.ws, b.ws].forEach((w) => w.close());
  });
});
