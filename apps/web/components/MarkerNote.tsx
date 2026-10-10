'use client';

import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { MAX_MARKER_LABEL_LENGTH } from '@/lib/sync-report';

/**
 * Whether the note field is open, for one take. N opens it, as M drops a bare
 * marker, and like M it is ignored while the person is typing somewhere. The
 * field closes when the take ends, so the next take never starts with it open.
 */
export function useMarkerNote(recording: boolean): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!recording) {
      setOpen(false);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'n' && e.key !== 'N') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      // The field takes focus while this key is still being handled; cancelling
      // the key keeps its letter out of the note.
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [recording]);
  return [open, setOpen];
}

/**
 * One line to type a note for a chapter marker. Enter adds the marker with the
 * note as its label; Escape and the close button add nothing.
 */
export function MarkerNote({
  onMark,
  onClose,
  className = 'top-3 flex',
}: {
  /** `at` is when this field opened: the moment the note is about. */
  onMark: (label: string, at?: number) => void;
  onClose: () => void;
  /** Where it sits in its positioned parent, and whether it is shown. */
  className?: string;
}) {
  const [text, setText] = useState('');
  // Typing takes seconds, and the moment is the one the field opened at.
  const [openedAt] = useState(() => Date.now());
  const note = text.trim();
  return (
    // The band lets clicks through; only the field itself takes them.
    <div className={`pointer-events-none absolute inset-x-0 z-30 justify-center px-4 ${className}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!note) return;
          onMark(note, openedAt);
          onClose();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
        className="pointer-events-auto flex w-full max-w-sm items-center gap-1 rounded-full bg-[#3c4043] pl-4 pr-1.5 shadow-2xl ring-1 ring-white/10 focus-within:ring-2 focus-within:ring-[#8ab4f8]"
      >
        {/* Opened only by its own button or key, to type, so it takes the
            keyboard on a phone too. The input drops its own outline; the pill
            shows focus instead. */}
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={MAX_MARKER_LABEL_LENGTH}
          placeholder="Note for this marker"
          aria-label="Note for this marker"
          enterKeyHint="done"
          className="min-w-0 flex-1 bg-transparent py-2.5 text-base text-white placeholder:text-white/70 focus:outline-none sm:text-sm"
        />
        <button
          type="submit"
          disabled={!note}
          className="inline-flex h-11 shrink-0 items-center rounded-full px-3 text-sm font-medium text-[#8ab4f8] hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8] disabled:opacity-40 sm:h-8"
        >
          Add
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close note"
          title="Close note"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white/80 hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8] sm:h-8 sm:w-8"
        >
          <Icon name="close" size={20} />
        </button>
      </form>
    </div>
  );
}
