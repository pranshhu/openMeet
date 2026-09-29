'use client';

import { useEffect, useState } from 'react';

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
  className = 'top-3',
}: {
  recording: boolean;
  host: boolean;
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
        className="flex items-center gap-3 rounded-full bg-[#ea4335] px-5 py-2.5 text-sm font-medium text-white shadow-2xl"
      >
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full bg-white"
          style={{ animation: 'om-rec-pulse 1.4s ease-in-out infinite' }}
        />
        {host ? 'Recording started' : 'This call is now being recorded'}
      </div>
    </div>
  );
}
