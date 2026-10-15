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
type Access = Extract<ServerMessage, { type: 'room-access' }>;

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

/** Join and keep what the socket is sent and how it closed, without waiting for a seat. */
async function knock(slug: string, displayName: string, extra: Record<string, unknown> = {}) {
  const ws = await openWs(slug);
  const heard: ServerMessage[] = [];
  const close: { code?: number; reason?: string } = {};
  ws.addEventListener('message', (e) => heard.push(JSON.parse(e.data as string) as ServerMessage));
  ws.addEventListener('close', (e) => {
    close.code = e.code;
    close.reason = e.reason;
  });
  ws.send(JSON.stringify({ type: 'join', displayName, userAgent: 'ua', ...extra }));
  return { ws, heard, close };
}

function ofType<T extends ServerMessage['type']>(heard: ServerMessage[], type: T) {
  return heard.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
}

const settle = () => new Promise((r) => setTimeout(r, 150));

async function until(cond: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 80 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 25));
}

const sendRaw = (ws: WebSocket, m: Record<string, unknown>) => ws.send(JSON.stringify(m));
const setWaitingRoom = (ws: WebSocket, waitingRoom: unknown = true) =>
  sendRaw(ws, { type: 'room-access', waitingRoom });
const admit = (ws: WebSocket, peerId: unknown, admitIt: unknown = true) =>
  sendRaw(ws, { type: 'admit', peerId, admit: admitIt });

const lastAccess = (heard: ServerMessage[]): Access => ofType(heard, 'room-access').at(-1)!;
const waitingNames = (heard: ServerMessage[]) => lastAccess(heard).waiting.map((w) => w.displayName);

/** A host seated in a room whose waiting room is on, and the Room has said so. */
async function hostWithWaitingRoom(slug: string) {
  await seedRoom(slug, `tok-${slug}`);
  const h = await enter(slug, 'H', { hostToken: `tok-${slug}`, clientId: 'tab-h' });
  setWaitingRoom(h.ws);
  await until(() => ofType(h.heard, 'room-access').at(-1)?.waitingRoom === true);
  return h;
}

/** A guest the host has let in, so a test has someone seated in a room whose door is closed. */
async function seat(h: Awaited<ReturnType<typeof hostWithWaitingRoom>>, slug: string, name: string, clientId: string) {
  const k = await knock(slug, name, { clientId });
  await until(() => lastAccess(h.heard).waiting.some((w) => w.displayName === name));
  admit(h.ws, lastAccess(h.heard).waiting.find((w) => w.displayName === name)!.peerId);
  await until(() => ofType(k.heard, 'role-assigned').length > 0);
  await until(() => lastAccess(h.heard).waiting.length === 0);
  return { ws: k.ws, heard: k.heard, me: ofType(k.heard, 'role-assigned')[0]! };
}

const storedAccess = (slug: string) =>
  runInDurableObject(env.ROOM_DO.get(env.ROOM_DO.idFromName(slug)), (_instance, state) =>
    state.storage.get<{ waitingRoom?: boolean }>('access')
  );

const count = async (sql: string, ...bind: unknown[]) =>
  (await env.DB.prepare(sql).bind(...bind).first<{ n: number }>())!.n;

