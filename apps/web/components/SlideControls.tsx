'use client';

import { useEffect, useRef, useState } from 'react';
import type { PresentedSlides } from '@/lib/slides';

const BUTTON =
  'inline-flex min-h-11 items-center justify-center rounded-full bg-[#3c4043] px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-[#4a4d51] disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]';

const SLIDE_KEYS = new Set(['ArrowRight', 'PageDown', 'ArrowLeft', 'PageUp']);

/**
 * Turns the deck this page presents. It starts from the slide the deck is on:
 * the call screen is unmounted while the page shows "Everyone else left", and
 * the deck keeps its place. Mount it keyed by the deck, so a second deck
 * starts from its own first slide.
 *
 * The arrow keys and Page Up and Down, which a presentation clicker sends,
 * press its buttons. They are not single letters, so they stay on when the
 * single keys are off, and they are left alone wherever a field, a list or a
 * fader uses them.
 */
export function SlideControls({ slides }: { slides: PresentedSlides }) {
  const [current, setCurrent] = useState(slides.index);
  const go = (i: number) => {
    setCurrent(i);
    void slides.show(i);
  };
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!SLIDE_KEYS.has(e.key)) return;
      // A held key would race through the deck; Alt+Left is the browser's Back.
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if ((e.target as Element | null)?.closest?.('input, textarea, select, [contenteditable]')) return;
      // A phone's bar is hidden while chat covers the stage.
      if (row.current?.checkVisibility?.() === false) return;
      // The page behind would scroll, also when the button is disabled.
      e.preventDefault();
      row.current?.querySelector<HTMLButtonElement>(`button[aria-keyshortcuts~="${e.key}"]`)?.click();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div ref={row} role="group" aria-label="Slides" className="mb-2 flex max-w-full items-center justify-center gap-2">
      <button
        type="button"
        className={BUTTON}
        aria-keyshortcuts="ArrowLeft PageUp"
        disabled={current <= 0}
        onClick={() => go(current - 1)}
      >
        Previous
      </button>
      <span aria-live="polite" className="whitespace-nowrap px-1 text-sm tabular-nums text-white/80">
        Slide {current + 1} of {slides.count}
      </span>
      <button
        type="button"
        className={BUTTON}
        aria-keyshortcuts="ArrowRight PageDown"
        disabled={current >= slides.count - 1}
        onClick={() => go(current + 1)}
      >
        Next
      </button>
    </div>
  );
}
