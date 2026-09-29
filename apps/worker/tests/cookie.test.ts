import { describe, it, expect } from 'vitest';
import {
  serializeHostTokenCookie,
  parseHostTokenCookie,
} from '../src/lib/cookie.js';

describe('cookie helpers', () => {
  it('serializes a cookie with required attributes', () => {
    const c = serializeHostTokenCookie('xyz-abcd-pqr', 'abc123', { secure: true });
    expect(c).toContain('host_token__xyz-abcd-pqr=abc123');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Secure');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Path=/');
  });

  it('omits Secure flag when dev', () => {
    const c = serializeHostTokenCookie('xyz-abcd-pqr', 'abc123', { secure: false });
    expect(c).not.toContain('Secure');
  });

  it('parses host_token cookie by slug', () => {
    const header = 'foo=bar; host_token__xyz-abcd-pqr=abc123; other=xx';
    expect(parseHostTokenCookie(header, 'xyz-abcd-pqr')).toEqual('abc123');
  });

  it('returns null when cookie absent', () => {
    expect(parseHostTokenCookie('foo=bar', 'xyz-abcd-pqr')).toBeNull();
    expect(parseHostTokenCookie(null, 'xyz-abcd-pqr')).toBeNull();
  });

  it('does not return cookie for different slug', () => {
    const header = 'host_token__aaa-bbbb-ccc=xyz';
    expect(parseHostTokenCookie(header, 'xyz-abcd-pqr')).toBeNull();
  });
});
