'use client';

import { useId, useState, type FormEvent } from 'react';
import { isRoomName, isRoomSlug, MAX_ROOM_NAME_LENGTH } from '@openmeet/protocol';
import { createRoom } from '@/lib/api';
import { storeHostToken } from '@/lib/host-token';

const NOT_A_SLUG = 'Use 3 to 32 lowercase letters, digits or hyphens, starting and ending with a letter or digit.';
const LOOKS_RANDOM = 'That looks like a random room link. Choose another name.';

const LINES: Record<number, string> = {
  400: NOT_A_SLUG,
  409: 'That name is taken. Choose another.',
  429: 'Too many new rooms from this network. Try again in a minute.',
};

/** Typed text as a link name: what a person types as "My Show" is meant as `my-show`. */
const toName = (typed: string) => typed.trim().toLowerCase().replace(/ +/g, '-');

/** The home page's way to make a room whose link the host chose. */
export function NamedRoom() {
  const id = useId();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const name = toName(typed);
    if (!isRoomSlug(name)) return setError(NOT_A_SLUG);
    if (!isRoomName(name)) return setError(LOOKS_RANDOM);
    setBusy(true);
    try {
      const { slug, host_token } = await createRoom(name);
      storeHostToken(slug, host_token);
      window.location.href = `/r/${slug}/`;
    } catch (err) {
      const status = (err as { status?: unknown }).status;
      setError((typeof status === 'number' && LINES[status]) || 'Could not create the room. Try again.');
      setBusy(false);
    }
  }

  return (
    <details className="mt-4 text-left">
      <summary className="inline-flex min-h-[44px] cursor-pointer items-center text-sm font-medium text-[#0b57d0] hover:underline">
        Choose your own link
      </summary>
      <form onSubmit={submit} className="mt-1 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-1 text-[15px] text-[#5f6368]">
          <span aria-hidden="true">/r/</span>
          <label htmlFor={id} className="sr-only">
            Link name
          </label>
          <input
            id={id}
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              setError(null);
            }}
            placeholder="my-show"
            maxLength={MAX_ROOM_NAME_LENGTH}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${id}-hint`}
            className="min-h-[44px] min-w-0 flex-1 rounded-lg border border-[#dadce0] px-3 text-[15px] text-[#202124] focus-visible:outline-2 focus-visible:outline-[#0b57d0]"
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="min-h-[44px] w-full rounded-full bg-[#0b57d0] px-6 text-[15px] font-medium text-white transition-colors hover:bg-[#0842a0] disabled:opacity-50 sm:w-auto"
        >
          {busy ? 'Creating…' : 'Create link'}
        </button>
      </form>
      <p id={`${id}-hint`} className="mt-2 text-sm text-[#5f6368]">
        Lowercase letters, digits and hyphens, 3 to 32. Guests wait until you let them in. The link stays yours while
        it is used at least once every 30 days; after that nobody can use the name again.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-[#ea4335]">
          {error}
        </p>
      )}
    </details>
  );
}
