/**
 * The calendar entry a host makes for a session in a room: a calendar file and
 * the address that fills in Google Calendar's own form. Both are built in the
 * page from the room's link and a start time. The room knows nothing of it.
 */

/** How long the entry lasts. A calendar can change it; the room link works at any hour. */
export const SESSION_MS = 60 * 60 * 1000;

const TITLE = 'Recording session';

/**
 * What the guest reads in the entry. ASCII only: a line of the file holds at
 * most 75 octets, and with one octet to a character it can be cut by length.
 */
export function inviteText(link: string): string {
  return [
    'Join here at the start time:',
    link,
    '',
    'Before you join:',
    '- Use Chrome or Edge on a computer.',
    '- Wear headphones.',
    '- Sit in a quiet room.',
    '',
    "The host can record this session. If they do, your camera, microphone and chat are saved on the host's computer. Nothing is uploaded to a server, and you are told on screen when recording starts.",
  ].join('\n');
}

// 2026-10-20T15:00:00.000Z becomes 20261020T150000Z, the UTC form both calendars read.
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, '');

// A text value keeps a backslash, a semicolon and a comma behind a backslash,
// and writes a line break as \n.
const text = (s: string) => s.replace(/[\\;,]/g, '\\$&').replace(/\n/g, '\\n');

// A line longer than 75 octets goes on in a next line that starts with a space.
const fold = (line: string) => (line.match(/.{1,73}/g) ?? []).join('\r\n ');

/**
 * The calendar file (RFC 5545): one event, in UTC, so every calendar shows it
 * in its own zone. `startMs` is a real time; the caller checks it.
 */
export function buildIcs(link: string, startMs: number, nowMs = Date.now()): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//openMeet//Calendar entry//EN',
    'BEGIN:VEVENT',
    // The same room and hour are the same entry, so a second import replaces the first.
    `UID:${text(`${link}#${stamp(startMs)}`)}`,
    `DTSTAMP:${stamp(nowMs)}`,
    `DTSTART:${stamp(startMs)}`,
    `DTEND:${stamp(startMs + SESSION_MS)}`,
    `SUMMARY:${text(TITLE)}`,
    `LOCATION:${text(link)}`,
    `DESCRIPTION:${text(inviteText(link))}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ]
    .map(fold)
    .join('\r\n');
}

/** Google Calendar's new-event form, filled in with the same entry. */
export function googleCalendarUrl(link: string, startMs: number): string {
  const query = new URLSearchParams({
    action: 'TEMPLATE',
    text: TITLE,
    dates: `${stamp(startMs)}/${stamp(startMs + SESSION_MS)}`,
    details: inviteText(link),
    location: link,
  });
  return `https://calendar.google.com/calendar/render?${query.toString()}`;
}
