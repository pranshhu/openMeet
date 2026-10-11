import { describe, it, expect } from 'vitest';
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import type { ServerMessage } from '@openmeet/protocol';
import { Room } from '../src/do/Room.js';

// Seeded straight into D1: POST /api/rooms is rate-limited across the whole run.
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

type RoleAssigned = Extract<ServerMessage, { type: 'role-assigned' }>;

/** Join, and keep everything the socket is sent, so a test can assert on what it did NOT get. */
async function enter(slug: string, displayName: string, extra: Record<string, unknown> = {}) {
  const ws = await openWs(slug);
  const heard: ServerMessage[] = [];
  const assigned = new Promise<RoleAssigned>((resolve) => {
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data as string) as ServerMessage;
      heard.push(m);
      if (m.type === 'role-assigned') resolve(m);
    });
  });
  ws.send(JSON.stringify({ type: 'join', displayName, userAgent: 'ua', ...extra }));
  return { ws, heard, me: await assigned };
}

/** Join on a new socket and say how the Room answered: a seat, or a close code. */
async function knock(slug: string, extra: Record<string, unknown>) {
  const ws = await openWs(slug);
  const heard: ServerMessage[] = [];
  const answered = new Promise<'seated' | number>((resolve) => {
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data as string) as ServerMessage;
      heard.push(m);
      if (m.type === 'role-assigned') resolve('seated');
    });
    ws.addEventListener('close', (e) => resolve(e.code));
  });
  ws.send(JSON.stringify({ type: 'join', displayName: 'A', userAgent: 'ua', ...extra }));
  return { ws, heard, answer: await answered };
}

function ofType<T extends ServerMessage['type']>(heard: ServerMessage[], type: T) {
  return heard.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
}

const closed = (ws: WebSocket) =>
  new Promise<{ code: number; reason: string }>((resolve) => {
    ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason }));
  });

const settle = () => new Promise((r) => setTimeout(r, 150));

async function until(cond: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 80 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 25));
}

const sessionEnded = async (slug: string) =>
  (
    await env.DB.prepare('SELECT ended_at FROM sessions WHERE room_slug = ? ORDER BY started_at DESC')
      .bind(slug)
      .first<{ ended_at: number | null }>()
  )?.ended_at != null;

describe('Room DO — the host mutes a participant', () => {
  it("passes on only the host's request, and only to the person named", async () => {
    const slug = 'hcm-host-aaa';
    await seedRoom(slug, 'tok-hcm-host');
    const h = await enter(slug, 'H', { hostToken: 'tok-hcm-host' });
    const a = await enter(slug, 'A');
    const b = await enter(slug, 'B');
    const p = await enter(slug, 'P', { producer: true });

    // Neither a guest's word nor a producer's counts, whoever it names.
    b.ws.send(JSON.stringify({ type: 'peer-mute', peerId: a.me.peerId }));
    p.ws.send(JSON.stringify({ type: 'peer-mute', peerId: a.me.peerId }));
    await settle();
    for (const w of [h, a, b, p]) expect(ofType(w.heard, 'peer-mute')).toEqual([]);

    h.ws.send(JSON.stringify({ type: 'peer-mute', peerId: a.me.peerId }));
    await until(() => ofType(a.heard, 'peer-mute').length > 0);
    await settle();
    expect(ofType(a.heard, 'peer-mute')).toEqual([{ type: 'peer-mute' }]);
    for (const w of [h, b, p]) expect(ofType(w.heard, 'peer-mute')).toEqual([]);

    [h.ws, a.ws, b.ws, p.ws].forEach((w) => w.close());
  });

  it('ignores a request that names nobody else in the room, without closing the socket', async () => {
    const slug = 'hcm-ignr-aaa';
    await seedRoom(slug, 'tok-hcm-ignore');
    const h = await enter(slug, 'H', { hostToken: 'tok-hcm-ignore' });
    const a = await enter(slug, 'A');

    // No id, an id that is not a string, an unknown id and the host's own.
    h.ws.send(JSON.stringify({ type: 'peer-mute' }));
    for (const peerId of [7, null, '', 'nobody', h.me.peerId]) {
      h.ws.send(JSON.stringify({ type: 'peer-mute', peerId }));
    }
    // A valid request on the same socket, after all of the above.
    h.ws.send(JSON.stringify({ type: 'peer-mute', peerId: a.me.peerId }));

    await until(() => ofType(a.heard, 'peer-mute').length > 0);
    await settle();
    expect(ofType(a.heard, 'peer-mute')).toEqual([{ type: 'peer-mute' }]);
    expect(ofType(h.heard, 'peer-mute')).toEqual([]);
    for (const w of [h, a]) expect(ofType(w.heard, 'error')).toEqual([]);

    [h.ws, a.ws].forEach((w) => w.close());
  });
});

