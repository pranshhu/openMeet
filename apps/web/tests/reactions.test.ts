import { describe, it, expect } from 'vitest';
import {
  OWN_REACTION,
  REACTION_MIN_GAP_MS,
  REACTION_SHOWN_MS,
  takeReaction,
  type ShownReactions,
} from '@/lib/reactions';

const empty = (): { current: ShownReactions } => ({ current: new Map() });

describe('takeReaction', () => {
  it('takes a known code for a tile, with the time it was taken', () => {
    const held = empty();
    expect(takeReaction(held, 'p-bob', 'clap', 1000)).toBe(true);
    expect([...held.current]).toEqual([['p-bob', { reaction: 'clap', at: 1000 }]]);
  });

  it('refuses a code this build does not know, and leaves the record as it was', () => {
    const held = empty();
    takeReaction(held, 'p-bob', 'clap', 1000);
    const before = held.current;
    for (const junk of ['party', '', 'CLAP', 7, null, undefined, {}, ['clap']]) {
      expect(takeReaction(held, 'p-bob', junk, 9000)).toBe(false);
    }
    expect(held.current).toBe(before);
  });

  it('takes one a gap from one sender, without holding back anyone else', () => {
    const held = empty();
    expect(takeReaction(held, 'p-bob', 'clap', 1000)).toBe(true);
    const kept = held.current;
    expect(takeReaction(held, 'p-bob', 'heart', 1000 + REACTION_MIN_GAP_MS - 1)).toBe(false);
    expect(held.current).toBe(kept);

    expect(takeReaction(held, 'p-carol', 'laugh', 1001)).toBe(true);
    expect(takeReaction(held, OWN_REACTION, 'thumbs-up', 1002)).toBe(true);

    expect(takeReaction(held, 'p-bob', 'heart', 1000 + REACTION_MIN_GAP_MS)).toBe(true);
    expect(held.current.get('p-bob')).toEqual({ reaction: 'heart', at: 1000 + REACTION_MIN_GAP_MS });
    expect(held.current.get('p-carol')).toEqual({ reaction: 'laugh', at: 1001 });
    expect(held.current.get(OWN_REACTION)).toEqual({ reaction: 'thumbs-up', at: 1002 });
  });

  it('forgets reactions that have had their time, so the record stays small', () => {
    const held = empty();
    for (let i = 0; i < 50; i++) takeReaction(held, `p-${i}`, 'clap', 1000 + i);
    expect(held.current.size).toBe(50);

    expect(takeReaction(held, 'p-late', 'heart', 1049 + REACTION_SHOWN_MS)).toBe(true);
    expect([...held.current.keys()]).toEqual(['p-late']);
  });

  it('takes the next one after the clock was set back', () => {
    const held = empty();
    takeReaction(held, 'p-bob', 'clap', 50_000);
    expect(takeReaction(held, 'p-bob', 'heart', 10_000)).toBe(true);
    expect([...held.current]).toEqual([['p-bob', { reaction: 'heart', at: 10_000 }]]);
  });
});

describe('reaction timings', () => {
  // A sender can redraw every screen in the call no faster than once a
  // second, and a picture is gone after about three.
  it('holds a sender to one a second and shows a reaction for about three', () => {
    expect(REACTION_MIN_GAP_MS).toBeGreaterThanOrEqual(1000);
    expect(REACTION_SHOWN_MS).toBeGreaterThanOrEqual(2000);
    expect(REACTION_SHOWN_MS).toBeLessThanOrEqual(5000);
  });
});
