'use client';

import { useId, useState } from 'react';

/**
 * The noise suppression choice as one row of the call's microphone menu. It is for
 * what the others hear: the box says so, and why it is off when it cannot be used.
 */
export function NoiseRow({
  checked,
  unavailable,
  boardInUse,
  takeActive,
  onChange,
}: {
  checked: boolean;
  unavailable: boolean;
  boardInUse: boolean;
  takeActive: boolean;
  onChange: (on: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const noteId = useId();
  const refused = unavailable || boardInUse;
  const note = unavailable
    ? 'Not available in this browser.'
    : boardInUse
      ? 'Not with the media board in use.'
      : takeActive
        ? 'Change it between takes.'
        : 'For the call only. Your recording stays raw.';
  return (
    <label className="mb-1 flex min-h-11 items-start gap-2 border-b border-white/10 px-3 py-1.5 text-sm text-white">
      <input
        type="checkbox"
        aria-label="Noise suppression"
        aria-describedby={noteId}
        checked={checked && !refused}
        disabled={refused || takeActive || busy}
        onChange={async (e) => {
          setBusy(true);
          try {
            await onChange(e.target.checked);
          } finally {
            setBusy(false);
          }
        }}
        className="mt-1 h-4 w-4 shrink-0 accent-[#8ab4f8] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]"
      />
      <span className="min-w-0">
        <span className="block">Noise suppression</span>
        <span id={noteId} className="block text-xs text-white/70">
          {note}
        </span>
      </span>
    </label>
  );
}
