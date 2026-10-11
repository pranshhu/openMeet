import { describe, it, expect } from 'vitest';
import { isClientMessage, isServerMessage } from '../src/ws-messages.js';
import { WS_CLOSE_REMOVED } from '../src/constants.js';

describe('host controls on the wire', () => {
  it('identifies peer-mute on both the client and server unions', () => {
    expect(isClientMessage({ type: 'peer-mute', peerId: 'p1' })).toBe(true);
    expect(isServerMessage({ type: 'peer-mute' })).toBe(true);
  });

  it('identifies peer-remove as something only a client sends', () => {
    expect(isClientMessage({ type: 'peer-remove', peerId: 'p1' })).toBe(true);
    expect(isServerMessage({ type: 'peer-remove', peerId: 'p1' })).toBe(false);
  });

  it('defines WS_CLOSE_REMOVED as 4007', () => {
    expect(WS_CLOSE_REMOVED).toBe(4007);
  });
});
