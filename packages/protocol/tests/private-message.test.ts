import { describe, it, expect } from 'vitest';
import { isClientMessage, isServerMessage } from '../src/ws-messages.js';

describe('private-message', () => {
  it('is a known type from a client and from the Room', () => {
    expect(isClientMessage({ type: 'private-message', to: 'p1', text: 'hi' })).toBe(true);
    expect(isServerMessage({ type: 'private-message', text: 'hi', from: 'guest', fromPeerId: 'p1' })).toBe(true);
  });
});
