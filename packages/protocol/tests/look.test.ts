import { describe, it, expect } from 'vitest';
import { LOGO_MAX_PX, MAX_LOGO_LENGTH } from '../src/constants.js';
import { LOOK_ACCENTS, isClientMessage, isLogo, isLookAccent, isServerMessage } from '../src/ws-messages.js';

describe('look', () => {
  it('is a known type on the client and the server union', () => {
    expect(isClientMessage({ type: 'look', accent: 'red' })).toBe(true);
    expect(isClientMessage({ type: 'look' })).toBe(true);
    expect(isServerMessage({ type: 'look', accent: 'red' })).toBe(true);
    expect(isServerMessage({ type: 'look' })).toBe(true);
  });

  it('knows its six accent codes and nothing else', () => {
    expect([...LOOK_ACCENTS]).toEqual(['blue', 'red', 'green', 'yellow', 'purple', 'pink']);
    for (const code of LOOK_ACCENTS) expect(isLookAccent(code)).toBe(true);
    for (const v of ['orange', 'url(x)', '', 'RED', ' red', 7, null, undefined, {}, ['red']]) {
      expect(isLookAccent(v)).toBe(false);
    }
  });
});

describe('isLogo', () => {
  const PREFIX = 'data:image/png;base64,';
  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  // The first 24 bytes of a PNG: signature, the IHDR chunk header, width, height.
  function logo(width: number, height: number, signature = SIGNATURE): string {
    const head = [...signature, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(width), ...be32(height)];
    return PREFIX + Buffer.from(head).toString('base64') + 'AAAA';
  }
  const ONE_BY_ONE =
    PREFIX +
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  it('accepts a real 1 by 1 PNG, and a header at the largest size', () => {
    expect(isLogo(ONE_BY_ONE)).toBe(true);
    expect(isLogo(logo(LOGO_MAX_PX, LOGO_MAX_PX))).toBe(true);
    expect(isLogo(logo(1, LOGO_MAX_PX))).toBe(true);
  });

  it('refuses anything that is not a string, without throwing', () => {
    for (const v of [7, null, undefined, {}, ['x'], true, Symbol('x')]) expect(isLogo(v)).toBe(false);
  });

  it('refuses another type of picture, a character outside base64 and bytes that are no PNG', () => {
    expect(isLogo(ONE_BY_ONE.replace('image/png', 'image/svg+xml'))).toBe(false);
    expect(isLogo(ONE_BY_ONE.replace('image/png', 'image/jpeg'))).toBe(false);
    expect(isLogo(ONE_BY_ONE.replace('image/png', 'image/gif'))).toBe(false);
    expect(isLogo(PREFIX.toUpperCase() + ONE_BY_ONE.slice(PREFIX.length))).toBe(false);
    expect(isLogo('https://example.com/a.png')).toBe(false);
    expect(isLogo(PREFIX)).toBe(false);
    expect(isLogo(PREFIX + 'A')).toBe(false);
    expect(isLogo(ONE_BY_ONE + '"')).toBe(false);
    expect(isLogo(ONE_BY_ONE.slice(0, 40) + '!' + ONE_BY_ONE.slice(41))).toBe(false);
    expect(isLogo(ONE_BY_ONE.slice(0, 40) + '=' + ONE_BY_ONE.slice(41))).toBe(false);
    expect(isLogo(ONE_BY_ONE + '=')).toBe(false);
    const cut = Buffer.from(Buffer.from(logo(1, 1).slice(PREFIX.length), 'base64').subarray(0, 22));
    expect(cut.toString('base64')).toHaveLength(32);
    expect(isLogo(PREFIX + cut.toString('base64'))).toBe(false);
    expect(isLogo(logo(1, 1, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b]))).toBe(false);
    expect(isLogo(PREFIX + 'iVBORw0KGgo=')).toBe(false);
    const notIhdr = Buffer.from(Buffer.from(logo(1, 1).slice(PREFIX.length), 'base64'));
    notIhdr[12] = 0x58;
    expect(isLogo(PREFIX + notIhdr.toString('base64') + 'AAAA')).toBe(false);
    const shortChunk = Buffer.from(Buffer.from(logo(1, 1).slice(PREFIX.length), 'base64'));
    shortChunk[11] = 12;
    expect(isLogo(PREFIX + shortChunk.toString('base64') + 'AAAA')).toBe(false);
  });

  it('refuses a header that says too wide, too high, empty or enormous', () => {
    expect(isLogo(logo(LOGO_MAX_PX + 1, 1))).toBe(false);
    expect(isLogo(logo(1, LOGO_MAX_PX + 1))).toBe(false);
    expect(isLogo(logo(1, 0))).toBe(false);
    expect(isLogo(logo(0, 1))).toBe(false);
    expect(isLogo(logo(20000, 20000))).toBe(false);
    expect(isLogo(logo(0xffffffff, 0xffffffff))).toBe(false);
  });

  it('refuses a text over MAX_LOGO_LENGTH units and accepts one of exactly that length', () => {
    const fill = (n: number) => {
      const base = logo(1, 1);
      return base + 'A'.repeat(n - base.length);
    };
    expect(isLogo(fill(MAX_LOGO_LENGTH))).toBe(true);
    expect(isLogo(fill(MAX_LOGO_LENGTH + 1))).toBe(false);
  });
});
