import { describe, it, expect } from 'vitest';
import { SELF, env } from 'cloudflare:test';

describe('worker smoke', () => {
  it('GET /api/health returns ok', async () => {
    const res = await SELF.fetch('https://test/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('unknown path returns 404', async () => {
    const res = await SELF.fetch('https://test/no-such-route');
    expect(res.status).toBe(404);
  });

  // Derived from the configured PAGES_ORIGIN rather than hardcoded. The previous
  // version asserted 'http://localhost:3000' on both sides and so only passed
  // while that happened to be the configured value — it was testing the config,
  // not the behaviour, and went red the moment the deploy default changed.
  it('CORS preflight returns 204 and allows the configured origin', async () => {
    const allowed = env.PAGES_ORIGIN;
    expect(allowed, 'PAGES_ORIGIN must be configured').toBeTruthy();
    const res = await SELF.fetch('https://test/api/rooms', {
      method: 'OPTIONS',
      headers: { Origin: allowed, 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(allowed);
  });

  // The property that actually matters: CORS here is strict single-origin, and
  // nothing covered the rejection path.
  it('CORS preflight refuses any other origin', async () => {
    const res = await SELF.fetch('https://test/api/rooms', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
