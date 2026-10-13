'use client';

import type { HelpAsk as Ask } from '@openmeet/protocol';

const button =
  'min-h-11 rounded-full px-3 text-xs font-medium text-white ring-1 ring-white/30 transition-colors hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8] sm:min-h-8';

/**
 * The host's request to this person, asked on their own screen. It takes no
 * focus when it appears, so a person who is speaking or typing is not
 * interrupted, and nothing happens until they press a button.
 */
export function HelpAsk({
  recording,
  onRestart,
  onDismiss,
}: {
  /** What the host asked for. Only a restart of the connection exists. */
  ask: Ask;
  /** This page's own capture is running. */
  recording: boolean;
  onRestart: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      className="mb-1 flex max-w-[92vw] flex-wrap items-center justify-center gap-2 self-center rounded-2xl bg-black/40 px-3 py-1 text-center text-xs text-[#fdd663]"
    >
      <span>
        The host asks you to restart your connection. The call drops for a few seconds.
        {recording && ' Your recording goes on.'}
      </span>
      <button type="button" onClick={onRestart} className={button}>
        Restart
      </button>
      <button type="button" onClick={onDismiss} className={button}>
        Not now
      </button>
    </div>
  );
}
