'use client';

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
  onMute,
  onClose,
}: {
  people: RemotePeer[];
  /** Ask for this person's microphone to be turned off. */
  onMute: (peerId: string) => void;
  onClose: () => void;
}) {
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
            </li>
          );
        })}
      </ul>
    </section>
  );
}
