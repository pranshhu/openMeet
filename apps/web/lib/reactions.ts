import { isReaction, type Reaction } from '@openmeet/protocol';

export type { Reaction };

/** How long a reaction stays on its sender's tile. */
export const REACTION_SHOWN_MS = 3000;
/** One reaction from one sender is taken in this long; the rest are dropped where they arrive. */
export const REACTION_MIN_GAP_MS = 1000;
/** The key of this page's own tile. A peer id is a UUID the Room mints, so it is never this. */
export const OWN_REACTION = 'self';

/** The reaction each tile shows, by its sender's peer id, with the time this page took it. */
export type ShownReactions = ReadonlyMap<string, { reaction: Reaction; at: number }>;

/** `at` is less than `ms` before `now`. A clock that was set back makes nothing recent. */
const within = (at: number, now: number, ms: number) => now >= at && now - at < ms;

/**
 * Take one reaction for the tile `key` into `held`, and say whether it was
 * taken. It is not when the code is not one this build knows, or when it
 * comes within REACTION_MIN_GAP_MS of that sender's last one: a sender can
 * redraw every screen in the call no faster than that. Reactions that have
 * had their REACTION_SHOWN_MS are dropped on the way, so the record never
 * holds more than the senders of the last few seconds.
 */
export function takeReaction(
  held: { current: ShownReactions },
  key: string,
  reaction: unknown,
  now: number
): boolean {
  if (!isReaction(reaction)) return false;
  const last = held.current.get(key);
  if (last && within(last.at, now, REACTION_MIN_GAP_MS)) return false;
  const next = new Map<string, { reaction: Reaction; at: number }>();
  for (const [k, r] of held.current) if (within(r.at, now, REACTION_SHOWN_MS)) next.set(k, r);
  next.set(key, { reaction, at: now });
  held.current = next;
  return true;
}
