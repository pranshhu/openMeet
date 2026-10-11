import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CalendarInvite } from '@/components/CalendarInvite';
import { Lobby } from '@/components/Lobby';
import { buildIcs, googleCalendarUrl, inviteText } from '@/lib/calendar-invite';
import { ROOM_TTL_MS } from '@openmeet/protocol';
import { getRoom } from '@/lib/api';

// Only the room lookup is replaced: the lobby's own checks keep the rest of the module.
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getRoom: vi.fn(),
}));

// The picker's value is read on the computer's clock. These tests run in a zone
// that is not UTC, so reading it as UTC gives another moment wherever they run.
vi.stubEnv('TZ', 'Asia/Kolkata');
afterAll(() => vi.unstubAllEnvs());

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
    expect(lines.at(-1)).toBe(
      "The host can record this session. If they do, your camera, microphone and chat are saved on the host's computer. Nothing is uploaded to a server, and you are told on screen when recording starts."
    );
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
    expect(lines).toContain('UID:https://meet.example.org/r/a\\,b\\;c\\\\d/#20261020T150000Z');
    const description = lines.find((l) => l.startsWith('DESCRIPTION:'))!;
    expect(description).toContain('start time:\\nhttps://meet.example.org/r/a\\,b\\;c\\\\d/\\n');
    // The fixed text has commas of its own.
    expect(description).toContain('your camera\\, microphone and chat');
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
  // The room closes on 20 October at 15:30 on this computer's clock, 19 days after "now".
  const CLOSES = new Date('2026-10-20T15:30').getTime();
  const shown = (ms: number) =>
    new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const room = (expires_at: number) => ({ slug: 'xyz-abcd-pqr', expires_at, consumed: 1 });

  beforeEach(() => {
    // Only the clock is held still: the server's answer still arrives by itself.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T12:00'));
    vi.mocked(getRoom).mockResolvedValue(room(CLOSES));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(getRoom).mockReset();
    window.history.pushState({}, '', '/');
  });

  const toggle = () => screen.getByRole('button', { name: 'Add to calendar' });
  const pick = (value: string) =>
    fireEvent.change(screen.getByLabelText('Session start'), { target: { value } });
  const says = (text: string) => waitFor(() => expect(screen.getByRole('status').textContent).toBe(text));
  const openUntil = (ms: number) =>
    says(`This room is open until ${shown(ms)}. A room closes 30 days after its last call.`);

  it('asks when the room closes at each opening, not before, and says the date', async () => {
    render(<CalendarInvite slug="xyz-abcd-pqr" />);
    // A lobby in which nobody opens this asks the server nothing.
    expect(getRoom).not.toHaveBeenCalled();
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    // 44px to tap on a phone.
    expect(toggle()).toHaveClass('min-h-11');
    expect(screen.queryByLabelText('Session start')).toBeNull();
    // The status line is mounted with the panel, so a screen reader sees it appear.
    expect(screen.queryByRole('status')).toBeNull();

    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(getRoom).toHaveBeenCalledWith('xyz-abcd-pqr');
    expect(screen.getByLabelText('Session start')).toHaveAttribute('type', 'datetime-local');
    expect(screen.getByLabelText('Session start')).toHaveClass('min-h-11');
    expect(screen.getByRole('status').textContent).toBe('Checking how long this room stays open…');
    await openUntil(CLOSES);
    // No time, no entry.
    expect(screen.queryByRole('link')).toBeNull();

    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Session start')).toBeNull();
    // Closing asks nothing.
    expect(getRoom).toHaveBeenCalledTimes(1);

    // Until the server answers again, the last answer stays on screen.
    vi.mocked(getRoom).mockReturnValueOnce(new Promise<never>(() => {}));
    fireEvent.click(toggle());
    expect(getRoom).toHaveBeenCalledTimes(2);
    await openUntil(CLOSES);

    // A call in the room since the last opening has moved the date.
    fireEvent.click(toggle());
    vi.mocked(getRoom).mockResolvedValue(room(CLOSES + 60_000));
    fireEvent.click(toggle());
    await openUntil(CLOSES + 60_000);
  });

  it('offers the calendar file and the Google Calendar link for a session that ends by then', async () => {
    // A query on the host's own page must not get into the entry.
    window.history.pushState({}, '', '/r/xyz-abcd-pqr/?present=1');
    render(<CalendarInvite slug="xyz-abcd-pqr" />);
    fireEvent.click(toggle());
    // Its hour ends at the minute the room closes.
    pick('2026-10-20T14:30');
    // Nothing is offered before the server has said when the room closes.
    expect(screen.queryByRole('link')).toBeNull();
    await openUntil(CLOSES);

    const link = `${location.origin}/r/xyz-abcd-pqr/`;
    // The picker's value names no zone: it is 14:30 on this computer's clock.
    const startMs = new Date('2026-10-20T14:30').getTime();

    const file = await screen.findByRole('link', { name: 'Download calendar file (.ics)' });
    expect(file).toHaveAttribute('download', 'openmeet-xyz-abcd-pqr.ics');
    const prefix = 'data:text/calendar;charset=utf-8,';
    const href = file.getAttribute('href')!;
    expect(href.startsWith(prefix)).toBe(true);
    // An address ends at a raw '#' and drops a raw line break: every octet of
    // the file that is not a plain character is written as an escape.
    expect(href.slice(prefix.length)).toMatch(/^[\w.!~*'()%-]+$/);
    // The clock is held still, so the file says it was made at this moment.
    expect(decodeURIComponent(href.slice(prefix.length))).toBe(buildIcs(link, startMs, Date.now()));

    const google = screen.getByRole('link', { name: 'Open in Google Calendar' });
    expect(google).toHaveAttribute('href', googleCalendarUrl(link, startMs));
    expect(google).toHaveAttribute('target', '_blank');
    expect(google).toHaveAttribute('rel', 'noopener noreferrer');

    // 44px tall and as wide as the panel, so they sit one above the other on a phone.
    expect(file).toHaveClass('min-h-11', 'w-full');
    expect(google).toHaveClass('min-h-11', 'w-full');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      screen.getByText(
        /Anyone who can read the entry can join the room\. On the day, open the room in this browser: you are its host only here\./
      )
    ).toBeInTheDocument();
  });

  it('makes no entry for a session that would end after the room closes', async () => {
    render(<CalendarInvite slug="xyz-abcd-pqr" />);
    fireEvent.click(toggle());
    await openUntil(CLOSES);

    // Starts half an hour before the room closes, ends half an hour after.
    pick('2026-10-20T15:00');
    expect(screen.getByRole('alert').textContent).toBe(
      'That is after this room closes. Pick an earlier time, or join the room once: it then stays open for 30 days from that call.'
    );
    expect(screen.queryByRole('link')).toBeNull();

    pick('2026-10-20T14:30');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('makes no entry when the server gives no closing time', async () => {
    const answers = [
      () => Promise.reject(new Error('offline')),
      () => Promise.resolve(null),
      () => Promise.resolve(room('soon' as unknown as number)),
    ];
    for (const answer of answers) {
      vi.mocked(getRoom).mockImplementationOnce(answer);
      const { unmount } = render(<CalendarInvite slug="xyz-abcd-pqr" />);
      fireEvent.click(toggle());
      await says('Couldn’t check how long this room stays open. Reload the page and try again.');
      pick('2026-10-20T14:30');
      expect(screen.queryByRole('link')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      unmount();
    }
  });

  it('takes no closing time later than any room can have', async () => {
    // A year away; a room closes at most 30 days after it was last joined.
    vi.mocked(getRoom).mockResolvedValue(room(new Date('2027-10-01T12:00').getTime()));
    render(<CalendarInvite slug="xyz-abcd-pqr" />);
    fireEvent.click(toggle());
    await openUntil(Date.now() + ROOM_TTL_MS);

    // 45 days after "now".
    pick('2026-11-15T12:00');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
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
    vi.mocked(getRoom).mockReset();
    vi.unstubAllGlobals();
  });

  it('offers it to the browser that holds the host token, at the end of the join panel', async () => {
    localStorage.setItem('om_host_xyz-abcd-pqr', 'host-tok');
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const button = await screen.findByRole('button', { name: 'Add to calendar' });
    const panel = screen.getByRole('heading', { name: 'Ready to join?' }).parentElement!;
    // Last in the join panel: the backups and an unsaved recording stay above it.
    expect(panel.lastElementChild).toBe(button.parentElement);

    // The panel asks about the room this lobby is for.
    vi.mocked(getRoom).mockResolvedValue(null);
    fireEvent.click(button);
    expect(getRoom).toHaveBeenCalledWith('xyz-abcd-pqr');
    await screen.findByText(/Couldn’t check how long this room stays open/);
  });

  it('does not offer it on the check page, which joins no call', async () => {
    localStorage.setItem('om_host_xyz-abcd-pqr', 'host-tok');
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} checkOnly />);
    await screen.findByRole('heading', { name: 'Check your setup' });
    // The host check runs in an effect; let it and the preview settle.
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Add to calendar' })).toBeNull();
  });

  it('does not offer it to a guest', async () => {
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    await screen.findByRole('button', { name: 'Copy invite link' });
    // The host check runs in an effect; let it and the preview settle.
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Add to calendar' })).toBeNull();
  });
});