describe('Room DO: the waiting room holds a newcomer until the host lets them in', () => {
  it('sends a joining guest `door`, no `role-assigned`, lists it for the host, and announces nobody', async () => {
    const slug = 'rwt-hold-aaa';
    const h = await hostWithWaitingRoom(slug);
    const seated = await seat(h, slug, 'S', 'tab-s');
    // The room is open to a tab that was here first.
    expect(ofType(h.heard, 'peer-joined')).toHaveLength(1);

    const w = await knock(slug, 'Wanda', { clientId: 'tab-w' });
    await until(() => waitingNames(h.heard).length > 0);

    expect(w.heard).toEqual([{ type: 'door', state: 'waiting' }]);
    const list = lastAccess(h.heard).waiting;
    expect(list).toEqual([{ peerId: list[0]!.peerId, displayName: 'Wanda', role: 'guest' }]);
    expect(lastAccess(h.heard)).toMatchObject({ locked: false, waitingRoom: true });
    await settle();
    expect(ofType(h.heard, 'peer-joined')).toHaveLength(1);
    expect(ofType(seated.heard, 'peer-joined')).toEqual([]);
    expect(ofType(seated.heard, 'room-access')).toEqual([]);

    [h.ws, seated.ws, w.ws].forEach((x) => x.close());
  });

  it('lists a producer and a Present-only device with what they are', async () => {
    const slug = 'rwt-kind-aaa';
    const h = await hostWithWaitingRoom(slug);
    const p = await knock(slug, 'Pia', { producer: true, clientId: 'tab-p' });
    const c = await knock(slug, 'Cam', { companion: true, clientId: 'tab-c' });
    await until(() => waitingNames(h.heard).length > 1);

    expect(lastAccess(h.heard).waiting.map(({ peerId: _id, ...rest }) => rest)).toEqual([
      { displayName: 'Pia', role: 'producer' },
      { displayName: 'Cam', role: 'guest', companion: true },
    ]);

    [h.ws, p.ws, c.ws].forEach((x) => x.close());
  });

  it('creates no session or participant row, and does not push the expiry out', async () => {
    const slug = 'rwt-rows-aaa';
    await seedRoom(slug, 'tok-rwt-rows');
    const h = await enter(slug, 'H', { hostToken: 'tok-rwt-rows' });
    setWaitingRoom(h.ws);
    await until(() => ofType(h.heard, 'room-access').at(-1)?.waitingRoom === true);
    const expiry = () => count('SELECT expires_at AS n FROM rooms WHERE slug = ?', slug);
    const before = await expiry();
    const rows = () =>
      count(
        'SELECT COUNT(*) AS n FROM participants WHERE session_id IN (SELECT id FROM sessions WHERE room_slug = ?)',
        slug
      );
    expect(await rows()).toBe(1);
    await new Promise((r) => setTimeout(r, 20));

    const w = await knock(slug, 'Wanda', { clientId: 'tab-w' });
    await until(() => w.heard.length > 0);
    await settle();

    expect(await rows()).toBe(1);
    expect(await expiry()).toBe(before);

    [h.ws, w.ws].forEach((x) => x.close());
  });

  it('does not hold a guest while the waiting room is off, and never holds a host', async () => {
    const slug = 'rwt-offf-aaa';
    await seedRoom(slug, 'tok-rwt-offf');
    const g = await enter(slug, 'G', { clientId: 'tab-g' });
    expect(g.heard.some((m) => m.type === 'door')).toBe(false);

    const h = await hostWithWaitingRoom('rwt-offf-bbb');
    const second = await enter('rwt-offf-bbb', 'H2', { hostToken: 'tok-rwt-offf-bbb', clientId: 'tab-h2' });
    await until(() => ofType(second.heard, 'room-access').length > 0);
    expect(second.heard.some((m) => m.type === 'door')).toBe(false);
    expect(lastAccess(second.heard).waitingRoom).toBe(true);

    [g.ws, h.ws, second.ws].forEach((x) => x.close());
  });

  it('keeps chat from reaching a waiting socket, and a waiting socket’s chat from reaching anyone', async () => {
    const slug = 'rwt-chat-aaa';
    const h = await hostWithWaitingRoom(slug);
    const seated = await seat(h, slug, 'S', 'tab-s');
    const w = await knock(slug, 'Wanda', { clientId: 'tab-w' });
    await until(() => w.heard.length > 0);

    sendRaw(h.ws, { type: 'chat', text: 'to the room', ts: 1 });
    sendRaw(w.ws, { type: 'chat', text: 'from the door', ts: 2 });
    sendRaw(w.ws, { type: 'presence', micOn: true, camOn: true, screenSharing: false });
    await until(() => ofType(seated.heard, 'chat').length > 0);
    await settle();

    expect(ofType(seated.heard, 'chat').map((m) => m.text)).toEqual(['to the room']);
    expect(ofType(h.heard, 'chat')).toEqual([]);
    expect(ofType(h.heard, 'presence')).toEqual([]);
    expect(w.heard).toEqual([{ type: 'door', state: 'waiting' }]);

    [h.ws, seated.ws, w.ws].forEach((x) => x.close());
  });

  it('ignores a second `join` from a waiting socket, so the name the host saw stays', async () => {
    const slug = 'rwt-name-aaa';
    const h = await hostWithWaitingRoom(slug);
    const w = await knock(slug, 'Wanda', { clientId: 'tab-w' });
    await until(() => waitingNames(h.heard).length > 0);

    sendRaw(w.ws, { type: 'join', displayName: 'Somebody Else', userAgent: 'ua2', clientId: 'tab-w' });
    await settle();
    expect(waitingNames(h.heard)).toEqual(['Wanda']);
    expect(w.heard).toEqual([{ type: 'door', state: 'waiting' }]);

    admit(h.ws, lastAccess(h.heard).waiting[0]!.peerId);
    await until(() => ofType(h.heard, 'peer-joined').length > 0);
    expect(ofType(h.heard, 'peer-joined')[0]).toMatchObject({ displayName: 'Wanda', role: 'guest' });
    expect(
      await count('SELECT COUNT(*) AS n FROM participants WHERE display_name = ?', 'Somebody Else')
    ).toBe(0);

    [h.ws, w.ws].forEach((x) => x.close());
  });
});

