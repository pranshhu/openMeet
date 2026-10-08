import { describe, it, expect } from 'vitest';
import { isClientMessage, isServerMessage } from '../src/ws-messages.js';
import { WS_CLOSE_REPLACED } from '../src/constants.js';

describe('ws-messages type guards', () => {
  it('identifies a valid client message', () => {
    expect(isClientMessage({ type: 'join', displayName: 'Alice', userAgent: 'ua' })).toBe(true);
    expect(isClientMessage({ type: 'webrtc-offer', sdp: 'v=0\r\n' })).toBe(true);
    expect(isClientMessage({ type: 'ping' })).toBe(true);
  });

  it('still accepts the recording messages an older tab sends', () => {
    expect(
      isClientMessage({
        type: 'recording-started',
        recordingId: 'rec-1',
        kind: 'camera',
        filename: 'guest_rec-1.mp4',
      })
    ).toBe(true);
    expect(
      isClientMessage({
        type: 'recording-completed',
        recordingId: 'rec-1',
        lastIdx: 0,
        totalBytes: 100,
        sha256: null,
      })
    ).toBe(true);
  });

  it('rejects unknown message types', () => {
    expect(isClientMessage({ type: 'nope' })).toBe(false);
    expect(isClientMessage({})).toBe(false);
    expect(isClientMessage(null)).toBe(false);
  });

  it('identifies a valid server message', () => {
    expect(isServerMessage({ type: 'role-assigned', role: 'host', peerCount: 1 })).toBe(true);
    expect(isServerMessage({ type: 'pong' })).toBe(true);
  });

  it('identifies recording-capability on both the client and server unions', () => {
    expect(isClientMessage({ type: 'recording-capability', mp4: true, wav: false })).toBe(true);
    expect(
      isServerMessage({
        type: 'recording-capability',
        mp4: true,
        wav: false,
        from: 'guest',
        fromPeerId: 'p1',
      })
    ).toBe(true);
  });

  it('identifies recording-capability with optional note on both unions', () => {
    expect(isClientMessage({ type: 'recording-capability', mp4: true, wav: false, note: 'safari' })).toBe(true);
    expect(
      isServerMessage({
        type: 'recording-capability',
        mp4: true,
        wav: false,
        note: 'safari',
        from: 'guest',
        fromPeerId: 'p1',
      })
    ).toBe(true);
  });

  it('identifies peer-recorded on both the client and server unions', () => {
    expect(isClientMessage({ type: 'peer-recorded', peerId: 'p1', recorded: false })).toBe(true);
    expect(isServerMessage({ type: 'peer-recorded', peerId: 'p1', recorded: false })).toBe(true);
  });

  it('defines WS_CLOSE_REPLACED as 4006', () => {
    expect(WS_CLOSE_REPLACED).toBe(4006);
  });
});
