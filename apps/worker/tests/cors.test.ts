import { describe, it, expect } from 'vitest';
import { corsHeaders, handlePreflight } from '../src/lib/cors.js';

describe('cors', () => {
  const origin = 'http://localhost:3000';

  it('returns headers when origin matches allow-list', () => {
    const h = corsHeaders('http://localhost:3000', origin);
    expect(h['Access-Control-Allow-Origin']).toBe(origin);
    expect(h['Access-Control-Allow-Credentials']).toBe('true');
    expect(h['Vary']).toContain('Origin');
  });

  it('returns empty headers when origin not allowed', () => {
    const h = corsHeaders('http://localhost:3000', 'https://evil.example');
    expect(Object.keys(h)).toEqual([]);
  });

  it('handles preflight returning 204', () => {
    const req = new Request('https://api.example/api/rooms', {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
    });
    const res = handlePreflight(req, origin);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(204);
    expect(res!.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(res!.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    // Authorization must be allowed so cross-origin Bearer PATCH /api/recordings works.
    expect(res!.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain('authorization');
  });

  it('returns null on non-OPTIONS', () => {
    const req = new Request('https://api.example/api/rooms', { method: 'GET' });
    expect(handlePreflight(req, origin)).toBeNull();
  });
});
