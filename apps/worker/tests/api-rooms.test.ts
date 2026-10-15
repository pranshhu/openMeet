import { describe, it, expect, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import app from '../src/index.js';
import { isValidSlugFormat } from '../src/lib/slug.js';
import { getRoomBySlug, insertRoom } from '../src/db/queries.js';

describe('POST /api/rooms', () => {
  it('creates a room and sets host_token cookie', async () => {
    const res = await SELF.fetch('https://test/api/rooms', {
      method: 'POST',
      headers: { Origin: env.PAGES_ORIGIN },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { slug: string; host_token: string; expires_at: number };
    expect(isValidSlugFormat(body.slug)).toBe(true);
    expect(typeof body.expires_at).toBe('number');
    // host_token is returned in the body (cross-origin host auth) and as a cookie.
    expect(body.host_token).toMatch(/^[0-9a-f]{64}$/);

    const setCookie = res.headers.get('Set-Cookie');
    expect(setCookie).toContain(`host_token__${body.slug}=${body.host_token}`);
    expect(setCookie).toContain('HttpOnly');
  });

  it('persists the row in D1', async () => {
    const res = await SELF.fetch('https://test/api/rooms', { method: 'POST' });
    const { slug } = (await res.json()) as { slug: string };
    const row = await env.DB.prepare('SELECT * FROM rooms WHERE slug = ?').bind(slug).first();
    expect(row).not.toBeNull();
  });
});

describe('GET /api/rooms/:slug', () => {
  it('returns 404 for unknown slug', async () => {
    const res = await SELF.fetch('https://test/api/rooms/nop-nopq-rst');
    expect(res.status).toBe(404);
  });

  it('includes CORS headers on a 404 error response (regression: /api/rooms/placeholder)', async () => {
    const res = await SELF.fetch('https://test/api/rooms/placeholder', {
      headers: { Origin: env.PAGES_ORIGIN },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(env.PAGES_ORIGIN);
  });

  it('returns room metadata for valid slug', async () => {
    const create = await SELF.fetch('https://test/api/rooms', { method: 'POST' });
    const { slug } = (await create.json()) as { slug: string };
    const res = await SELF.fetch(`https://test/api/rooms/${slug}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string; consumed: number };
    expect(body.slug).toBe(slug);
    expect(body.consumed).toBe(0);
  });

  it('returns 404 for expired slug', async () => {
    await env.DB.prepare(
      'INSERT INTO rooms (slug, host_token, created_at, expires_at, consumed) VALUES (?, ?, ?, ?, 0)'
    )
      .bind('exp-irex-pir', 'tok', 1000, 2000)
      .run();
    const res = await SELF.fetch('https://test/api/rooms/exp-irex-pir');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/rooms rate limit', () => {
  it('returns 429 rate_limited when limiter returns success: false and 201 when success: true', async () => {
    const limitedRes = await app.fetch(
      new Request('https://test/api/rooms', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '198.51.100.99' },
      }),
      {
        ...env,
        ROOM_CREATE_LIMITER: {
          limit: async () => ({ success: false }),
        },
      }
    );
    expect(limitedRes.status).toBe(429);
    expect(await limitedRes.json()).toEqual({ error: 'rate_limited' });

    const okRes = await app.fetch(
      new Request('https://test/api/rooms', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '198.51.100.99' },
      }),
      {
        ...env,
        ROOM_CREATE_LIMITER: {
          limit: async () => ({ success: true }),
        },
      }
    );
    expect(okRes.status).toBe(201);
  });

  it('rate limits after 10 requests from same IP using miniflare native binding', async () => {
    const post = (from: string) =>
      SELF.fetch('https://test/api/rooms', { method: 'POST', headers: { 'CF-Connecting-IP': from } });
    // The limiter counts in fixed 60-second windows, so eleven requests in a row
    // can straddle a window edge and all be let through. Within twenty-one, one
    // window holds eleven of them.
    let limited: Response | undefined;
    let sent = 0;
    while (!limited && sent < 21) {
      const r = await post('198.51.100.42');
      sent += 1;
      if (r.status === 429) limited = r;
      else expect(r.status).toBe(201);
    }
    // Never before the eleventh, and always by the twenty-first.
    expect(sent).toBeGreaterThanOrEqual(11);
    expect(limited?.status).toBe(429);
    expect(await limited!.json()).toEqual({ error: 'rate_limited' });

    const other = await post('198.51.100.43');
    expect(other.status).toBe(201);
  });

  it('returns 201 when ROOM_CREATE_LIMITER is not present on env', async () => {
    const { ROOM_CREATE_LIMITER: _, ...envWithoutLimiter } = env;
    const res = await app.fetch(
      new Request('https://test/api/rooms', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '198.51.100.99' },
      }),
      envWithoutLimiter as unknown as typeof env
    );
    expect(res.status).toBe(201);
  });
});

describe('POST /api/rooms with a chosen name', () => {
  const post = (body: unknown, ip: string, raw = false) =>
    SELF.fetch('https://test/api/rooms', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': ip, 'content-type': 'application/json' },
      body: raw ? (body as string) : JSON.stringify(body),
    });
  const rowFor = (slug: string) =>
    env.DB.prepare('SELECT * FROM rooms WHERE slug = ?').bind(slug).first<{ host_token: string }>();

  it('creates the room under that name, with a host token cookie and a row', async () => {
    const res = await post({ name: 'my-show' }, '203.0.113.1');
    expect(res.status).toBe(201);
    const body = (await res.json()) as { slug: string; host_token: string; expires_at: number };
    expect(body.slug).toBe('my-show');
    expect(res.headers.get('Set-Cookie')).toContain(`host_token__my-show=${body.host_token}`);
    expect((await rowFor('my-show'))?.host_token).toBe(body.host_token);
  });

  it('answers 409 name_taken for the same name again and leaves the row alone', async () => {
    const first = await post({ name: 'taken-show' }, '203.0.113.2');
    const { host_token } = (await first.json()) as { host_token: string };
    const again = await post({ name: 'taken-show' }, '203.0.113.3');
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'name_taken' });
    expect((await rowFor('taken-show'))?.host_token).toBe(host_token);
  });

  it('answers 409 for a name whose room expired', async () => {
    await env.DB.prepare(
      'INSERT INTO rooms (slug, host_token, created_at, expires_at, consumed) VALUES (?, ?, ?, ?, 0)'
    )
      .bind('old-show', 'old-tok', 1000, 2000)
      .run();
    const res = await post({ name: 'old-show' }, '203.0.113.4');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'name_taken' });
    expect((await rowFor('old-show'))?.host_token).toBe('old-tok');
  });

  it('gives one of two simultaneous requests for a free name the room and the other a 409', async () => {
    const [a, b] = await Promise.all([
      post({ name: 'race-show' }, '203.0.113.5'),
      post({ name: 'race-show' }, '203.0.113.6'),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const winner = (await (a.status === 201 ? a : b).json()) as { host_token: string };
    expect((await rowFor('race-show'))?.host_token).toBe(winner.host_token);
  });

  it('refuses a name that is not a name with 400 invalid_name and writes nothing', async () => {
    const bad: unknown[] = ['ab', 'a'.repeat(33), 'My-Show', '-show', 'show-', 'my_show', 'my show', '../x', '', 42, null, ['my-show'], 'abc-defg-hij'];
    for (const [i, name] of bad.entries()) {
      const res = await post({ name }, `203.0.113.${10 + i}`);
      expect(res.status, JSON.stringify(name)).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_name' });
    }
    expect(await env.DB.prepare('SELECT 1 FROM rooms WHERE slug IN (?, ?)').bind('abc-defg-hij', 'my_show').first()).toBeNull();
  });

  it('makes a random slug when the body is missing, not JSON, or has no name', async () => {
    const none = await SELF.fetch('https://test/api/rooms', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '203.0.113.30' },
    });
    const notJson = await post('{nope', '203.0.113.31', true);
    const empty = await post({}, '203.0.113.32');
    for (const res of [none, notJson, empty]) {
      expect(res.status).toBe(201);
      expect(((await res.json()) as { slug: string }).slug).toMatch(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
    }
  });

  it('spends the same rate limit slot, and checks it before the name', async () => {
    let limited: Response | undefined;
    let sent = 0;
    while (!limited && sent < 21) {
      const r = await post({ name: sent === 0 ? 'rate-show' : 'Bad Name' }, '203.0.113.40');
      sent += 1;
      if (r.status === 429) limited = r;
    }
    expect(sent).toBeGreaterThanOrEqual(11);
    expect(limited?.status).toBe(429);
    expect(await limited!.json()).toEqual({ error: 'rate_limited' });
  });

  it('serves a named room through the room, turn credential and socket routes', async () => {
    await post({ name: 'route-show' }, '203.0.113.41');
    expect((await SELF.fetch('https://test/api/rooms/route-show')).status).toBe(200);
    const turn = await SELF.fetch('https://test/api/turn-cred', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'route-show' }),
    });
    expect(turn.status).toBe(200);
    const ws = await SELF.fetch('https://test/ws/r/route-show', { headers: { Upgrade: 'websocket' } });
    expect(ws.status).toBe(101);
    ws.webSocket!.accept();
    ws.webSocket!.close();
  });
});

describe('insertRoom', () => {
  it('resolves true for a new slug and false for one that exists, leaving the row alone', async () => {
    const row = { slug: 'ins-room', host_token: 'first', created_at: 1, expires_at: 2 };
    expect(await insertRoom(env.DB, row)).toBe(true);
    expect(await insertRoom(env.DB, { ...row, host_token: 'second' })).toBe(false);
    expect((await getRoomBySlug(env.DB, 'ins-room'))?.host_token).toBe('first');
  });
});

describe('POST /api/rooms random slug collisions', () => {
  // The three letter groups of a slug are drawn in arrays shorter than a token.
  const zeroLetters = (limit: number) => {
    const real = crypto.getRandomValues.bind(crypto);
    let drawn = 0;
    return vi.spyOn(crypto, 'getRandomValues').mockImplementation(((a: Uint8Array) => {
      if (a.length < 32 && drawn < limit) {
        drawn += 1;
        return a.fill(0);
      }
      return real(a);
    }) as typeof crypto.getRandomValues);
  };
  const create = (ip: string) =>
    app.fetch(new Request('https://test/api/rooms', { method: 'POST', headers: { 'CF-Connecting-IP': ip } }), env);

  it('draws another slug when the first is taken', async () => {
    await insertRoom(env.DB, { slug: 'aaa-aaaa-aaa', host_token: 'held', created_at: 1, expires_at: 2 });
    const spy = zeroLetters(3);
    try {
      const res = await create('203.0.113.60');
      expect(res.status).toBe(201);
      const { slug } = (await res.json()) as { slug: string };
      expect(slug).not.toBe('aaa-aaaa-aaa');
      expect((await getRoomBySlug(env.DB, 'aaa-aaaa-aaa'))?.host_token).toBe('held');
    } finally {
      spy.mockRestore();
    }
  });

  it('answers 503 slug_exhausted after five taken slugs', async () => {
    await insertRoom(env.DB, { slug: 'aaa-aaaa-aaa', host_token: 'held', created_at: 1, expires_at: 2 });
    const spy = zeroLetters(15);
    try {
      const res = await create('203.0.113.61');
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'slug_exhausted' });
    } finally {
      spy.mockRestore();
    }
  });
});