describe('Room DO: the host answers a waiting person', () => {
  it('lets one in: role-assigned for it, peer-joined with its name for the others, an empty list for the host', async () => {
    const slug = 'rwt-lett-aaa';
    const h = await hostWithWaitingRoom(slug);
    const seated = await seat(h, slug, 'S', 'tab-s');
    const w = await knock(slug, 'Wanda', { clientId: 'tab-w', userAgent: 'Wanda-UA/1.0' });
    await until(() => waitingNames(h.heard).length > 0);
    const peerId = lastAccess(h.heard).waiting[0]!.peerId;
    const before = ofType(seated.heard, 'peer-joined').length;

    admit(h.ws, peerId, true);
    await until(() => ofType(w.heard, 'role-assigned').length > 0);
    await until(() => waitingNames(h.heard).length === 0);

    const assigned = ofType(w.heard, 'role-assigned')[0]!;
    expect(assigned).toMatchObject({ role: 'guest', peerId, recording: false });
    expect(assigned.peers.map((x) => x.displayName).sort()).toEqual(['H', 'S']);
    expect(ofType(seated.heard, 'peer-joined').slice(before)).toMatchObject([
      { displayName: 'Wanda', userAgent: 'Wanda-UA/1.0', peerId, role: 'guest' },
    ]);
    expect(lastAccess(h.heard).waiting).toEqual([]);
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM participants WHERE display_name = ? AND user_agent = ? AND left_at IS NULL',
        'Wanda',
        'Wanda-UA/1.0'
      )
    ).toBe(1);

    [h.ws, seated.ws, w.ws].forEach((x) => x.close());
  });

  it('seats a producer it lets in as a producer', async () => {
    const slug = 'rwt-prod-aaa';
    const h = await hostWithWaitingRoom(slug);
    const p = await knock(slug, 'Pia', { producer: true, clientId: 'tab-p' });
    await until(() => waitingNames(h.heard).length > 0);

    admit(h.ws, lastAccess(h.heard).waiting[0]!.peerId);
    await until(() => ofType(p.heard, 'role-assigned').length > 0);
    expect(ofType(p.heard, 'role-assigned')[0]!.role).toBe('producer');

    [h.ws, p.ws].forEach((x) => x.close());
  });

  it('refuses one with 4008 and the reason "refused", and the host’s list is empty', async () => {
    const slug = 'rwt-refu-aaa';
    const h = await hostWithWaitingRoom(slug);
    const w = await knock(slug, 'Wanda', { clientId: 'tab-w' });
    await until(() => waitingNames(h.heard).length > 0);

    admit(h.ws, lastAccess(h.heard).waiting[0]!.peerId, false);
    await until(() => w.close.code !== undefined);
    await until(() => waitingNames(h.heard).length === 0);

    expect(w.close).toEqual({ code: 4008, reason: 'refused' });
    expect(lastAccess(h.heard).waiting).toEqual([]);
    expect(w.heard.some((m) => m.type === 'role-assigned')).toBe(false);
    expect(ofType(h.heard, 'peer-left')).toEqual([]);

    h.ws.close();
  });

  it('ignores `admit` from a guest, and from the host with an id or answer it cannot use', async () => {
    const slug = 'rwt-igno-aaa';
    const h = await hostWithWaitingRoom(slug);
    const seated = await seat(h, slug, 'S', 'tab-s');
    const w = await knock(slug, 'Wanda', { clientId: 'tab-w' });
    await until(() => waitingNames(h.heard).length > 0);
    const peerId = lastAccess(h.heard).waiting[0]!.peerId;

    admit(seated.ws, peerId, true);
    admit(w.ws, peerId, true);
    admit(h.ws, peerId, 'yes');
    admit(h.ws, peerId, 1);
    admit(h.ws, 42, true);
    admit(h.ws, 'no-such-peer', true);
    admit(h.ws, seated.me.peerId, true);
    sendRaw(h.ws, { type: 'admit', peerId });
    await settle();

    expect(w.heard).toEqual([{ type: 'door', state: 'waiting' }]);
    expect(w.close.code).toBeUndefined();
    expect(waitingNames(h.heard)).toEqual(['Wanda']);

    [h.ws, seated.ws, w.ws].forEach((x) => x.close());
  });

  it('answers a person it has let in only once', async () => {
    const slug = 'rwt-once-aaa';
    const h = await hostWithWaitingRoom(slug);
    const w = await knock(slug, 'Wanda', { clientId: 'tab-w' });
    await until(() => waitingNames(h.heard).length > 0);
    const peerId = lastAccess(h.heard).waiting[0]!.peerId;

    admit(h.ws, peerId, true);
    await until(() => ofType(w.heard, 'role-assigned').length > 0);
    admit(h.ws, peerId, false);
    await settle();

    expect(w.close.code).toBeUndefined();
    expect(ofType(w.heard, 'role-assigned')).toHaveLength(1);

    [h.ws, w.ws].forEach((x) => x.close());
  });

  it('sends role-assigned with recording: true to a person let in during a take', async () => {
    const slug = 'rwt-take-aaa';
    const h = await hostWithWaitingRoom(slug);
    sendRaw(h.ws, { type: 'recording-started', recordingId: 'rec-w', kind: 'camera', filename: 'host_rec-w.mp4' });
    await until(() => count('SELECT COUNT(*) AS n FROM recordings WHERE id = ?', 'rec-w').then((n) => n > 0));
    const w = await knock(slug, 'Wanda', { clientId: 'tab-w' });
    await until(() => waitingNames(h.heard).length > 0);

    admit(h.ws, lastAccess(h.heard).waiting[0]!.peerId);
    await until(() => ofType(w.heard, 'role-assigned').length > 0);

    expect(ofType(w.heard, 'role-assigned')[0]!.recording).toBe(true);
    expect(w.heard.some((m) => m.type === 'recording-started')).toBe(false);

    [h.ws, w.ws].forEach((x) => x.close());
  });
});

