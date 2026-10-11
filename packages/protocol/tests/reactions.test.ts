import { describe, it, expect } from 'vitest';
import { REACTIONS, isClientMessage, isReaction, isServerMessage } from '../src/ws-messages.js';

describe('reaction', () => {
  it('is a known type on the client and the server union', () => {
    expect(isClientMessage({ type: 'reaction', reaction: 'clap' })).toBe(true);
    expect(isServerMessage({ type: 'reaction', reaction: 'clap', from: 'guest', fromPeerId: 'p1' })).toBe(true);
  });

  it('knows its four codes and nothing else', () => {
    expect([...REACTIONS]).toEqual(['thumbs-up', 'clap', 'laugh', 'heart']);
    for (const code of REACTIONS) expect(isReaction(code)).toBe(true);
    for (const v of ['party', '', 'CLAP', ' clap', 7, null, undefined, {}, ['clap']]) {
      expect(isReaction(v)).toBe(false);
    }
  });
});
