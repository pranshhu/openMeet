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

type RoleAssigned = ServerMessage & { type: 'role-assigned' };
type Outcome = { kind: 'role-assigned'; msg: RoleAssigned } | { kind: 'close'; code: number; reason: string };

function waitForRoleOrClose(ws: WebSocket): Promise<Outcome> {
  return new Promise((resolve) => {
    const onMsg = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string) as ServerMessage;
      if (msg.type === 'role-assigned') {
        cleanup();
        resolve({ kind: 'role-assigned', msg: msg as RoleAssigned });
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

/** Opens a socket, sends a join with these extra fields, and says how the Room answered. */
async function join(
  slug: string,
  extra: Record<string, unknown>,
  opened: WebSocket[]
): Promise<Outcome> {
  const ws = await openWs(slug);
  opened.push(ws);
  const outcome = waitForRoleOrClose(ws);
  ws.send(JSON.stringify({ type: 'join', displayName: `P${opened.length}`, userAgent: 'ua', ...extra }));
  return outcome;
}

async function joinAll(slug: string, count: number, extra: Record<string, unknown>, opened: WebSocket[]) {
  for (let i = 0; i < count; i++) {
    expect((await join(slug, extra, opened)).kind).toBe('role-assigned');
  }
}

const refused = { kind: 'close', code: 4001, reason: 'room_full' };

function closeAll(opened: WebSocket[]) {
  opened.forEach((w) => {
    try {
      w.close();
    } catch {
      // already gone
    }
  });
}

describe('Room DO: recorded seats when everyone joined with the microphone only', () => {
  it('seats eight audio-only people and refuses the ninth', async () => {
    const slug = 'aud-eigh-aaa';
    await seedRoom(slug, 'tok-aud-eight');
    const opened: WebSocket[] = [];
    await joinAll(slug, 8, { audioOnly: true }, opened);
    expect(await join(slug, { audioOnly: true }, opened)).toEqual(refused);
    closeAll(opened);
  });

  it('refuses a person with a camera as the fifth once four audio-only seats are taken', async () => {
    const slug = 'aud-camf-aaa';
    await seedRoom(slug, 'tok-aud-cam5');
    const opened: WebSocket[] = [];
    await joinAll(slug, 4, { audioOnly: true }, opened);
    expect(await join(slug, {}, opened)).toEqual(refused);
    closeAll(opened);
  });

  it('admits a person with a camera as the fourth, and then refuses an audio-only fifth', async () => {
    const slug = 'aud-camq-aaa';
    await seedRoom(slug, 'tok-aud-cam4');
    const opened: WebSocket[] = [];
    await joinAll(slug, 3, { audioOnly: true }, opened);
    expect((await join(slug, {}, opened)).kind).toBe('role-assigned');
    expect(await join(slug, { audioOnly: true }, opened)).toEqual(refused);
    closeAll(opened);
  });

  it.each([
    ['the string "true"', 'true', 'aud-bdst-aaa'],
    ['the number 1', 1, 'aud-bdnu-aaa'],
    ['an object', {}, 'aud-bdob-aaa'],
  ])(
    'treats audioOnly as %s as a seat with a camera',
    async (_label, value, slug) => {
      await seedRoom(slug, `tok-${slug}`);
      const opened: WebSocket[] = [];
      await joinAll(slug, 4, { audioOnly: true }, opened);
      expect(await join(slug, { audioOnly: value }, opened)).toEqual(refused);
      closeAll(opened);
    }
  );

  it('keeps two producer slots beside eight audio-only seats and refuses a third unrecorded join', async () => {
    const slug = 'aud-prod-aaa';
    await seedRoom(slug, 'tok-aud-prod');
    const opened: WebSocket[] = [];
    await joinAll(slug, 8, { audioOnly: true }, opened);
    const first = await join(slug, { producer: true }, opened);
    const second = await join(slug, { producer: true }, opened);
    expect(first.kind === 'role-assigned' && first.msg.role).toBe('producer');
    expect(second.kind === 'role-assigned' && second.msg.role).toBe('producer');
    expect(await join(slug, { producer: true }, opened)).toEqual(refused);
    closeAll(opened);
  });

  it('ignores audioOnly on a producer and on a companion', async () => {
    const slug = 'aud-igno-aaa';
    await seedRoom(slug, 'tok-aud-ign');
    const opened: WebSocket[] = [];
    await joinAll(slug, 4, {}, opened);
    const producer = await join(slug, { producer: true, audioOnly: true }, opened);
    expect(producer.kind === 'role-assigned' && producer.msg.role).toBe('producer');
    const companion = await join(slug, { companion: true, audioOnly: true }, opened);
    expect(companion.kind).toBe('role-assigned');
    // Neither took a recorded seat, and neither is an audio-only seat that could lift the cap.
    expect(await join(slug, { audioOnly: true }, opened)).toEqual(refused);
    closeAll(opened);
  });

  it('does not count a producer or a companion as a seat with a camera', async () => {
    const slug = 'aud-unrc-aaa';
    await seedRoom(slug, 'tok-aud-unrc');
    const opened: WebSocket[] = [];
    await joinAll(slug, 5, { audioOnly: true }, opened);
    expect((await join(slug, { producer: true }, opened)).kind).toBe('role-assigned');
    expect((await join(slug, { companion: true }, opened)).kind).toBe('role-assigned');
    expect((await join(slug, { audioOnly: true }, opened)).kind).toBe('role-assigned');
    closeAll(opened);
  });

  it('admits a reconnect with the client id of a seat in a full room of eight', async () => {
    const slug = 'aud-reco-aaa';
    await seedRoom(slug, 'tok-aud-reco');
    const opened: WebSocket[] = [];
    for (let i = 0; i < 8; i++) {
      expect((await join(slug, { audioOnly: true, clientId: `cid-${i}` }, opened)).kind).toBe('role-assigned');
    }
    const oldClosed = new Promise<{ code: number; reason: string }>((resolve) => {
      opened[7]!.addEventListener('close', (e) => resolve({ code: (e as CloseEvent).code, reason: (e as CloseEvent).reason }));
    });
    const again = await join(slug, { audioOnly: true, clientId: 'cid-7' }, opened);
    expect(again.kind).toBe('role-assigned');
    expect(await oldClosed).toEqual({ code: 4006, reason: 'replaced' });
    expect(await join(slug, { audioOnly: true, clientId: 'cid-other' }, opened)).toEqual(refused);
    closeAll(opened);
  });

  it('does not admit two concurrent audio-only joins into a room of seven', async () => {
    const slug = 'aud-conc-aaa';
    await seedRoom(slug, 'tok-aud-conc');
    const opened: WebSocket[] = [];
    await joinAll(slug, 7, { audioOnly: true }, opened);
    const a = await openWs(slug);
    const b = await openWs(slug);
    opened.push(a, b);
    const outcomes = Promise.all([waitForRoleOrClose(a), waitForRoleOrClose(b)]);
    a.send(JSON.stringify({ type: 'join', displayName: 'A', userAgent: 'ua', audioOnly: true }));
    b.send(JSON.stringify({ type: 'join', displayName: 'B', userAgent: 'ua', audioOnly: true }));
    const results = await outcomes;
    expect(results.filter((r) => r.kind === 'role-assigned')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'close' && r.code === 4001)).toHaveLength(1);
    closeAll(opened);
  });
});
