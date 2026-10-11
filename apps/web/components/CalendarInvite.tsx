'use client';

import { useState } from 'react';
import { buildIcs, googleCalendarUrl } from '@/lib/calendar-invite';
import { Icon } from './Icon';

const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0b57d0]';
// 44px tall and one above the other: two side by side do not fit a phone.
const action = `inline-flex min-h-11 w-full items-center justify-center rounded-full px-4 text-sm font-medium text-[#0b57d0] ring-1 ring-inset ring-[#dadce0] transition-colors hover:bg-[#0b57d0]/10 ${focus}`;

/**
 * A calendar entry for a session in this room, behind a button in the host's
 * lobby: a file any calendar opens, and Google Calendar's own form filled in.
 * Both are made in the page. Nothing is stored, and the room is told
 * nothing: it knows no date.
 */
export function CalendarInvite({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState('');
  // The picker's value names no zone, so it is read on this computer's clock.
  const startMs = when ? new Date(when).getTime() : NaN;
  // origin+pathname is the plain invite link, whatever query this page has.
  // Read only once a start is picked, which no server render reaches.
  const link = Number.isFinite(startMs) ? `${location.origin}${location.pathname}` : null;

  return (
    <div className="flex w-full flex-col items-center gap-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`inline-flex min-h-11 items-center gap-1 rounded-full px-4 text-sm font-medium text-[#0b57d0] transition-colors hover:bg-[#0b57d0]/10 ${focus}`}
      >
        Add to calendar
        <Icon name={open ? 'arrow_drop_up' : 'arrow_drop_down'} size={20} />
      </button>
      {open && (
        <div className="flex w-full flex-col gap-3 rounded-3xl border border-[#e1e5ea] bg-[#f8fafd] px-5 py-4 text-left">
          <label className="flex flex-col gap-1.5 text-sm font-medium text-[#202124]">
            Session start
            <input
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              className="min-h-11 w-full rounded-lg border border-[#dadce0] bg-white px-3 text-base font-normal outline-none focus:border-[#0b57d0] focus:ring-1 focus:ring-[#0b57d0]"
            />
          </label>
          {link && (
            <>
              <a
                href={`data:text/calendar;charset=utf-8,${encodeURIComponent(buildIcs(link, startMs))}`}
                download={`openmeet-${slug}.ics`}
                className={action}
              >
                Download calendar file (.ics)
              </a>
              <a href={googleCalendarUrl(link, startMs)} target="_blank" rel="noopener noreferrer" className={action}>
                Open in Google Calendar
              </a>
            </>
          )}
          <p className="text-[13px] leading-relaxed text-[#5f6368]">
            The entry lasts one hour, at the time on this computer’s clock, and holds the room link and a
            short checklist for your guest. Anyone who can read the entry can join the room. On the day,
            open the room in this browser: you are its host only here.
          </p>
        </div>
      )}
    </div>
  );
}
