import { describe, it, expect } from 'vitest';
import { generateHostToken } from '../src/lib/token.js';

describe('host token', () => {
  it('produces a 64-char hex string', () => {
    const t = generateHostToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces distinct tokens', () => {
    const a = generateHostToken();
    const b = generateHostToken();
    expect(a).not.toEqual(b);
  });
});
