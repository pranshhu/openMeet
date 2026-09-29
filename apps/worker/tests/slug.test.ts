import { describe, it, expect } from 'vitest';
import { generateSlug, isValidSlugFormat } from '../src/lib/slug.js';

describe('slug', () => {
  it('generates a slug matching the canonical pattern', () => {
    const s = generateSlug();
    expect(s).toMatch(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  });

  it('generates distinct slugs across many invocations', () => {
    const set = new Set<string>();
    for (let i = 0; i < 1000; i++) set.add(generateSlug());
    expect(set.size).toBeGreaterThan(990);
  });

  it('validates known-good slugs', () => {
    expect(isValidSlugFormat('xyz-abcd-pqr')).toBe(true);
    expect(isValidSlugFormat('aaa-bbbb-ccc')).toBe(true);
  });

  it('rejects malformed slugs', () => {
    expect(isValidSlugFormat('xyz-abc-pqr')).toBe(false);
    expect(isValidSlugFormat('XYZ-ABCD-PQR')).toBe(false);
    expect(isValidSlugFormat('xyz_abcd_pqr')).toBe(false);
    expect(isValidSlugFormat('')).toBe(false);
    expect(isValidSlugFormat('xyz-abcd-pqr-extra')).toBe(false);
  });
});
