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

type Access = Extract<ServerMessage, { type: 'room-access' }>;
type Door = Extract<ServerMessage, { type: 'door' }> & { wrong?: boolean };

/** Connect and keep what the socket is sent and how it closed. Joins only when `join` is given. */
async function connect(slug: string, join?: Record<string, unknown>) {
  const ws = await openWs(slug);
  const heard: ServerMessage[] = [];
  const close: { code?: number; reason?: string } = {};
  ws.addEventListener('message', (e) => heard.push(JSON.parse(e.data as string) as ServerMessage));
  ws.addEventListener('close', (e) => {
    close.code = e.code;
    close.reason = e.reason;
  });
  const sendJoin = (extra: Record<string, unknown> = {}) =>
    ws.send(JSON.stringify({ type: 'join', displayName: 'G', userAgent: 'ua', ...extra }));
  if (join) sendJoin(join);
  return { ws, heard, close, sendJoin };
}

function ofType<T extends ServerMessage['type']>(heard: ServerMessage[], type: T) {
  return heard.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
}

async function until(cond: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 80 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 25));
}
const settle = () => new Promise((r) => setTimeout(r, 150));

const sendRaw = (ws: WebSocket, m: Record<string, unknown>) => ws.send(JSON.stringify(m));
const doors = (heard: ServerMessage[]) => ofType(heard, 'door') as Door[];
const lastAccess = (heard: ServerMessage[]): Access => ofType(heard, 'room-access').at(-1)!;

const PASS = 'tuesday7';

/** A host seated in a room, and the passcode it has set, confirmed by the Room. */
async function hostWithPasscode(slug: string, passcode: string | null = PASS) {
  await seedRoom(slug, `tok-${slug}`);
  const h = await connect(slug, { displayName: 'H', hostToken: `tok-${slug}`, clientId: 'tab-h' });
  await until(() => ofType(h.heard, 'role-assigned').length > 0);
  if (passcode !== null) {
    sendRaw(h.ws, { type: 'room-access', passcode });
    await until(() => lastAccess(h.heard)?.passcode === true);
  }
  return h;
}

const objectOf = <T>(slug: string, fn: (state: DurableObjectState) => Promise<T>) =>
  runInDurableObject(env.ROOM_DO.get(env.ROOM_DO.idFromName(slug)), (_i, state) => fn(state));

const stored = (slug: string, key: string) => objectOf(slug, (state) => state.storage.get<Record<string, unknown>>(key));
const passFails = (slug: string) => stored(slug, 'passFails') as Promise<{ count: number; since: number } | undefined>;

/** `n` wrong passcodes, each on a socket of its own so the per-socket limit is not reached. */
async function wrongTries(slug: string, n: number) {
  for (let i = 0; i < n; i++) {
    const g = await connect(slug, { passcode: 'wrong-' + i });
    await until(() => doors(g.heard).length > 0);
    g.ws.close();
  }
}

