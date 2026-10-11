'use client';

import { useEffect, useRef, useState } from 'react';
import { REACTIONS } from '@openmeet/protocol';
import { Icon } from './Icon';
import { REACTION_FACE } from './ReactionBadge';
import type { Reaction } from '@/lib/reactions';

const LABEL = 'Reactions';

/**
 * The arrow beside Raise hand and the row of reactions it opens. It keeps its
 * own open state and closes on a choice, on Escape and on a click anywhere
 * else, so the call screen's other menus need to know nothing about it.
 *
 * The caller places the row: it is `absolute`, above the pill the arrow sits
 * in, and that pill must be `relative`. Neither is shown below sm: in a
 * narrow bar the pill can be the first button of a row, and a row hung from
 * its right edge would leave the screen.
 */
export function ReactionMenu({ onReact }: { onReact: (reaction: Reaction) => void }) {
  const [open, setOpen] = useState(false);
  const arrow = useRef<HTMLButtonElement>(null);
  const row = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!arrow.current?.contains(target) && !row.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      // Hand focus back to the arrow; otherwise it falls to <body> when the
      // button it was on unmounts.
      arrow.current?.focus();
    };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={arrow}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={LABEL}
        title={LABEL}
        aria-haspopup="menu"
        aria-expanded={open}
        className="hidden h-12 w-9 items-center justify-center rounded-r-full text-white hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8] sm:inline-flex"
      >
        <Icon name={open ? 'arrow_drop_down' : 'arrow_drop_up'} size={18} />
      </button>
      {open && (
        <div
          ref={row}
          role="menu"
          aria-label={LABEL}
          className="absolute bottom-full right-0 z-30 mb-2 hidden gap-1 rounded-full bg-[#202124] p-1.5 shadow-2xl ring-1 ring-white/10 sm:flex"
        >
          {REACTIONS.map((r) => (
            <button
              key={r}
              type="button"
              role="menuitem"
              aria-label={REACTION_FACE[r].label}
              title={REACTION_FACE[r].label}
              onClick={() => {
                setOpen(false);
                // The button pressed is about to unmount; keep focus in the bar.
                arrow.current?.focus();
                onReact(r);
              }}
              className="inline-flex h-11 w-11 items-center justify-center rounded-full text-2xl leading-none hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]"
            >
              <span aria-hidden="true">{REACTION_FACE[r].emoji}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
