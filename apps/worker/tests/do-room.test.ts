import { describe, it, expect, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import type { ServerMessage } from '@openmeet/protocol';
import { Room } from '../src/do/Room.js';

async function createRoom(ip?: string): Promise<{ slug: string; hostToken: string }> {
  const res = await SELF.fetch('https://test/api/rooms', {
    method: 'POST',
    headers: ip ? { 'CF-Connecting-IP': ip } : {},
  });
  expect(res.status).toBe(201);
  const setCookie = res.headers.get('Set-Cookie')!;
  const { slug } = (await res.json()) as { slug: string };
  const m = setCookie.match(new RegExp(`host_token__${slug}=([0-9a-f]+)`));
  return { slug, hostToken: m![1]! };
}

// Seed a room directly in D1 (no POST /api/rooms) to avoid the 10/min rate
// limit shared across tests in this worker run.
async function seedRoom(slug: string, hostToken: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO rooms (slug, host_token, created_at, expires_at, consumed) VALUES (?, ?, ?, ?, 0)'
  )
    .bind(slug, hostToken, Date.now(), Date.now() + 3_600_000)
    .run();
}

async function openWs(slug: string, cookie?: string): Promise<WebSocket> {
  const res = await SELF.fetch(`https://test/ws/r/${slug}`, {
    headers: {
      Upgrade: 'websocket',
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  return ws as unknown as WebSocket;
}

function waitForMessage(ws: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      ws.removeEventListener('message', onMsg);
      try {
        resolve(JSON.parse(e.data as string) as ServerMessage);
      } catch (err) {
        reject(err);
      }
    };
    ws.addEventListener('message', onMsg);
  });
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

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason }));
  });
}

function waitForRoleOrClose(
  ws: WebSocket
): Promise<
  | { kind: 'role-assigned'; msg: ServerMessage & { type: 'role-assigned' } }
  | { kind: 'close'; code: number; reason: string }
> {
  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as ServerMessage;
        if (msg.type === 'role-assigned') {
          cleanup();
          resolve({ kind: 'role-assigned', msg: msg as ServerMessage & { type: 'role-assigned' } });
        }
      } catch (err) {
        cleanup();
        reject(err);
      }
    };
    const onClose = (e: Event) => {
      cleanup();
      const ce = e as CloseEvent;
      resolve({ kind: 'close', code: ce.code, reason: ce.reason });
    };
    const cleanup = () => {
      ws.removeEventListener('message', onMsg);
      ws.removeEventListener('close', onClose);
    };
    ws.addEventListener('message', onMsg);
    ws.addEventListener('close', onClose);
  });
}

