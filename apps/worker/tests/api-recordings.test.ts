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

  it('rejects PATCH without host token with 401 and leaves the row unchanged', async () => {
    const slug = 'no-tok-pat';
    const tok = 'tok-no-patch';
    const recId = await seedRecording(slug, tok);

    const checkRow = async () =>
      (await env.DB.prepare('SELECT total_bytes, last_offset, sha256, status, finalized_at FROM recordings WHERE id = ?')
        .bind(recId)
        .first())!;
    const initial = await checkRow();

    const res = await SELF.fetch(`https://test/api/recordings/${recId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ last_offset: 1024, total_bytes: 1024, status: 'finalized' }),
    });
    expect(res.status).toBe(401);
    expect(await checkRow()).toEqual(initial);
  });

  it('rejects PATCH with wrong token with 401 and leaves the row unchanged', async () => {
    const slug = 'wrg-tok-pat';
    const tok = 'tok-wrg-patch';
    const recId = await seedRecording(slug, tok);

    const checkRow = async () =>
      (await env.DB.prepare('SELECT total_bytes, last_offset, sha256, status, finalized_at FROM recordings WHERE id = ?')
        .bind(recId)
        .first())!;
    const initial = await checkRow();

    const res = await SELF.fetch(`https://test/api/recordings/${recId}`, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer wrong-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ last_offset: 1024, total_bytes: 1024, status: 'finalized' }),
    });
    expect(res.status).toBe(401);
    expect(await checkRow()).toEqual(initial);
  });

  it('rejects invalid fields with 400 and leaves the row unchanged', async () => {
    const slug = 'val-fail-xxx';
    const tok = 'tok-val-fail';
    const recId = await seedRecording(slug, tok);

    const checkRow = async () =>
      (await env.DB.prepare('SELECT total_bytes, last_offset, sha256, status, finalized_at FROM recordings WHERE id = ?')
        .bind(recId)
        .first<{
          total_bytes: number;
          last_offset: number;
          sha256: string | null;
          status: string;
          finalized_at: number | null;
        }>())!;

    const initial = await checkRow();
    expect(initial).toMatchObject({
      total_bytes: 0,
      last_offset: 0,
      sha256: null,
      status: 'recording',
      finalized_at: null,
    });

    const invalidBodies = [
      { total_bytes: -1 },
      { total_bytes: 1.5 },
      { last_offset: -1 },
      { last_offset: 2.5 },
      { sha256: 'a'.repeat(65) },
      { sha256: 123 },
      { status: 'unknown' },
      { total_bytes: 10, last_offset: 10, sha256: 'a'.repeat(65) },
      { total_bytes: 10, status: 'unknown' },
    ];

    for (const body of invalidBodies) {
      const res = await SELF.fetch(`https://test/api/recordings/${recId}`, {
        method: 'PATCH',
        headers: {
          Cookie: `host_token__${slug}=${tok}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error?: string };
      expect(json.error).toBe('invalid_field');
      expect(await checkRow()).toEqual(initial);
    }
  });

  it('stamps finalized_at with Date.now() when status is set to finalized', async () => {
    const slug = 'fin-stam-xxx';
    const tok = 'tok-fin-stamp';
    const recId = await seedRecording(slug, tok);
    const before = Date.now();

    const res = await SELF.fetch(`https://test/api/recordings/${recId}`, {
      method: 'PATCH',
      headers: {
        Cookie: `host_token__${slug}=${tok}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ status: 'finalized', finalized_at: 123456789 }),
    });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare('SELECT status, finalized_at FROM recordings WHERE id = ?')
      .bind(recId)
      .first<{ status: string; finalized_at: number }>();
    expect(row?.status).toBe('finalized');
    expect(typeof row?.finalized_at).toBe('number');
    expect(row!.finalized_at).not.toBe(123456789);
    expect(row!.finalized_at).toBeGreaterThanOrEqual(before);
    expect(row!.finalized_at).toBeLessThanOrEqual(Date.now());
  });

  it('leaves finalized_at null when status is recording', async () => {
    const slug = 'rec-fina-xxx';
    const tok = 'tok-rec-final';
    const recId = await seedRecording(slug, tok);

    const res = await SELF.fetch(`https://test/api/recordings/${recId}`, {
      method: 'PATCH',
      headers: {
        Cookie: `host_token__${slug}=${tok}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ status: 'recording' }),
    });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare('SELECT status, finalized_at FROM recordings WHERE id = ?')
      .bind(recId)
      .first<{ status: string; finalized_at: number | null }>();
    expect(row?.status).toBe('recording');
    expect(row?.finalized_at).toBeNull();
  });

  it('does not store client-supplied finalized_at', async () => {
    const slug = 'ign-fina-xxx';
    const tok = 'tok-ign-final';
    const recId = await seedRecording(slug, tok);

    const res = await SELF.fetch(`https://test/api/recordings/${recId}`, {
      method: 'PATCH',
      headers: {
        Cookie: `host_token__${slug}=${tok}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ finalized_at: 123456789 }),
    });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare('SELECT finalized_at FROM recordings WHERE id = ?')
      .bind(recId)
      .first<{ finalized_at: number | null }>();
    expect(row?.finalized_at).toBeNull();
  });

  it('returns 200 and changes nothing when request has no recognised fields', async () => {
    const slug = 'no-reco-xxx';
    const tok = 'tok-no-reco';
    const recId = await seedRecording(slug, tok);

    const before = await env.DB.prepare('SELECT total_bytes, last_offset, sha256, status, finalized_at FROM recordings WHERE id = ?')
      .bind(recId)
      .first();

    const res = await SELF.fetch(`https://test/api/recordings/${recId}`, {
      method: 'PATCH',
      headers: {
        Cookie: `host_token__${slug}=${tok}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ unrecognised: 'foo', another: 123 }),
    });
    expect(res.status).toBe(200);

    const after = await env.DB.prepare('SELECT total_bytes, last_offset, sha256, status, finalized_at FROM recordings WHERE id = ?')
      .bind(recId)
      .first();
    expect(after).toEqual(before);
  });

  it('returns 200 and changes nothing when body is null', async () => {
    const slug = 'nul-body-xxx';
    const tok = 'tok-null-body';
    const recId = await seedRecording(slug, tok);

    const before = await env.DB.prepare('SELECT total_bytes, last_offset, sha256, status, finalized_at FROM recordings WHERE id = ?')
      .bind(recId)
      .first();

    const res = await SELF.fetch(`https://test/api/recordings/${recId}`, {
      method: 'PATCH',
      headers: {
        Cookie: `host_token__${slug}=${tok}`,
        'content-type': 'application/json',
      },
      body: 'null',
    });
    expect(res.status).toBe(200);

    const after = await env.DB.prepare('SELECT total_bytes, last_offset, sha256, status, finalized_at FROM recordings WHERE id = ?')
      .bind(recId)
      .first();
    expect(after).toEqual(before);
  });
});
