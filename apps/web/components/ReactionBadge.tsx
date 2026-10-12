'use client';

import { useEffect, useState } from 'react';
import { REACTION_SHOWN_MS, type Reaction } from '@/lib/reactions';

/** How this build draws and names each code. The codes are what travels. */
export const REACTION_FACE: Record<Reaction, { emoji: string; label: string }> = {
  'thumbs-up': { emoji: '👍', label: 'Thumbs up' },
  clap: { emoji: '👏', label: 'Applause' },
  laugh: { emoji: '😂', label: 'Laugh' },
  heart: { emoji: '❤️', label: 'Heart' },
};

/**
 * One reaction over its sender's tile, at the top left, clear of the name tag
 * and the marks. Give it `key={at}`: each reaction is then an element of its
 * own, and a second one from the same person shows again. It takes itself
 * away REACTION_SHOWN_MS after `at`, the moment this page took the reaction.
 */
export function ReactionBadge({ reaction, at }: { reaction: Reaction; at: number }) {
  // What is left of its time, read once at mount: a tile that is drawn again
  // (a new layout) shows the rest of a reaction, and nothing of an old one.
  const [left] = useState(() => Math.min(REACTION_SHOWN_MS, at + REACTION_SHOWN_MS - Date.now()));
  const [gone, setGone] = useState(left <= 0);
  useEffect(() => {
    if (left <= 0) return;
    const timer = setTimeout(() => setGone(true), left);
    return () => clearTimeout(timer);
  }, [left]);
  if (gone) return null;
  const face = REACTION_FACE[reaction];
  return (
    <span
      role="img"
      aria-label={face.label}
      className="pointer-events-none absolute left-2 top-2 animate-bounce text-2xl leading-none select-none motion-reduce:animate-none sm:left-3 sm:top-3 sm:text-4xl"
    >
      {face.emoji}
    </span>
  );
}