describe('Room DO: the passcode a guest gives before it joins', () => {
  it('asks for it, seats the same socket on the right one, and answers a wrong one with wrong: true', async () => {
    const slug = 'pca-gate-aaa';
    const h = await hostWithPasscode(slug);

    const g = await connect(slug, {});
    await until(() => doors(g.heard).length > 0);
    expect(g.heard.map((m) => m.type)).toEqual(['door']);
    expect(g.heard[0]).toEqual({ type: 'door', state: 'passcode' });

    g.sendJoin({ passcode: 'monday8' });
    await until(() => doors(g.heard).length > 1);
    expect(g.heard[1]).toEqual({ type: 'door', state: 'passcode', wrong: true });
    expect(ofType(g.heard, 'role-assigned')).toHaveLength(0);

    g.sendJoin({ passcode: PASS });
    await until(() => ofType(g.heard, 'role-assigned').length > 0);
    expect(ofType(g.heard, 'role-assigned')[0]!.role).toBe('guest');

    h.ws.close();
    g.ws.close();
  });

  it('closes a socket with 4008 on its fifth wrong passcode, and not before', async () => {
    const slug = 'pca-five-aaa';
    const h = await hostWithPasscode(slug);
    const g = await connect(slug, {});
    await until(() => doors(g.heard).length === 1);
    for (let i = 1; i <= 4; i++) {
      g.sendJoin({ passcode: 'wrong-' + i });
      await until(() => doors(g.heard).length === i + 1);
    }
    expect(g.close.code).toBeUndefined();
    expect(doors(g.heard).slice(1).every((d) => d.wrong === true)).toBe(true);

    g.sendJoin({ passcode: 'wrong-5' });
    await until(() => g.close.code !== undefined);
    expect(g.close).toEqual({ code: 4008, reason: 'passcode' });
    expect(ofType(g.heard, 'role-assigned')).toHaveLength(0);

    h.ws.close();
  });

  it('counts only wrong passcodes: a join without one, or with one of the wrong type or length, is not counted', async () => {
    const slug = 'pca-cont-aaa';
    const h = await hostWithPasscode(slug);
    const g = await connect(slug);
    for (const bad of [undefined, '', 'x'.repeat(65), 7, null, { a: 1 }]) {
      g.sendJoin(bad === undefined ? {} : { passcode: bad });
    }
    await until(() => doors(g.heard).length === 6);
    expect(doors(g.heard).every((d) => d.wrong === undefined)).toBe(true);
    expect(await passFails(slug)).toBeUndefined();
    // Five more would have closed it had the above been counted.
    for (let i = 1; i <= 4; i++) g.sendJoin({ passcode: 'wrong-' + i });
    await until(() => doors(g.heard).length === 10);
    expect(g.close.code).toBeUndefined();

    h.ws.close();
    g.ws.close();
  });

  it('asks a producer link and a Present-only link, and does not ask the host', async () => {
    const slug = 'pca-role-aaa';
    const h = await hostWithPasscode(slug);

    const prod = await connect(slug, { producer: true, clientId: 'tab-p' });
    const comp = await connect(slug, { companion: true, clientId: 'tab-c' });
    await until(() => doors(prod.heard).length > 0 && doors(comp.heard).length > 0);
    for (const x of [prod, comp]) {
      expect(x.heard.map((m) => m.type)).toEqual(['door']);
      expect(doors(x.heard)[0]).toEqual({ type: 'door', state: 'passcode' });
    }

    // The host reconnecting, by token, on a socket that has not seen the passcode.
    const h2 = await connect(slug, { displayName: 'H', hostToken: `tok-${slug}`, clientId: 'tab-h' });
    await until(() => ofType(h2.heard, 'role-assigned').length > 0);
    expect(ofType(h2.heard, 'role-assigned')[0]!.role).toBe('host');
    expect(doors(h2.heard)).toHaveLength(0);

    for (const x of [h, h2, prod, comp]) x.ws.close();
  });

  it('seats a producer who gives the right passcode', async () => {
    const slug = 'pca-prod-aaa';
    const h = await hostWithPasscode(slug);
    const prod = await connect(slug, { producer: true, passcode: PASS });
    await until(() => ofType(prod.heard, 'role-assigned').length > 0);
    expect(ofType(prod.heard, 'role-assigned')[0]!.role).toBe('producer');
    h.ws.close();
    prod.ws.close();
  });

  it('does not ask a seated guest whose client id arrives on a new socket', async () => {
    const slug = 'pca-back-aaa';
    const h = await hostWithPasscode(slug, null);
    const g = await connect(slug, { clientId: 'tab-g' });
    await until(() => ofType(g.heard, 'role-assigned').length > 0);

    sendRaw(h.ws, { type: 'room-access', passcode: PASS });
    await until(() => lastAccess(h.heard).passcode === true);

    const again = await connect(slug, { clientId: 'tab-g' });
    await until(() => ofType(again.heard, 'role-assigned').length > 0);
    expect(doors(again.heard)).toHaveLength(0);

    const stranger = await connect(slug, { clientId: 'tab-other' });
    await until(() => doors(stranger.heard).length > 0);
    expect(ofType(stranger.heard, 'role-assigned')).toHaveLength(0);

    for (const x of [h, g, again, stranger]) x.ws.close();
  });

  it('setting a passcode closes nobody who is in the room', async () => {
    const slug = 'pca-keep-aaa';
    const h = await hostWithPasscode(slug, null);
    const g = await connect(slug, { clientId: 'tab-g' });
    await until(() => ofType(g.heard, 'role-assigned').length > 0);
    sendRaw(h.ws, { type: 'room-access', passcode: PASS });
    await until(() => lastAccess(h.heard).passcode === true);
    await settle();
    expect(g.close.code).toBeUndefined();
    h.ws.close();
    g.ws.close();
  });

  it('with the waiting room on, the right passcode leads to the waiting room and the host lists the person', async () => {
    const slug = 'pca-wait-aaa';
    const h = await hostWithPasscode(slug);
    sendRaw(h.ws, { type: 'room-access', waitingRoom: true });
    await until(() => lastAccess(h.heard).waitingRoom === true);

    const g = await connect(slug, { displayName: 'Knock', clientId: 'tab-k' });
    await until(() => doors(g.heard).length > 0);
    expect(doors(g.heard)).toEqual([{ type: 'door', state: 'passcode' }]);
    expect(lastAccess(h.heard).waiting).toEqual([]);

    g.sendJoin({ displayName: 'Knock', clientId: 'tab-k', passcode: PASS });
    await until(() => doors(g.heard).length > 1);
    expect(doors(g.heard)[1]).toEqual({ type: 'door', state: 'waiting' });
    await until(() => lastAccess(h.heard).waiting.length === 1);
    expect(lastAccess(h.heard).waiting.map((w) => w.displayName)).toEqual(['Knock']);
    expect(ofType(g.heard, 'role-assigned')).toHaveLength(0);

    sendRaw(h.ws, { type: 'admit', peerId: lastAccess(h.heard).waiting[0]!.peerId, admit: true });
    await until(() => ofType(g.heard, 'role-assigned').length > 0);
    expect(ofType(g.heard, 'role-assigned')).toHaveLength(1);
    expect(doors(g.heard)).toHaveLength(2);

    h.ws.close();
    g.ws.close();
  });

  it('with the room locked, closes the join before it is asked for a passcode', async () => {
    const slug = 'pca-lock-aaa';
    const h = await hostWithPasscode(slug);
    sendRaw(h.ws, { type: 'room-access', locked: true });
    await until(() => lastAccess(h.heard).locked === true);

    const g = await connect(slug, { clientId: 'tab-l' });
    await until(() => g.close.code !== undefined);
    expect(g.close).toEqual({ code: 4008, reason: 'locked' });
    expect(doors(g.heard)).toHaveLength(0);

    h.ws.close();
  });

  it('keeps only a digest of slug and passcode, and the passcode text nowhere', async () => {
    const slug = 'pca-stor-aaa';
    const secret = 'zebra-quartz-93';
    const h = await hostWithPasscode(slug, secret);
    const g = await connect(slug, { displayName: 'Gu', clientId: 'tab-g', passcode: 'zebra-quartz-94' });
    await until(() => doors(g.heard).length > 0);
    const ok = await connect(slug, { displayName: 'Ok', clientId: 'tab-ok', passcode: secret });
    await until(() => ofType(ok.heard, 'role-assigned').length > 0);

    const access = (await stored(slug, 'access')) as { passcodeHash?: string };
    expect(access.passcodeHash).toMatch(/^[0-9a-f]{64}$/);
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${slug}:${secret}`));
    expect(access.passcodeHash).toBe([...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join(''));

    for (const key of ['access', 'session', 'passFails', 'room']) {
      expect(JSON.stringify(await stored(slug, key))).not.toContain('zebra-quartz');
    }
    for (const table of ['rooms', 'sessions', 'participants']) {
      const rows = await env.DB.prepare(`SELECT * FROM ${table}`).all();
      expect(JSON.stringify(rows.results)).not.toContain('zebra-quartz');
    }

    for (const x of [h, g, ok]) x.ws.close();
  });

  it('ignores a passcode of 5 or 65 characters, a number, or one from a guest', async () => {
    const slug = 'pca-nogo-aaa';
    const h = await hostWithPasscode(slug, null);
    const g = await connect(slug, { clientId: 'tab-g' });
    await until(() => ofType(g.heard, 'role-assigned').length > 0);

    for (const bad of ['abcde', 'x'.repeat(65), 1234567, true, ['abcdefg'], {}]) {
      sendRaw(h.ws, { type: 'room-access', passcode: bad });
    }
    sendRaw(g.ws, { type: 'room-access', passcode: 'sneaky-guest' });
    await settle();
    expect(await stored(slug, 'access')).toBeUndefined();
    expect(lastAccess(h.heard)?.passcode ?? false).toBe(false);

    // The edges of the range are accepted.
    sendRaw(h.ws, { type: 'room-access', passcode: 'abcdef' });
    await until(() => lastAccess(h.heard)?.passcode === true);
    sendRaw(h.ws, { type: 'room-access', passcode: 'x'.repeat(64) });
    await settle();
    const late = await connect(slug, { clientId: 'tab-late', passcode: 'x'.repeat(64) });
    await until(() => ofType(late.heard, 'role-assigned').length > 0);

    for (const x of [h, g, late]) x.ws.close();
  });

  it('removes the passcode on null, and the next guest is seated unasked', async () => {
    const slug = 'pca-null-aaa';
    const h = await hostWithPasscode(slug);
    sendRaw(h.ws, { type: 'room-access', passcode: null });
    await until(() => lastAccess(h.heard).passcode === false);
    expect(((await stored(slug, 'access')) as { passcodeHash?: string }).passcodeHash).toBeUndefined();

    const g = await connect(slug, { clientId: 'tab-g' });
    await until(() => ofType(g.heard, 'role-assigned').length > 0);
    expect(doors(g.heard)).toHaveLength(0);

    h.ws.close();
    g.ws.close();
  });

  it('keeps the waiting room and the passcode when either changes', async () => {
    const slug = 'pca-both-aaa';
    const h = await hostWithPasscode(slug);
    sendRaw(h.ws, { type: 'room-access', waitingRoom: true });
    await until(() => lastAccess(h.heard).waitingRoom === true);
    expect(lastAccess(h.heard).passcode).toBe(true);
    expect(await stored(slug, 'access')).toMatchObject({
      waitingRoom: true,
      passcodeHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    sendRaw(h.ws, { type: 'room-access', passcode: null });
    await until(() => lastAccess(h.heard).passcode === false);
    expect(lastAccess(h.heard).waitingRoom).toBe(true);
    expect(await stored(slug, 'access')).toEqual({ waitingRoom: true });
    h.ws.close();
  });

  it('closes a join at 4008 once 20 wrong passcodes were given in ten minutes, even with the right one', async () => {
    const slug = 'pca-spnt-aaa';
    const h = await hostWithPasscode(slug);
    await wrongTries(slug, 20);
    expect((await passFails(slug))?.count).toBe(20);

    const late = await connect(slug, { clientId: 'tab-late', passcode: PASS });
    await until(() => late.close.code !== undefined);
    expect(late.close).toEqual({ code: 4008, reason: 'passcode' });
    expect(ofType(late.heard, 'role-assigned')).toHaveLength(0);
    expect((await passFails(slug))?.count).toBe(20);

    // One that gives no passcode is still told to give one: nothing is compared.
    const bare = await connect(slug, {});
    await until(() => doors(bare.heard).length > 0);
    expect(bare.close.code).toBeUndefined();

    // The window starts afresh ten minutes after the first.
    await objectOf(slug, async (state) => {
      const f = (await state.storage.get<{ count: number; since: number }>('passFails'))!;
      await state.storage.put('passFails', { count: f.count, since: f.since - 10 * 60_000 - 1 });
    });
    const ok = await connect(slug, { clientId: 'tab-ok', passcode: PASS });
    await until(() => ofType(ok.heard, 'role-assigned').length > 0);

    // A wrong one now opens a new window.
    const w = await connect(slug, { passcode: 'nope-nope' });
    await until(() => doors(w.heard).length > 0);
    expect((await passFails(slug))?.count).toBe(1);

    for (const x of [h, bare, ok, w]) x.ws.close();
  });

  it('empties the count when the host sets a new passcode', async () => {
    const slug = 'pca-rset-aaa';
    const h = await hostWithPasscode(slug);
    await wrongTries(slug, 20);
    sendRaw(h.ws, { type: 'room-access', passcode: 'wednesday9' });
    await until(async () => (await passFails(slug)) === undefined);
    expect(await passFails(slug)).toBeUndefined();

    const g = await connect(slug, { clientId: 'tab-g', passcode: 'wednesday9' });
    await until(() => ofType(g.heard, 'role-assigned').length > 0);
    expect(ofType(g.heard, 'role-assigned')).toHaveLength(1);

    h.ws.close();
    g.ws.close();
  });

  it('empties the count when the host removes the passcode', async () => {
    const slug = 'pca-rsta-aaa';
    const h = await hostWithPasscode(slug);
    await wrongTries(slug, 3);
    expect((await passFails(slug))?.count).toBe(3);
    sendRaw(h.ws, { type: 'room-access', passcode: null });
    await until(async () => (await passFails(slug)) === undefined);
    expect(await passFails(slug)).toBeUndefined();
    h.ws.close();
  });

  it('seats a socket once when two joins with the right passcode are handled at the same time', async () => {
    const slug = 'pca-twic-aaa';
    const h = await hostWithPasscode(slug);
    const g = await connect(slug, { clientId: 'tab-tw' });
    await until(() => doors(g.heard).length > 0);
    // Called on the object itself, as the runtime would not interleave them.
    await runInDurableObject(env.ROOM_DO.get(env.ROOM_DO.idFromName(slug)), async (instance, state) => {
      const ws = state
        .getWebSockets()
        .find((x) => (x.deserializeAttachment() as { clientId?: string })?.clientId === 'tab-tw')!;
      const join = JSON.stringify({ type: 'join', displayName: 'G', userAgent: 'ua', clientId: 'tab-tw', passcode: PASS });
      const room = instance as Room;
      await Promise.all([room.webSocketMessage(ws, join), room.webSocketMessage(ws, join)]);
    });
    await settle();
    expect(ofType(g.heard, 'role-assigned')).toHaveLength(1);
    h.ws.close();
    g.ws.close();
  });

  it('still asks for the passcode after the Room was evicted from memory', async () => {
    const slug = 'pca-wake-aaa';
    const h = await hostWithPasscode(slug);

    const answer = await objectOf(slug, async (state) => {
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
      await fresh.webSocketMessage(serverWs, JSON.stringify({ type: 'join', displayName: 'G', userAgent: 'ua' }));
      return heard;
    });
    expect(answer).toBe('door');

    h.ws.close();
  }, 15_000);

  it('tells the host that a passcode is set and carries no passcode text or digest', async () => {
    const slug = 'pca-host-aaa';
    const h = await hostWithPasscode(slug, 'zebra-quartz-93');
    const msg = lastAccess(h.heard);
    expect(msg.passcode).toBe(true);
    expect(Object.keys(msg).filter((k) => /pass/i.test(k))).toEqual(['passcode']);
    const wire = JSON.stringify(h.heard);
    expect(wire).not.toContain('zebra-quartz');
    expect(wire).not.toMatch(/[0-9a-f]{64}/);
    h.ws.close();
  });
});

describe('Room DO: a socket closed for its passcode tries is never seated afterwards', () => {
  it('does not seat a socket that sends five wrong passcodes and then the right one in one burst', async () => {
    const slug = 'pcb-bust-aaa';
    const h = await hostWithPasscode(slug);
    const g = await connect(slug, {});
    await until(() => doors(g.heard).length === 1);

    for (let i = 1; i <= 5; i++) g.sendJoin({ passcode: 'wrong-' + i });
    g.sendJoin({ passcode: PASS });
    await until(() => g.close.code !== undefined);
    await settle();
    expect(g.close).toEqual({ code: 4008, reason: 'passcode' });
    expect(ofType(g.heard, 'role-assigned')).toHaveLength(0);
    expect(ofType(h.heard, 'peer-joined')).toHaveLength(0);

    const later = await connect(slug, { clientId: 'tab-later', passcode: PASS });
    await until(() => ofType(later.heard, 'role-assigned').length > 0);
    expect(ofType(later.heard, 'role-assigned')[0]!.peerCount).toBe(2);

    h.ws.close();
    later.ws.close();
  });

  it('compares at most five passcodes from a socket that sends thirty wrong ones in one burst', async () => {
    const slug = 'pcb-thir-aaa';
    const h = await hostWithPasscode(slug);
    const g = await connect(slug, {});
    await until(() => doors(g.heard).length === 1);

    for (let i = 0; i < 30; i++) g.sendJoin({ passcode: 'wrong-' + i });
    await until(() => g.close.code !== undefined);
    await settle();
    expect(g.close).toEqual({ code: 4008, reason: 'passcode' });
    expect((await passFails(slug))?.count).toBeLessThanOrEqual(5);

    h.ws.close();
  });

  it('does not seat a socket closed for the room-wide limit when the host sets a new passcode and it joins again', async () => {
    const slug = 'pcb-room-aaa';
    const h = await hostWithPasscode(slug);
    await wrongTries(slug, 20);

    const late = await connect(slug, { clientId: 'tab-late', passcode: PASS });
    await until(() => late.close.code !== undefined);
    expect(late.close).toEqual({ code: 4008, reason: 'passcode' });
    sendRaw(h.ws, { type: 'room-access', passcode: 'wednesday9' });
    await until(async () => (await passFails(slug)) === undefined);
    late.sendJoin({ clientId: 'tab-late', passcode: 'wednesday9' });
    await settle();

    expect(ofType(h.heard, 'peer-joined')).toHaveLength(0);
    h.ws.close();
  });

  it('closes a socket that has used its five wrong passcodes without comparing the right one', async () => {
    const slug = 'pcb-used-aaa';
    const h = await hostWithPasscode(slug);
    const g = await connect(slug, { clientId: 'tab-used' });
    await until(() => doors(g.heard).length === 1);
    await objectOf(slug, async (state) => {
      const ws = state
        .getWebSockets()
        .find((x) => (x.deserializeAttachment() as { clientId?: string })?.clientId === 'tab-used')!;
      ws.serializeAttachment({ ...(ws.deserializeAttachment() as object), passFails: 5 });
    });

    g.sendJoin({ clientId: 'tab-used', passcode: PASS });
    await until(() => g.close.code !== undefined);
    await settle();

    expect(g.close).toEqual({ code: 4008, reason: 'passcode' });
    expect(ofType(h.heard, 'peer-joined')).toHaveLength(0);
    h.ws.close();
  });
});
