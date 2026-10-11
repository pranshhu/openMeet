'use client';

import { useEffect, useMemo, useState } from 'react';
import { MAX_RUNDOWN_LENGTH, loadRundown, parseRundown, saveRundown } from '@/lib/rundown';
import { formatTimecode } from '@/lib/sync-report';

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
  // The segment chosen to start next, when it is not the one that follows.
  const [picked, setPicked] = useState<number | null>(null);
  // When the running segment started, on this page's clock. Kept here and not
  // in the clock, which is unmounted while the strip is hidden.
  const [since, setSince] = useState(0);
  // Every take starts its rundown over.
  useEffect(() => {
    if (!recording) {
      setIndex(null);
      setPicked(null);
    }
  }, [recording]);

  function go(i: number) {
    const segment = segments[i];
    if (!segment) return;
    setIndex(i);
    setPicked(null);
    setSince(Date.now());
    onMark(segment.name);
  }

  if (!open) return null;
  const current = index === null ? undefined : segments[index];
  const target = picked ?? (index === null ? 0 : index + 1);
  const next = segments[target];
  const planned = segments.reduce((sum, s) => sum + (s.plannedMs ?? 0), 0);
  return (
    <section
      aria-label="Rundown"
      className="mb-2 w-full max-w-md rounded-2xl bg-[#2a2b2e] px-4 py-3 text-white ring-1 ring-white/5"
    >
      {!recording ? (
        <>
          <h2 className="text-sm font-medium">Rundown</h2>
          <p id="rundown-hint" className="text-xs text-white/70">
            One segment per line; end a line with its planned length, like 2:00. During a take, each segment you start adds a chapter marker.
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
            placeholder={'Intro 2:00\nInterview 20:00\nQuestions'}
            className="mt-2 block w-full resize-none rounded-lg bg-black/30 p-2 text-base text-white ring-1 ring-white/10 placeholder:text-white/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8] sm:text-sm"
          />
          {/* What was understood: a length typed another way is part of the name. */}
          {segments.length > 0 && (
            <p className="mt-1 text-xs text-white/70">
              {`${segments.length} segment${segments.length === 1 ? '' : 's'}${
                planned ? `, ${formatTimecode(planned)} planned` : ''
              }`}
            </p>
          )}
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
            {current && <SegmentClock since={since} plannedMs={current.plannedMs} />}
          </div>
          <div className="mt-2 flex items-center justify-end gap-2">
            {/* Choosing here starts nothing: a keyboard moves through a list one row
                at a time, and a row passed on the way must not become a marker. */}
            <select
              aria-label="Segment to start next"
              title="Segment to start next"
              value={next ? target : ''}
              onChange={(e) => setPicked(Number(e.target.value))}
              className="h-11 min-w-0 flex-1 rounded-full bg-[#3c4043] px-3 text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8] sm:h-9"
            >
              {!next && (
                <option value="" disabled>
                  End of the rundown
                </option>
              )}
              {segments.map((s, i) => (
                <option key={i} value={i}>
                  {`${i + 1}. ${optionName(s.name)}`}
                </option>
              ))}
            </select>
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

/**
 * How long the running segment has run, against its planned length when it has
 * one. On screen only while the strip is shown, so nothing ticks for a hidden
 * rundown; `since` comes from the strip's owner, which outlives it.
 */
function SegmentClock({ since, plannedMs }: { since: number; plannedMs: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsed = now - since;
  // Whole seconds: a segment a few milliseconds past its length is not over yet.
  const over = plannedMs !== null ? Math.floor((elapsed - plannedMs) / 1000) : 0;
  // aria-live off, like the take's own clock: read out every second it would
  // drown out the announcements that matter.
  return (
    <span role="timer" aria-live="off" className="shrink-0 text-sm tabular-nums text-white/80">
      {formatTimecode(elapsed)}
      {plannedMs !== null && ` / ${formatTimecode(plannedMs)}`}
      {/* In words as well as in colour. */}
      {over > 0 && <span className="text-[#fdd663]">{` ${formatTimecode(over * 1000)} over`}</span>}
    </span>
  );
}

// A native list is as wide as its longest row, so a long name is cut there.
// The marker and the line above the list carry it whole.
function optionName(name: string): string {
  return name.length > 30 ? `${name.slice(0, 29)}…` : name;
}