describe('Room DO — the host removes a participant', () => {
  it("closes the person named with 4007 and tells the others, on the host's word only", async () => {
    const slug = 'hcr-host-aaa';
    await seedRoom(slug, 'tok-hcr-host');
    const h = await enter(slug, 'H', { hostToken: 'tok-hcr-host' });
    const a = await enter(slug, 'A', { clientId: 'tab-a' });
    const p = await enter(slug, 'P', { producer: true, clientId: 'tab-p' });
    const goneA = closed(a.ws);
    const goneP = closed(p.ws);

    // Neither a guest's word nor a producer's counts, whoever it names.
    a.ws.send(JSON.stringify({ type: 'peer-remove', peerId: p.me.peerId }));
    p.ws.send(JSON.stringify({ type: 'peer-remove', peerId: a.me.peerId }));
    await settle();
    expect(ofType(h.heard, 'peer-left')).toEqual([]);

    h.ws.send(JSON.stringify({ type: 'peer-remove', peerId: a.me.peerId }));
    expect(await goneA).toEqual({ code: 4007, reason: 'removed' });
    await until(() => [h, p].every((w) => ofType(w.heard, 'peer-left').length > 0));
    for (const w of [h, p]) {
      expect(ofType(w.heard, 'peer-left')).toEqual([
        { type: 'peer-left', role: 'guest', reason: 'removed', peerId: a.me.peerId },
      ]);
    }

    // A producer is removed the same way.
    h.ws.send(JSON.stringify({ type: 'peer-remove', peerId: p.me.peerId }));
    expect(await goneP).toEqual({ code: 4007, reason: 'removed' });

    h.ws.close();
  });

  it('keeps the removed tab out, tells nobody it knocked, seats another tab and never refuses a host', async () => {
    const slug = 'hcr-back-aaa';
    await seedRoom(slug, 'tok-hcr-back');
    const h = await enter(slug, 'H', { hostToken: 'tok-hcr-back' });
    const a = await enter(slug, 'A', { clientId: 'tab-a' });
    const gone = closed(a.ws);
    h.ws.send(JSON.stringify({ type: 'peer-remove', peerId: a.me.peerId }));
    await gone;

    const again = await knock(slug, { clientId: 'tab-a' });
    expect(again.answer).toBe(4007);
    expect(again.heard).toEqual([]);
    await settle();
    expect(ofType(h.heard, 'peer-joined')).toHaveLength(1);

    // Another tab is another id: the invite link is still the only credential.
    const other = await knock(slug, { clientId: 'tab-a-new' });
    expect(other.answer).toBe('seated');

    // The token outranks the list, whatever id the host's tab presents.
    const host = await knock(slug, { clientId: 'tab-a', hostToken: 'tok-hcr-back' });
    expect(host.answer).toBe('seated');

    [other.ws, host.ws].forEach((w) => w.close());
  });

  it('forgets the removal when the session ends', async () => {
    const slug = 'hcr-over-aaa';
    await seedRoom(slug, 'tok-hcr-over');
    const h = await enter(slug, 'H', { hostToken: 'tok-hcr-over' });
    const a = await enter(slug, 'A', { clientId: 'tab-a' });
    const gone = closed(a.ws);
    h.ws.send(JSON.stringify({ type: 'peer-remove', peerId: a.me.peerId }));
    await gone;

    // Everyone has left: the session is over, and its list with it.
    h.ws.close();
    await until(() => sessionEnded(slug));
    await settle();

    const back = await knock(slug, { clientId: 'tab-a' });
    expect(back.answer).toBe('seated');
    back.ws.close();
  });

  it('ignores a request that names nobody it may remove, and closes nobody', async () => {
    const slug = 'hcr-ignr-aaa';
    await seedRoom(slug, 'tok-hcr-ignore');
    const h = await enter(slug, 'H', { hostToken: 'tok-hcr-ignore' });
    const a = await enter(slug, 'A', { clientId: 'tab-a' });

    // No id, an id that is not a string, an unknown id and the host's own.
    h.ws.send(JSON.stringify({ type: 'peer-remove' }));
    for (const peerId of [7, null, '', 'nobody', h.me.peerId]) {
      h.ws.send(JSON.stringify({ type: 'peer-remove', peerId }));
    }
    // Both are still in the room: a chat line goes each way.
    h.ws.send(JSON.stringify({ type: 'chat', text: 'still here', ts: 1 }));
    a.ws.send(JSON.stringify({ type: 'chat', text: 'me too', ts: 2 }));
    await until(() => ofType(a.heard, 'chat').length > 0 && ofType(h.heard, 'chat').length > 0);

    expect(ofType(a.heard, 'chat').map((m) => m.text)).toEqual(['still here']);
    expect(ofType(h.heard, 'chat').map((m) => m.text)).toEqual(['me too']);
    for (const w of [h, a]) expect(ofType(w.heard, 'peer-left')).toEqual([]);

    [h.ws, a.ws].forEach((w) => w.close());
  });

  it('still refuses the removed tab after the Room was evicted from memory', async () => {
    const slug = 'hcr-wake-aaa';
    await seedRoom(slug, 'tok-hcr-wake');
    const h = await enter(slug, 'H', { hostToken: 'tok-hcr-wake' });
    const a = await enter(slug, 'A', { clientId: 'tab-a' });
    const gone = closed(a.ws);
    h.ws.send(JSON.stringify({ type: 'peer-remove', peerId: a.me.peerId }));
    await gone;

    const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(slug));
    const answer = await runInDurableObject(stub, async (_instance, state) => {
      // A woken Room is a new instance that knows only what storage holds.
      const fresh = new Room(state, env);
      await new Promise((r) => setTimeout(r, 50));
      const before = new Set(state.getWebSockets());
      const res = await fresh.fetch(
        new Request(`https://test/ws/r/${slug}`, { headers: { Upgrade: 'websocket' } })
      );
      const clientWs = res.webSocket!;
      clientWs.accept();
      const serverWs = state.getWebSockets().find((s) => !before.has(s));
      if (!serverWs) throw new Error('expected a newly accepted socket');
      const answered = new Promise<'seated' | number>((resolve) => {
        clientWs.addEventListener('message', () => resolve('seated'));
        clientWs.addEventListener('close', (e) => resolve(e.code));
      });
      await fresh.webSocketMessage(
        serverWs,
        JSON.stringify({ type: 'join', displayName: 'A', userAgent: 'ua', clientId: 'tab-a' })
      );
      return answered;
    });
    expect(answer).toBe(4007);

    h.ws.close();
  }, 15_000);

  it('remembers the newest 16 removed tabs and forgets the oldest', async () => {
    const slug = 'hcr-many-aaa';
    await seedRoom(slug, 'tok-hcr-many');
    const h = await enter(slug, 'H', { hostToken: 'tok-hcr-many' });
    const a = await enter(slug, 'A', { clientId: 'tab-a' });

    const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(slug));
    const kept = await runInDurableObject(stub, async (_instance, state) => {
      // A session that already holds sixteen, read by a woken Room: the
      // resident one keeps its own list in memory and would not see them.
      const stored = (await state.storage.get<Record<string, unknown>>('session'))!;
      const sixteen = Array.from({ length: 16 }, (_, i) => `tab-old-${i}`);
      await state.storage.put('session', { ...stored, removed: sixteen });
      const fresh = new Room(state, env);
      await new Promise((r) => setTimeout(r, 50));
      const hostWs = state
        .getWebSockets()
        .find((s) => (s.deserializeAttachment() as { role?: string })?.role === 'host');
      if (!hostWs) throw new Error('expected the host socket');
      await fresh.webSocketMessage(hostWs, JSON.stringify({ type: 'peer-remove', peerId: a.me.peerId }));
      return (await state.storage.get<{ removed?: string[] }>('session'))?.removed;
    });
    expect(kept).toEqual([...Array.from({ length: 15 }, (_, i) => `tab-old-${i + 1}`), 'tab-a']);

    h.ws.close();
  }, 15_000);
});

