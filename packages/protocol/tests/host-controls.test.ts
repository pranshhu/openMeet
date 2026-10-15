import { describe, it, expect } from 'vitest';
import { isClientMessage, isHelpAsk, isServerMessage } from '../src/ws-messages.js';
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

describe('the host asks a guest for help on the wire', () => {
  it('identifies peer-help on both the client and server unions', () => {
    expect(isClientMessage({ type: 'peer-help', peerId: 'p1', ask: 'reconnect' })).toBe(true);
    expect(isServerMessage({ type: 'peer-help', ask: 'reconnect' })).toBe(true);
  });

  it('takes reconnect as an ask and refuses anything else', () => {
    expect(isHelpAsk('reconnect')).toBe(true);
    expect(isHelpAsk('mute')).toBe(false);
    expect(isHelpAsk(1)).toBe(false);
    expect(isHelpAsk(undefined)).toBe(false);
  });

  it('takes microphone and camera as asks too', () => {
    expect(isHelpAsk('microphone')).toBe(true);
    expect(isHelpAsk('camera')).toBe(true);
    expect(isHelpAsk('speaker')).toBe(false);
  });
});
