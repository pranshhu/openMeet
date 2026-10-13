'use client';

import { useState } from 'react';
import { LOOK_ACCENTS, isLookAccent } from '@openmeet/protocol';
import { readLook, saveLook } from '@/lib/look';

const LABEL = { blue: 'Blue', red: 'Red', green: 'Green', yellow: 'Yellow', purple: 'Purple', pink: 'Pink' };

/**
 * The colour of the name tags, chosen in the host's lobby. It is saved when
 * chosen and sent to the room by the call page when this tab joins, so a
 * change after joining waits for the next join.
 */
export function ShowLook({ slug }: { slug: string }) {
  const [accent, setAccent] = useState(() => readLook(slug).accent ?? '');

  return (
    <div className="flex w-full flex-col gap-1.5 text-left">
      <label className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg border border-[#dadce0] px-3 py-2 text-base text-[#5f6368] focus-within:border-[#0b57d0] focus-within:ring-1 focus-within:ring-[#0b57d0] sm:text-sm">
        <select
          aria-label="Name tag colour"
          aria-describedby="show-look-hint"
          value={accent}
          onChange={(e) => {
            const next = isLookAccent(e.target.value) ? e.target.value : '';
            setAccent(next);
            saveLook(slug, next ? { accent: next } : {});
          }}
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
      <p id="show-look-hint" className="px-1 text-xs leading-relaxed text-[#5f6368]">
        Everyone in the call sees it. To change it, leave and join again.
      </p>
    </div>
  );
}
