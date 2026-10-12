'use client';

import { useState } from 'react';
import { SHARED_FILE_ACCEPT, sharedFileProblem } from '@/lib/shared-file';

/**
 * Chat's "Send a file to the host": one file, picked from this device. A file
 * that cannot go is refused here with the reason; nothing of it is offered.
 */
export function SendFile({ onSend }: { onSend: (file: File) => void }) {
  const [refused, setRefused] = useState<string | null>(null);
  return (
    <div className="px-3">
      {/* A label around the input, as for the photo a person presents: the
          input stays reachable by keyboard and the label shows its focus. */}
      <label className="flex min-h-11 cursor-pointer items-center justify-center rounded-full text-sm font-medium text-[#8ab4f8] hover:bg-white/10 focus-within:ring-2 focus-within:ring-[#8ab4f8]">
        <span>Send a file to the host</span>
        <input
          type="file"
          accept={SHARED_FILE_ACCEPT}
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Emptied so that picking the same file again is a change.
            e.target.value = '';
            if (!file) return;
            const why = sharedFileProblem(file);
            setRefused(why);
            if (!why) onSend(file);
          }}
        />
      </label>
      {refused && (
        <p role="alert" className="pb-1 text-center text-xs text-[#f6aea9]">
          {refused}
        </p>
      )}
    </div>
  );
}
