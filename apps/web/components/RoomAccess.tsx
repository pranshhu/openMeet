'use client';

import { useId, useState } from 'react';
import { MAX_PASSCODE_LENGTH, MIN_PASSCODE_LENGTH } from '@openmeet/protocol';
import type { RoomAccess as Access } from '@/lib/room-access';

/**
 * The host's lock, waiting room and passcode, drawn in the People panel. Each
 * control follows what the Room last said: a click asks for the opposite and
 * changes nothing here, so a tick the Room did not get never shows as set.
 */
export function RoomAccess({
  access,
  onChange,
}: {
  access: Access;
  onChange: (change: { locked: boolean } | { waitingRoom: boolean } | { passcode: string | null }) => void;
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
      {access.passcode ? (
        <div className="flex flex-col items-start gap-2 py-2">
          <p className="text-xs text-white/70">A passcode is set. openMeet can’t show it again.</p>
          <button type="button" onClick={() => onChange({ passcode: null })} className={`${button} bg-white/10`}>
            Remove passcode
          </button>
        </div>
      ) : (
        <PasscodeField onSet={(passcode) => onChange({ passcode })} />
      )}
    </div>
  );
}

const button =
  'inline-flex min-h-11 items-center rounded-full px-4 text-sm font-medium text-white ring-1 ring-inset ring-white/30 hover:bg-white/15 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]';

/** Shown only while no passcode is set, so what was typed is gone once the Room confirms one. */
function PasscodeField({ onSet }: { onSet: (passcode: string) => void }) {
  const id = useId();
  const hintId = useId();
  const [code, setCode] = useState('');
  return (
    <div className="flex flex-col items-start gap-1 py-2">
      <label htmlFor={id} className="text-sm text-white">
        Passcode
      </label>
      <div className="flex w-full gap-2">
        <input
          id={id}
          type="text"
          autoComplete="off"
          maxLength={MAX_PASSCODE_LENGTH}
          value={code}
          aria-describedby={hintId}
          onChange={(e) => setCode(e.target.value)}
          className="min-h-11 min-w-0 flex-1 rounded-full bg-white/10 px-4 text-sm text-white ring-1 ring-inset ring-white/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]"
        />
        <button
          type="button"
          disabled={code.length < MIN_PASSCODE_LENGTH}
          onClick={() => onSet(code)}
          className={`${button} shrink-0 bg-[#8ab4f8] text-[#202124] hover:bg-[#a8c7fa]`}
        >
          Set passcode
        </button>
      </div>
      <p id={hintId} className="text-xs text-white/70">
        6 to 64 characters. Guests type it before they join.
      </p>
    </div>
  );
}
