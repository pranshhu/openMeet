import { describe, it, expect } from 'vitest';
import { SELF, env } from 'cloudflare:test';

async function seedRecording(slug: string, hostToken: string): Promise<string> {
  const sessionId = crypto.randomUUID();
  const partId = crypto.randomUUID();
  const recId = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO rooms (slug, host_token, created_at, expires_at, consumed) VALUES (?, ?, ?, ?, 1)'
  )
    .bind(slug, hostToken, Date.now(), Date.now() + 3_600_000)
    .run();
  await env.DB.prepare('INSERT INTO sessions (id, room_slug, started_at) VALUES (?, ?, ?)')
    .bind(sessionId, slug, Date.now())
    .run();
  await env.DB.prepare(
    'INSERT INTO participants (id, session_id, role, display_name, joined_at) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(partId, sessionId, 'guest', 'G', Date.now())
    .run();
  await env.DB.prepare(
    'INSERT INTO recordings (id, session_id, participant_id, kind, filename, total_bytes, last_offset, status, started_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)'
  )
    .bind(recId, sessionId, partId, 'camera', 'guest.mp4', 'recording', Date.now())
    .run();
  return recId;
}

describe('GET /api/recordings/:id', () => {
  it('returns 401 without host_token cookie', async () => {
    const recId = await seedRecording('aaa-bbbb-ccc', 'tok123');
    const res = await SELF.fetch(`https://test/api/recordings/${recId}`);
    expect(res.status).toBe(401);
  });

  it('returns resume metadata with valid cookie', async () => {
    const recId = await seedRecording('ddd-eeee-fff', 'tok-xyz');
    const res = await SELF.fetch(`https://test/api/recordings/${recId}`, {
      headers: { Cookie: 'host_token__ddd-eeee-fff=tok-xyz' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { last_offset: number; status: string };
    expect(body.last_offset).toBe(0);
    expect(body.status).toBe('recording');
  });

  it('authorizes via Authorization: Bearer host_token (cross-origin path)', async () => {
    const recId = await seedRecording('jjj-kkkk-lll', 'tok-bearer');
    const res = await SELF.fetch(`https://test/api/recordings/${recId}`, {
      headers: { Authorization: 'Bearer tok-bearer' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects a wrong Bearer token with 401', async () => {
    const recId = await seedRecording('mmm-nnnn-ooo', 'tok-real');
    const res = await SELF.fetch(`https://test/api/recordings/${recId}`, {
      headers: { Authorization: 'Bearer tok-wrong' },
    });
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/recordings/:id', () => {
  it('updates last_offset with valid cookie', async () => {
    const recId = await seedRecording('ggg-hhhh-iii', 'tok-aaa');
    const res = await SELF.fetch(`https://test/api/recordings/${recId}`, {
      method: 'PATCH',
      headers: {
        Cookie: 'host_token__ggg-hhhh-iii=tok-aaa',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ last_offset: 1024, total_bytes: 1024 }),
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT last_offset FROM recordings WHERE id = ?')
      .bind(recId)
      .first<{ last_offset: number }>();
    expect(row?.last_offset).toBe(1024);
  });
});
