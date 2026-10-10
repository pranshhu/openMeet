import { describe, it, expect } from 'vitest';
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import type { ServerMessage } from '@openmeet/protocol';
import type { Room } from '../src/do/Room.js';

// MAX_SCRIPT_LENGTH in packages/protocol/src/constants.ts, spelled out so a
// change to the figure is seen here.
const MAX = 50_000;

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

const scripts = (heard: ServerMessage[]) => heard.filter((m) => m.type === 'script');
const settle = () => new Promise((r) => setTimeout(r, 150));

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 80 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
}

describe('Room DO: the host sends a script', () => {
  it("passes on only the host's script, to everyone else in the room, and keeps nothing", async () => {
    const slug = 'scr-host-aaa';
    await seedRoom(slug, 'tok-scr-host');
    const h = await enter(slug, 'H', { hostToken: 'tok-scr-host' });
    const a = await enter(slug, 'A');
    const p = await enter(slug, 'P', { producer: true });

    a.ws.send(JSON.stringify({ type: 'script', text: 'from a guest' }));
    p.ws.send(JSON.stringify({ type: 'script', text: 'from a producer' }));
    await settle();
    for (const w of [h, a, p]) expect(scripts(w.heard)).toEqual([]);

    h.ws.send(JSON.stringify({ type: 'script', text: 'Welcome to the show' }));
    await until(() => [a, p].every((w) => scripts(w.heard).length > 0));
    await settle();
    for (const w of [a, p]) {
      expect(scripts(w.heard)).toEqual([{ type: 'script', text: 'Welcome to the show' }]);
    }
    expect(scripts(h.heard)).toEqual([]);

    // Nothing is kept: a person who joins afterwards is not sent it.
    const late = await enter(slug, 'L');
    await settle();
    expect(scripts(late.heard)).toEqual([]);

    [h.ws, a.ws, p.ws, late.ws].forEach((w) => w.close());
  });

  it('passes on a script of exactly the bound and drops a longer one', async () => {
    const slug = 'scr-long-aaa';
    await seedRoom(slug, 'tok-scr-long');
    const h = await enter(slug, 'H', { hostToken: 'tok-scr-long' });
    const a = await enter(slug, 'A');

    h.ws.send(JSON.stringify({ type: 'script', text: 'a'.repeat(MAX + 1) }));
    const longest = 'a'.repeat(MAX);
    h.ws.send(JSON.stringify({ type: 'script', text: longest }));
    await until(() => scripts(a.heard).length > 0);
    await settle();
    expect(scripts(a.heard)).toEqual([{ type: 'script', text: longest }]);
    for (const w of [h, a]) expect(w.heard.filter((m) => m.type === 'error')).toEqual([]);

    [h.ws, a.ws].forEach((w) => w.close());
  });

  // Called on the object itself, so a handler that throws fails this test
  // whatever the runtime does with a thrown message handler.
  it('drops a script that carries no text, without throwing', async () => {
    const slug = 'scr-type-aaa';
    await seedRoom(slug, 'tok-scr-type');
    const h = await enter(slug, 'H', { hostToken: 'tok-scr-type' });
    const a = await enter(slug, 'A');

    const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(slug));
    await runInDurableObject(stub, async (instance, state) => {
      const hostWs = state.getWebSockets().find((s) => {
        const att = s.deserializeAttachment() as { role?: string } | null;
        return att?.role === 'host';
      })!;
      const room = instance as unknown as Room;
      for (const text of [undefined, null, 7, {}, ['a']]) {
        await room.webSocketMessage(hostWs, JSON.stringify({ type: 'script', text }));
      }
    });
    await settle();
    expect(scripts(a.heard)).toEqual([]);

    [h.ws, a.ws].forEach((w) => w.close());
  });
});
