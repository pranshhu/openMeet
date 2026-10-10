'use client';

import { useId, useState } from 'react';
import type { RemotePeer } from '@/hooks/useRoom';
import { Icon } from './Icon';

const rowButton =
  'min-h-11 shrink-0 rounded-full px-3 text-xs font-medium text-white ring-1 ring-white/30 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8] sm:min-h-8';

/**
 * The host's list of everyone else in the call, opened from the control bar
 * and laid out like the media board. Each row carries its own buttons,
 * reached with Tab.
 */
export function PeoplePanel({
  people,
  recording = false,
  onMute,
  onRemove,
  onClose,
}: {
  people: RemotePeer[];
  /** A take is running or can still be resumed, so removing a recorded person ends their files here. */
  recording?: boolean;
  /** Ask for this person's microphone to be turned off. */
  onMute: (peerId: string) => void;
  /** Remove this person from the room. Without it no row offers Remove. */
  onRemove?: ((peerId: string) => void) | undefined;
  onClose: () => void;
}) {
  // The person whose removal is being asked about, by peer id. Asked in the
  // row: a blocking dialog would stall this tab, which writes the take.
  const [asking, setAsking] = useState<string | null>(null);
  const questionId = useId();
  return (
    <section
      aria-label="People"
      className="pointer-events-auto absolute inset-x-2 bottom-24 z-20 mx-auto max-w-md rounded-xl bg-black/85 p-3 ring-1 ring-white/10 backdrop-blur sm:inset-x-auto sm:bottom-40 sm:left-6 sm:w-80"
    >
      <div className="mb-1 flex items-center">
        <span className="text-sm font-medium text-white">People</span>
        {/* Focus comes here when the panel opens, so the rows are the next Tab. */}
        <button
          type="button"
          autoFocus
          onClick={onClose}
          aria-label="Close people"
          className="ml-auto rounded-full p-3.5 text-white hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8] sm:p-2"
        >
          <Icon name="close" className="h-4 w-4" />
        </button>
      </div>
      <ul className="max-h-[40dvh] overflow-y-auto">
        {people.map((p) => {
          const name = p.name || 'Guest';
          // A producer and a present-only device join with no microphone.
          const hasMic = p.role !== 'producer' && !p.companion;
          const label =
            p.role === 'producer' ? `${name} (Producer)` : p.companion ? `${name} (Presenting)` : name;
          // Until their first presence arrives a person counts as unmuted.
          const micOn = p.presence?.micOn !== false;
          if (onRemove && asking === p.peerId) {
            // A producer is in no file, and neither is a guest set as not recorded.
            const ends = recording && p.role !== 'producer' && !p.notRecorded;
            return (
              <li key={p.peerId} className="py-1.5 text-sm text-white">
                <p id={questionId} className="text-xs text-[#fdd663] wrap-anywhere">
                  {ends
                    ? `Remove ${name}? Their recording here ends now, and their tab can’t rejoin this call.`
                    : `Remove ${name}? Their tab can’t rejoin this call.`}
                </p>
                {/* Cancel is last, at the row's right end where Remove was: a
                    second click there never confirms. */}
                <div className="mt-1 flex justify-end gap-2">
                  <button
                    type="button"
                    aria-label={`Remove ${name} from the call`}
                    aria-describedby={questionId}
                    onClick={() => {
                      setAsking(null);
                      onRemove(p.peerId);
                    }}
                    className={`${rowButton} bg-[#ea4335] hover:bg-[#d33426]`}
                  >
                    Remove
                  </button>
                  <button
                    type="button"
                    autoFocus
                    aria-describedby={questionId}
                    onClick={() => setAsking(null)}
                    className={`${rowButton} hover:bg-white/10`}
                  >
                    Cancel
                  </button>
                </div>
              </li>
            );
          }
          return (
            <li key={p.peerId} className="flex min-h-11 items-center gap-2 text-sm text-white">
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {hasMic && (
                // The same button once they are muted, so focus stays where it was.
                <button
                  type="button"
                  aria-disabled={!micOn}
                  aria-label={micOn ? `Mute ${name}` : `${name} is muted`}
                  onClick={() => micOn && onMute(p.peerId)}
                  className={`${rowButton} ${micOn ? 'hover:bg-white/10' : 'cursor-default opacity-50'}`}
                >
                  {micOn ? 'Mute' : 'Muted'}
                </button>
              )}
              {onRemove && (
                <button
                  type="button"
                  aria-label={`Remove ${name}`}
                  onClick={() => setAsking(p.peerId)}
                  className={`${rowButton} hover:bg-white/10`}
                >
                  Remove
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
