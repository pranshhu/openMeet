'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MAX_SCRIPT_LENGTH } from '@openmeet/protocol';
import { Icon } from './Icon';

/**
 * Script overlay, positioned high on the stage so the reader's eyeline stays
 * near the camera.
 *
 * Each person's script is their own: the text lives in localStorage keyed by
 * room, and nothing about it reaches the recording. It leaves this browser
 * only when a host presses Send to everyone, and a script that arrives that
 * way replaces nothing until the person presses Use it.
 */

const key = (slug: string) => `om_prompter_${slug}`;
// Position is a UI preference, not room content — one placement for every room.
const POS_KEY = 'om_prompter_pos';

export interface Point {
  x: number;
  y: number;
}

/**
 * Keep the panel fully on screen.
 *
 * Without this a drag (or shrinking the window afterwards) can strand the panel
 * past the edge, where its header — the only drag handle — is unreachable and
 * there is no way to get it back.
 */
export function clampToViewport(x: number, y: number, w: number, h: number, vw: number, vh: number): Point {
  return {
    x: Math.min(Math.max(0, x), Math.max(0, vw - w)),
    y: Math.min(Math.max(0, y), Math.max(0, vh - h)),
  };
}

/** Buttons and sliders in the header must not start a drag. */
function isInteractive(el: EventTarget | null): boolean {
  return el instanceof Element && el.closest('button, input, select, textarea, a') !== null;
}

/** Whole minutes to read `text` aloud at 150 words a minute, a usual speaking pace. */
export function readingMinutes(text: string): number {
  // Words are what spaces separate, so a script in a language written
  // without them counts as one word and reads as a minute.
  return Math.ceil((text.match(/\S+/g)?.length ?? 0) / 150);
}

