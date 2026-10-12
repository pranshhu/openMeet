import { describe, it, expect } from 'vitest';
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import type { ServerMessage } from '@openmeet/protocol';

// Seeded straight into D1: POST /api/rooms is rate limited across the whole run.
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

function waitForRoleAssigned(ws: WebSocket): Promise<ServerMessage & { type: 'role-assigned' }> {
  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as ServerMessage;
        if (msg.type === 'role-assigned') {
          ws.removeEventListener('message', onMsg);
          resolve(msg as ServerMessage & { type: 'role-assigned' });
        }
      } catch (err) {
        reject(err);
      }
    };
    ws.addEventListener('message', onMsg);
  });
}

// Everything a socket is sent, so a test can assert on what it did NOT get.
function collect(ws: WebSocket): ServerMessage[] {
  const heard: ServerMessage[] = [];
  ws.addEventListener('message', (e) => heard.push(JSON.parse(e.data as string) as ServerMessage));
  return heard;
}

function ofType<T extends ServerMessage['type']>(heard: ServerMessage[], type: T) {
  return heard.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
}

async function enter(slug: string, displayName: string, extra: Record<string, unknown> = {}) {
  const ws = await openWs(slug);
  const heard = collect(ws);
  const assigned = waitForRoleAssigned(ws);
  ws.send(JSON.stringify({ type: 'join', displayName, userAgent: 'ua', ...extra }));
  return { ws, heard, me: await assigned };
}

const settle = () => new Promise((r) => setTimeout(r, 150));

async function until(cond: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 80 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 25));
}

const privately = (to: unknown, text: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'private-message', to, text, ...over });

describe('Room DO — private message', () => {
  it('hands it to the person it names and to nobody else, stamped by the Room', async () => {
    const slug = 'pvm-only-aaa';
    await seedRoom(slug, 'tok-pvm-only');
    const h = await enter(slug, 'H', { hostToken: 'tok-pvm-only' });
    const a = await enter(slug, 'A');
    const b = await enter(slug, 'B');
    const p = await enter(slug, 'P', { producer: true });

    // What the sender says about itself is not what the recipient is told.
    p.ws.send(privately(h.me.peerId, 'two minutes', { from: 'host', fromPeerId: 'forged', fromName: 'Forged' }));
    await until(() => ofType(h.heard, 'private-message').length > 0);
    await settle();

    expect(ofType(h.heard, 'private-message')).toEqual([
      { type: 'private-message', text: 'two minutes', from: 'producer', fromPeerId: p.me.peerId, fromName: 'P' },
    ]);
    for (const w of [a, b, p]) expect(ofType(w.heard, 'private-message')).toEqual([]);

    // Guest to guest, behind the host's back, works the same way.
    a.ws.send(privately(b.me.peerId, 'hi B'));
    await until(() => ofType(b.heard, 'private-message').length > 0);
    await settle();

    expect(ofType(b.heard, 'private-message')).toEqual([
      { type: 'private-message', text: 'hi B', from: 'guest', fromPeerId: a.me.peerId, fromName: 'A' },
    ]);
    expect(ofType(h.heard, 'private-message')).toHaveLength(1);
    for (const w of [a, p]) expect(ofType(w.heard, 'private-message')).toEqual([]);
    // Nor did either reach anyone as an ordinary chat line.
    for (const w of [h, a, b, p]) expect(ofType(w.heard, 'chat')).toEqual([]);

    [h.ws, a.ws, b.ws, p.ws].forEach((w) => w.close());
  });

  it('drops one that names nobody usable, and never sends it to the room', async () => {
    const slug = 'pvm-drop-aaa';
    await seedRoom(slug, 'tok-pvm-drop');
    const h = await enter(slug, 'H', { hostToken: 'tok-pvm-drop' });
    const a = await enter(slug, 'A');
    const b = await enter(slug, 'B');

    // Nobody, the sender itself, and values that are not an id at all.
    for (const to of ['nobody', a.me.peerId, '', null, undefined, 7, {}, [b.me.peerId]]) {
      a.ws.send(privately(to, 'lost'));
    }
    // A valid one on the same socket, after all of the above.
    a.ws.send(privately(b.me.peerId, 'found'));
    await until(() => ofType(b.heard, 'private-message').length > 0);
    await settle();

    expect(ofType(b.heard, 'private-message').map((m) => m.text)).toEqual(['found']);
    for (const w of [h, a]) expect(ofType(w.heard, 'private-message')).toEqual([]);
    for (const w of [h, a, b]) {
      expect(ofType(w.heard, 'chat')).toEqual([]);
      expect(ofType(w.heard, 'error')).toEqual([]);
    }

    [h.ws, a.ws, b.ws].forEach((w) => w.close());
  });

  it('reaches only a socket that joined, and takes none from one that did not', async () => {
    const slug = 'pvm-unjo-ina';
    await seedRoom(slug, 'tok-pvm-unjoined');
    const h = await enter(slug, 'H', { hostToken: 'tok-pvm-unjoined' });
    const a = await enter(slug, 'A');
    const lurker = await openWs(slug);
    const idle = collect(lurker);
    const lurkerId = await runInDurableObject(env.ROOM_DO.get(env.ROOM_DO.idFromName(slug)), async (_i, state) =>
      state
        .getWebSockets()
        .map((ws) => (ws.deserializeAttachment() as { peerId: string }).peerId)
        .find((id) => id !== h.me.peerId && id !== a.me.peerId)!
    );

    h.ws.send(privately(lurkerId, 'to a socket outside the room'));
    lurker.send(privately(a.me.peerId, 'from a socket outside the room'));
    h.ws.send(privately(a.me.peerId, 'sentinel'));
    await until(() => ofType(a.heard, 'private-message').length > 0);
    await settle();

    expect(ofType(a.heard, 'private-message').map((m) => m.text)).toEqual(['sentinel']);
    expect(idle).toEqual([]);

    [h.ws, a.ws].forEach((w) => w.close());
    lurker.close();
  });
});
