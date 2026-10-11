import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CalendarInvite } from '@/components/CalendarInvite';
import { Lobby } from '@/components/Lobby';
import { buildIcs, googleCalendarUrl, inviteText } from '@/lib/calendar-invite';

const LINK = 'https://meet.example.org/r/xyz-abcd-pqr/';
// 20 October 2026, 15:00 UTC, in a file made on the 11th.
const START = Date.UTC(2026, 9, 20, 15, 0);
const MADE = Date.UTC(2026, 9, 11, 9, 30, 5);

// What a calendar does with the file: join the folded lines, then take them one by one.
const read = (ics: string) => ics.replace(/\r\n /g, '').split('\r\n');
// And with a text value: take the backslashes back out.
const plain = (value: string) => value.replace(/\\([\\;,n])/g, (_, c: string) => (c === 'n' ? '\n' : c));

describe('calendar entry', () => {
  it('tells the guest where to join, what to prepare and that the session can be recorded', () => {
    const lines = inviteText(LINK).split('\n');
    expect(lines[1]).toBe(LINK);
    expect(lines).toEqual(
      expect.arrayContaining([
        '- Use Chrome or Edge on a computer.',
        '- Wear headphones.',
        '- Sit in a quiet room.',
      ])
    );
    expect(lines.at(-1)).toMatch(/^The host can record this session\. If they do, your camera, microphone and chat/);
    // One octet to a character is what lets the file's lines be cut by length.
    expect(inviteText(LINK)).toMatch(/^[\n\x20-\x7e]*$/);
  });

  it('writes one hour-long event in UTC, at the room link, with that text', () => {
    const lines = read(buildIcs(LINK, START, MADE));
    const description = lines.find((l) => l.startsWith('DESCRIPTION:'))!;
    expect(plain(description.slice('DESCRIPTION:'.length))).toBe(inviteText(LINK));
    expect(lines.indexOf(description)).toBe(10);
    expect(lines.filter((l) => l !== description)).toEqual([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//openMeet//Calendar entry//EN',
      'BEGIN:VEVENT',
      `UID:${LINK}#20261020T150000Z`,
      'DTSTAMP:20261011T093005Z',
      'DTSTART:20261020T150000Z',
      'DTEND:20261020T160000Z',
      'SUMMARY:Recording session',
      `LOCATION:${LINK}`,
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ]);
  });

  it('cuts the file into lines of at most 75 characters that end in CRLF', () => {
    const ics = buildIcs(LINK, START, MADE);
    const physical = ics.split('\r\n');
    // The text is several lines long, so this file has continuation lines.
    expect(physical.filter((l) => l.startsWith(' ')).length).toBeGreaterThan(2);
    for (const line of physical) expect(line.length).toBeLessThanOrEqual(75);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('escapes what a calendar would read as a separator', () => {
    const lines = read(buildIcs('https://meet.example.org/r/a,b;c\\d/', START, MADE));
    expect(lines).toContain('LOCATION:https://meet.example.org/r/a\\,b\\;c\\\\d/');
  });

  it('fills in the Google Calendar form with the same hour, link and text', () => {
    const url = new URL(googleCalendarUrl(LINK, START));
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      action: 'TEMPLATE',
      text: 'Recording session',
      dates: '20261020T150000Z/20261020T160000Z',
      details: inviteText(LINK),
      location: LINK,
    });
  });
});

describe('CalendarInvite', () => {
  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  const toggle = () => screen.getByRole('button', { name: 'Add to calendar' });
  const pick = (value: string) =>
    fireEvent.change(screen.getByLabelText('Session start'), { target: { value } });

  it('stays closed until its button is pressed, and offers no entry without a start', () => {
    render(<CalendarInvite slug="xyz-abcd-pqr" />);
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    // 44px to tap on a phone.
    expect(toggle()).toHaveClass('min-h-11');
    expect(screen.queryByLabelText('Session start')).toBeNull();

    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Session start')).toHaveAttribute('type', 'datetime-local');
    expect(screen.getByLabelText('Session start')).toHaveClass('min-h-11');
    // No time, no entry.
    expect(screen.queryByRole('link')).toBeNull();

    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Session start')).toBeNull();
  });

  it('offers the calendar file and the Google Calendar link once a start is picked', async () => {
    // A query on the host's own page must not get into the entry.
    window.history.pushState({}, '', '/r/xyz-abcd-pqr/?present=1');
    render(<CalendarInvite slug="xyz-abcd-pqr" />);
    fireEvent.click(toggle());
    pick('2026-10-20T14:30');

    const link = `${location.origin}/r/xyz-abcd-pqr/`;
    // The picker's value names no zone: it is 14:30 on this computer's clock.
    const startMs = new Date('2026-10-20T14:30').getTime();

    const file = await screen.findByRole('link', { name: 'Download calendar file (.ics)' });
    expect(file).toHaveAttribute('download', 'openmeet-xyz-abcd-pqr.ics');
    const prefix = 'data:text/calendar;charset=utf-8,';
    const href = file.getAttribute('href')!;
    expect(href.startsWith(prefix)).toBe(true);
    // The line that says when the file was made is the only one that differs.
    const made = (ics: string) => ics.replace(/DTSTAMP:.*\r\n/, '');
    expect(made(decodeURIComponent(href.slice(prefix.length)))).toBe(made(buildIcs(link, startMs)));

    const google = screen.getByRole('link', { name: 'Open in Google Calendar' });
    expect(google).toHaveAttribute('href', googleCalendarUrl(link, startMs));
    expect(google).toHaveAttribute('target', '_blank');
    expect(google).toHaveAttribute('rel', 'noopener noreferrer');

    // 44px tall and as wide as the panel, so they sit one above the other on a phone.
    expect(file).toHaveClass('min-h-11', 'w-full');
    expect(google).toHaveClass('min-h-11', 'w-full');
    expect(
      screen.getByText(
        /Anyone who can read the entry can join the room\. On the day, open the room in this browser: you are its host only here\./
      )
    ).toBeInTheDocument();
  });
});

// The preview tile listens to its stream, so the stream is an EventTarget.
function fakeStream(): MediaStream {
  const tracks = [
    { kind: 'audio', enabled: true, stop: vi.fn() },
    { kind: 'video', enabled: true, stop: vi.fn() },
  ];
  return Object.assign(new EventTarget(), {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  }) as unknown as MediaStream;
}

describe('Lobby: calendar entry', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(fakeStream()),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
    });
  });

  afterEach(() => {
    localStorage.removeItem('om_host_xyz-abcd-pqr');
    vi.unstubAllGlobals();
  });

  it('offers it to the browser that holds the host token, at the end of the join panel', async () => {
    localStorage.setItem('om_host_xyz-abcd-pqr', 'host-tok');
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const button = await screen.findByRole('button', { name: 'Add to calendar' });
    const panel = screen.getByRole('heading', { name: 'Ready to join?' }).parentElement!;
    // Last in the join panel: the backups and an unsaved recording stay above it.
    expect(panel.lastElementChild).toBe(button.parentElement);
  });

  it('does not offer it to a guest', async () => {
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    await screen.findByRole('button', { name: 'Copy invite link' });
    // The host check runs in an effect; let it and the preview settle.
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Add to calendar' })).toBeNull();
  });
});
