'use client';

import { useState } from 'react';
import { resultText, type Check } from '@/lib/preflight';
import { describeTrack } from '@/lib/quality';
import { Icon } from './Icon';

/**
 * Copies what the readiness panel shows as plain text, for a guest to paste
 * into a message to the host. The text goes to the clipboard and nowhere else.
 */
export function CopyCheckResult({ checks, stream }: { checks: Check[]; stream: MediaStream | null }) {
  const [note, setNote] = useState<'copied' | 'failed' | null>(null);

  // Built at the click, so the text is what the panel shows at that moment.
  function copy() {
    const mic = stream?.getAudioTracks()[0];
    const cam = stream?.getVideoTracks()[0];
    const camera = [cam?.label, describeTrack(cam)].filter(Boolean).join(', ');
    const text = resultText(checks, [
      ...(mic?.label ? [`Microphone: ${mic.label}`] : []),
      ...(camera ? [`Camera: ${camera}`] : []),
    ]);
    // No clipboard (plain-http self-host) or permission denied: say so, so the
    // click never does nothing.
    const write = navigator.clipboard?.writeText(text);
    if (!write) return setNote('failed');
    write.then(
      () => setNote('copied'),
      () => setNote('failed')
    );
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={copy}
        className="-ml-3 inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-sm font-medium text-[#0b57d0] transition-colors hover:bg-[#0b57d0]/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0b57d0]"
      >
        <Icon name="copy" size={18} />
        Copy result
      </button>
      {/* Inserted by the press, not rendered empty: a screen reader announces it. */}
      {note && (
        <p
          role={note === 'failed' ? 'alert' : 'status'}
          className={note === 'failed' ? 'text-[#b3261e]' : 'text-[#5f6368]'}
        >
          {note === 'failed'
            ? 'Couldn’t copy. Select the checks above and copy them by hand.'
            : 'Result copied: the checks above and the names of your camera and microphone. Paste it into a message to send it.'}
        </p>
      )}
    </div>
  );
}