export function Teleprompter({
  slug,
  onClose,
  incoming = null,
  onIncomingDone,
  onSend,
}: {
  slug: string;
  onClose: () => void;
  /** A script the host sent that this person has not answered; null when none. */
  incoming?: string | null;
  /** The person took the offered script or turned it down. */
  onIncomingDone?: (() => void) | undefined;
  /** Host only: offer this script to everyone else. False when it did not go out. */
  onSend?: ((text: string) => boolean) | undefined;
}) {
  const [text, setText] = useState('');
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(40); // px/sec
  const [fontSize, setFontSize] = useState(28);
  const [opacity, setOpacity] = useState(0.85);
  const [editing, setEditing] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // null = the default centred-at-top placement; set once the user drags.
  const [pos, setPos] = useState<Point | null>(null);
  const [dragging, setDragging] = useState(false);
  const grab = useRef<{ dx: number; dy: number } | null>(null);
  // Sub-pixel accumulator: at slow speeds a whole-pixel step per tick stutters.
  const carry = useRef(0);
  // What the last Send did, for the line under the editor. An edit clears
  // it: the line is about the text that was sent.
  const [sent, setSent] = useState<boolean | null>(null);
  // Counted when the text changes, not on every render: a drag renders on
  // every pointer move.
  const minutes = useMemo(() => readingMinutes(text), [text]);
  const incomingMinutes = useMemo(() => readingMinutes(incoming ?? ''), [incoming]);
  const tooLong = text.length > MAX_SCRIPT_LENGTH;
  const sendNote = tooLong
    ? `Too long to send: ${MAX_SCRIPT_LENGTH.toLocaleString('en-US')} characters at most.`
    : sent === true
      ? 'Sent. The others can use it or ignore it.'
      : sent === false
        ? 'Not sent: no connection. Try again in a moment.'
        : null;

  useEffect(() => {
    try {
      const saved = localStorage.getItem(key(slug));
      if (saved) setText(saved);
      else setEditing(true);
    } catch {
      setEditing(true);
    }
  }, [slug]);

  useEffect(() => {
    try {
      localStorage.setItem(key(slug), text);
    } catch {
      /* private mode — the script just doesn't persist */
    }
  }, [slug, text]);

  useEffect(() => {
    if (!playing) return;
    const TICK = 33;
    const id = setInterval(() => {
      const el = scrollRef.current;
      if (!el) return;
      carry.current += (speed * TICK) / 1000;
      const step = Math.floor(carry.current);
      if (step < 1) return;
      carry.current -= step;
      el.scrollTop += step;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) setPlaying(false);
    }, TICK);
    return () => clearInterval(id);
  }, [playing, speed]);

  // Clamped on the way in: the placement is global, so one saved on a wider
  // window would otherwise reopen off screen here. Layout effect, so the
  // panel never paints at the stale spot first.
  useLayoutEffect(() => {
    try {
      const saved = localStorage.getItem(POS_KEY);
      const el = panelRef.current;
      if (!saved || !el) return;
      const p = JSON.parse(saved) as Point;
      setPos(clampToViewport(p.x, p.y, el.offsetWidth, el.offsetHeight, innerWidth, innerHeight));
    } catch {
      /* unset or unparseable — fall back to the default placement */
    }
  }, []);

  // Shrinking the window can put a previously-valid position off screen, which
  // would leave the panel unreachable. Pull it back in.
  useEffect(() => {
    const onResize = () => {
      const el = panelRef.current;
      if (!el) return;
      setPos((prev) =>
        prev
          ? clampToViewport(prev.x, prev.y, el.offsetWidth, el.offsetHeight, innerWidth, innerHeight)
          : prev
      );
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (isInteractive(e.target)) return;
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    grab.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    setDragging(true);
    // Capture so the drag survives the pointer outracing the handle.
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const g = grab.current;
    const el = panelRef.current;
    if (!g || !el) return;
    setPos(
      clampToViewport(e.clientX - g.dx, e.clientY - g.dy, el.offsetWidth, el.offsetHeight, innerWidth, innerHeight)
    );
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!grab.current) return;
    grab.current = null;
    setDragging(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
    // Persist on release only — writing on every move would thrash storage.
    try {
      if (pos) localStorage.setItem(POS_KEY, JSON.stringify(pos));
    } catch {
      /* private mode — the placement just doesn't persist */
    }
  }

  const restart = () => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    carry.current = 0;
  };

  // The one place the host's script replaces this person's own: their click.
  const take = () => {
    if (incoming === null) return;
    setText(incoming);
    setEditing(false);
    setPlaying(false);
    restart();
    onIncomingDone?.();
  };

  return (
    <div
      ref={panelRef}
      className={`pointer-events-auto absolute z-20 max-w-3xl overflow-hidden rounded-xl ring-1 ring-white/10 backdrop-blur ${
        pos ? '' : 'inset-x-2 top-2 mx-auto sm:inset-x-4'
      }`}
      // The backdrop fades, never the whole panel: faded with it, the controls
      // and the close button got hard to find.
      style={{
        ...(pos ? { left: pos.x, top: pos.y, right: 'auto', width: 'min(48rem, calc(100vw - 1rem))' } : {}),
        backgroundColor: `rgba(0,0,0,${opacity})`,
      }}
    >
      {/* Header doubles as the drag handle. touch-none is load-bearing: without
          it a touch drag scrolls the page instead of moving the panel, and the
          pointermove events never arrive at all. Its own dark strip keeps the
          controls readable however far the Backdrop slider fades the rest. */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={`flex touch-none flex-wrap items-center gap-2 border-b border-white/10 bg-black/80 px-3 py-1.5 text-xs text-white/70 ${
          dragging ? 'cursor-grabbing' : 'cursor-grab'
        }`}
        title="Drag to move"
      >
        {/* Play leaves the editor: the box it scrolls only exists outside it,
            so Play used to say Pause while nothing moved. Editing pauses. */}
        <button
          onClick={() => {
            setEditing(false);
            setPlaying((p) => !p);
          }}
          disabled={!text.trim()}
          className="min-h-11 rounded-full bg-white px-3 py-1.5 font-medium text-[#202124] enabled:hover:bg-white/90 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/40 sm:min-h-0"
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        {/* Nothing to rewind in the editor, or with no script. */}
        <button
          onClick={restart}
          disabled={editing || !text.trim()}
          className="min-h-11 rounded-full bg-white/10 px-3 py-1.5 text-white enabled:hover:bg-white/15 disabled:cursor-not-allowed disabled:text-white/40 sm:min-h-0"
        >
          Restart
        </button>
        <button
          onClick={() => {
            setEditing((e) => !e);
            setPlaying(false);
          }}
          className="min-h-11 rounded-full bg-white/10 px-3 py-1.5 text-white hover:bg-white/15 sm:min-h-0"
        >
          {editing ? 'Done' : 'Edit'}
        </button>
        <label className="ml-1 flex items-center gap-1">
          Speed
          <input
            type="range" min={10} max={150} value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            className="w-16 accent-[#8ab4f8] sm:w-24" aria-label="Scroll speed"
          />
        </label>
        <label className="flex items-center gap-1">
          Size
          <input
            type="range" min={16} max={56} value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
            className="w-14 accent-[#8ab4f8] sm:w-20" aria-label="Font size"
          />
        </label>
        <label className="flex items-center gap-1">
          Backdrop
          <input
            type="range" min={30} max={100} value={Math.round(opacity * 100)}
            onChange={(e) => setOpacity(Number(e.target.value) / 100)}
            className="w-14 accent-[#8ab4f8] sm:w-20" aria-label="Backdrop opacity"
          />
        </label>
        <button
          onClick={onClose}
          className="ml-auto rounded-full p-3.5 hover:bg-white/10 sm:p-2"
          aria-label="Close teleprompter"
        >
          <Icon name="close" className="h-4 w-4" />
        </button>
      </div>

      {incoming !== null && (
        <div
          role="group"
          aria-label="Script from the host"
          className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-black/80 px-3 py-1.5 text-xs text-white"
        >
          <span className="min-w-40 flex-1">
            {`The host sent a script, about ${incomingMinutes} min to read.`}
            {text.trim() ? ' Using it replaces yours.' : ''}
          </span>
          <button
            type="button"
            onClick={take}
            className="min-h-11 rounded-full bg-white px-3 py-1.5 font-medium text-[#202124] hover:bg-white/90 sm:min-h-0"
          >
            Use it
          </button>
          <button
            type="button"
            onClick={() => onIncomingDone?.()}
            className="min-h-11 rounded-full bg-white/10 px-3 py-1.5 text-white hover:bg-white/15 sm:min-h-0"
          >
            Ignore
          </button>
        </div>
      )}
      {editing ? (
        <>
          <label htmlFor="teleprompter-script" className="sr-only">
            Teleprompter script
          </label>
          <textarea
            id="teleprompter-script"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSent(null);
            }}
            placeholder="Paste your script or talking points…"
            className="h-48 w-full resize-none bg-transparent p-3 text-base text-white outline-none placeholder:text-white/60 sm:text-sm"
          />
          {/* Under the script, where it is written. Its own dark strip, like the
              header's, so it stays readable however far the backdrop fades. */}
          {(minutes > 0 || onSend) && (
            <div className="flex flex-wrap items-center gap-x-3 border-t border-white/10 bg-black/80 px-3 py-1.5 text-xs text-white/70">
              <span className="flex-1">{minutes > 0 ? `About ${minutes} min to read` : ''}</span>
              {onSend && (
                <>
                  <button
                    type="button"
                    onClick={() => setSent(onSend(text))}
                    disabled={!text.trim() || tooLong}
                    className="min-h-11 rounded-full bg-white/10 px-3 py-1.5 text-white enabled:hover:bg-white/15 disabled:cursor-not-allowed disabled:text-white/40 sm:min-h-0"
                  >
                    Send to everyone
                  </button>
                  {/* Mounted whether or not it has something to say: many screen
                      readers skip a live region inserted along with its text. */}
                  <div role="status" className="basis-full">
                    {sendNote && <p className="pt-1">{sendNote}</p>}
                  </div>
                </>
              )}
            </div>
          )}
        </>
      ) : (
        <div
          ref={scrollRef}
          className="h-48 overflow-y-auto px-4 py-3 leading-relaxed text-white sm:h-56"
          style={{ fontSize }}
        >
          {text ? (
            <p className="whitespace-pre-wrap">{text}</p>
          ) : (
            <p className="text-base text-white/60">No script yet — press Edit.</p>
          )}
          {/* Trailing space so the last line can scroll to the middle of the panel. */}
          <div aria-hidden className="h-32" />
        </div>
      )}
    </div>
  );
}
