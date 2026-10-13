'use client';

import { useState } from 'react';
import type { PresentedSlides } from '@/lib/slides';

const BUTTON =
  'inline-flex min-h-11 items-center justify-center rounded-full bg-[#3c4043] px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-[#4a4d51] disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]';

/**
 * Turns the deck this page presents. It starts from the slide the deck is on:
 * the call screen is unmounted while the page shows "Everyone else left", and
 * the deck keeps its place. Mount it keyed by the deck, so a second deck
 * starts from its own first slide.
 */
export function SlideControls({ slides }: { slides: PresentedSlides }) {
  const [current, setCurrent] = useState(slides.index);
  const go = (i: number) => {
    setCurrent(i);
    void slides.show(i);
  };
  return (
    <div role="group" aria-label="Slides" className="mb-2 flex max-w-full items-center justify-center gap-2">
      <button type="button" className={BUTTON} disabled={current <= 0} onClick={() => go(current - 1)}>
        Previous
      </button>
      <span aria-live="polite" className="whitespace-nowrap px-1 text-sm tabular-nums text-white/80">
        Slide {current + 1} of {slides.count}
      </span>
      <button
        type="button"
        className={BUTTON}
        disabled={current >= slides.count - 1}
        onClick={() => go(current + 1)}
      >
        Next
      </button>
    </div>
  );
}
