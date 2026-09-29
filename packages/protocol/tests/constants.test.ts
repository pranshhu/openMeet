import { describe, it, expect } from 'vitest';
import { recordingChannelKind, TURN_CRED_TTL_S } from '../src/constants.js';

describe('recordingChannelKind', () => {
  it('returns the whole label as base when there is no key', () => {
    expect(recordingChannelKind('recording')).toEqual({ base: 'recording' });
    expect(recordingChannelKind('recording-audio')).toEqual({ base: 'recording-audio' });
    expect(recordingChannelKind('recording-screen-1')).toEqual({ base: 'recording-screen-1' });
  });

  it('splits base and key on the first #', () => {
    expect(recordingChannelKind('recording#abc-123')).toEqual({ base: 'recording', key: 'abc-123' });
    expect(recordingChannelKind('recording-audio#abc-123')).toEqual({
      base: 'recording-audio',
      key: 'abc-123',
    });
  });

  it('splits on the FIRST # only, leaving any later # in the key', () => {
    expect(recordingChannelKind('recording#a#b')).toEqual({ base: 'recording', key: 'a#b' });
  });
});

describe('TURN_CRED_TTL_S', () => {
  // The client fetches TURN credentials once per join and never refreshes them,
  // and Cloudflare disconnects a relayed call shortly after its credential
  // expires. So the lifetime must outlast a long recording session, while staying
  // within Cloudflare's 48-hour maximum.
  it('outlasts a long session and stays within the 48 h maximum', () => {
    expect(TURN_CRED_TTL_S).toBeGreaterThanOrEqual(8 * 60 * 60);
    expect(TURN_CRED_TTL_S).toBeLessThanOrEqual(48 * 60 * 60);
  });
});
