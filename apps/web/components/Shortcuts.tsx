'use client';

import { useEffect, useState } from 'react';

// What the list shows, in the order of the control bar. M is handled by
// CallStage; it is listed so the list is whole.
const ROWS: [keys: string, does: string][] = [
  ['A', 'Microphone on or off'],
  ['V', 'Camera on or off'],
  ['C', 'Chat'],
  ['T', 'Teleprompter'],
  ['M', 'Marker, while recording'],
  ['?', 'This list'],
];

/**
 * The call's keyboard shortcuts, and the list of them.
 *
 * A key is not wired to an action. It presses the button that carries it in
 * `aria-keyshortcuts`, so a button that is disabled or not on screen cannot
 * be reached from the keyboard either, whatever the reason it is off.
 */
export function Shortcuts() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        return;
      }
      // A held key would switch over and over, and a chord is the browser's.
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      // Typing is never a shortcut.
      const el = e.target as Element | null;
      if (el?.closest?.('input, textarea, select, [contenteditable]')) return;
      if (e.key === '?') {
        setOpen((o) => !o);
        return;
      }
      // Letters only: the key goes into a selector. Shift+letter is left alone.
      if (e.shiftKey || !/^[a-z]$/i.test(e.key)) return;
      const button = document.querySelector<HTMLElement>(`button[aria-keyshortcuts="${e.key.toUpperCase()}"]`);
      // A narrow window hides the control bar while chat or the summary covers
      // the stage; a button nobody can see is not pressed.
      if (!button || button.checkVisibility?.() === false) return;
      // Chat focuses its field as it opens, and the letter would be typed into it.
      e.preventDefault();
      button.click();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    // Not below sm: a phone has no keyboard, and its top bar has no room.
    <div className="relative -my-2 ml-auto hidden shrink-0 sm:block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts (?)"
        aria-expanded={open}
        className="flex h-11 w-11 items-center justify-center rounded-full text-base font-medium text-white/80 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]"
      >
        ?
      </button>
      {open && (
        // aria-live off: the status bar is a live region, and the list is not news.
        <div
          aria-live="off"
          className="absolute right-0 top-full z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl bg-[#202124] p-3 text-sm text-white shadow-2xl ring-1 ring-white/10"
        >
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/70">Keyboard shortcuts</div>
          <dl className="space-y-1.5">
            {ROWS.map(([keys, does]) => (
              <div key={keys} className="flex items-baseline gap-3">
                <dt className="w-14 shrink-0">
                  <kbd className="rounded bg-white/10 px-1.5 py-0.5 font-sans text-xs font-medium">{keys}</kbd>
                </dt>
                <dd className="min-w-0 text-white/90">{does}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-xs text-white/70">
            {'A key presses its button, so it works while that button is shown. Keys do nothing while you type in a field.'}
          </p>
        </div>
      )}
    </div>
  );
}
