import { describe, it, expect } from 'vitest';
import { LISTENING_CHOICES, isListening } from '../src/ws-messages.js';

describe('isListening', () => {
  it('takes each of the three codes and nothing else', () => {
    expect([...LISTENING_CHOICES]).toEqual(['headphones', 'speakers', 'speakers-ec']);
    for (const code of LISTENING_CHOICES) expect(isListening(code)).toBe(true);
    for (const other of ['', 'Headphones', 'speakers-ec ', 'none', 1, true, null, undefined, {}, ['speakers']]) {
      expect(isListening(other)).toBe(false);
    }
  });
});
