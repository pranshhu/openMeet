'use client';

import { useEffect, useReducer, useState } from 'react';

/** How long the consent toast stays up before it collapses to the REC pill. */
export const NOTICE_MS = 7000;

/**
 * Tell everyone in the room that the call is being recorded.
 *
 * Two parts on purpose. The toast is the announcement — it has to be
 * unmissable at the moment recording starts. The persistent pill in the top
 * bar is the actual disclosure: a notice someone looked away from is not
 * consent, so the state has to stay visible for the whole recording.
 *
 * `role="alert"` rather than "status": this is an interruption by design.
 */
export function RecordingNotice({
  recording,
  host,
  notRecorded = false,
  className = 'top-3',
}: {
  recording: boolean;
  host: boolean;
  /** The host set this viewer as not recorded. */
  notRecorded?: boolean;
  /** Where it sits in its positioned parent. */
  className?: string;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!recording) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const t = setTimeout(() => setVisible(false), NOTICE_MS);
    return () => clearTimeout(t);
  }, [recording]);

  if (!visible) return null;
  return (
    // Floats over the top of the stage (CallStage gives it a positioned parent)
    // so the stage doesn't drop when a take starts and jump back seven seconds later.
    <div className={`pointer-events-none absolute inset-x-0 z-30 flex justify-center px-4 ${className}`}>
      <div
        role="alert"
        className="flex max-w-md items-center gap-3 rounded-3xl bg-[#ea4335] px-5 py-2.5 text-sm font-medium text-white shadow-2xl"
      >
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full bg-white"
          style={{ animation: 'om-rec-pulse 1.4s ease-in-out infinite' }}
        />
        {host
          ? 'Recording started'
          : notRecorded
            ? 'This call is now being recorded. Your camera, microphone, screen and chat are left out.'
            : 'This call and chat are now being recorded'}
      </div>
    </div>
  );
}

/**
 * The seconds before a take, counted down on screen. Display only: the take
 * starts on the host's own timer whether or not this was ever shown, and the
 * figure is read from this tab's clock.
 */
export function RecordingCountdown({
  endsAt,
  className = 'top-3',
}: {
  /** When the take is due, in this tab's own time; null while nothing is counted. */
  endsAt: number | null;
  /** Where it sits in its positioned parent. */
  className?: string;
}) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);

  // Four times a second, so the figure changes within a quarter of a second
  // of its moment, and not at all once the count is over.
  useEffect(() => {
    if (endsAt === null) return;
    const id = setInterval(() => {
      redraw();
      if (Date.now() >= endsAt) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [endsAt]);

  const left = endsAt === null ? 0 : Math.ceil((endsAt - Date.now()) / 1000);
  if (left <= 0) return null;
  return (
    <div className={`pointer-events-none absolute inset-x-0 z-30 flex justify-center px-4 ${className}`}>
      <div
        role="status"
        className="rounded-3xl bg-[#3c4043] px-5 py-2.5 text-sm font-medium tabular-nums text-white shadow-2xl"
      >
        {`Recording starts in ${left}`}
      </div>
    </div>
  );
}
