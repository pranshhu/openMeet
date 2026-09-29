'use client';

import { useEffect, useReducer, useRef, useState } from 'react';
import type { MediaBoard, Pad } from '@/lib/media-board';
import { Icon } from './Icon';

/**
 * Pads for intros, stingers and ad reads. Firing one plays it into the call and
 * drops a chapter marker, so the moment is findable in post.
 */
export function MediaBoardPanel({
  board,
  midTake = false,
  onFire,
  onClose,
}: {
  board: MediaBoard | null;
  /** First opened during this take, whose recording therefore has no pads. */
  midTake?: boolean;
  onFire: (name: string) => void;
  onClose: () => void;
}) {
  const [pads, setPads] = useState<Pad[]>(board?.pads ?? []);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // What is playing lives on the board, not here: the panel unmounts on close
  // while a pad plays on, and a local copy came back wrong on reopen.
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => board?.onPadEnded(refresh), [board]);

  async function addFiles(files: FileList | null) {
    if (!board || !files) return;
    setError(null);
    for (const f of Array.from(files)) {
      try {
        await board.load(f);
      } catch {
        setError(`Could not decode ${f.name}. Use WAV, MP3, or M4A.`);
      }
    }
    setPads([...board.pads]);
  }

  function toggle(pad: Pad) {
    if (!board) return;
    if (board.isPlaying(pad.id)) {
      board.stop(pad.id);
    } else {
      board.play(pad.id);
      onFire(pad.name);
    }
    refresh();
  }

  // The control bar sits below the stage, so the bottom offset only has to
  // clear the self view / peer PiP in the stage's bottom-right corner:
  // bottom-24 on a phone, sm:bottom-40 for the larger desktop PiP.
  return (
    <div className="pointer-events-auto absolute inset-x-2 bottom-24 z-20 mx-auto max-w-md rounded-xl bg-black/85 p-3 ring-1 ring-white/10 backdrop-blur sm:inset-x-auto sm:bottom-40 sm:right-6">
      <div className="mb-2 flex items-center gap-2 text-xs text-white/70">
        <span className="text-sm font-medium text-white">Media board</span>
        <button
          onClick={() => inputRef.current?.click()}
          className="min-h-11 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/15 sm:min-h-0"
        >
          Add audio…
        </button>
        <button onClick={onClose} className="ml-auto rounded-full p-3.5 hover:bg-white/10 sm:p-2" aria-label="Close media board">
          <Icon name="close" className="h-4 w-4" />
        </button>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        multiple
        hidden
        onChange={(e) => void addFiles(e.target.files)}
      />

      {error && <p className="mb-2 text-xs text-[#f6aea9]">{error}</p>}

      {pads.length === 0 ? (
        <p className="text-xs text-white/70">
          Load intros, stingers or ad reads. They play into the call and drop a chapter marker; the
          audio stays on your computer.
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-2">
          {pads.map((pad) => {
            const playing = board?.isPlaying(pad.id) ?? false;
            return (
              <li key={pad.id}>
                <button
                  onClick={() => toggle(pad)}
                  aria-pressed={playing}
                  className={`w-full truncate rounded-lg px-3 py-2 text-left text-xs transition-colors ${
                    playing ? 'bg-[#0b57d0] text-white' : 'bg-white/10 text-white/85 hover:bg-white/15'
                  }`}
                  title={pad.name}
                >
                  <span className="block truncate">{pad.name}</span>
                  {/* white/70 is 3.9:1 on the playing blue; white/90 is 5.5:1. */}
                  <span className={`text-[11px] ${playing ? 'text-white/90' : 'text-white/70'}`}>
                    {(pad.durationMs / 1000).toFixed(1)}s
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {/* Honest about the known gap, and only while it applies: a take already
          running when the board first opens can't pick up the pads (its
          recorder can't swap tracks). */}
      {midTake && (
        <p className="mt-2 text-xs text-[#fdd663]">This take keeps your mic only — pads are recorded from the next take.</p>
      )}
    </div>
  );
}
