'use client';

import { useEffect, useMemo, useState } from 'react';
import { MAX_RUNDOWN_LENGTH, loadRundown, parseRundown, saveRundown } from '@/lib/rundown';

/**
 * The host's running order for a show: written between takes, stepped through
 * during one. Starting a segment adds a chapter marker with the segment's
 * name, through the entry the marker button uses, so a take's chapters file
 * is its rundown with the real times.
 *
 * Host-only and never transmitted: the text lives in localStorage keyed by
 * room. It stays mounted while the strip is hidden, so the place in the show
 * survives hiding it.
 */
export function Rundown({
  slug,
  open,
  recording,
  onMark,
}: {
  slug: string;
  /** The strip is on screen. */
  open: boolean;
  /** This tab's take is running. */
  recording: boolean;
  onMark: (label: string) => void;
}) {
  const [text, setText] = useState(() => loadRundown(slug));
  const segments = useMemo(() => parseRundown(text), [text]);
  // The segment that is running; null until one is started in this take.
  const [index, setIndex] = useState<number | null>(null);
  // Every take starts its rundown over.
  useEffect(() => {
    if (!recording) setIndex(null);
  }, [recording]);

  function go(i: number) {
    const segment = segments[i];
    if (!segment) return;
    setIndex(i);
    onMark(segment.name);
  }

  if (!open) return null;
  const current = index === null ? undefined : segments[index];
  const target = index === null ? 0 : index + 1;
  const next = segments[target];
  return (
    <section
      aria-label="Rundown"
      className="mb-2 w-full max-w-md rounded-2xl bg-[#2a2b2e] px-4 py-3 text-white ring-1 ring-white/5"
    >
      {!recording ? (
        <>
          <h2 className="text-sm font-medium">Rundown</h2>
          <p id="rundown-hint" className="text-xs text-white/70">
            One segment per line. During a take, each segment you start adds a chapter marker.
          </p>
          <textarea
            aria-label="Rundown segments"
            aria-describedby="rundown-hint"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              saveRundown(slug, e.target.value);
            }}
            maxLength={MAX_RUNDOWN_LENGTH}
            rows={4}
            placeholder={'Intro\nInterview\nQuestions'}
            className="mt-2 block w-full resize-none rounded-lg bg-black/30 p-2 text-base text-white ring-1 ring-white/10 placeholder:text-white/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8] sm:text-sm"
          />
        </>
      ) : segments.length === 0 ? (
        <p className="text-xs text-white/70">No rundown for this room. Write one before the next take.</p>
      ) : (
        <>
          <div className="flex items-baseline gap-3">
            <p role="status" title={current?.name} className="min-w-0 flex-1 truncate text-sm font-medium">
              {current ? (
                <>
                  <span className="text-white/70">{`${(index ?? 0) + 1} of ${segments.length}`}</span>{' '}
                  {current.name}
                </>
              ) : (
                'Rundown not started'
              )}
            </p>
          </div>
          <div className="mt-2 flex items-center justify-end gap-2">
            {/* Always here, so pressing it again and again never loses the
                keyboard's place; after the last segment it is switched off. */}
            <button
              type="button"
              disabled={!next}
              onClick={() => go(target)}
              className="inline-flex h-11 min-w-0 max-w-[60%] items-center rounded-full bg-white px-4 text-sm font-medium text-[#202124] enabled:hover:bg-white/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8] disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/60 sm:h-9"
            >
              <span className="truncate">
                {next ? `${index === null ? 'Start' : 'Next'}: ${next.name}` : 'Last segment'}
              </span>
            </button>
          </div>
        </>
      )}
    </section>
  );
}
