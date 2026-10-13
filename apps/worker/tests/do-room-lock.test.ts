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

const lock = (ws: WebSocket, locked: unknown = true) => ws.send(JSON.stringify({ type: 'room-access', locked }));
const sendRaw = (ws: WebSocket, m: Record<string, unknown>) => ws.send(JSON.stringify(m));

const storedSession = (slug: string) =>
  runInDurableObject(env.ROOM_DO.get(env.ROOM_DO.idFromName(slug)), (_instance, state) =>
    state.storage.get<{ locked?: boolean; admitted?: string[] }>('session')
  );

describe('Room DO — the host locks the room', () => {
  it('refuses a new guest, a producer link and a Present-only link with 4008, and disturbs nobody seated', async () => {
    const slug = 'rlk-refu-aaa';
    await seedRoom(slug, 'tok-rlk-refu');
    const h = await enter(slug, 'H', { hostToken: 'tok-rlk-refu' });
    const a = await enter(slug, 'A', { clientId: 'tab-a' });
    const goneA = closed(a.ws);
    let aClosed = false;
    void goneA.then(() => (aClosed = true));
    lock(h.ws);
    await until(() => ofType(h.heard, 'room-access').length > 1);

    for (const extra of [{ clientId: 'tab-new' }, { producer: true, clientId: 'tab-prod' }, { companion: true, clientId: 'tab-pres' }, {}]) {
      const k = await knock(slug, extra);
      expect(k.answer).toBe(4008);
      expect(k.heard).toEqual([]);
    }
    await settle();
    expect(aClosed).toBe(false);
    expect(ofType(a.heard, 'room-access')).toEqual([]);
    expect(ofType(a.heard, 'peer-left')).toEqual([]);
    expect(ofType(h.heard, 'peer-joined')).toHaveLength(1);

    [h.ws, a.ws].forEach((w) => w.close());
  });

  it('closes a refused join with the reason "locked"', async () => {
    const slug = 'rlk-reas-aaa';
    await seedRoom(slug, 'tok-rlk-reas');
    const h = await enter(slug, 'H', { hostToken: 'tok-rlk-reas' });
    lock(h.ws);
    await until(() => ofType(h.heard, 'room-access').length > 1);
    const ws = await openWs(slug);
    const gone = closed(ws);
    ws.send(JSON.stringify({ type: 'join', displayName: 'A', userAgent: 'ua', clientId: 'tab-x' }));
    expect(await gone).toEqual({ code: 4008, reason: 'locked' });
    h.ws.close();
  });

  it('seats a tab it seated before, on a new socket, and refuses an id it never saw', async () => {
    const slug = 'rlk-back-aaa';
    await seedRoom(slug, 'tok-rlk-back');
    const h = await enter(slug, 'H', { hostToken: 'tok-rlk-back' });
    const a = await enter(slug, 'A', { clientId: 'tab-a' });
    lock(h.ws);
    await until(() => ofType(h.heard, 'room-access').length > 1);

    const again = await knock(slug, { clientId: 'tab-a' });
    expect(again.answer).toBe('seated');
    expect((await knock(slug, { clientId: 'tab-b' })).answer).toBe(4008);

    [h.ws, a.ws, again.ws].forEach((w) => w.close());
  });

  it('seats a join that carries the host token', async () => {
    const slug = 'rlk-host-aaa';
    await seedRoom(slug, 'tok-rlk-host');
    const h = await enter(slug, 'H', { hostToken: 'tok-rlk-host' });
    const a = await enter(slug, 'A', { clientId: 'tab-a' });
    lock(h.ws);
    await until(() => ofType(h.heard, 'room-access').length > 1);

    const host = await knock(slug, { hostToken: 'tok-rlk-host', clientId: 'tab-h2' });
    expect(host.answer).toBe('seated');

    [host.ws, a.ws].forEach((w) => w.close());
  });

  it('ignores room-access from a guest, and from the host with a value that is not a boolean', async () => {
    const slug = 'rlk-ignr-aaa';
    await seedRoom(slug, 'tok-rlk-ignr');
    const h = await enter(slug, 'H', { hostToken: 'tok-rlk-ignr' });
    const a = await enter(slug, 'A', { clientId: 'tab-a' });
    const p = await enter(slug, 'P', { producer: true, clientId: 'tab-p' });

    lock(a.ws);
    lock(p.ws);
    for (const v of ['yes', 1, null, [true], {}]) lock(h.ws, v);
    sendRaw(h.ws, { type: 'room-access' });
    await settle();

    expect(ofType(h.heard, 'room-access')).toEqual([{ type: 'room-access', locked: false }]);
    for (const w of [a, p]) expect(ofType(w.heard, 'room-access')).toEqual([]);
    const next = await knock(slug, { clientId: 'tab-next' });
    expect(next.answer).toBe('seated');

    [h.ws, a.ws, p.ws, next.ws].forEach((w) => w.close());
  });

  it('tells the host after its role-assigned and after each change, and tells nobody else', async () => {
    const slug = 'rlk-tell-aaa';
    await seedRoom(slug, 'tok-rlk-tell');
    const h = await enter(slug, 'H', { hostToken: 'tok-rlk-tell' });
    const a = await enter(slug, 'A', { clientId: 'tab-a' });
    expect(h.heard.map((m) => m.type).slice(0, 2)).toEqual(['role-assigned', 'room-access']);

    lock(h.ws, true);
    await until(() => ofType(h.heard, 'room-access').length > 1);
    lock(h.ws, false);
    await until(() => ofType(h.heard, 'room-access').length > 2);
    expect(ofType(h.heard, 'room-access').map((m) => m.locked)).toEqual([false, true, false]);
    expect(ofType(a.heard, 'room-access')).toEqual([]);

    // A host that comes back, by token, is told whether the room is locked.
    lock(h.ws, true);
    await until(() => ofType(h.heard, 'room-access').length > 3);
    const back = await enter(slug, 'H', { hostToken: 'tok-rlk-tell' });
    await until(() => ofType(back.heard, 'room-access').length > 0);
    expect(ofType(back.heard, 'room-access')).toEqual([{ type: 'room-access', locked: true }]);

    [back.ws, a.ws].forEach((w) => w.close());
  });

  it('sends the answer to every host in the room, and to no guest', async () => {
    const slug = 'rlk-both-aaa';
    await seedRoom(slug, 'tok-rlk-both');
    const h = await enter(slug, 'H', { hostToken: 'tok-rlk-both' });
    const a = await enter(slug, 'A', { clientId: 'tab-a' });
    const mate = await enter(slug, 'M', { clientId: 'tab-m' });
    lock(h.ws);
    await until(() => ofType(h.heard, 'room-access').length > 1);
    await settle();
    expect(ofType(a.heard, 'room-access')).toEqual([]);
    expect(ofType(mate.heard, 'room-access')).toEqual([]);

    [h.ws, a.ws, mate.ws].forEach((w) => w.close());
  });

  it('keeps the lock and the seated ids in the session row', async () => {
    const slug = 'rlk-stor-aaa';
    await seedRoom(slug, 'tok-rlk-stor');
    const h = await enter(slug, 'H', { hostToken: 'tok-rlk-stor', clientId: 'tab-h' });
    const a = await enter(slug, 'A', { clientId: 'tab-a' });
    const p = await enter(slug, 'P', { producer: true, clientId: 'tab-p' });
    lock(h.ws);
    await until(() => ofType(h.heard, 'room-access').length > 1);
    // A repeat of the same id is held once.
    const again = await knock(slug, { clientId: 'tab-a' });

    const row = await storedSession(slug);
    expect(row?.locked).toBe(true);
    // The host's own id is not listed: a host is never refused.
    expect(row?.admitted).toEqual(['tab-a', 'tab-p']);

    [h.ws, a.ws, p.ws, again.ws].forEach((w) => w.close());
  });

  it('is still locked, and still seats the tabs it seated, after the Room was evicted from memory', async () => {
    const slug = 'rlk-wake-aaa';
    await seedRoom(slug, 'tok-rlk-wake');
    const h = await enter(slug, 'H', { hostToken: 'tok-rlk-wake' });
    const a = await enter(slug, 'A', { clientId: 'tab-a' });
    lock(h.ws);
    await until(() => ofType(h.heard, 'room-access').length > 1);

    const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(slug));
    const answers = await runInDurableObject(stub, async (_instance, state) => {
      // A woken Room is a new instance that knows only what storage holds.
      const fresh = new Room(state, env);
      await new Promise((r) => setTimeout(r, 50));
      const knockOn = async (clientId: string) => {
        const before = new Set(state.getWebSockets());
        const res = await fresh.fetch(
          new Request(`https://test/ws/r/${slug}`, { headers: { Upgrade: 'websocket' } })
        );
        const clientWs = res.webSocket!;
        clientWs.accept();
        const serverWs = state.getWebSockets().find((x) => !before.has(x));
        if (!serverWs) throw new Error('expected a newly accepted socket');
        const answered = new Promise<'seated' | number>((resolve) => {
          clientWs.addEventListener('message', () => resolve('seated'));
          clientWs.addEventListener('close', (e) => resolve(e.code));
        });
        await fresh.webSocketMessage(
          serverWs,
          JSON.stringify({ type: 'join', displayName: 'A', userAgent: 'ua', clientId })
        );
        return answered;
      };
      return [await knockOn('tab-new'), await knockOn('tab-a')];
    });
    expect(answers).toEqual([4008, 'seated']);

    [h.ws, a.ws].forEach((w) => w.close());
  }, 15_000);

  it('opens again when everyone has left: the next guest is seated and the row is empty', async () => {
    const slug = 'rlk-over-aaa';
    await seedRoom(slug, 'tok-rlk-over');
    const h = await enter(slug, 'H', { hostToken: 'tok-rlk-over' });
    const a = await enter(slug, 'A', { clientId: 'tab-a' });
    lock(h.ws);
    await until(() => ofType(h.heard, 'room-access').length > 1);

    h.ws.close();
    a.ws.close();
    await until(() => sessionEnded(slug));
    await settle();

    const row = await storedSession(slug);
    expect(row?.locked).toBe(false);
    expect(row?.admitted).toEqual([]);
    const next = await knock(slug, { clientId: 'tab-new' });
    expect(next.answer).toBe('seated');
    next.ws.close();
  });

  it('still closes a removed tab with 4007, locked or not', async () => {
    const slug = 'rlk-remo-aaa';
    await seedRoom(slug, 'tok-rlk-remo');
    const h = await enter(slug, 'H', { hostToken: 'tok-rlk-remo' });
    const a = await enter(slug, 'A', { clientId: 'tab-a' });
    const gone = closed(a.ws);
    h.ws.send(JSON.stringify({ type: 'peer-remove', peerId: a.me.peerId }));
    await gone;

    expect((await knock(slug, { clientId: 'tab-a' })).answer).toBe(4007);
    lock(h.ws);
    await until(() => ofType(h.heard, 'room-access').length > 1);
    expect((await knock(slug, { clientId: 'tab-a' })).answer).toBe(4007);

    h.ws.close();
  });

  it('remembers the newest 32 seated tabs, and keeps one that is still in the room', async () => {
    const slug = 'rlk-many-aaa';
    await seedRoom(slug, 'tok-rlk-many');
    const h = await enter(slug, 'H', { hostToken: 'tok-rlk-many' });
    const a = await enter(slug, 'A', { clientId: 'tab-stays' });

    for (let i = 0; i < 32; i++) {
      const k = await knock(slug, { clientId: `tab-${i}` });
      expect(k.answer).toBe('seated');
      k.ws.close();
      await until(async () => ofType(h.heard, 'peer-left').length >= i + 1);
    }

    const row = await storedSession(slug);
    expect(row?.admitted).toHaveLength(32);
    expect(row?.admitted).toContain('tab-stays');
    expect(row?.admitted).toContain('tab-31');
    expect(row?.admitted).not.toContain('tab-0');

    [h.ws, a.ws].forEach((w) => w.close());
  }, 20_000);
});
