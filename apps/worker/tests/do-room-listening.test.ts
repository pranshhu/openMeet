import { describe, it, expect } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { ServerMessage } from '@openmeet/protocol';

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

/** Two guests in a room: `a` hears what `b` sends. */
async function pair(slug: string): Promise<{ a: WebSocket; b: WebSocket }> {
  await seedRoom(slug, `tok-${slug}`);
  const a = await openWs(slug);
  a.send(JSON.stringify({ type: 'join', displayName: 'A', userAgent: 'ua' }));
  await waitForMessage(a);
  const b = await openWs(slug);
  b.send(JSON.stringify({ type: 'join', displayName: 'B', userAgent: 'ua' }));
  await waitForMessage(b);
  await waitForMessage(a); // peer-joined
  return { a, b };
}

describe('Room DO: the lobby answer on recording-capability', () => {
  it('relays each of the three answers to the other peer', async () => {
    const { a, b } = await pair('lis-tena-aaa');
    for (const listening of ['headphones', 'speakers', 'speakers-ec']) {
      b.send(JSON.stringify({ type: 'recording-capability', mp4: true, wav: true, listening }));
      expect(await waitForMessage(a)).toMatchObject({
        type: 'recording-capability',
        mp4: true,
        wav: true,
        listening,
        from: 'guest',
      });
    }
    a.close();
    b.close();
  });

  it('drops an answer that is not one of the three, and still relays the rest', async () => {
    const { a, b } = await pair('lis-tena-bbb');
    for (const listening of ['Speakers', 'speakers-ec ', 'x'.repeat(5000), 1, true, null, { a: 1 }, ['speakers']]) {
      b.send(JSON.stringify({ type: 'recording-capability', mp4: true, wav: false, listening }));
      const relayed = await waitForMessage(a);
      expect(relayed).toMatchObject({ type: 'recording-capability', mp4: true, wav: false });
      expect('listening' in relayed).toBe(false);
    }
    a.close();
    b.close();
  });
});
