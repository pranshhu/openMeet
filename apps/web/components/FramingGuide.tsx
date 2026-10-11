'use client';

import { useState } from 'react';
import { isPhone } from '@/lib/switchable-media';

// Two lines down and two across, at the thirds of the box they are laid over.
const LINES = [
  'left-1/3 top-0 h-full w-px',
  'left-2/3 top-0 h-full w-px',
  'left-0 top-1/3 h-px w-full',
  'left-0 top-2/3 h-px w-full',
];

/**
 * A rule-of-thirds grid over the camera preview, and the button that shows it.
 * It goes inside the positioned box that holds the preview. The page draws the
 * lines over the picture and this component is given no stream, so nothing of
 * them can reach a recording or another participant.
 *
 * Not on a phone: held upright it gives a tall picture, the preview shows a
 * wide band of it, and thirds of that band are not thirds of what is recorded.
 */
export function FramingGuide() {
  const [on, setOn] = useState(false);
  if (isPhone()) return null;
  return (
    <>
      {on && (
        <div aria-hidden data-testid="framing-guide" className="pointer-events-none absolute inset-0">
          {LINES.map((line) => (
            // White with a dark edge: it shows over a bright wall and a dark shirt alike.
            <span key={line} className={`absolute bg-white/70 shadow-[0_0_2px_rgb(0_0_0/0.8)] ${line}`} />
          ))}
        </div>
      )}
      <button
        type="button"
        aria-pressed={on}
        onClick={() => setOn((v) => !v)}
        className={`absolute right-3 top-3 inline-flex min-h-11 items-center rounded-full px-4 text-sm font-medium shadow-md transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
          on ? 'bg-white text-[#202124]' : 'bg-black/45 text-white ring-1 ring-white/60 backdrop-blur-sm hover:bg-black/60'
        }`}
      >
        Framing guide
      </button>
    </>
  );
}
