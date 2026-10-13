import { describe, it, expect } from 'vitest';
import { LOOK_ACCENTS, isClientMessage, isLookAccent, isServerMessage } from '../src/ws-messages.js';

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
