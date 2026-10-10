import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Lobby } from '@/components/Lobby';
import { RoomView } from '@/components/RoomView';
import type { TakeJournal } from '@/lib/take-journal';

const SLUG = 'xyz-abcd-pqr';

let state: Record<string, unknown>;
let hook: Record<string, unknown>;

vi.mock('@/hooks/useRoom', () => ({
  useRoom: () => ({ state, join: vi.fn(), leave: vi.fn(), setMic: vi.fn(), setCam: vi.fn(), ...hook }),
}));

function fakeStream(): MediaStream {
  const tracks = [
    { kind: 'audio', enabled: true, stop: vi.fn() },
    { kind: 'video', enabled: true, stop: vi.fn() },
  ];
  // An EventTarget: the preview listens for `removetrack` on the stream it shows.
  return Object.assign(new EventTarget(), {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  }) as unknown as MediaStream;
}

/** Lets the lobby's own lookups (camera, backups, unsaved recordings, the host token) land. */
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  hook = {};
  state = {
    phase: 'lobby',
    role: null,
    companion: false,
    localStream: null,
    localName: '',
    connectionWarning: null,
    syncReportUrl: null,
    chaptersUrl: null,
    backupBlobUrl: null,
    wavBackupBlobUrl: null,
    takes: [],
  };
  vi.stubGlobal('navigator', {
    userAgent: 'test',
    mediaDevices: {
      getUserMedia: vi.fn().mockResolvedValue(fakeStream()),
      enumerateDevices: vi.fn().mockResolvedValue([
        { kind: 'videoinput', deviceId: 'cam1', label: 'Webcam' },
        { kind: 'audioinput', deviceId: 'mic1', label: 'Mic' },
      ]),
      // The ordinary lobby offers Present only with this; its absence on the
      // check page is then the check page's doing.
      getDisplayMedia: vi.fn(),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
  localStorage.removeItem(`om_host_${SLUG}`);
});

describe('check link', () => {
  it('shows the lobby’s preview, pickers and checks, with no way into the room', async () => {
    const onJoin = vi.fn();
    render(<Lobby slug={SLUG} onJoin={onJoin} checkOnly />);
    expect(screen.getByRole('heading', { name: 'Check your setup' })).toBeInTheDocument();
    expect(screen.getByText(/You’re not in the room\. This page tests your camera/)).toBeInTheDocument();

    expect(await screen.findByLabelText('Microphone')).toBeInTheDocument();
    expect(screen.getByLabelText('Camera')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn off microphone' })).toBeInTheDocument();
    expect(screen.getByText(/Wear headphones/)).toBeInTheDocument();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);

    expect(screen.queryByRole('heading', { name: 'Ready to join?' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Your name' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Join now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Present only' })).toBeNull();
    expect(onJoin).not.toHaveBeenCalled();
  });

  it('links to the checks and to the room', async () => {
    render(<Lobby slug={SLUG} onJoin={vi.fn()} checkOnly />);
    const room = screen.getByRole('link', { name: 'Go to the room' });
    expect(room).toHaveAttribute('href', `/r/${SLUG}/`);
    expect(room.className).toMatch(/(^|\s)min-h-11(\s|$)/);
    // The checks are on the page only once the camera and mic are.
    expect(screen.queryByRole('link', { name: 'See your checks ↓' })).toBeNull();
    const checks = await screen.findByRole('link', { name: 'See your checks ↓' });
    expect(checks).toHaveAttribute('href', '#preflight');
    expect(checks.className).toMatch(/(^|\s)min-h-11(\s|$)/);
    expect(document.getElementById('preflight')).not.toBeNull();
  });

  it('leaves the ordinary lobby as it is', async () => {
    render(<Lobby slug={SLUG} onJoin={vi.fn()} />);
    await settle();
    expect(screen.getByRole('heading', { name: 'Ready to join?' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Your name' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Present only' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Go to the room' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'See your checks ↓' })).toBeNull();
    expect(screen.queryByText(/You’re not in the room\./)).toBeNull();
  });

  it('keeps leftover backups and an unsaved recording off the check page', async () => {
    const file = new File(['a'], `openmeet-backup-1700000000000-${SLUG}.mp4`, { lastModified: 1700000000000 });
    const journal = {
      dirName: `openmeet-take-1759824000000-${SLUG}`,
      notes: { room: SLUG, hostStartMs: 1759824000000 },
      notesOk: true,
      bytes: 1_000_000,
    } as unknown as TakeJournal;
    const findBackups = vi.spyOn(await import('@/lib/backup-recorder'), 'findBackups').mockResolvedValue([file]);
    const findJournals = vi.spyOn(await import('@/lib/take-journal'), 'findTakeJournals').mockResolvedValue([journal]);
    URL.createObjectURL = vi.fn().mockReturnValue('blob:x');
    URL.revokeObjectURL = vi.fn();
    try {
      // The ordinary lobby lists both, so the two fixtures are real.
      const { unmount } = render(<Lobby slug={SLUG} onJoin={vi.fn()} />);
      await settle();
      expect(screen.getByRole('heading', { name: 'Backups on this device' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Unsaved recording' })).toBeInTheDocument();
      unmount();

      render(<Lobby slug={SLUG} onJoin={vi.fn()} checkOnly />);
      await settle();
      expect(screen.getByLabelText('Microphone')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Backups on this device' })).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Unsaved recording' })).toBeNull();
    } finally {
      findBackups.mockRestore();
      findJournals.mockRestore();
    }
  });

  it('gives the host a check link to copy, and a guest none', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    window.history.replaceState({}, '', `/r/${SLUG}/`);

    const { unmount } = render(<Lobby slug={SLUG} onJoin={vi.fn()} />);
    await settle();
    expect(screen.getByRole('button', { name: 'Copy invite link' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy check link' })).toBeNull();
    unmount();

    localStorage.setItem(`om_host_${SLUG}`, 'host-tok');
    render(<Lobby slug={SLUG} onJoin={vi.fn()} />);
    await settle();
    const copy = screen.getByRole('button', { name: 'Copy check link' });
    expect(copy).toHaveAccessibleDescription(/to test their camera and mic before the call, without joining/);
    expect(copy.className).toMatch(/(^|\s)min-h-11(\s|$)/);
    fireEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith(`${location.origin}/r/${SLUG}/?check=1`);
    expect(screen.getByRole('button', { name: 'Link copied' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy invite link' })).toBeInTheDocument();
  });

  it('opens the check page from ?check=1 on the room link, and the lobby without it', async () => {
    window.history.replaceState({}, '', `/r/${SLUG}/?check=1`);
    const { unmount } = render(<RoomView slug={SLUG} />);
    await settle();
    expect(screen.getByRole('heading', { name: 'Check your setup' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join now' })).toBeNull();
    unmount();

    for (const search of ['', '?check=0', '?check=true']) {
      window.history.replaceState({}, '', `/r/${SLUG}/${search}`);
      const view = render(<RoomView slug={SLUG} />);
      await settle();
      expect(screen.getByRole('heading', { name: 'Ready to join?' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Join now' })).toBeInTheDocument();
      view.unmount();
    }
  });

  it('copies the same check link from an address that already carries a word', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    localStorage.setItem(`om_host_${SLUG}`, 'host-tok');
    for (const word of ['check', 'producer']) {
      window.history.replaceState({}, '', `/r/${SLUG}/?${word}=1`);
      const view = render(
        <Lobby slug={SLUG} onJoin={vi.fn()} checkOnly={word === 'check'} producer={word === 'producer'} />
      );
      await settle();
      fireEvent.click(screen.getByRole('button', { name: 'Copy check link' }));
      expect(writeText).toHaveBeenLastCalledWith(`${location.origin}/r/${SLUG}/?check=1`);
      view.unmount();
    }
  });

  it('reads Copy check link again a second and a half after a press', async () => {
    localStorage.setItem(`om_host_${SLUG}`, 'host-tok');
    render(<Lobby slug={SLUG} onJoin={vi.fn()} />);
    await settle();
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Copy check link' }));
      expect(screen.getByRole('button', { name: 'Link copied' })).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(1499);
      });
      expect(screen.getByRole('button', { name: 'Link copied' })).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.getByRole('button', { name: 'Copy check link' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the way to the room one path segment, whatever the address held', async () => {
    render(<Lobby slug="abc-defg-hij?x=1#/y" onJoin={vi.fn()} checkOnly />);
    expect(screen.getByRole('link', { name: 'Go to the room' })).toHaveAttribute(
      'href',
      '/r/abc-defg-hij%3Fx%3D1%23%2Fy/'
    );
    await settle();
  });

  it('is the producer or the Present-only link when the address carries that word too', async () => {
    window.history.replaceState({}, '', `/r/${SLUG}/?check=1&producer=1`);
    const first = render(<RoomView slug={SLUG} />);
    await settle();
    expect(screen.getByRole('heading', { name: 'Join as a producer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join now' })).toBeInTheDocument();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    first.unmount();

    window.history.replaceState({}, '', `/r/${SLUG}/?check=1&present=1`);
    render(<RoomView slug={SLUG} />);
    await settle();
    expect(screen.getByRole('heading', { name: 'Ready to present?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share screen & join' })).toBeInTheDocument();
  });
});
