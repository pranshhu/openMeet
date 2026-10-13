'use client';

import { useId } from 'react';
import type { RoomAccess as Access } from '@/lib/room-access';

/**
 * The host's lock on the room, drawn in the People panel. The box follows what
 * the Room last said: a click asks for the opposite and changes nothing here,
 * so a tick the Room did not get never shows as locked.
 */
export function RoomAccess({
  access,
  onChange,
}: {
  access: Access;
  onChange: (change: { locked: boolean }) => void;
}) {
  const hintId = useId();
  return (
    <div className="mb-1 border-b border-white/10 pb-2">
      <label className="flex min-h-11 items-center gap-3 whitespace-nowrap text-sm text-white">
        <input
          type="checkbox"
          checked={access.locked}
          aria-describedby={hintId}
          onChange={() => onChange({ locked: !access.locked })}
          className="h-4 w-4 accent-[#8ab4f8] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]"
        />
        Lock the room
      </label>
      <p id={hintId} className="text-xs text-white/70">
        Nobody new can join. People already here can reconnect.
      </p>
    </div>
  );
}