describe('Room DO — WS join', () => {
  it('accepts host with cookie and assigns role=host', async () => {
    const { slug, hostToken } = await createRoom();
    const ws = await openWs(slug, `host_token__${slug}=${hostToken}`);
    ws.send(JSON.stringify({ type: 'join', displayName: 'H', userAgent: 'ua' }));
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('role-assigned');
    if (msg.type === 'role-assigned') {
      expect(msg.role).toBe('host');
      expect(msg.peerCount).toBe(1);
    }
    ws.close();
  });

  it('accepts guest without cookie and assigns role=guest', async () => {
    const { slug } = await createRoom();
    const ws = await openWs(slug);
    ws.send(JSON.stringify({ type: 'join', displayName: 'G', userAgent: 'ua' }));
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('role-assigned');
    if (msg.type === 'role-assigned') expect(msg.role).toBe('guest');
    ws.close();
  });

  // The regression that stranded every call on "Connecting…": politeness used to
  // be derived client-side as `role === 'guest'`, so when neither tab held the
  // host token — opening the invite link directly, a new tab, private mode —
  // BOTH peers were 'guest', BOTH polite, and no offer/answer pair could ever
  // complete. Ordinals are a TOTAL order, so every pair has exactly one impolite
  // side (the lower ordinal) no matter how role assignment lands or how many
  // peers are present.
  it('gives every pair exactly one impolite side, even when all peers are guests', async () => {
    const { slug } = await createRoom();
    const a = await openWs(slug); // no cookie, no hostToken -> guest
    a.send(JSON.stringify({ type: 'join', displayName: 'A', userAgent: 'ua' }));
    const ma = await waitForMessage(a);
    const b = await openWs(slug); // also guest
    b.send(JSON.stringify({ type: 'join', displayName: 'B', userAgent: 'ua' }));
    const mb = await waitForMessage(b);

    expect(ma.type).toBe('role-assigned');
    expect(mb.type).toBe('role-assigned');
    if (ma.type === 'role-assigned' && mb.type === 'role-assigned') {
      expect(ma.role).toBe('guest');
      expect(mb.role).toBe('guest'); // role degraded...
      expect(ma.ordinal).not.toBe(mb.ordinal); // ...but negotiation still works
      expect(ma.ordinal).toBeLessThan(mb.ordinal); // first in is impolite
      expect(ma.peerId).not.toBe(mb.peerId);
    }
    a.close();
    b.close();
  });

  it('relays marker, chat and presence to the other peer, stamped with from, fromPeerId and fromName', async () => {
    // seedRoom, not createRoom: POST /api/rooms is rate-limited to 10 per 60s
    // per isolate, and these tests share one.
    const slug = 'mrk-erpq-aaa';
    await seedRoom(slug, 'tok-marker-aaa');
    const a = await openWs(slug);
    a.send(JSON.stringify({ type: 'join', displayName: 'A', userAgent: 'ua' }));
    await waitForMessage(a);
    const b = await openWs(slug);
    b.send(JSON.stringify({ type: 'join', displayName: 'B', userAgent: 'ua' }));
    const bRoleAssigned = await waitForMessage(b);
    await waitForMessage(a); // peer-joined
    const bPeerId = bRoleAssigned.type === 'role-assigned' ? bRoleAssigned.peerId : '';

    b.send(JSON.stringify({ type: 'marker', label: 'Topic two' }));
    const relayedMarker = await waitForMessage(a);
    expect(relayedMarker.type).toBe('marker');
    if (relayedMarker.type === 'marker') {
      expect(relayedMarker.label).toBe('Topic two');
      expect(relayedMarker.from).toBe('guest');
      expect(relayedMarker.fromPeerId).toBe(bPeerId);
      expect(relayedMarker.fromName).toBe('B');
    }

    b.send(JSON.stringify({ type: 'chat', text: 'hello', ts: 1234 }));
    const relayedChat = await waitForMessage(a);
    expect(relayedChat.type).toBe('chat');
    if (relayedChat.type === 'chat') {
      expect(relayedChat.text).toBe('hello');
      expect(relayedChat.from).toBe('guest');
      expect(relayedChat.fromPeerId).toBe(bPeerId);
      expect(relayedChat.fromName).toBe('B');
    }

    b.send(JSON.stringify({ type: 'presence', micOn: false, camOn: true, screenSharing: false }));
    const relayedPresence = await waitForMessage(a);
    expect(relayedPresence.type).toBe('presence');
    if (relayedPresence.type === 'presence') {
      expect(relayedPresence.micOn).toBe(false);
      expect(relayedPresence.camOn).toBe(true);
      expect(relayedPresence.screenSharing).toBe(false);
      expect(relayedPresence.from).toBe('guest');
      expect(relayedPresence.fromPeerId).toBe(bPeerId);
      expect(relayedPresence.fromName).toBe('B');
    }

    a.close();
    b.close();
  });

  it('relays recording-capability to the other peer, stamped with from and fromPeerId', async () => {
    const slug = 'cap-erpq-aaa';
    await seedRoom(slug, 'tok-cap-aaaa');
    const a = await openWs(slug);
    a.send(JSON.stringify({ type: 'join', displayName: 'A', userAgent: 'ua' }));
    await waitForMessage(a);
    const b = await openWs(slug);
    b.send(JSON.stringify({ type: 'join', displayName: 'B', userAgent: 'ua' }));
    const bRoleAssigned = await waitForMessage(b);
    await waitForMessage(a); // peer-joined
    const bPeerId = bRoleAssigned.type === 'role-assigned' ? bRoleAssigned.peerId : '';

    b.send(JSON.stringify({ type: 'recording-capability', mp4: false, wav: true }));
    const relayed = await waitForMessage(a);
    expect(relayed.type).toBe('recording-capability');
    if (relayed.type === 'recording-capability') {
      expect(relayed.mp4).toBe(false);
      expect(relayed.wav).toBe(true);
      expect(relayed.from).toBe('guest');
      expect(relayed.fromPeerId).toBe(bPeerId);
    }
    a.close();
    b.close();
  });

  it('relays recording-capability with note to the other peer', async () => {
    const slug = 'cap-note-aaa';
    await seedRoom(slug, 'tok-cap-note');
    const a = await openWs(slug);
    a.send(JSON.stringify({ type: 'join', displayName: 'A', userAgent: 'ua' }));
    await waitForMessage(a);
    const b = await openWs(slug);
    b.send(JSON.stringify({ type: 'join', displayName: 'B', userAgent: 'ua' }));
    const bRoleAssigned = await waitForMessage(b);
    await waitForMessage(a); // peer-joined
    const bPeerId = bRoleAssigned.type === 'role-assigned' ? bRoleAssigned.peerId : '';

    b.send(JSON.stringify({ type: 'recording-capability', mp4: true, wav: false, note: 'safari' }));
    const relayed = await waitForMessage(a);
    expect(relayed.type).toBe('recording-capability');
    if (relayed.type === 'recording-capability') {
      expect(relayed.mp4).toBe(true);
      expect(relayed.wav).toBe(false);
      expect((relayed as unknown as { note?: string }).note).toBe('safari');
      expect(relayed.from).toBe('guest');
      expect(relayed.fromPeerId).toBe(bPeerId);
    }
    a.close();
    b.close();
  });

  it('drops a recording-capability note that is not a known code', async () => {
    const slug = 'cap-note-bbb';
    await seedRoom(slug, 'tok-cap-note-b');
    const a = await openWs(slug);
    a.send(JSON.stringify({ type: 'join', displayName: 'A', userAgent: 'ua' }));
    await waitForMessage(a);
    const b = await openWs(slug);
    b.send(JSON.stringify({ type: 'join', displayName: 'B', userAgent: 'ua' }));
    await waitForMessage(b);
    await waitForMessage(a); // peer-joined

    b.send(JSON.stringify({ type: 'recording-capability', mp4: true, wav: true, note: 'Host: click this link' }));
    const relayed = await waitForMessage(a);
    expect(relayed.type).toBe('recording-capability');
    expect('note' in relayed).toBe(false);
    a.close();
    b.close();
  });

  it('closes with 4002 (invalid_slug) for a room that never existed', async () => {
    const ws = await openWs('zzz-zzzz-zzz'); // valid format, no such room
    const { code, reason } = await waitForClose(ws);
    expect(code).toBe(4002);
    expect(reason).toBe('invalid_slug');
  });

  it('closes with 4003 (expired_slug) for a known but expired room', async () => {
    await env.DB.prepare(
      'INSERT INTO rooms (slug, host_token, created_at, expires_at, consumed) VALUES (?, ?, ?, ?, 0)'
    )
      .bind('exp-ired-aaa', 'tok-exp-aaa', Date.now() - 7_200_000, Date.now() - 3_600_000)
      .run();
    const ws = await openWs('exp-ired-aaa');
    const { code, reason } = await waitForClose(ws);
    expect(code).toBe(4003);
    expect(reason).toBe('expired_slug');
  });

  it('does not corrupt room slug when a percent-encoded request routes to the room', async () => {
    const { slug, hostToken } = await createRoom('10.0.19.5');
    const host = await openWs(slug, `host_token__${slug}=${hostToken}`);

    // Percent-encode the last character of the slug: the router decodes it,
    // so it routes to the same Durable Object, but the raw path has the percent encoding.
    const lastChar = slug[slug.length - 1]!;
    const encodedChar = `%${lastChar.charCodeAt(0).toString(16)}`;
    const encodedSlug = `${slug.slice(0, -1)}${encodedChar}`;

    const encodedRes = await SELF.fetch(`https://test/ws/r/${encodedSlug}`, {
      headers: { Upgrade: 'websocket' },
    });
    expect(encodedRes.status).toBe(101);
    const encodedWs = encodedRes.webSocket!;
    encodedWs.accept();
    const { code, reason } = await waitForClose(encodedWs as unknown as WebSocket);
    expect(code).toBe(4002);
    expect(reason).toBe('invalid_slug');

    host.send(JSON.stringify({ type: 'join', displayName: 'H', userAgent: 'ua' }));
    const msg = await waitForMessage(host);
    expect(msg.type).toBe('role-assigned');

    const session = await env.DB.prepare('SELECT id, room_slug FROM sessions WHERE room_slug = ?')
      .bind(slug)
      .first<{ id: string; room_slug: string }>();
    expect(session).not.toBeNull();
    expect(session?.room_slug).toBe(slug);

    host.close();
  });

  it('closes with 4002 (invalid_slug) when raw path is not a well-formed slug', async () => {
    await seedRoom('not-a-valid-slug', 'tok-not-valid');
    const id = env.ROOM_DO.idFromName('mal-form-aaa');
    const stub = env.ROOM_DO.get(id);
    const res = await stub.fetch('https://test/ws/r/not-a-valid-slug', {
      headers: { Upgrade: 'websocket' },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    const { code, reason } = await waitForClose(ws as unknown as WebSocket);
    expect(code).toBe(4002);
    expect(reason).toBe('invalid_slug');
  });

  it('assigns role=host when join carries a valid hostToken (no cookie, cross-origin path)', async () => {
    await seedRoom('hto-kenn-aaa', 'tok-host-aaa');
    const ws = await openWs('hto-kenn-aaa'); // no cookie
    ws.send(
      JSON.stringify({ type: 'join', displayName: 'H', userAgent: 'ua', hostToken: 'tok-host-aaa' })
    );
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('role-assigned');
    if (msg.type === 'role-assigned') expect(msg.role).toBe('host');
    ws.close();
  });

  it('stays role=guest when join carries a wrong hostToken', async () => {
    await seedRoom('hto-kenn-bbb', 'tok-host-bbb');
    const ws = await openWs('hto-kenn-bbb');
    ws.send(
      JSON.stringify({ type: 'join', displayName: 'G', userAgent: 'ua', hostToken: 'wrong-token' })
    );
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('role-assigned');
    if (msg.type === 'role-assigned') expect(msg.role).toBe('guest');
    ws.close();
  });

  it('enforces unique host: newest verified host replaces previous host connection (overlap)', async () => {
    const slug = 'uni-queh-ost';
    const hostToken = 'tok-unique-host';
    await seedRoom(slug, hostToken);

    // Socket A joins with host token -> becomes host
    const a = await openWs(slug);
    const closePromiseA = waitForClose(a);
    a.send(JSON.stringify({ type: 'join', displayName: 'A', userAgent: 'ua', hostToken }));
    const ma = await waitForMessage(a);
    expect(ma.type).toBe('role-assigned');
    if (ma.type === 'role-assigned') {
      expect(ma.role).toBe('host');
    }

    // Socket B joins with same token while A is still open -> becomes host
    const b = await openWs(slug);
    b.send(JSON.stringify({ type: 'join', displayName: 'B', userAgent: 'ua', hostToken }));
    const mb = await waitForRoleAssigned(b);
    expect(mb.type).toBe('role-assigned');
    expect(mb.role).toBe('host');

    // Socket A is closed with code 4006 (WS_CLOSE_REPLACED) and reason 'replaced'
    const closeA = await closePromiseA;
    expect(closeA.code).toBe(4006);
    expect(closeA.reason).toBe('replaced');

    b.close();
  });

  it('enforces unique host with cookies: second socket with valid cookie replaces first host', async () => {
    const slug = 'uni-quec-ook';
    const hostToken = 'tok-unique-cook';
    await seedRoom(slug, hostToken);

    const c1 = await openWs(slug, `host_token__${slug}=${hostToken}`);
    const closePromiseC1 = waitForClose(c1);
    c1.send(JSON.stringify({ type: 'join', displayName: 'C1', userAgent: 'ua' }));
    const m1 = await waitForMessage(c1);
    expect(m1.type).toBe('role-assigned');
    if (m1.type === 'role-assigned') {
      expect(m1.role).toBe('host');
    }

    const c2 = await openWs(slug, `host_token__${slug}=${hostToken}`);
    c2.send(JSON.stringify({ type: 'join', displayName: 'C2', userAgent: 'ua' }));
    const m2 = await waitForRoleAssigned(c2);
    expect(m2.type).toBe('role-assigned');
    expect(m2.role).toBe('host');

    const closeC1 = await closePromiseC1;
    expect(closeC1.code).toBe(4006);
    expect(closeC1.reason).toBe('replaced');

    c2.close();
  });

  it('preserves recording state when host is replaced during recording', async () => {
    const slug = 'rec-repl-ace';
    const hostToken = 'tok-rec-replace';
    await seedRoom(slug, hostToken);

    const a = await openWs(slug);
    const closePromiseA = waitForClose(a);
    a.send(JSON.stringify({ type: 'join', displayName: 'A', userAgent: 'ua', hostToken }));
    const ma = await waitForMessage(a);
    expect(ma.type).toBe('role-assigned');
    if (ma.type === 'role-assigned') {
      expect(ma.role).toBe('host');
    }

    a.send(
      JSON.stringify({ type: 'recording-started', recordingId: 'r-repl', kind: 'camera', filename: 'h.mp4' })
    );
    await new Promise((r) => setTimeout(r, 50));

    // B joins with same token while A was recording
    const b = await openWs(slug);
    b.send(JSON.stringify({ type: 'join', displayName: 'B', userAgent: 'ua', hostToken }));
    const mb = await waitForRoleAssigned(b);
    expect(mb.type).toBe('role-assigned');
    expect(mb.role).toBe('host');
    expect(mb.recording).toBe(true);

    const closeA = await closePromiseA;
    expect(closeA.code).toBe(4006);

    b.close();
  });

  it('admits reconnecting host into a full room of 4 recorded peers and broadcasts peer-left for replaced host', async () => {
    const slug = 'rec-full-aaa';
    const hostToken = 'tok-full-room';
    await seedRoom(slug, hostToken);

    // Host A joins
    const a = await openWs(slug);
    const closePromiseA = waitForClose(a);
    a.send(JSON.stringify({ type: 'join', displayName: 'HostA', userAgent: 'ua', hostToken }));
    const ma = await waitForMessage(a);
    expect(ma.type).toBe('role-assigned');
    const hostAPeerId = (ma as { peerId: string }).peerId;

    // 3 guests join -> room has 4 recorded peers (Host A + 3 guests)
    const guests: WebSocket[] = [];
    const guestMessages: ServerMessage[][] = [[], [], []];
    for (let i = 0; i < 3; i++) {
      const g = await openWs(slug);
      g.addEventListener('message', (e) => {
        guestMessages[i]!.push(JSON.parse(e.data as string) as ServerMessage);
      });
      g.send(JSON.stringify({ type: 'join', displayName: `G${i}`, userAgent: 'ua' }));
      guests.push(g);
    }

    // Wait until all 3 guests have received their role-assigned
    for (let i = 0; i < 3; i++) {
      for (let attempt = 0; attempt < 20; attempt++) {
        if (guestMessages[i]!.some((m) => m.type === 'role-assigned')) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(guestMessages[i]!.some((m) => m.type === 'role-assigned')).toBe(true);
    }

    // Socket B presents the same host token while A is still open
    const b = await openWs(slug);
    b.send(JSON.stringify({ type: 'join', displayName: 'HostB', userAgent: 'ua', hostToken }));

    // B gets role-assigned with role host (not close 4001)
    const mb = await waitForRoleAssigned(b);
    expect(mb.type).toBe('role-assigned');
    expect(mb.role).toBe('host');

    // Socket A is closed with replaced (4006)
    const closeA = await closePromiseA;
    expect(closeA.code).toBe(4006);
    expect(closeA.reason).toBe('replaced');

    // Wait briefly for all message delivery
    for (let attempt = 0; attempt < 20; attempt++) {
      const allReceived = guestMessages.every((msgs) =>
        msgs.some((m) => m.type === 'peer-left' && m.peerId === hostAPeerId)
      );
      if (allReceived) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    // Each other peer receives exactly one peer-left for A's peerId
    for (let i = 0; i < 3; i++) {
      const peerLeftMsgs = guestMessages[i]!.filter(
        (m) => m.type === 'peer-left' && m.peerId === hostAPeerId
      );
      expect(peerLeftMsgs).toHaveLength(1);
    }

    b.close();
    guests.forEach((g) => g.close());
  });

  it('does not admit concurrent joins beyond the recorded seat cap', async () => {
    const slug = 'con-curr-aaa';
    await seedRoom(slug, 'tok-curr-aaa');
    const open: WebSocket[] = [];
    for (let i = 0; i < 3; i++) {
      const ws = await openWs(slug);
      ws.send(JSON.stringify({ type: 'join', displayName: `P${i}`, userAgent: 'ua' }));
      const msg = await waitForRoleAssigned(ws);
      expect(msg.type).toBe('role-assigned');
      open.push(ws);
    }

    const ws4 = await openWs(slug);
    const ws5 = await openWs(slug);
    const resultPromise4 = waitForRoleOrClose(ws4);
    const resultPromise5 = waitForRoleOrClose(ws5);

    ws4.send(JSON.stringify({ type: 'join', displayName: 'P4', userAgent: 'ua' }));
    ws5.send(JSON.stringify({ type: 'join', displayName: 'P5', userAgent: 'ua' }));

    const [r4, r5] = await Promise.all([resultPromise4, resultPromise5]);

    const roleAssignedCount = [r4, r5].filter((r) => r.kind === 'role-assigned').length;
    const rejected4001Count = [r4, r5].filter(
      (r) => r.kind === 'close' && r.code === 4001
    ).length;

    expect(roleAssignedCount).toBe(1);
    expect(rejected4001Count).toBe(1);

    open.forEach((w) => w.close());
    ws4.close();
    ws5.close();
  });


  // Mesh is O(n^2) connections, so the room caps at 4. Beyond ~4-5 the honest
  // answer is an SFU, which would mean a media server — breaking both the
  // free-tier promise and the "bytes never touch a server" guarantee.
  it('accepts up to 4 peers and rejects the 5th with close code 4001', async () => {
    const slug = 'cap-acit-aaa';
    await seedRoom(slug, 'tok-cap-aaa');
    const open: WebSocket[] = [];
    for (let i = 0; i < 4; i++) {
      const ws = await openWs(slug);
      ws.send(JSON.stringify({ type: 'join', displayName: `P${i}`, userAgent: 'ua' }));
      const msg = await waitForMessage(ws);
      expect(msg.type).toBe('role-assigned');
      open.push(ws);
    }

    const overflow = await openWs(slug);
    overflow.send(JSON.stringify({ type: 'join', displayName: 'X', userAgent: 'ua' }));
    const closeCode = await new Promise<number>((resolve) => {
      overflow.addEventListener('close', (e) => resolve((e as CloseEvent).code));
    });
    expect(closeCode).toBe(4001);
    open.forEach((w) => w.close());
  });

  it('ignores a clientId longer than 64 characters (stored in the socket attachment)', async () => {
    const slug = 'cid-long-aaa';
    await seedRoom(slug, 'tok-cid-long');
    const long = 'x'.repeat(65);
    const a = await openWs(slug);
    a.send(JSON.stringify({ type: 'join', displayName: 'A', userAgent: 'ua', clientId: long }));
    expect((await waitForMessage(a)).type).toBe('role-assigned');
    const b = await openWs(slug);
    b.send(JSON.stringify({ type: 'join', displayName: 'B', userAgent: 'ua', clientId: long }));
    expect((await waitForMessage(b)).type).toBe('role-assigned');
    // Not treated as the same tab: A is still connected and hears B join.
    expect((await waitForMessage(a)).type).toBe('peer-joined');
    a.close();
    b.close();
  });

  it('full room (4 recorded) + a socket with the same client id is admitted and closes old socket, while different id gets 4001', async () => {
    const slug = 'cap-stab-aaa';
    await seedRoom(slug, 'tok-cap-stab');
    const open: WebSocket[] = [];
    const clientIds = ['cid-0', 'cid-1', 'cid-2', 'cid-3'];
    for (let i = 0; i < 4; i++) {
      const ws = await openWs(slug);
      ws.send(JSON.stringify({ type: 'join', displayName: `P${i}`, userAgent: 'ua', clientId: clientIds[i] }));
      const msg = await waitForMessage(ws);
      expect(msg.type).toBe('role-assigned');
      open.push(ws);
    }

    const oldSocketClosedPromise = new Promise<{ code: number; reason: string }>((resolve) => {
      open[3]!.addEventListener('close', (e) => {
        resolve({ code: (e as CloseEvent).code, reason: (e as CloseEvent).reason });
      });
    });

    const reconnecting = await openWs(slug);
    reconnecting.send(JSON.stringify({ type: 'join', displayName: 'P3-reconnected', userAgent: 'ua', clientId: 'cid-3' }));
    const recMsg = await waitForRoleAssigned(reconnecting);
    expect(recMsg.type).toBe('role-assigned');

    const oldClose = await oldSocketClosedPromise;
    expect(oldClose.code).toBe(4006);
    expect(oldClose.reason).toBe('replaced');

    const different = await openWs(slug);
    different.send(JSON.stringify({ type: 'join', displayName: 'Diff', userAgent: 'ua', clientId: 'cid-diff' }));
    const diffCloseCode = await new Promise<number>((resolve) => {
      different.addEventListener('close', (e) => resolve((e as CloseEvent).code));
    });
    expect(diffCloseCode).toBe(4001);

    open.forEach((w) => {
      try { w.close(); } catch { /* ignore */ }
    });
    reconnecting.close();
  });

  it('gives every peer in a 4-way room a distinct id and ordinal', async () => {
    const slug = 'mes-hnet-aaa';
    await seedRoom(slug, 'tok-mesh-aaa');
    const ids = new Set<string>();
    const ordinals = new Set<number>();
    const open: WebSocket[] = [];
    for (let i = 0; i < 4; i++) {
      const ws = await openWs(slug);
      ws.send(JSON.stringify({ type: 'join', displayName: `P${i}`, userAgent: 'ua' }));
      const msg = await waitForMessage(ws);
      if (msg.type === 'role-assigned') {
        ids.add(msg.peerId);
        ordinals.add(msg.ordinal);
        // Each joiner is told about everyone already present, so it can open a
        // connection to each rather than only learning of future arrivals.
        expect(msg.peers).toHaveLength(i);
      }
      open.push(ws);
    }
    expect(ids.size).toBe(4);
    expect(ordinals.size).toBe(4);
    open.forEach((w) => w.close());
  });

  it('rejects a malformed join with invalid_join error and close code 4005', async () => {
    const slug = 'mal-form-aaa';
    await seedRoom(slug, 'tok-malform-aaa');
    const ws = await openWs(slug);
    const msgPromise = waitForMessage(ws);
    const closePromise = waitForClose(ws);
    ws.send(JSON.stringify({ type: 'join', name: 'x' }));
    const msg = await msgPromise;
    expect(msg).toEqual({
      type: 'error',
      code: 'invalid_join',
      message: 'join requires string displayName and userAgent',
    });
    const { code } = await closePromise;
    expect(code).toBe(4005);
  });
});

describe('Room DO — signaling relay', () => {
  it('relays webrtc-offer from host to guest with from=host', async () => {
    const { slug, hostToken } = await createRoom();
    const host = await openWs(slug, `host_token__${slug}=${hostToken}`);
    host.send(JSON.stringify({ type: 'join', displayName: 'H', userAgent: 'ua' }));
    await waitForMessage(host); // role-assigned

    const guest = await openWs(slug);
    guest.send(JSON.stringify({ type: 'join', displayName: 'G', userAgent: 'ua' }));
    await waitForMessage(guest); // role-assigned

    const hostPeerJoined = await waitForMessage(host);
    expect(hostPeerJoined.type).toBe('peer-joined');

    host.send(JSON.stringify({ type: 'webrtc-offer', sdp: 'v=0\r\n' }));
    const guestReceived = await waitForMessage(guest);
    expect(guestReceived.type).toBe('webrtc-offer');
    if (guestReceived.type === 'webrtc-offer') {
      expect(guestReceived.sdp).toBe('v=0\r\n');
      expect(guestReceived.from).toBe('host');
    }
    host.close();
    guest.close();
  });

  it('does not echo SDP back to sender (loop guard)', async () => {
    const { slug, hostToken } = await createRoom();
    const host = await openWs(slug, `host_token__${slug}=${hostToken}`);
    host.send(JSON.stringify({ type: 'join', displayName: 'H', userAgent: 'ua' }));
    await waitForMessage(host);

    const guest = await openWs(slug);
    guest.send(JSON.stringify({ type: 'join', displayName: 'G', userAgent: 'ua' }));
    await waitForMessage(guest);
    await waitForMessage(host); // peer-joined

    host.send(JSON.stringify({ type: 'webrtc-offer', sdp: 'v=0' }));

    const guestMsg = await waitForMessage(guest);
    expect(guestMsg.type).toBe('webrtc-offer');

    const hostRace = await Promise.race([
      waitForMessage(host).then((m) => ({ kind: 'msg' as const, m })),
      new Promise<{ kind: 'timeout' }>((r) => setTimeout(() => r({ kind: 'timeout' }), 200)),
    ]);
    expect(hostRace.kind).toBe('timeout');

    host.close();
    guest.close();
  });
});

describe('Room DO — close handshake', () => {
  // Without the DO reciprocating ws.close() in webSocketClose, a client that
  // initiates close never receives its own close event promptly — it waits
  // out whatever the runtime's abandoned-connection timeout is (10s+ in real
  // Chrome). The DO must echo a close frame so the handshake completes.
  it('completes the closing handshake promptly when the client initiates close', async () => {
    const slug = 'clo-sehn-daa';
    const hostToken = 'tok-close-hs';
    await seedRoom(slug, hostToken);
    const ws = await openWs(slug, `host_token__${slug}=${hostToken}`);
    ws.send(JSON.stringify({ type: 'join', displayName: 'H', userAgent: 'ua' }));
    await waitForMessage(ws);

    const closed = waitForClose(ws);
    ws.close();
    const result = await Promise.race([
      closed.then(() => 'closed' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1500)),
    ]);
    expect(
      result,
      'close event did not fire within 1.5s — webSocketClose never reciprocates ws.close()'
    ).toBe('closed');
  });
});

describe('Room DO — save() left guard', () => {
  // webSocketMessage deserialises its own copy of the attachment, then awaits
  // D1 (insertSession/markRoomConsumed) before saving it back. If onClose for
  // the same socket runs during that await (its own close, or a host
  // replacement) and saves left:true, the message handler's later save must
  // not clobber it with a stale copy that lacks the flag — otherwise a
  // departed socket reappears in allPeers()/role-assigned.peers.
  it('keeps left:true once set, even when a caller saves a stale copy without it', async () => {
    const slug = 'sav-elef-taa';
    const hostToken = 'tok-save-left';
    await seedRoom(slug, hostToken);
    const host = await openWs(slug, `host_token__${slug}=${hostToken}`);
    host.send(JSON.stringify({ type: 'join', displayName: 'H', userAgent: 'ua' }));
    await waitForMessage(host);

    const id = env.ROOM_DO.idFromName(slug);
    const stub = env.ROOM_DO.get(id);

    const leftAfterStaleSave = await runInDurableObject(stub, async (instance, state) => {
      const serverWs = state.getWebSockets()[0]!;
      const room = instance as unknown as {
        peer: (ws: WebSocket) => Record<string, unknown> & { left?: boolean };
        save: (ws: WebSocket, p: Record<string, unknown> & { left?: boolean }) => void;
      };
      // A handler mid-await deserialised its own copy BEFORE onClose ran.
      const stale = room.peer(serverWs);
      // onClose runs first (its own close, or closeExistingHosts) and marks left.
      room.save(serverWs, { ...room.peer(serverWs), left: true });
      // The mid-await handler now saves its stale copy, which has no `left`.
      room.save(serverWs, stale);
      return room.peer(serverWs).left;
    });

    expect(
      leftAfterStaleSave,
      'a stale save clobbered left — the departed socket would reappear in allPeers()'
    ).toBe(true);
    host.close();
  });
});

describe('Room DO — heartbeat', () => {
  it('replies pong to ping', async () => {
    const { slug, hostToken } = await createRoom('10.0.18.1');
    const ws = await openWs(slug, `host_token__${slug}=${hostToken}`);
    ws.send(JSON.stringify({ type: 'join', displayName: 'H', userAgent: 'ua' }));
    await waitForMessage(ws);

    ws.send(JSON.stringify({ type: 'ping' }));
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('pong');
    ws.close();
  });
});

describe('Room DO — peer-left on close', () => {
  it('notifies remaining peer when other closes', async () => {
    const { slug, hostToken } = await createRoom('10.0.18.2');
    const host = await openWs(slug, `host_token__${slug}=${hostToken}`);
    host.send(JSON.stringify({ type: 'join', displayName: 'H', userAgent: 'ua' }));
    await waitForMessage(host);

    const guest = await openWs(slug);
    guest.send(JSON.stringify({ type: 'join', displayName: 'G', userAgent: 'ua' }));
    await waitForMessage(guest);
    await waitForMessage(host); // peer-joined

    guest.close();
    const hostMsg = await waitForMessage(host);
    expect(hostMsg.type).toBe('peer-left');
    if (hostMsg.type === 'peer-left') expect(hostMsg.role).toBe('guest');
    host.close();
  });
});

describe('Room DO — D1 persistence', () => {
  it('inserts a session row when first peer joins', async () => {
    const { slug, hostToken } = await createRoom('10.0.19.1');
    const ws = await openWs(slug, `host_token__${slug}=${hostToken}`);
    ws.send(JSON.stringify({ type: 'join', displayName: 'H', userAgent: 'ua' }));
    await waitForMessage(ws);
    const row = await env.DB.prepare('SELECT * FROM sessions WHERE room_slug = ?')
      .bind(slug)
      .first();
    expect(row).not.toBeNull();
    ws.close();
  });

  it('inserts a participant row per joiner', async () => {
    const { slug, hostToken } = await createRoom('10.0.19.2');
    const host = await openWs(slug, `host_token__${slug}=${hostToken}`);
    host.send(JSON.stringify({ type: 'join', displayName: 'H', userAgent: 'ua-host' }));
    await waitForMessage(host);

    const guest = await openWs(slug);
    guest.send(JSON.stringify({ type: 'join', displayName: 'G', userAgent: 'ua-guest' }));
    await waitForMessage(guest);

    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM participants').first<{ n: number }>();
    expect(row?.n).toBeGreaterThanOrEqual(2);
    host.close();
    guest.close();
  });

  it('marks room consumed on first join', async () => {
    const { slug, hostToken } = await createRoom('10.0.19.3');
    const ws = await openWs(slug, `host_token__${slug}=${hostToken}`);
    ws.send(JSON.stringify({ type: 'join', displayName: 'H', userAgent: 'ua' }));
    await waitForMessage(ws);
    const row = await env.DB.prepare('SELECT consumed FROM rooms WHERE slug = ?')
      .bind(slug)
      .first<{ consumed: number }>();
    expect(row?.consumed).toBe(1);
    ws.close();
  });

  it('persists a recordings row with status=recording on recording-started', async () => {
    const { slug, hostToken } = await createRoom('10.0.19.4');
    const ws = await openWs(slug, `host_token__${slug}=${hostToken}`);
    ws.send(JSON.stringify({ type: 'join', displayName: 'H', userAgent: 'ua' }));
    await waitForMessage(ws);

    const recordingId = crypto.randomUUID();
    ws.send(
      JSON.stringify({
        type: 'recording-started',
        recordingId,
        kind: 'camera',
        filename: 'host_x.mp4',
      })
    );

    let row: { id: string; status: string; started_at: number } | null = null;
    for (let i = 0; i < 20 && !row; i++) {
      row = await env.DB.prepare('SELECT * FROM recordings WHERE id = ?')
        .bind(recordingId)
        .first<{ id: string; status: string; started_at: number }>();
      if (!row) await new Promise((r) => setTimeout(r, 25));
    }
    expect(row).not.toBeNull();
    expect(row?.status).toBe('recording');
    expect(row?.started_at).toBeGreaterThan(1e12);
    ws.close();
  });

  it('logs an error when insertRecording fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { slug, hostToken } = await createRoom('10.0.19.99');
      const ws = await openWs(slug, `host_token__${slug}=${hostToken}`);
      ws.send(JSON.stringify({ type: 'join', displayName: 'H', userAgent: 'ua' }));
      await waitForMessage(ws);

      const session = await env.DB.prepare('SELECT id FROM sessions WHERE room_slug = ?')
        .bind(slug)
        .first<{ id: string }>();
      const participant = await env.DB.prepare('SELECT id FROM participants WHERE session_id = ?')
        .bind(session!.id)
        .first<{ id: string }>();

      const recordingId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO recordings (id, session_id, participant_id, kind, filename,
          total_bytes, last_offset, sha256, status, started_at, finalized_at)
         VALUES (?, ?, ?, 'camera', 'pre-existing.mp4', 0, 0, NULL, 'recording', 1, NULL)`
      )
        .bind(recordingId, session!.id, participant!.id)
        .run();

      ws.send(
        JSON.stringify({
          type: 'recording-started',
          recordingId,
          kind: 'camera',
          filename: 'host_x.mp4',
        })
      );

      for (let i = 0; i < 20; i++) {
        if (errorSpy.mock.calls.some((c) => c[0] === 'room:insertRecording')) break;
        await new Promise((r) => setTimeout(r, 25));
      }

      const matchingCall = errorSpy.mock.calls.find((c) => c[0] === 'room:insertRecording');
      expect(matchingCall, 'expected console.error with room:insertRecording').toBeDefined();
      expect(matchingCall![0]).toBe('room:insertRecording');
      ws.close();
    } finally {
      errorSpy.mockRestore();
    }
  });

  // Recording is one room-wide act. The guest's capture is STARTED by this
  // relay, so if the DO swallows it (as it used to) the host records itself
  // talking to a silent, unrecorded guest and nobody finds out until playback.
  it('relays recording-started to the other peer', async () => {
    const slug = 'rel-star-aaa';
    await seedRoom(slug, 'tok-relay-start');
    const host = await openWs(slug, `host_token__${slug}=tok-relay-start`);
    host.send(JSON.stringify({ type: 'join', displayName: 'H', userAgent: 'ua' }));
    await waitForMessage(host);
    const guest = await openWs(slug);
    guest.send(JSON.stringify({ type: 'join', displayName: 'G', userAgent: 'ua' }));
    await waitForMessage(guest); // role-assigned
    await waitForMessage(host); // peer-joined

    const seen = waitForMessage(guest);
    host.send(
      JSON.stringify({ type: 'recording-started', recordingId: 'r-1', kind: 'camera', filename: 'host_x.mp4' })
    );
    const msg = await seen;
    expect(msg.type).toBe('recording-started');
    if (msg.type === 'recording-started') {
      expect(msg.recordingId).toBe('r-1');
      // The guest only obeys the HOST, so the stamp has to survive the relay.
      expect(msg.from).toBe('host');
    }
    host.close();
    guest.close();
  });

  // Rejoining mid-session (crashed tab, closed laptop) is routine on a long
  // recording. The recording-started broadcast went out before this socket
  // existed, so without room state the returning guest sits there unrecorded
  // and untold — the exact failure nobody notices until playback.
  it('tells a peer joining mid-recording that the room is recording', async () => {
    const slug = 'lat-join-aaa';
    await seedRoom(slug, 'tok-late-join');
    const host = await openWs(slug, `host_token__${slug}=tok-late-join`);
    host.send(JSON.stringify({ type: 'join', displayName: 'H', userAgent: 'ua' }));
    await waitForMessage(host);
    host.send(
      JSON.stringify({ type: 'recording-started', recordingId: 'r-late', kind: 'camera', filename: 'h.mp4' })
    );

    const late = await openWs(slug);
    late.send(JSON.stringify({ type: 'join', displayName: 'G', userAgent: 'ua' }));
    const msg = await waitForMessage(late);
    expect(msg.type).toBe('role-assigned');
    if (msg.type === 'role-assigned') expect(msg.recording).toBe(true);

    // ...and stops saying so once the host ends it.
    host.send(JSON.stringify({ type: 'recording-stop', recordingId: 'r-late' }));
    await waitForMessage(late); // the relayed recording-stop
    const after = await openWs(slug);
    after.send(JSON.stringify({ type: 'join', displayName: 'G2', userAgent: 'ua' }));
    const msg2 = await waitForMessage(after);
    if (msg2.type === 'role-assigned') expect(msg2.recording).toBe(false);

    host.close();
    late.close();
    after.close();
  });

  it('relays recording-stop to the other peer', async () => {
    const slug = 'rel-stop-aaa';
    await seedRoom(slug, 'tok-relay-stop');
    const host = await openWs(slug, `host_token__${slug}=tok-relay-stop`);
    host.send(JSON.stringify({ type: 'join', displayName: 'H', userAgent: 'ua' }));
    await waitForMessage(host);
    const guest = await openWs(slug);
    guest.send(JSON.stringify({ type: 'join', displayName: 'G', userAgent: 'ua' }));
    await waitForMessage(guest);
    await waitForMessage(host);

    const seen = waitForMessage(guest);
    host.send(JSON.stringify({ type: 'recording-stop', recordingId: 'r-1' }));
    const msg = await seen;
    expect(msg.type).toBe('recording-stop');
    if (msg.type === 'recording-stop') expect(msg.from).toBe('host');
    host.close();
    guest.close();
  });
});

describe('reusable rooms', () => {
  it('lets a room be rejoined after everyone has left', async () => {
    const slug = 'reu-sabl-aaa';
    await seedRoom(slug, 'tok-reuse-aaa');

    const first = await openWs(slug);
    first.send(JSON.stringify({ type: 'join', displayName: 'A', userAgent: 'ua' }));
    expect((await waitForMessage(first)).type).toBe('role-assigned');
    first.close();
    await new Promise((r) => setTimeout(r, 50));

    // Same link, later. A one-shot room would refuse this.
    const second = await openWs(slug);
    second.send(JSON.stringify({ type: 'join', displayName: 'A again', userAgent: 'ua' }));
    const msg = await waitForMessage(second);
    expect(msg.type).toBe('role-assigned');
    second.close();
  });

  it('keeps host role across a reconnect when the token is presented again', async () => {
    const slug = 'reh-ostt-aaa';
    await seedRoom(slug, 'tok-rehost-aaa');
    for (const attempt of [1, 2]) {
      const ws = await openWs(slug);
      ws.send(
        JSON.stringify({ type: 'join', displayName: `H${attempt}`, userAgent: 'ua', hostToken: 'tok-rehost-aaa' })
      );
      const msg = await waitForMessage(ws);
      if (msg.type === 'role-assigned') expect(msg.role).toBe('host');
      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it('pushes the expiry out on join so a recurring show keeps one link', async () => {
    const slug = 'sli-ding-aaa';
    const soon = Date.now() + 60_000;
    await env.DB.prepare(
      'INSERT INTO rooms (slug, host_token, created_at, expires_at, consumed) VALUES (?, ?, ?, ?, 0)'
    )
      .bind(slug, 'tok-slide-aaa', Date.now(), soon)
      .run();

    const ws = await openWs(slug);
    ws.send(JSON.stringify({ type: 'join', displayName: 'A', userAgent: 'ua' }));
    await waitForMessage(ws);
    ws.close();
    await new Promise((r) => setTimeout(r, 100));

    const row = await env.DB.prepare('SELECT expires_at FROM rooms WHERE slug = ?').bind(slug).first<{ expires_at: number }>();
    expect(row!.expires_at).toBeGreaterThan(soon);
  });
});

describe('producer role', () => {
  it('assigns role=producer when the join asks for it', async () => {
    const slug = 'pro-duce-aaa';
    await seedRoom(slug, 'tok-prod-aaa');
    const ws = await openWs(slug);
    ws.send(JSON.stringify({ type: 'join', displayName: 'P', userAgent: 'ua', producer: true }));
    const msg = await waitForMessage(ws);
    if (msg.type === 'role-assigned') expect(msg.role).toBe('producer');
    ws.close();
  });

  // The point of the role: a producer runs the session without consuming one of
  // the four recorded seats.
  it('does not consume a recorded seat', async () => {
    const slug = 'pro-seat-aaa';
    await seedRoom(slug, 'tok-seat-aaa');
    const open: WebSocket[] = [];

    const prod = await openWs(slug);
    prod.send(JSON.stringify({ type: 'join', displayName: 'P', userAgent: 'ua', producer: true }));
    await waitForMessage(prod);
    open.push(prod);

    // All four recorded seats must still be available alongside the producer.
    for (let i = 0; i < 4; i++) {
      const ws = await openWs(slug);
      ws.send(JSON.stringify({ type: 'join', displayName: `G${i}`, userAgent: 'ua' }));
      const msg = await waitForMessage(ws);
      expect(msg.type).toBe('role-assigned');
      if (msg.type === 'role-assigned') expect(msg.role).not.toBe('producer');
      open.push(ws);
    }
    open.forEach((w) => w.close());
  });

  it('a producer request wins over a host token — it is an explicit choice', async () => {
    await seedRoom('pro-host-aaa', 'tok-prodh-aa');
    const ws = await openWs('pro-host-aaa');
    ws.send(
      JSON.stringify({ type: 'join', displayName: 'P', userAgent: 'ua', producer: true, hostToken: 'tok-prodh-aa' })
    );
    const msg = await waitForMessage(ws);
    if (msg.type === 'role-assigned') expect(msg.role).toBe('producer');
    ws.close();
  });

  it('rejects a 3rd producer with 4001 while recorded seats are free', async () => {
    const slug = 'pro-capa-aaa';
    await seedRoom(slug, 'tok-capa-aaa');
    const open: WebSocket[] = [];

    // Host joins (recorded seats still free)
    const host = await openWs(slug, `host_token__${slug}=tok-capa-aaa`);
    host.send(JSON.stringify({ type: 'join', displayName: 'H', userAgent: 'ua' }));
    await waitForMessage(host);
    open.push(host);

    // Two producers join
    for (let i = 0; i < 2; i++) {
      const ws = await openWs(slug);
      ws.send(JSON.stringify({ type: 'join', displayName: `P${i}`, userAgent: 'ua', producer: true }));
      const msg = await waitForMessage(ws);
      expect(msg.type).toBe('role-assigned');
      if (msg.type === 'role-assigned') expect(msg.role).toBe('producer');
      open.push(ws);
    }

    // 3rd producer must be closed with 4001
    const p3 = await openWs(slug);
    p3.send(JSON.stringify({ type: 'join', displayName: 'P3', userAgent: 'ua', producer: true }));
    const closePromise = waitForClose(p3);
    const result = await Promise.race([
      waitForMessage(p3).then((m) => ({ kind: 'msg' as const, msg: m })),
      closePromise.then((c) => ({ kind: 'close' as const, close: c })),
    ]);
    expect(result.kind).toBe('close');
    if (result.kind === 'close') expect(result.close.code).toBe(4001);

    open.forEach((w) => w.close());
    p3.close();
  });

  it('admits 4 recorded peers and 2 producers together', async () => {
    const slug = 'pro-maxa-aaa';
    await seedRoom(slug, 'tok-maxa-aaa');
    const open: WebSocket[] = [];

    for (let i = 0; i < 4; i++) {
      const ws = await openWs(slug);
      ws.send(JSON.stringify({ type: 'join', displayName: `G${i}`, userAgent: 'ua' }));
      const msg = await waitForMessage(ws);
      expect(msg.type).toBe('role-assigned');
      if (msg.type === 'role-assigned') expect(msg.role).not.toBe('producer');
      open.push(ws);
    }

    for (let i = 0; i < 2; i++) {
      const ws = await openWs(slug);
      ws.send(JSON.stringify({ type: 'join', displayName: `P${i}`, userAgent: 'ua', producer: true }));
      const msg = await waitForMessage(ws);
      expect(msg.type).toBe('role-assigned');
      if (msg.type === 'role-assigned') expect(msg.role).toBe('producer');
      open.push(ws);
    }

    expect(open).toHaveLength(6);
    open.forEach((w) => w.close());
  });

  it('unjoined pending sockets do not consume recorded seats', async () => {
    const slug = 'pro-unjo-aaa';
    await seedRoom(slug, 'tok-unjo-aaa');
    const open: WebSocket[] = [];

    // 3 recorded peers join
    for (let i = 0; i < 3; i++) {
      const ws = await openWs(slug);
      ws.send(JSON.stringify({ type: 'join', displayName: `G${i}`, userAgent: 'ua' }));
      const msg = await waitForMessage(ws);
      expect(msg.type).toBe('role-assigned');
      open.push(ws);
    }

    // 3 pending sockets connect without sending join (total sockets in DO = 6)
    const pendingSockets: WebSocket[] = [];
    for (let i = 0; i < 3; i++) {
      const pending = await openWs(slug);
      pendingSockets.push(pending);
    }

    // 4th recorded peer joins successfully
    const g4 = await openWs(slug);
    g4.send(JSON.stringify({ type: 'join', displayName: 'G3', userAgent: 'ua' }));
    const msg = await waitForMessage(g4);
    expect(msg.type).toBe('role-assigned');
    if (msg.type === 'role-assigned') expect(msg.role).not.toBe('producer');
    open.push(g4);

    open.forEach((w) => w.close());
    pendingSockets.forEach((w) => w.close());
  });
});

describe('companion mode', () => {
  it('a companion join does not use a recorded seat', async () => {
    const slug = 'cmp-seat-aaa';
    await seedRoom(slug, 'tok-cmp-seat');
    const open: WebSocket[] = [];

    const comp = await openWs(slug);
    comp.send(JSON.stringify({ type: 'join', displayName: 'C', userAgent: 'ua', companion: true }));
    const compMsg = await waitForMessage(comp);
    expect(compMsg.type).toBe('role-assigned');
    open.push(comp);

    // All four recorded seats must still be available alongside the companion.
    for (let i = 0; i < 4; i++) {
      const ws = await openWs(slug);
      ws.send(JSON.stringify({ type: 'join', displayName: `G${i}`, userAgent: 'ua' }));
      const msg = await waitForMessage(ws);
      expect(msg.type).toBe('role-assigned');
      open.push(ws);
    }
    open.forEach((w) => w.close());
  });

  it('4 recorded + 2 companions/producers fit', async () => {
    const slug = 'cmp-maxa-aaa';
    await seedRoom(slug, 'tok-cmp-max');
    const open: WebSocket[] = [];

    // 4 recorded peers
    for (let i = 0; i < 4; i++) {
      const ws = await openWs(slug);
      ws.send(JSON.stringify({ type: 'join', displayName: `G${i}`, userAgent: 'ua' }));
      const msg = await waitForMessage(ws);
      expect(msg.type).toBe('role-assigned');
      open.push(ws);
    }

    // 1 producer
    const prod = await openWs(slug);
    prod.send(JSON.stringify({ type: 'join', displayName: 'P0', userAgent: 'ua', producer: true }));
    const pMsg = await waitForMessage(prod);
    expect(pMsg.type).toBe('role-assigned');
    open.push(prod);

    // 1 companion
    const comp = await openWs(slug);
    comp.send(JSON.stringify({ type: 'join', displayName: 'C0', userAgent: 'ua', companion: true }));
    const cMsg = await waitForMessage(comp);
    expect(cMsg.type).toBe('role-assigned');
    open.push(comp);

    expect(open).toHaveLength(6);
    open.forEach((w) => w.close());
  });

  it('a third unrecorded is refused with 4001', async () => {
    const slug = 'cmp-capa-aaa';
    await seedRoom(slug, 'tok-cmp-capa');
    const open: WebSocket[] = [];

    // 1 producer + 1 companion = 2 unrecorded
    const prod = await openWs(slug);
    prod.send(JSON.stringify({ type: 'join', displayName: 'P', userAgent: 'ua', producer: true }));
    await waitForMessage(prod);
    open.push(prod);

    const comp = await openWs(slug);
    comp.send(JSON.stringify({ type: 'join', displayName: 'C', userAgent: 'ua', companion: true }));
    await waitForMessage(comp);
    open.push(comp);

    // 3rd unrecorded (companion) must be closed with 4001
    const comp2 = await openWs(slug);
    comp2.send(JSON.stringify({ type: 'join', displayName: 'C2', userAgent: 'ua', companion: true }));
    const closePromise = waitForClose(comp2);
    const result = await Promise.race([
      waitForMessage(comp2).then((m) => ({ kind: 'msg' as const, msg: m })),
      closePromise.then((c) => ({ kind: 'close' as const, close: c })),
    ]);
    expect(result.kind).toBe('close');
    if (result.kind === 'close') expect(result.close.code).toBe(4001);

    open.forEach((w) => w.close());
    comp2.close();
  });

  it('the flag is echoed in peer info', async () => {
    const slug = 'cmp-echo-aaa';
    await seedRoom(slug, 'tok-cmp-echo');
    const a = await openWs(slug);
    a.send(JSON.stringify({ type: 'join', displayName: 'A', userAgent: 'ua', companion: true }));
    const aRoleAssigned = await waitForMessage(a);
    expect(aRoleAssigned.type).toBe('role-assigned');

    const b = await openWs(slug);
    b.send(JSON.stringify({ type: 'join', displayName: 'B', userAgent: 'ua' }));
    const bRoleAssigned = await waitForMessage(b);
    expect(bRoleAssigned.type).toBe('role-assigned');
    if (bRoleAssigned.type === 'role-assigned') {
      const aInfo = bRoleAssigned.peers.find((p) => p.displayName === 'A');
      expect(aInfo?.companion).toBe(true);
    }

    const aPeerJoined = await waitForMessage(a);
    expect(aPeerJoined.type).toBe('peer-joined');

    const c = await openWs(slug);
    const aHearsCPromise = waitForMessage(a);
    const bHearsCPromise = waitForMessage(b);
    const cRoleAssignedPromise = waitForMessage(c);
    c.send(JSON.stringify({ type: 'join', displayName: 'C', userAgent: 'ua', companion: true }));

    const [aHearsC, bHearsC, cRoleAssigned] = await Promise.all([
      aHearsCPromise,
      bHearsCPromise,
      cRoleAssignedPromise,
    ]);

    expect(aHearsC.type).toBe('peer-joined');
    if (aHearsC.type === 'peer-joined') {
      expect(aHearsC.displayName).toBe('C');
      expect((aHearsC as unknown as { companion?: boolean }).companion).toBe(true);
    }

    expect(bHearsC.type).toBe('peer-joined');
    if (bHearsC.type === 'peer-joined') {
      expect(bHearsC.displayName).toBe('C');
      expect((bHearsC as unknown as { companion?: boolean }).companion).toBe(true);
    }

    expect(cRoleAssigned.type).toBe('role-assigned');
    if (cRoleAssigned.type === 'role-assigned') {
      const aInfo = cRoleAssigned.peers.find((p) => p.displayName === 'A');
      expect(aInfo?.companion).toBe(true);
      const bInfo = cRoleAssigned.peers.find((p) => p.displayName === 'B');
      expect(bInfo?.companion).toBeFalsy();
    }

    a.close();
    b.close();
    c.close();
  });
});

describe('Room DO — hardening', () => {
  // Every distinct name instantiates a Durable Object. Without validation,
  // varying the URL spins up unbounded DOs — each billable, and DO count is a
  // free-tier limit.
  it('rejects a malformed slug before instantiating a Durable Object', async () => {
    for (const bad of ['UPPERCASE', 'no-dashes', 'a-b-c', '../etc', '%00']) {
      const res = await SELF.fetch(`https://test/ws/r/${encodeURIComponent(bad)}`, {
        headers: { Upgrade: 'websocket' },
      });
      expect(res.status, bad).toBe(400);
    }
  });

  it('rejects an arbitrary long name', async () => {
    const res = await SELF.fetch(`https://test/ws/r/${'a'.repeat(200)}`, {
      headers: { Upgrade: 'websocket' },
    });
    expect(res.status).toBe(400);
  });

  // A host whose tab crashes mid-recording must not leave the room telling
  // every future joiner to start capturing into a host that isn't there.
  it('clears the recording flag when the host disconnects', async () => {
    const slug = 'hos-tgon-eaa';
    await seedRoom(slug, 'tok-host-gone');
    const host = await openWs(slug, `host_token__${slug}=tok-host-gone`);
    host.send(JSON.stringify({ type: 'join', displayName: 'H', userAgent: 'ua' }));
    await waitForMessage(host);
    const guest = await openWs(slug);
    guest.send(JSON.stringify({ type: 'join', displayName: 'G', userAgent: 'ua' }));
    await waitForMessage(guest);
    await waitForMessage(host);

    host.send(
      JSON.stringify({ type: 'recording-started', recordingId: 'r-gone', kind: 'camera', filename: 'h.mp4' })
    );
    await waitForMessage(guest); // the relay
    host.close();
    await waitForMessage(guest); // peer-left

    const late = await openWs(slug);
    late.send(JSON.stringify({ type: 'join', displayName: 'L', userAgent: 'ua' }));
    const msg = await waitForMessage(late);
    if (msg.type === 'role-assigned') expect(msg.recording).toBe(false);

    guest.close();
    late.close();
  });
});

