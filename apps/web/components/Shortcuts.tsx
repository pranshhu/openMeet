'use client';

import { useEffect, useRef, useState } from 'react';
import { setSingleKeys, singleKeysOn, useSingleKeys } from '@/hooks/use-single-keys';

// What the list shows, in the order of the control bar. M is handled by
// CallStage and N by useMarkerNote; they are listed so the list is whole.
const ROWS: [keys: string, does: string][] = [
  ['A', 'Microphone on or off'],
  ['V', 'Camera on or off'],
  ['C', 'Chat'],
  ['T', 'Teleprompter'],
  ['Alt+R', 'Record (host)'],
  ['Alt+S', 'End & save (host)'],
  ['M', 'Marker, while recording'],
  ['N', 'Marker with a note, while recording'],
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
  const singleKeys = useSingleKeys();
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Escape unmounts the list, and the tick box in it can hold the keyboard:
        // hand focus back to the button, otherwise it falls to <body>.
        const wrap = root.current;
        if (wrap?.contains(document.activeElement)) wrap.querySelector('button')?.focus();
        setOpen(false);
        return;
      }
      // A held key would switch over and over, and a Ctrl or Cmd chord is the browser's.
      if (e.repeat || e.ctrlKey || e.metaKey) return;
      // Typing is never a shortcut.
      const el = e.target as Element | null;
      if (el?.closest?.('input, textarea, select, [contenteditable]')) return;
      // Speech input types letters, so a person who dictates turns the single
      // keys off. Asked as the key arrives: this listener is added once. A
      // chord with Alt is not a single key and stays.
      if (!e.altKey && !singleKeysOn()) return;
      if (e.key === '?' && !e.altKey) {
        setOpen((o) => !o);
        return;
      }
      if (e.shiftKey) return;
      // With Alt held a Mac types a symbol in place of the letter, so a chord is
      // read from the key code: the letter this keyboard has on that key, or the
      // key's place on a keyboard without Latin letters. `code` is the place
      // alone, and Colemak has R where QWERTY has S: the key that starts a take
      // would end one. Not upper-cased: the key codes of the function keys and
      // the number pad are lower-case letters, F4 being "s".
      const letter = e.altKey ? String.fromCharCode(e.keyCode) : e.key.toUpperCase();
      // One Latin letter: it goes into a selector.
      if (!/^[A-Z]$/.test(letter)) return;
      const button = document.querySelector<HTMLElement>(
        `button[aria-keyshortcuts="${e.altKey ? 'Alt+' : ''}${letter}"]`
      );
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
    <div ref={root} className="relative -my-2 ml-auto hidden shrink-0 sm:block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Keyboard shortcuts"
        title={singleKeys ? 'Keyboard shortcuts (?)' : 'Keyboard shortcuts'}
        aria-expanded={open}
        className="flex h-11 w-11 items-center justify-center rounded-full text-base font-medium text-white/80 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]"
      >
        ?
      </button>
      {open && (
        // aria-live off: the status bar is a live region, and the list is not news.
        <div
          aria-live="off"
          className="absolute right-0 top-full z-40 mt-2 max-h-[calc(100dvh-5rem)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl bg-[#202124] p-3 text-sm text-white shadow-2xl ring-1 ring-white/10"
        >
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/70">Keyboard shortcuts</div>
          <dl className="space-y-1.5">
            {ROWS.map(([keys, does]) => (
              // A single key that is switched off is dimmed; a chord is longer than
              // one character and always works.
              <div
                key={keys}
                className={`flex items-baseline gap-3${singleKeys || keys.length > 1 ? '' : ' opacity-60'}`}
              >
                <dt className="w-14 shrink-0">
                  <kbd className="rounded bg-white/10 px-1.5 py-0.5 font-sans text-xs font-medium">{keys}</kbd>
                </dt>
                <dd className="min-w-0 text-white/90">{does}</dd>
              </div>
            ))}
          </dl>
          {/* A real checkbox with its words beside it, in a row 44px tall: it is
              reached by Tab, by touch and by saying its name. */}
          <label className="mt-2 flex min-h-11 cursor-pointer items-center gap-2.5">
            <input
              type="checkbox"
              checked={singleKeys}
              onChange={(e) => setSingleKeys(e.target.checked)}
              className="h-4 w-4 shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]"
            />
            Single-key shortcuts
          </label>
          {!singleKeys && <p className="text-xs text-white">Single keys are off. Alt+R and Alt+S stay on.</p>}
          <p className="mt-2 text-xs text-white/70">
            {'A key works while its button is shown. Keys do nothing while you type in a field. On a Mac, Alt is the Option key.'}
          </p>
        </div>
      )}
    </div>
  );
}
