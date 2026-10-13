import { describe, it, expect } from 'vitest';
import { titleFrom, MAX_TITLE_LENGTH } from '../src/index.js';

describe('titleFrom', () => {
  it('keeps a plain text', () => {
    expect(titleFrom('Founder, Acme')).toBe('Founder, Acme');
  });

  it('trims the padding', () => {
    expect(titleFrom('  Founder \n')).toBe('Founder');
  });

  it('accepts 60 units and drops 61, never cutting', () => {
    expect(MAX_TITLE_LENGTH).toBe(60);
    expect(titleFrom('a'.repeat(60))).toBe('a'.repeat(60));
    expect(titleFrom('a'.repeat(61))).toBe('');
  });

  it('measures the trimmed text', () => {
    expect(titleFrom(`  ${'a'.repeat(60)}  `)).toBe('a'.repeat(60));
  });

  it('gives nothing for a blank text', () => {
    expect(titleFrom('')).toBe('');
    expect(titleFrom('   ')).toBe('');
  });

  it('gives nothing for anything that is not a string', () => {
    expect(titleFrom(42)).toBe('');
    expect(titleFrom({ toString: () => 'x' })).toBe('');
    expect(titleFrom(['x'])).toBe('');
    expect(titleFrom(null)).toBe('');
    expect(titleFrom(undefined)).toBe('');
  });
});