describe('Room DO — recording-completed is ignored', () => {
  it('changes nothing, whoever sends recording-completed', async () => {
    // A recording that belongs to somebody else's session.
    await seedRoom('vic-timr-oma', 'tok-victim');
    await env.DB.prepare(
      'INSERT INTO sessions (id, room_slug, started_at) VALUES (?, ?, ?)'
    ).bind('victim-session', 'vic-timr-oma', Date.now()).run();
    await env.DB.prepare(
      'INSERT INTO participants (id, session_id, role, display_name, joined_at) VALUES (?, ?, ?, ?, ?)'
    ).bind('victim-participant', 'victim-session', 'host', 'V', Date.now()).run();
    await env.DB.prepare(
      `INSERT INTO recordings (id, session_id, participant_id, kind, filename,
        total_bytes, last_offset, sha256, status, started_at, finalized_at)
       VALUES (?, ?, ?, 'camera', 'host_v.mp4', 999, 0, 'REALHASH', 'recording', 1, NULL)`
    ).bind('victim-recording', 'victim-session', 'victim-participant').run();

    // An unrelated room.
    const slug = 'atk-acke-aaa';
    await seedRoom(slug, 'tok-attacker');
    const ws = await openWs(slug);
    ws.send(JSON.stringify({ type: 'join', displayName: 'A', userAgent: 'ua' }));
    await waitForMessage(ws);

    ws.send(
      JSON.stringify({
        type: 'recording-completed',
        recordingId: 'victim-recording',
        lastIdx: 0,
        totalBytes: 1,
        sha256: 'FORGED',
      })
    );
    await new Promise((r) => setTimeout(r, 300));

    const row = await env.DB.prepare('SELECT sha256, status, total_bytes FROM recordings WHERE id = ?')
      .bind('victim-recording')
      .first<{ sha256: string; status: string; total_bytes: number }>();
    expect(row?.sha256).toBe('REALHASH');
    expect(row?.status).toBe('recording');
    expect(row?.total_bytes).toBe(999);
    ws.close();
  });

  it('leaves the row recording when the host sends recording-completed', async () => {
    const slug = 'own-eron-aaa';
    await seedRoom(slug, 'tok-owner');
    const ws = await openWs(slug, `host_token__${slug}=tok-owner`);
    ws.send(JSON.stringify({ type: 'join', displayName: 'H', userAgent: 'ua' }));
    await waitForMessage(ws);

    const recId = 'owned-recording';
    ws.send(JSON.stringify({ type: 'recording-started', recordingId: recId, kind: 'camera', filename: 'h.mp4' }));
    let row: { status: string; finalized_at: number | null } | null = null;
    for (let i = 0; i < 20 && !row; i++) {
      row = await env.DB.prepare('SELECT status, finalized_at FROM recordings WHERE id = ?').bind(recId).first();
      if (!row) await new Promise((r) => setTimeout(r, 25));
    }
    expect(row?.status).toBe('recording');

    ws.send(JSON.stringify({ type: 'recording-completed', recordingId: recId, lastIdx: 1, totalBytes: 42, sha256: 'MINE' }));
    await new Promise((r) => setTimeout(r, 150));

    const finalRow = await env.DB.prepare('SELECT status, finalized_at FROM recordings WHERE id = ?')
      .bind(recId)
      .first<{ status: string; finalized_at: number | null }>();
    expect(finalRow?.status).toBe('recording');
    expect(finalRow?.finalized_at).toBeNull();

    const guestWs = await openWs(slug);
    guestWs.send(JSON.stringify({ type: 'join', displayName: 'G', userAgent: 'ua' }));
    await waitForMessage(guestWs);

    guestWs.send(JSON.stringify({ type: 'recording-completed', recordingId: recId, lastIdx: 1, totalBytes: 99, sha256: 'GUEST' }));
    await new Promise((r) => setTimeout(r, 150));

    const afterGuest = await env.DB.prepare('SELECT status, finalized_at FROM recordings WHERE id = ?')
      .bind(recId)
      .first<{ status: string; finalized_at: number | null }>();
    expect(afterGuest?.status).toBe('recording');
    expect(afterGuest?.finalized_at).toBeNull();

    guestWs.close();
    ws.close();
  });
});

