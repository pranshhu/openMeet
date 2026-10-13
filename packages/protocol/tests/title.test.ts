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

  it('turns line breaks and other control characters into one space', () => {
    expect(titleFrom('a\nb')).toBe('a b');
    expect(titleFrom('a\r\n\tb')).toBe('a b');
    expect(titleFrom('a\u2028b\u2029c')).toBe('a b c');
  });

  it('gives nothing for a text with no visible character', () => {
    expect(titleFrom('\u200b')).toBe('');
    expect(titleFrom('\u202e')).toBe('');
    expect(titleFrom(' \u200b \u202e\u200b ')).toBe('');
    expect(titleFrom('\n\t')).toBe('');
  });

  it('keeps a format character inside a title that has visible characters', () => {
    expect(titleFrom('a\u200db')).toBe('a\u200db');
  });

  it('judges the length of the cleaned text', () => {
    const half = 'a'.repeat(29);
    expect(titleFrom(`${half}\n\n\n${half}`)).toBe(`${half} ${half}`);
    const full = `${'a'.repeat(30)}\n${'a'.repeat(29)}`;
    expect(titleFrom(full)).toBe(`${'a'.repeat(30)} ${'a'.repeat(29)}`);
    expect(titleFrom(`${'a'.repeat(30)}\n${'a'.repeat(30)}`)).toBe('');
  });
});
