'use client';

import { useState } from 'react';
import { LOOK_ACCENTS, isLookAccent, type LookAccent } from '@openmeet/protocol';
import { logoFrom, lookFrom, readLook, saveLook } from '@/lib/look';

const LABEL = { blue: 'Blue', red: 'Red', green: 'Green', yellow: 'Yellow', purple: 'Purple', pink: 'Pink' };

const BUTTON =
  'flex min-h-11 cursor-pointer items-center rounded-lg border border-[#dadce0] px-3 py-2 text-base text-[#0b57d0] hover:bg-[#f6f8fc] focus-within:border-[#0b57d0] focus-within:ring-1 focus-within:ring-[#0b57d0] sm:text-sm';

/**
 * The colour of the name tags and the logo, chosen in the host's lobby. Each is
 * saved when chosen and sent to the room by the call page when this tab joins,
 * so a change after joining waits for the next join.
 */
export function ShowLook({ slug }: { slug: string }) {
  const [look, setLook] = useState(() => readLook(slug));
  const [refused, setRefused] = useState(false);

  // Built from what is saved, so a colour picked while a picture is still
  // being read is not lost.
  function change(patch: { accent?: LookAccent | undefined; logo?: string | undefined }) {
    const next = lookFrom({ ...readLook(slug), ...patch });
    setLook(next);
    saveLook(slug, next);
  }

  async function pickLogo(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const logo = await logoFrom(file);
    setRefused(logo === null);
    if (logo !== null) change({ logo });
  }

  return (
    <div className="flex w-full flex-col gap-1.5 text-left">
      <label className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg border border-[#dadce0] px-3 py-2 text-base text-[#5f6368] focus-within:border-[#0b57d0] focus-within:ring-1 focus-within:ring-[#0b57d0] sm:text-sm">
        <select
          aria-label="Name tag colour"
          aria-describedby="show-look-hint"
          value={look.accent ?? ''}
          onChange={(e) => change({ accent: isLookAccent(e.target.value) ? e.target.value : undefined })}
          className="w-full min-w-0 bg-transparent text-[#202124] outline-none"
        >
          <option value="">No colour</option>
          {LOOK_ACCENTS.map((a) => (
            <option key={a} value={a}>
              {LABEL[a]}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {look.logo && <img src={look.logo} alt="Your logo" className="h-10 w-auto max-w-24 object-contain" />}
        <label className={BUTTON}>
          {look.logo ? 'Change logo' : 'Add a logo'}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-describedby="show-look-hint"
            onChange={(e) => void pickLogo(e.currentTarget)}
            className="sr-only"
          />
        </label>
        {look.logo && (
          <button type="button" onClick={() => change({ logo: undefined })} className={BUTTON}>
            Remove logo
          </button>
        )}
      </div>
      {refused && (
        <p role="alert" className="px-1 text-xs leading-relaxed text-[#b3261e]">
          Could not use that picture. Try a PNG or a JPEG.
        </p>
      )}
      <p id="show-look-hint" className="px-1 text-xs leading-relaxed text-[#5f6368]">
        Everyone in the call sees it. To change it, leave and join again.
      </p>
    </div>
  );
}