describe('Room DO — hibernation wake', () => {
  // The DO can be evicted from memory between messages under the Hibernation
  // API, so nothing a peer needs may live only in private instance fields on
  // the one JS object that happened to handle earlier messages — it has to be
  // in DO storage (room/session/nextOrdinal) or WebSocket attachments
  // (per-peer role/joined/peerId/ordinal). Simulate a wake by constructing a
  // SECOND `Room` over the SAME `DurableObjectState` — exactly what the
  // runtime does when it re-instantiates an evicted actor — and driving the
  // whole third-peer join through THAT instance's own methods directly
  // (bypassing normal WS dispatch, which would route to the still-resident
  // first instance and prove nothing about storage/attachment persistence).
  it('a freshly constructed Room answers a late join with recording state and peer roles from storage/attachments alone', async () => {
    const slug = 'hib-erna-tea';
    const hostToken = 'tok-hibernate-a';
    await seedRoom(slug, hostToken);

    const host = await openWs(slug, `host_token__${slug}=${hostToken}`);
    host.send(JSON.stringify({ type: 'join', displayName: 'H', userAgent: 'ua' }));
    await waitForMessage(host); // role-assigned

    const guest = await openWs(slug);
    guest.send(JSON.stringify({ type: 'join', displayName: 'G', userAgent: 'ua' }));
    await waitForMessage(guest); // role-assigned
    await waitForMessage(host); // peer-joined

    host.send(
      JSON.stringify({ type: 'recording-started', recordingId: 'r-hib', kind: 'camera', filename: 'h.mp4' })
    );
    await waitForMessage(guest); // the relayed recording-started

    const id = env.ROOM_DO.idFromName(slug);
    const stub = env.ROOM_DO.get(id);

    const storedSession = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.get<{ sessionId: string | null; recording: boolean; recordingCount?: number }>('session')
    );
    expect(storedSession?.recordingCount).toBe(1);

    const late = await runInDurableObject(stub, async (_instance, state) => {
      const fresh = new Room(state, env);
      // Let the constructor's blockConcurrencyWhile finish loading
      // room/session/nextOrdinal from storage before using `fresh`.
      await new Promise((r) => setTimeout(r, 50));

      const beforeSockets = new Set(state.getWebSockets());
      const req = new Request(`https://test/ws/r/${slug}`, {
        headers: { Upgrade: 'websocket' },
      });
      const res = await fresh.fetch(req);
      const clientWs = res.webSocket!;
      clientWs.accept();
      const serverWs = state.getWebSockets().find((s) => !beforeSockets.has(s));
      if (!serverWs) throw new Error('expected a newly accepted socket');

      const reply = new Promise<ServerMessage & { type: 'role-assigned' }>((resolve, reject) => {
        clientWs.addEventListener('message', (e: MessageEvent) => {
          try {
            const msg = JSON.parse(e.data as string) as ServerMessage;
            if (msg.type === 'role-assigned') resolve(msg as ServerMessage & { type: 'role-assigned' });
          } catch (err) {
            reject(err);
          }
        });
      });
      // Call the fresh instance's own handler directly rather than sending
      // over the wire: real WS dispatch would be routed by the runtime to
      // whichever instance it currently considers resident (the original,
      // still-warm one), which would trivially pass this test regardless of
      // whether hibernation persistence actually works.
      await fresh.webSocketMessage(
        serverWs,
        JSON.stringify({ type: 'join', displayName: 'Late', userAgent: 'ua' })
      );
      return reply;
    });

    expect(late.recording, 'recording flag must survive from DO storage, not an instance field').toBe(true);
    expect(late.peers).toHaveLength(2);
    expect(late.peers.map((p) => p.role).sort()).toEqual(['guest', 'host']);

    const capRecId = 'r-hib-capped';
    await runInDurableObject(stub, async (_instance, state) => {
      const sess = (await state.storage.get<{ sessionId: string | null; recording: boolean; recordingCount?: number }>('session'))!;
      await state.storage.put('session', { ...sess, recordingCount: 256 });
      const freshAtCap = new Room(state, env);
      await new Promise((r) => setTimeout(r, 50));
      const hostWs = state.getWebSockets().find((s) => {
        const att = s.deserializeAttachment() as { role?: string };
        return att?.role === 'host';
      })!;
      await freshAtCap.webSocketMessage(
        hostWs,
        JSON.stringify({ type: 'recording-started', recordingId: capRecId, kind: 'camera', filename: 'h-cap.mp4' })
      );
    });
    await new Promise((r) => setTimeout(r, 150));
    const cappedRow = await env.DB.prepare('SELECT id FROM recordings WHERE id = ?').bind(capRecId).first();
    expect(cappedRow).toBeNull();

    host.close();
    guest.close();
  });
});