describe('Room DO — host controls during a take', () => {
  it('passes on a mute and carries out a removal while a take runs, and the take goes on', async () => {
    const slug = 'hct-take-aaa';
    await seedRoom(slug, 'tok-hct-take');
    const h = await enter(slug, 'H', { hostToken: 'tok-hct-take' });
    const a = await enter(slug, 'A', { clientId: 'tab-a' });
    const b = await enter(slug, 'B', { clientId: 'tab-b' });
    h.ws.send(
      JSON.stringify({ type: 'recording-started', recordingId: 'rec-1', kind: 'camera', filename: 'host_rec-1.mp4' })
    );
    await until(() => ofType(a.heard, 'recording-started').length > 0);

    h.ws.send(JSON.stringify({ type: 'peer-mute', peerId: a.me.peerId }));
    await until(() => ofType(a.heard, 'peer-mute').length > 0);
    expect(ofType(a.heard, 'peer-mute')).toEqual([{ type: 'peer-mute' }]);

    const gone = closed(a.ws);
    h.ws.send(JSON.stringify({ type: 'peer-remove', peerId: a.me.peerId }));
    const left = await Promise.race([gone, new Promise<null>((r) => setTimeout(() => r(null), 2000))]);
    expect(left).toEqual({ code: 4007, reason: 'removed' });

    // Still the room's take: someone who joins is told it is running.
    const late = await enter(slug, 'C', { clientId: 'tab-c' });
    expect(late.me.recording).toBe(true);

    [h.ws, b.ws, late.ws].forEach((w) => w.close());
  });
});
