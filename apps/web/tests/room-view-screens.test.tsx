import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { RoomView } from '@/components/RoomView';

/**
 * RoomView's screens for states that are slow to reach through the real hook
 * (a finished take, a present-only device, a connection in trouble). The hook
 * is replaced by a fixed state.
 */

let state: Record<string, unknown>;
let hook: Record<string, unknown>;

vi.mock('@/hooks/useRoom', () => ({
  useRoom: () => ({ state, join: vi.fn(), leave: vi.fn(), setMic: vi.fn(), setCam: vi.fn(), ...hook }),
}));

const empty = { getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream;

beforeEach(() => {
  hook = {};
  state = {
    phase: 'left',
    role: 'host',
    companion: false,
    localStream: null,
    localName: 'Ana',
    connectionWarning: null,
    syncReportUrl: null,
    chaptersUrl: null,
    backupBlobUrl: null,
    wavBackupBlobUrl: null,
  };
});

describe('left', () => {
  it('offers the finished take’s files, which exist only in this tab', () => {
    state.syncReportUrl = 'blob:sync';
    state.backupBlobUrl = 'blob:backup';
    render(<RoomView slug="abc-defg-hij" />);

    expect(screen.getByRole('heading', { name: 'You left the call' })).toBeInTheDocument();
    expect(screen.getByText(/Download these before you close this tab/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'sync.json' })).toHaveAttribute('href', 'blob:sync');
    expect(screen.getByRole('link', { name: 'sync.json' })).toHaveAttribute('download', 'sync.json');
    expect(screen.getByRole('link', { name: 'Backup video' })).toHaveAttribute('download', 'backup.mp4');
    expect(screen.queryByRole('link', { name: 'chapters.txt' })).not.toBeInTheDocument();
    expect(screen.queryByText(/You can close this tab/)).not.toBeInTheDocument();
  });

  // Rejoin reloads the page, which would drop those in-memory links.
  it('asks before the page unloads while a host still holds them, and not once there are none', () => {
    state.syncReportUrl = 'blob:sync';
    const { unmount } = render(<RoomView slug="abc-defg-hij" />);
    const held = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(held);
    expect(held.defaultPrevented).toBe(true);
    unmount();

    state.syncReportUrl = null;
    render(<RoomView slug="abc-defg-hij" />);
    const free = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(free);
    expect(free.defaultPrevented).toBe(false);
  });

  it('does not ask before unload when sidecars were saved on disk and no backups remain', () => {
    state.syncReportUrl = 'blob:sync';
    state.sidecarsSaved = true;
    render(<RoomView slug="abc-defg-hij" />);
    const free = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(free);
    expect(free.defaultPrevented).toBe(false);
  });

  // A guest's backups live on in this browser and are listed in every lobby.
  it('tells a guest the backups stay in this browser, and does not hold the page', () => {
    Object.assign(state, { role: 'guest', backupBlobUrl: 'blob:backup' });
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.getByText(/Your backup copies stay in this browser/)).toBeInTheDocument();
    expect(screen.queryByText(/they exist only here/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Backup video' }).className).toMatch(/(^|\s)underline(\s|$)/);
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('present-only device', () => {
  it('waiting: confirms its screen is being presented', () => {
    Object.assign(state, { phase: 'waiting', role: 'guest', companion: true, screenSharing: true, localStream: empty });
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.getByText(/You’re presenting from this device/)).toBeInTheDocument();
  });

  it('waiting: stops saying so once the device stopped sharing', () => {
    Object.assign(state, { phase: 'waiting', role: 'guest', companion: true, screenSharing: false, localStream: empty });
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.queryByText(/You’re presenting from this device/)).not.toBeInTheDocument();
  });

  it('connecting: a connection warning takes precedence over the presenting note', () => {
    Object.assign(state, {
      phase: 'connecting',
      role: 'guest',
      companion: true,
      screenSharing: true,
      localStream: empty,
      connectionWarning: 'Connection lost — retrying…',
    });
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.getByRole('heading', { name: 'Having trouble connecting' })).toBeInTheDocument();
    expect(screen.getByText('Connection lost — retrying…')).toBeInTheDocument();
    expect(screen.queryByText(/You’re presenting from this device/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave' })).toBeInTheDocument();
  });
});

describe('recording', () => {
  it('hands the call the room’s load reading', async () => {
    Object.assign(state, {
      phase: 'recording',
      role: 'host',
      peerRecording: true,
      remoteStream: null,
      remotePeers: [],
      remoteScreenStream: null,
      localScreenStream: null,
      screenSharing: false,
      capabilities: {},
      finalizingGuests: [],
      messages: [],
      markers: [],
      takes: [],
      summary: null,
      recordingError: null,
      drained: true,
      sidecarsSaved: false,
    });
    let lost = 0;
    hook.readLoad = vi.fn(async () => ({ audioDroppedMs: (lost += 150), cpuLimited: false }));
    vi.useFakeTimers();
    try {
      const { rerender } = render(<RoomView slug="abc-defg-hij" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(7_000);
      });
      rerender(<RoomView slug="abc-defg-hij" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(
        screen.getByText(
          'This device is struggling to keep up, so the recording may skip. Close other apps and tabs.'
        )
      ).toBeInTheDocument();
      rerender(<RoomView slug="abc-defg-hij" />);
      expect(
        screen.getByText(
          'This device is struggling to keep up, so the recording may skip. Close other apps and tabs.'
        )
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

const inCall = {
  phase: 'in-call',
  role: 'guest',
  remoteStream: null,
  remotePeers: [],
  remoteScreenStream: null,
  localScreenStream: null,
  screenSharing: false,
  peerRecording: false,
  capabilities: {},
  finalizingGuests: [],
  messages: [],
  markers: [],
  takes: [],
  summary: null,
  recordingError: null,
};
const copy =
  'No sound from your microphone for 10 seconds. Check it’s plugged in and not muted, or select another microphone.';

describe('mic warning', () => {
  it('hands the warning to the call screen for guest and host', () => {
    Object.assign(state, inCall, { micWarning: 'silent' });
    const { unmount } = render(<RoomView slug="abc-defg-hij" />);
    expect(screen.getByText(copy)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss microphone warning' })).toBeInTheDocument();
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.tagName).toBe('SPAN');
    unmount();

    Object.assign(state, { role: 'host' });
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.getByText(copy)).toBeInTheDocument();
  });

  it('shows no mic warning when state.micWarning is null', () => {
    Object.assign(state, inCall, { micWarning: null });
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.queryByText(/No sound from your microphone for 10 seconds/)).toBeNull();
  });

  it('does not show the mic warning on other screens', () => {
    for (const otherPhase of ['left', 'waiting', 'connecting', 'error', 'full'] as const) {
      Object.assign(state, {
        phase: otherPhase,
        role: 'guest',
        micWarning: 'silent',
      });
      const { unmount } = render(<RoomView slug="abc-defg-hij" />);
      expect(
        screen.queryByText(/No sound from your microphone for 10 seconds/)
      ).toBeNull();
      unmount();
    }
  });
});