describe('Room DO — mid-call expiry (alarm)', () => {
  // join arms an alarm for the room's (freshly extended) expires_at. If
  // nobody rejoins before that time, the room must close itself instead of
  // running on forever — connect-time expiry checks alone never fire again
  // once a call is already underway.
  it('closes open sockets with 4003 when the room has expired by the time the alarm fires', async () => {
    const slug = 'alm-expi-red';
    const hostToken = 'tok-alarm-expired';
    await seedRoom(slug, hostToken);

    const ws = await openWs(slug, `host_token__${slug}=${hostToken}`);
    const closed = waitForClose(ws);
    ws.send(JSON.stringify({ type: 'join', displayName: 'H', userAgent: 'ua' }));
    await waitForMessage(ws); // role-assigned; join armed the alarm

    // Simulate the room having since expired: push expires_at into the past,
    // exactly like a room nobody rejoined before its TTL lapsed.
    await env.DB.prepare('UPDATE rooms SET expires_at = ? WHERE slug = ?')
      .bind(Date.now() - 1000, slug)
      .run();

    const id = env.ROOM_DO.idFromName(slug);
    const stub = env.ROOM_DO.get(id);
    const ran = await runDurableObjectAlarm(stub);
    expect(ran, 'join must have scheduled an alarm for the alarm to run').toBe(true);

    const { code, reason } = await closed;
    expect(code).toBe(4003);
    expect(reason).toBe('expired_slug');

    const session = await env.DB.prepare('SELECT ended_at, end_reason FROM sessions WHERE room_slug = ?')
      .bind(slug)
      .first<{ ended_at: number | null; end_reason: string | null }>();
    expect(session?.end_reason).toBe('expired');
    expect(session?.ended_at).not.toBeNull();
  });

  it('re-arms instead of closing when expires_at is still in the future (a later join extended it)', async () => {
    const slug = 'alm-futu-rea';
    const hostToken = 'tok-alarm-future';
    await seedRoom(slug, hostToken);

    const ws = await openWs(slug, `host_token__${slug}=${hostToken}`);
    ws.send(JSON.stringify({ type: 'join', displayName: 'H', userAgent: 'ua' }));
    await waitForMessage(ws); // role-assigned; join pushed expires_at (and the alarm) into the future

    const id = env.ROOM_DO.idFromName(slug);
    const stub = env.ROOM_DO.get(id);
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    // Nothing closes...
    const raced = await Promise.race([
      waitForClose(ws).then(() => 'closed' as const),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 200)),
    ]);
    expect(raced).toBe('timeout');

    // ...and a fresh alarm is armed for the (still future) expiry.
    const alarmAt = await runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm());
    expect(alarmAt).not.toBeNull();
    expect(alarmAt!).toBeGreaterThan(Date.now());

    ws.close();
  });
});

