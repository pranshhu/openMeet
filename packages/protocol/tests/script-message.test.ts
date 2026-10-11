import { describe, it, expect } from 'vitest';
import { isClientMessage, isServerMessage } from '../src/ws-messages.js';

describe('script', () => {
  // A page drops a message whose type its guard does not know, so the type has
  // to be in both sets or the script never arrives.
  it('is a known type on both the client and server unions', () => {
    expect(isClientMessage({ type: 'script', text: 'Welcome to the show' })).toBe(true);
    expect(isServerMessage({ type: 'script', text: 'Welcome to the show' })).toBe(true);
  });
});
