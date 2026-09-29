import { describe, it, expect } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import app from '../src/index.js';
import { isValidSlugFormat } from '../src/lib/slug.js';

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
    const ip = '198.51.100.42';
    for (let i = 0; i < 10; i++) {
      const r = await SELF.fetch('https://test/api/rooms', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': ip },
      });
      expect(r.status).toBe(201);
    }
    const r11 = await SELF.fetch('https://test/api/rooms', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': ip },
    });
    expect(r11.status).toBe(429);
    expect(await r11.json()).toEqual({ error: 'rate_limited' });

    const other = await SELF.fetch('https://test/api/rooms', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '198.51.100.43' },
    });
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