describe('Room DO: the waiting list', () => {
  it('closes a ninth waiting socket with 4008 and the reason "busy", and lists eight in the order they came', async () => {
    const slug = 'rwt-nine-aaa';
    const h = await hostWithWaitingRoom(slug);
    const eight = [];
    for (let i = 0; i < 8; i++) eight.push(await knock(slug, `W${i}`, { clientId: `tab-${i}` }));
    await until(() => waitingNames(h.heard).length === 8);

    const ninth = await knock(slug, 'W8', { clientId: 'tab-8' });
    await until(() => ninth.close.code !== undefined);

    expect(ninth.close).toEqual({ code: 4008, reason: 'busy' });
    expect(ninth.heard).toEqual([]);
    expect(waitingNames(h.heard)).toEqual(['W0', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7']);

    // A place that is given back is taken by the next to knock.
    eight[0]!.ws.close();
    await until(() => waitingNames(h.heard).length === 7);
    const again = await knock(slug, 'W9', { clientId: 'tab-9' });
    await until(() => waitingNames(h.heard).includes('W9'));
    expect(again.close.code).toBeUndefined();

    [h.ws, again.ws, ...eight.map((x) => x.ws)].forEach((x) => x.close());
  }, 20_000);

  it('drops a waiting socket that closes from the host’s list', async () => {
    const slug = 'rwt-clos-aaa';
    const h = await hostWithWaitingRoom(slug);
    const a = await knock(slug, 'Ann', { clientId: 'tab-a' });
    const b = await knock(slug, 'Bea', { clientId: 'tab-b' });
    await until(() => waitingNames(h.heard).length === 2);

    a.ws.close();
    await until(() => waitingNames(h.heard).length === 1);
    expect(waitingNames(h.heard)).toEqual(['Bea']);
    await settle();
    expect(ofType(h.heard, 'peer-left')).toEqual([]);

    [h.ws, b.ws].forEach((x) => x.close());
  });

  it('replaces a waiting socket with the newer one from the same tab', async () => {
    const slug = 'rwt-repl-aaa';
    const h = await hostWithWaitingRoom(slug);
    const first = await knock(slug, 'Wanda', { clientId: 'tab-w' });
    await until(() => waitingNames(h.heard).length === 1);
    const second = await knock(slug, 'Wanda', { clientId: 'tab-w' });
    await until(() => first.close.code !== undefined);
    await until(() => ofType(second.heard, 'door').length > 0);
    await settle();

    expect(first.close.code).toBe(4006);
    expect(waitingNames(h.heard)).toEqual(['Wanda']);

    [h.ws, second.ws].forEach((x) => x.close());
  });

  it('gives a host that joins after two people started waiting both of them in its room-access', async () => {
    const slug = 'rwt-late-aaa';
    await seedRoom(slug, 'tok-rwt-late');
    const first = await enter(slug, 'H', { hostToken: 'tok-rwt-late' });
    setWaitingRoom(first.ws);
    await until(() => ofType(first.heard, 'room-access').at(-1)?.waitingRoom === true);
    const a = await knock(slug, 'Ann', { clientId: 'tab-a' });
    const b = await knock(slug, 'Bea', { clientId: 'tab-b' });
    await until(() => waitingNames(first.heard).length === 2);
    first.ws.close();
    await until(() => first.heard.length > 0);

    const back = await enter(slug, 'H', { hostToken: 'tok-rwt-late' });
    await until(() => ofType(back.heard, 'room-access').length > 0);
    expect(ofType(back.heard, 'room-access')).toHaveLength(1);
    expect(lastAccess(back.heard)).toMatchObject({ waitingRoom: true });
    expect(waitingNames(back.heard)).toEqual(['Ann', 'Bea']);

    [back.ws, a.ws, b.ws].forEach((x) => x.close());
  });

  it('tells every host in the room, and no guest', async () => {
    const slug = 'rwt-tell-aaa';
    const h = await hostWithWaitingRoom(slug);
    const seated = await seat(h, slug, 'S', 'tab-s');
    const w = await knock(slug, 'Wanda', { clientId: 'tab-w' });
    await until(() => waitingNames(h.heard).length > 0);

    expect(ofType(seated.heard, 'room-access')).toEqual([]);
    expect(ofType(w.heard, 'room-access')).toEqual([]);

    [h.ws, seated.ws, w.ws].forEach((x) => x.close());
  });
});

describe('Room DO: the waiting room with the lock and the session', () => {
  it('closes a newcomer to a locked room, and still lets in one that was already waiting', async () => {
    const slug = 'rwt-lock-aaa';
    const h = await hostWithWaitingRoom(slug);
    const w = await knock(slug, 'Wanda', { clientId: 'tab-w' });
    await until(() => waitingNames(h.heard).length > 0);
    sendRaw(h.ws, { type: 'room-access', locked: true });
    await until(() => lastAccess(h.heard).locked);

    const late = await knock(slug, 'Late', { clientId: 'tab-late' });
    await until(() => late.close.code !== undefined);
    expect(late.close).toEqual({ code: 4008, reason: 'locked' });
    expect(late.heard).toEqual([]);

    admit(h.ws, lastAccess(h.heard).waiting[0]!.peerId);
    await until(() => ofType(w.heard, 'role-assigned').length > 0);
    expect(w.close.code).toBeUndefined();

    [h.ws, w.ws].forEach((x) => x.close());
  });

  it('seats a tab it seated before on a new socket without waiting', async () => {
    const slug = 'rwt-back-aaa';
    const h = await hostWithWaitingRoom(slug);
    const w = await knock(slug, 'Wanda', { clientId: 'tab-w' });
    await until(() => waitingNames(h.heard).length > 0);
    admit(h.ws, lastAccess(h.heard).waiting[0]!.peerId);
    await until(() => ofType(w.heard, 'role-assigned').length > 0);

    const again = await knock(slug, 'Wanda', { clientId: 'tab-w' });
    await until(() => ofType(again.heard, 'role-assigned').length > 0);
    expect(again.heard.some((m) => m.type === 'door')).toBe(false);
    expect(lastAccess(h.heard).waiting).toEqual([]);

    // An id the room never seated waits like anyone.
    const other = await knock(slug, 'Other', { clientId: 'tab-o' });
    await until(() => ofType(other.heard, 'door').length > 0);
    expect(other.heard.some((m) => m.type === 'role-assigned')).toBe(false);

    [h.ws, w.ws, again.ws, other.ws].forEach((x) => x.close());
  });

  it('holds a join that carries no client id', async () => {
    const slug = 'rwt-noid-aaa';
    const h = await hostWithWaitingRoom(slug);
    const w = await knock(slug, 'Wanda');
    await until(() => w.heard.length > 0);
    expect(w.heard).toEqual([{ type: 'door', state: 'waiting' }]);

    [h.ws, w.ws].forEach((x) => x.close());
  });

  it('seats everyone who waits when the host turns the waiting room off', async () => {
    const slug = 'rwt-offs-aaa';
    const h = await hostWithWaitingRoom(slug);
    const a = await knock(slug, 'Ann', { clientId: 'tab-a' });
    const b = await knock(slug, 'Bea', { clientId: 'tab-b' });
    await until(() => waitingNames(h.heard).length === 2);

    setWaitingRoom(h.ws, false);
    await until(() => ofType(a.heard, 'role-assigned').length > 0 && ofType(b.heard, 'role-assigned').length > 0);
    await until(() => lastAccess(h.heard).waiting.length === 0);

    expect(lastAccess(h.heard)).toMatchObject({ waitingRoom: false, waiting: [] });
    expect(ofType(h.heard, 'peer-joined').map((m) => m.displayName)).toEqual(['Ann', 'Bea']);
    // They see each other: the second to be seated is told of the first.
    expect(ofType(b.heard, 'role-assigned')[0]!.peers.map((x) => x.displayName).sort()).toEqual(['Ann', 'H']);
    const c = await enter(slug, 'Cy', { clientId: 'tab-c' });
    expect(c.heard.some((m) => m.type === 'door')).toBe(false);

    [h.ws, a.ws, b.ws, c.ws].forEach((x) => x.close());
  });

  it('ignores a waitingRoom that is not a boolean, and one from a guest', async () => {
    const slug = 'rwt-bool-aaa';
    const h = await hostWithWaitingRoom(slug);
    const seated = await seat(h, slug, 'S', 'tab-s');
    const before = ofType(h.heard, 'room-access').length;

    for (const v of ['no', 0, null, [false], {}]) setWaitingRoom(h.ws, v);
    setWaitingRoom(seated.ws, false);
    await settle();

    expect(ofType(h.heard, 'room-access')).toHaveLength(before);
    const w = await knock(slug, 'Wanda', { clientId: 'tab-w' });
    await until(() => w.heard.length > 0);
    expect(w.heard).toEqual([{ type: 'door', state: 'waiting' }]);

    [h.ws, seated.ws, w.ws].forEach((x) => x.close());
  });

  it('changes one setting without touching the other', async () => {
    const slug = 'rwt-both-aaa';
    const h = await hostWithWaitingRoom(slug);
    sendRaw(h.ws, { type: 'room-access', locked: true });
    await until(() => lastAccess(h.heard).locked);
    expect(lastAccess(h.heard)).toMatchObject({ locked: true, waitingRoom: true });

    sendRaw(h.ws, { type: 'room-access', locked: false });
    await until(() => !lastAccess(h.heard).locked);
    expect(lastAccess(h.heard)).toMatchObject({ locked: false, waitingRoom: true });

    h.ws.close();
  });

  it('keeps the setting in storage under `access` after everyone has left, and holds the next newcomer', async () => {
    const slug = 'rwt-stor-aaa';
    const h = await hostWithWaitingRoom(slug);
    expect(await storedAccess(slug)).toEqual({ waitingRoom: true });

    h.ws.close();
    await until(() => count('SELECT COUNT(*) AS n FROM sessions WHERE room_slug = ? AND ended_at IS NOT NULL', slug).then((n) => n > 0));
    await settle();

    expect(await storedAccess(slug)).toEqual({ waitingRoom: true });
    const w = await knock(slug, 'Wanda', { clientId: 'tab-w' });
    await until(() => w.heard.length > 0);
    expect(w.heard).toEqual([{ type: 'door', state: 'waiting' }]);

    w.ws.close();
  });

  it('still holds a newcomer after the Room was evicted from memory', async () => {
    const slug = 'rwt-wake-aaa';
    const h = await hostWithWaitingRoom(slug);

    const answer = await runInDurableObject(env.ROOM_DO.get(env.ROOM_DO.idFromName(slug)), async (_instance, state) => {
      // A woken Room is a new instance that knows only what storage holds.
      const fresh = new Room(state, env);
      await new Promise((r) => setTimeout(r, 50));
      const before = new Set(state.getWebSockets());
      const res = await fresh.fetch(new Request(`https://test/ws/r/${slug}`, { headers: { Upgrade: 'websocket' } }));
      const clientWs = res.webSocket!;
      clientWs.accept();
      const serverWs = state.getWebSockets().find((x) => !before.has(x));
      if (!serverWs) throw new Error('expected a newly accepted socket');
      const heard = new Promise<string>((resolve) => {
        clientWs.addEventListener('message', (e) => resolve((JSON.parse(e.data as string) as { type: string }).type));
      });
      await fresh.webSocketMessage(
        serverWs,
        JSON.stringify({ type: 'join', displayName: 'Wanda', userAgent: 'ua', clientId: 'tab-w' })
      );
      return heard;
    });
    expect(answer).toBe('door');

    h.ws.close();
  }, 15_000);

  it('closes a waiting socket when the room expires', async () => {
    const slug = 'rwt-expi-aaa';
    const h = await hostWithWaitingRoom(slug);
    const w = await knock(slug, 'Wanda', { clientId: 'tab-w' });
    await until(() => waitingNames(h.heard).length > 0);
    await env.DB.prepare('UPDATE rooms SET expires_at = ? WHERE slug = ?').bind(Date.now() - 1, slug).run();

    await runInDurableObject(env.ROOM_DO.get(env.ROOM_DO.idFromName(slug)), (instance) => (instance as Room).alarm());
    await until(() => w.close.code !== undefined);

    expect(w.close.code).toBe(4003);

    h.ws.close();
  });
});

describe('Room DO: a room with a chosen name starts with its waiting room on', () => {
  it('holds a guest at the door and tells the host the waiting room is on', async () => {
    const slug = 'rwt-named-show';
    await seedRoom(slug, `tok-${slug}`);
    const h = await enter(slug, 'H', { hostToken: `tok-${slug}`, clientId: 'tab-h' });
    await until(() => ofType(h.heard, 'room-access').length > 0);
    expect(lastAccess(h.heard).waitingRoom).toBe(true);
    // A Room woken from eviction reads only storage, so the default is kept there.
    expect(await storedAccess(slug)).toEqual({ waitingRoom: true });

    const w = await knock(slug, 'Wanda', { clientId: 'tab-w' });
    await until(() => w.heard.length > 0);
    expect(w.heard).toEqual([{ type: 'door', state: 'waiting' }]);

    [h.ws, w.ws].forEach((x) => x.close());
  });

  it('stays off once the host turned it off, for a later guest on a new socket', async () => {
    const slug = 'rwt-named-open';
    await seedRoom(slug, `tok-${slug}`);
    const h = await enter(slug, 'H', { hostToken: `tok-${slug}`, clientId: 'tab-h' });
    setWaitingRoom(h.ws, false);
    await until(() => ofType(h.heard, 'room-access').at(-1)?.waitingRoom === false);
    expect((await storedAccess(slug))?.waitingRoom).toBe(false);

    const g = await enter(slug, 'G', { clientId: 'tab-g' });
    expect(g.heard.some((m) => m.type === 'door')).toBe(false);

    [h.ws, g.ws].forEach((x) => x.close());
  });

  it('seats a guest at once in a room with a random slug', async () => {
    const slug = 'rwt-rand-aaa';
    await seedRoom(slug, `tok-${slug}`);
    const g = await enter(slug, 'G', { clientId: 'tab-g' });
    expect(g.heard.some((m) => m.type === 'door')).toBe(false);
    expect(await storedAccess(slug)).toBeUndefined();

    g.ws.close();
  });
});