describe('WS Origin check', () => {
  const upgrade = (slug: string, origin?: string) =>
    SELF.fetch(`https://test/ws/r/${slug}`, {
      headers: { Upgrade: 'websocket', ...(origin ? { Origin: origin } : {}) },
    });

  it('refuses a handshake from a foreign Origin with 403', async () => {
    await seedRoom('ori-gine-vil', 'tok-origin-evil');
    const res = await upgrade('ori-gine-vil', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.webSocket).toBeNull();
  });

  it('upgrades a handshake from the configured PAGES_ORIGIN', async () => {
    await seedRoom('ori-ginp-age', 'tok-origin-page');
    const res = await upgrade('ori-ginp-age', env.PAGES_ORIGIN);
    expect(res.status).toBe(101);
    res.webSocket!.accept();
    res.webSocket!.close();
  });

  it('upgrades a handshake with no Origin (non-browser tooling)', async () => {
    await seedRoom('ori-ginn-one', 'tok-origin-none');
    const res = await upgrade('ori-ginn-one');
    expect(res.status).toBe(101);
    res.webSocket!.accept();
    res.webSocket!.close();
  });
});

// A socket is in the room only between a `join` that passed the caps and its
// close. These drive the sockets that are NOT: connected but never joined,
// refused at the cap, or already replaced — each of which keeps a working
// socket for as long as its client declines to finish the closing handshake.
describe('Room DO — only a joined socket is in the room', () => {
  // Everything a socket is sent, so a test can assert on what it did NOT get.
  function collect(ws: WebSocket): ServerMessage[] {
    const heard: ServerMessage[] = [];
    ws.addEventListener('message', (e) => heard.push(JSON.parse(e.data as string) as ServerMessage));
    return heard;
  }

  function ofType<T extends ServerMessage['type']>(heard: ServerMessage[], type: T) {
    return heard.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }

  async function enter(slug: string, displayName: string, extra: Record<string, unknown> = {}, cookie?: string) {
    const ws = await openWs(slug, cookie);
    const heard = collect(ws);
    const assigned = waitForRoleAssigned(ws);
    ws.send(JSON.stringify({ type: 'join', displayName, userAgent: 'ua', ...extra }));
    return { ws, heard, me: await assigned };
  }

  const settle = () => new Promise((r) => setTimeout(r, 150));

  async function until(cond: () => boolean | Promise<boolean>): Promise<void> {
    for (let i = 0; i < 80 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 25));
  }

  const sessionOf = (slug: string) =>
    env.DB.prepare('SELECT id, ended_at FROM sessions WHERE room_slug = ? ORDER BY started_at DESC')
      .bind(slug)
      .first<{ id: string; ended_at: number | null }>();

  const started = (recordingId: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'recording-started', recordingId, kind: 'camera', filename: `guest_${recordingId}.mp4`, ...over });

  it('delivers nothing to a socket that never sent join', async () => {
    const slug = 'unj-hear-aaa';
    await seedRoom(slug, 'tok-unj-hear');
    const lurker = await openWs(slug);
    const overheard = collect(lurker);

    const host = await enter(slug, 'H', { hostToken: 'tok-unj-hear' });
    const guest = await enter(slug, 'G');
    host.ws.send(JSON.stringify({ type: 'chat', text: 'private', ts: 1 }));
    host.ws.send(JSON.stringify({ type: 'presence', micOn: true, camOn: true, screenSharing: false }));
    host.ws.send(JSON.stringify({ type: 'marker', label: 'm' }));
    host.ws.send(started('r-unj-hear'));
    host.ws.send(JSON.stringify({ type: 'recording-stop', recordingId: 'r-unj-hear' }));
    await until(() => ofType(guest.heard, 'recording-stop').length > 0);
    guest.ws.close();
    await until(() => ofType(host.heard, 'peer-left').length > 0);

    // The guest, who did join, got all of it — so this is not just a quiet room.
    expect(guest.heard.map((m) => m.type)).toEqual([
      'role-assigned',
      'chat',
      'presence',
      'marker',
      'recording-started',
      'recording-stop',
    ]);
    expect(overheard).toEqual([]);
    host.ws.close();
    lurker.close();
  });

  it('relays nothing sent by a socket that never sent join', async () => {
    const slug = 'unj-send-aaa';
    await seedRoom(slug, 'tok-unj-send');
    const a = await enter(slug, 'A');
    const b = await enter(slug, 'B');
    const lurker = await openWs(slug);
    for (const msg of [
      { type: 'chat', text: 'from nobody', ts: 1 },
      { type: 'presence', micOn: false, camOn: false, screenSharing: true },
      { type: 'marker', label: 'm' },
      { type: 'recording-capability', mp4: true, wav: true },
      { type: 'webrtc-offer', sdp: 'v=0' },
      { type: 'recording-started', recordingId: 'r-unj-send', kind: 'camera', filename: 'x.mp4' },
      { type: 'recording-stop', recordingId: 'r-unj-send' },
      { type: 'leave', reason: 'user-exit' },
    ]) {
      lurker.send(JSON.stringify(msg));
    }
    await settle();
    b.ws.send(JSON.stringify({ type: 'chat', text: 'sentinel', ts: 2 }));
    await until(() => ofType(a.heard, 'chat').some((m) => m.text === 'sentinel'));

    expect(a.heard.map((m) => m.type)).toEqual(['role-assigned', 'peer-joined', 'chat']);
    expect(b.heard.map((m) => m.type)).toEqual(['role-assigned']);
    a.ws.close();
    b.ws.close();
    lurker.close();
  });

  // The cookie path makes a socket role=host at connect, before any join.
  it('does not let an un-joined socket holding the host cookie mark the room as recording', async () => {
    const slug = 'unj-cook-aaa';
    await seedRoom(slug, 'tok-unj-cook');
    const lurker = await openWs(slug, `host_token__${slug}=tok-unj-cook`);
    lurker.send(started('r-unj-cook'));
    await settle();
    const late = await enter(slug, 'L');
    expect(late.me.recording).toBe(false);
    late.ws.close();
    lurker.close();
  });

  it('counts only joined sockets in role-assigned.peerCount', async () => {
    const slug = 'unj-coun-taa';
    await seedRoom(slug, 'tok-unj-count');
    const idle = [await openWs(slug), await openWs(slug)];
    const a = await enter(slug, 'A');
    expect(a.me.peerCount).toBe(1);
    const b = await enter(slug, 'B');
    expect(b.me.peerCount).toBe(2);
    expect(b.me.peers).toHaveLength(1);
    [a.ws, b.ws, ...idle].forEach((w) => w.close());
  });

  it('keeps a socket refused at the cap outside the room', async () => {
    const slug = 'cap-outs-ide';
    await seedRoom(slug, 'tok-cap-outside');
    const seated: Array<Awaited<ReturnType<typeof enter>>> = [];
    for (let i = 0; i < 4; i++) seated.push(await enter(slug, `P${i}`));

    const fifth = await openWs(slug);
    const refused = waitForClose(fifth);
    fifth.send(JSON.stringify({ type: 'join', displayName: 'X', userAgent: 'ua' }));
    expect((await refused).code).toBe(4001);
    // Refused, but its client has not closed its own end yet.
    fifth.send(JSON.stringify({ type: 'chat', text: 'from outside', ts: 1 }));
    await settle();
    fifth.close();
    await settle();
    seated[1]!.ws.send(JSON.stringify({ type: 'chat', text: 'sentinel', ts: 2 }));
    await until(() => ofType(seated[0]!.heard, 'chat').some((m) => m.text === 'sentinel'));

    expect(ofType(seated[0]!.heard, 'chat').map((m) => m.text)).toEqual(['sentinel']);
    // Nobody was told it joined, so nobody is told it left.
    expect(ofType(seated[0]!.heard, 'peer-left')).toEqual([]);
    seated.forEach((s) => s.ws.close());
  });

  it('ignores everything a replaced host sends after it was replaced', async () => {
    const slug = 'rep-ghos-taa';
    const hostToken = 'tok-rep-ghost';
    await seedRoom(slug, hostToken);
    const old = await enter(slug, 'Old', { hostToken });
    const guest = await enter(slug, 'G');
    const replaced = waitForClose(old.ws);
    const next = await enter(slug, 'New', { hostToken });
    expect((await replaced).code).toBe(4006);

    old.ws.send(JSON.stringify({ type: 'chat', text: 'ghost', ts: 1 }));
    old.ws.send(started('r-rep-ghost'));
    await settle();
    next.ws.send(JSON.stringify({ type: 'chat', text: 'sentinel', ts: 2 }));
    await until(() => ofType(guest.heard, 'chat').some((m) => m.text === 'sentinel'));

    expect(ofType(guest.heard, 'chat').map((m) => m.text)).toEqual(['sentinel']);
    expect(ofType(guest.heard, 'recording-started')).toEqual([]);
    const late = await enter(slug, 'L');
    expect(late.me.recording).toBe(false);
    [old.ws, guest.ws, next.ws, late.ws].forEach((w) => w.close());
  });

  it('treats a second join on a joined socket as a no-op', async () => {
    const slug = 'rej-oinn-oop';
    await seedRoom(slug, 'tok-rejoin-noop');
    const a = await enter(slug, 'A');
    const b = await enter(slug, 'B');
    b.ws.send(JSON.stringify({ type: 'join', displayName: 'Someone else', userAgent: 'ua2', producer: true }));
    b.ws.send(JSON.stringify({ type: 'join', displayName: 'Someone else', userAgent: 'ua2', hostToken: 'tok-rejoin-noop' }));
    await settle();
    b.ws.send(JSON.stringify({ type: 'chat', text: 'sentinel', ts: 1 }));
    await until(() => ofType(a.heard, 'chat').length > 0);

    expect(ofType(a.heard, 'peer-joined')).toHaveLength(1);
    expect(ofType(b.heard, 'role-assigned')).toHaveLength(1);
    // Neither the name nor the role moved.
    expect(ofType(a.heard, 'chat')[0]).toMatchObject({ from: 'guest', fromName: 'B' });
    const session = await sessionOf(slug);
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM participants WHERE session_id = ?')
      .bind(session!.id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(2);
    a.ws.close();
    b.ws.close();
  });

  it('persists a recordings row only for a bounded id and filename and a known kind', async () => {
    const slug = 'rec-vali-daa';
    await seedRoom(slug, 'tok-rec-valid');
    const host = await enter(slug, 'H', { hostToken: 'tok-rec-valid' });
    const guest = await enter(slug, 'G');
    const producer = await enter(slug, 'P', { producer: true });
    const hostRec = crypto.randomUUID();
    const guestRec = crypto.randomUUID();
    const prodRec = crypto.randomUUID();

    host.ws.send(started(crypto.randomUUID(), { filename: 'f'.repeat(3000) }));
    host.ws.send(started('i'.repeat(3000)));
    host.ws.send(started('', { filename: 'host_empty_id.mp4' }));
    host.ws.send(started(crypto.randomUUID(), { filename: '' }));
    host.ws.send(started(crypto.randomUUID(), { kind: 'audio' }));
    host.ws.send(started(crypto.randomUUID(), { kind: undefined }));
    host.ws.send(started(crypto.randomUUID(), { filename: { nested: true } }));
    host.ws.send(started(hostRec, { filename: `host_${hostRec}.mp4` }));

    guest.ws.send(started(guestRec));
    producer.ws.send(started(prodRec));

    const session = await sessionOf(slug);
    const rows = () =>
      env.DB.prepare(
        `SELECT r.id, r.kind, r.filename, p.role FROM recordings r
           JOIN participants p ON p.id = r.participant_id WHERE r.session_id = ?`
      )
        .bind(session!.id)
        .all<{ id: string; kind: string; filename: string; role: string }>();

    await until(async () => (await rows()).results.some((r) => r.id === hostRec));
    await settle();

    const written = (await rows()).results;
    expect(written.map((r) => r.id)).toEqual([hostRec]);
    expect(written.find((r) => r.id === hostRec)).toMatchObject({
      kind: 'camera',
      filename: `host_${hostRec}.mp4`,
      role: 'host',
    });

    const hostRelayed = ofType(guest.heard, 'recording-started').filter((m) => m.from === 'host');
    expect(hostRelayed).toHaveLength(8);

    const guestRelayed = ofType(host.heard, 'recording-started').find((m) => m.recordingId === guestRec);
    expect(guestRelayed).toBeDefined();
    expect(guestRelayed?.from).toBe('guest');

    const prodRelayed = ofType(host.heard, 'recording-started').find((m) => m.recordingId === prodRec);
    expect(prodRelayed).toBeDefined();
    expect(prodRelayed?.from).toBe('producer');

    host.ws.close();
    guest.ws.close();
    producer.ws.close();
  });

  it('bounds the recordings rows per session', async () => {
    const slug = 'rec-boun-daa';
    await seedRoom(slug, 'tok-rec-bound');
    const host = await enter(slug, 'H', { hostToken: 'tok-rec-bound' });
    for (let i = 0; i < 260; i++) host.ws.send(started(crypto.randomUUID()));

    const session = await sessionOf(slug);
    const count = async (sessId: string) =>
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM recordings WHERE session_id = ?')
        .bind(sessId)
        .first<{ n: number }>())!.n;
    await until(async () => (await count(session!.id)) >= 256);
    await settle();
    expect(await count(session!.id)).toBe(256);

    // A host that reconnects in the same session does not get a fresh allowance.
    const host2 = await openWs(slug, `host_token__${slug}=tok-rec-bound`);
    host2.send(JSON.stringify({ type: 'join', displayName: 'H2', userAgent: 'ua' }));
    await waitForRoleAssigned(host2);
    host2.send(started(crypto.randomUUID()));
    await settle();
    expect(await count(session!.id)).toBe(256);

    // End the session by closing all sockets.
    host.ws.close();
    host2.close();
    await until(async () => (await sessionOf(slug))?.ended_at != null);

    // A new session starts at zero.
    const host3 = await enter(slug, 'H3', { hostToken: 'tok-rec-bound' });
    const newSession = await sessionOf(slug);
    expect(newSession!.id).not.toBe(session!.id);
    const newRec = crypto.randomUUID();
    host3.ws.send(started(newRec));
    await until(async () => (await count(newSession!.id)) >= 1);
    expect(await count(newSession!.id)).toBe(1);
    host3.ws.close();
  });

  it('truncates an over-long displayName and userAgent in D1 and in peer-joined', async () => {
    const slug = 'trn-cate-aaa';
    await seedRoom(slug, 'tok-truncate');
    const a = await enter(slug, 'A');
    const b = await enter(slug, 'n'.repeat(3000), { userAgent: 'u'.repeat(3000) });
    await until(() => ofType(a.heard, 'peer-joined').length > 0);

    expect(ofType(a.heard, 'peer-joined')[0]).toMatchObject({
      displayName: 'n'.repeat(64),
      userAgent: 'u'.repeat(512),
    });
    const session = await sessionOf(slug);
    const row = await env.DB.prepare(
      "SELECT display_name, user_agent FROM participants WHERE session_id = ? AND display_name LIKE 'n%'"
    )
      .bind(session!.id)
      .first<{ display_name: string; user_agent: string }>();
    expect(row).toEqual({ display_name: 'n'.repeat(64), user_agent: 'u'.repeat(512) });

    b.ws.send(JSON.stringify({ type: 'chat', text: 'hi', ts: 1 }));
    await until(() => ofType(a.heard, 'chat').length > 0);
    expect(ofType(a.heard, 'chat')[0]!.fromName).toBe('n'.repeat(64));
    // A later joiner is given the same capped name.
    const c = await enter(slug, 'C');
    expect(c.me.peers.map((p) => p.displayName).sort()).toEqual(['A', 'n'.repeat(64)]);
    // A cut that lands inside a surrogate pair drops the pair, rather than
    // storing and relaying half of one.
    await enter(slug, 'e'.repeat(63) + '\u{1F600}');
    await until(() => ofType(c.heard, 'peer-joined').length > 0);
    expect(ofType(c.heard, 'peer-joined')[0]!.displayName).toBe('e'.repeat(63));
    [a.ws, b.ws, c.ws].forEach((w) => w.close());
  });

  // The attachment is limited to 2048 bytes and a string outside Latin-1 costs
  // two bytes a character, so this is the largest attachment a socket can have:
  // every capped field at its cap, every optional one set.
  it('fits the socket attachment when every capped field is at its cap in two-byte characters', async () => {
    const slug = 'trn-wide-aaa';
    await seedRoom(slug, 'tok-truncate-wide');
    const wide = await enter(slug, '名'.repeat(3000), {
      userAgent: '名'.repeat(3000),
      clientId: '名'.repeat(64),
      producer: true,
      companion: true,
    });
    expect(wide.me.role).toBe('producer');
    wide.ws.close();
  });

  it('announces a graceful leave exactly once, with the reason the leaver gave', async () => {
    const slug = 'lea-veon-cea';
    await seedRoom(slug, 'tok-leave-once');
    const a = await enter(slug, 'A');
    const b = await enter(slug, 'B');
    const closed = waitForClose(b.ws);
    b.ws.send(JSON.stringify({ type: 'leave', reason: 'user-exit' }));
    expect((await closed).code).toBe(1000);
    // What a browser does next: finish the handshake, which runs the DO's own
    // close callback for the same socket.
    b.ws.close();
    await settle();

    expect(ofType(a.heard, 'peer-left')).toEqual([
      { type: 'peer-left', role: 'guest', reason: 'user-exit', peerId: b.me.peerId },
    ]);
    a.ws.close();
  });

  it('ends the session when the last joined peer leaves, even with an un-joined socket still connected', async () => {
    const slug = 'ses-ends-aaa';
    await seedRoom(slug, 'tok-session-ends');
    const idle = await openWs(slug);
    const a = await enter(slug, 'A', {}, `host_token__${slug}=tok-session-ends`);
    a.ws.send(started('r-ses-ends'));
    await until(async () => (await env.DB.prepare('SELECT 1 FROM recordings WHERE id = ?').bind('r-ses-ends').first()) !== null);
    expect((await sessionOf(slug))?.ended_at).toBeNull();
    a.ws.close();
    await until(async () => (await sessionOf(slug))?.ended_at != null);
    expect((await sessionOf(slug))?.ended_at).not.toBeNull();
    const stored = await runInDurableObject(env.ROOM_DO.get(env.ROOM_DO.idFromName(slug)), async (_instance, state) =>
      state.storage.get<{ recordingCount?: number }>('session')
    );
    expect(stored?.recordingCount).toBe(0);
    idle.close();
  });

  it('does not end a session, or announce a departure, when an un-joined socket closes', async () => {
    const slug = 'ses-stay-saa';
    await seedRoom(slug, 'tok-session-stays');
    const a = await enter(slug, 'A');
    const idle = await openWs(slug);
    idle.close();
    await settle();
    expect((await sessionOf(slug))?.ended_at).toBeNull();
    expect(a.heard.map((m) => m.type)).toEqual(['role-assigned']);
    a.ws.close();
  });

  it('still closes an un-joined socket with 4003 when the room expires mid-call', async () => {
    const slug = 'alm-unjo-ina';
    await seedRoom(slug, 'tok-alarm-unjoined');
    const a = await enter(slug, 'A', {}, `host_token__${slug}=tok-alarm-unjoined`); // join arms the alarm
    a.ws.send(started('r-alm-unjo'));
    await until(async () => (await env.DB.prepare('SELECT 1 FROM recordings WHERE id = ?').bind('r-alm-unjo').first()) !== null);
    const idle = await openWs(slug);
    const closes = [waitForClose(a.ws), waitForClose(idle)];
    await env.DB.prepare('UPDATE rooms SET expires_at = ? WHERE slug = ?').bind(Date.now() - 1000, slug).run();
    await runDurableObjectAlarm(env.ROOM_DO.get(env.ROOM_DO.idFromName(slug)));
    expect((await Promise.all(closes)).map((c) => c.code)).toEqual([4003, 4003]);
    const stored = await runInDurableObject(env.ROOM_DO.get(env.ROOM_DO.idFromName(slug)), async (_instance, state) =>
      state.storage.get<{ recordingCount?: number }>('session')
    );
    expect(stored?.recordingCount).toBe(0);
  });

  // The cookie path replaces the old host at connect, before the new socket
  // has joined — so for a moment the room has a host but no joined peer.
  it('keeps the take and the session when a host alone in the room reconnects on the cookie path', async () => {
    const slug = 'coo-krec-onn';
    const cookie = `host_token__${slug}=tok-cookie-reconnect`;
    await seedRoom(slug, 'tok-cookie-reconnect');
    const old = await enter(slug, 'H', {}, cookie);
    const rec = crypto.randomUUID();
    old.ws.send(started(rec));
    await until(async () => (await env.DB.prepare('SELECT 1 FROM recordings WHERE id = ?').bind(rec).first()) !== null);

    const replaced = waitForClose(old.ws);
    const next = await openWs(slug, cookie);
    expect((await replaced).code).toBe(4006);
    // The old socket's close has run to its end before the new one joins.
    await settle();
    const assigned = waitForRoleAssigned(next);
    next.send(JSON.stringify({ type: 'join', displayName: 'H', userAgent: 'ua' }));
    expect((await assigned).recording).toBe(true);
    const late = await enter(slug, 'G');
    expect(late.me.recording, 'a guest joining now would not be recorded').toBe(true);
    const sessions = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE room_slug = ?')
      .bind(slug)
      .first<{ n: number }>();
    expect(sessions?.n).toBe(1);
    [old.ws, next, late.ws].forEach((w) => w.close());
  });

  it('ends the session when a socket holding the host cookie closes without joining and nobody else is left', async () => {
    const slug = 'coo-kidl-eaa';
    await seedRoom(slug, 'tok-cookie-idle');
    const a = await enter(slug, 'A');
    const idleHost = await openWs(slug, `host_token__${slug}=tok-cookie-idle`);
    a.ws.close();
    await settle();
    idleHost.close();
    await until(async () => (await sessionOf(slug))?.ended_at != null);
    expect((await sessionOf(slug))?.ended_at).not.toBeNull();
  });

  it('leaves the socket open and sends no error after ignored messages', async () => {
    const slug = 'rco-open-aaa';
    await seedRoom(slug, 'tok-rc-open');
    const host = await enter(slug, 'H', { hostToken: 'tok-rc-open' });
    const guest = await enter(slug, 'G');
    const producer = await enter(slug, 'P', { producer: true });
    const speaker = await enter(slug, 'S');

    host.ws.send(JSON.stringify({ type: 'recording-completed', recordingId: 'rec-1', lastIdx: 0, totalBytes: 1 }));
    guest.ws.send(JSON.stringify({ type: 'recording-completed', recordingId: 'rec-1', lastIdx: 0, totalBytes: 1 }));
    guest.ws.send(started(crypto.randomUUID()));
    producer.ws.send(started(crypto.randomUUID()));

    await new Promise((r) => setTimeout(r, 100));

    expect(ofType(host.heard, 'error')).toHaveLength(0);
    expect(ofType(guest.heard, 'error')).toHaveLength(0);
    expect(ofType(producer.heard, 'error')).toHaveLength(0);

    speaker.ws.send(JSON.stringify({ type: 'chat', text: 'check-open', ts: 1 }));
    await until(() => ofType(host.heard, 'chat').some((m) => m.text === 'check-open'));
    await until(() => ofType(guest.heard, 'chat').some((m) => m.text === 'check-open'));
    await until(() => ofType(producer.heard, 'chat').some((m) => m.text === 'check-open'));

    expect(ofType(host.heard, 'chat').some((m) => m.text === 'check-open')).toBe(true);
    expect(ofType(guest.heard, 'chat').some((m) => m.text === 'check-open')).toBe(true);
    expect(ofType(producer.heard, 'chat').some((m) => m.text === 'check-open')).toBe(true);

    host.ws.close();
    guest.ws.close();
    producer.ws.close();
    speaker.ws.close();
  });

  it('relays recording-stop from a guest without clearing the recording flag', async () => {
    const slug = 'rec-stop-gst';
    await seedRoom(slug, 'tok-rec-stop');
    const host = await enter(slug, 'H', { hostToken: 'tok-rec-stop' });
    const guest = await enter(slug, 'G');

    const recId = crypto.randomUUID();
    host.ws.send(started(recId));
    await until(() => ofType(guest.heard, 'recording-started').length > 0);

    guest.ws.send(JSON.stringify({ type: 'recording-stop', recordingId: recId }));
    await until(() => ofType(host.heard, 'recording-stop').length > 0);

    const relayed = ofType(host.heard, 'recording-stop')[0];
    expect(relayed).toMatchObject({
      type: 'recording-stop',
      recordingId: recId,
      from: 'guest',
    });

    const late = await enter(slug, 'L');
    expect(late.me.recording).toBe(true);

    host.ws.close();
    guest.ws.close();
    late.ws.close();
  });

  // Called on the instance, since over the wire a throw is only a log line.
  it('drops a frame that is not a JSON object without throwing', async () => {
    const slug = 'bad-fram-eaa';
    await seedRoom(slug, 'tok-bad-frame');
    const a = await enter(slug, 'A');
    const idle = await openWs(slug);
    await runInDurableObject(env.ROOM_DO.get(env.ROOM_DO.idFromName(slug)), async (instance, state) => {
      for (const ws of state.getWebSockets()) {
        for (const frame of ['null', '5', '"join"', '[]', 'true', '{}', '{"type":null}', '']) {
          await (instance as Room).webSocketMessage(ws, frame);
        }
        await (instance as Room).webSocketMessage(ws, new ArrayBuffer(4));
      }
    });
    a.ws.close();
    idle.close();
  });
});
