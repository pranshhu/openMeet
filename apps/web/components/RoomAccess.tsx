'use client';

import { useId } from 'react';
import type { RoomAccess as Access } from '@/lib/room-access';

/**
 * The host's lock and waiting room, drawn in the People panel. Each box follows
 * what the Room last said: a click asks for the opposite and changes nothing
 * here, so a tick the Room did not get never shows as set.
 */
export function RoomAccess({
  access,
  onChange,
}: {
  access: Access;
  onChange: (change: { locked: boolean } | { waitingRoom: boolean }) => void;
}) {
  const hintId = useId();
  const waitingHintId = useId();
  const box =
    'h-4 w-4 accent-[#8ab4f8] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]';
  const label = 'flex min-h-11 items-center gap-3 whitespace-nowrap text-sm text-white';
  return (
    <div className="mb-1 border-b border-white/10 pb-2">
      <label className={label}>
        <input
          type="checkbox"
          checked={access.locked}
          aria-describedby={hintId}
          onChange={() => onChange({ locked: !access.locked })}
          className={box}
        />
        Lock the room
      </label>
      <p id={hintId} className="text-xs text-white/70">
        Nobody new can join. People already here can reconnect.
      </p>
      <label className={label}>
        <input
          type="checkbox"
          checked={access.waitingRoom}
          aria-describedby={waitingHintId}
          onChange={() => onChange({ waitingRoom: !access.waitingRoom })}
          className={box}
        />
        Waiting room
      </label>
      <p id={waitingHintId} className="text-xs text-white/70">
        New people wait until you let them in.
      </p>
    </div>
  );
}
