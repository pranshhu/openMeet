import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
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

describe('guest waiting with an offered backup', () => {
  const offered = [
    { id: 'backup_asha_camera_20231114T221320000Z.mp4', kind: 'camera', size: 1, status: 'offered', percent: 0, from: 'Asha' },
  ];

  it('says the backup is offered as soon as the host joins', () => {
    Object.assign(state, { phase: 'waiting', role: 'guest', localStream: empty, backupTransfers: offered });
    render(<RoomView slug="abc-defg-hij" />);
    expect(
      screen.getByText('Your backup is offered to the host as soon as they join. Keep this tab open.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/Hang tight/)).toBeNull();
  });

  it('keeps the usual waiting copy without an offered backup', () => {
    Object.assign(state, { phase: 'waiting', role: 'guest', localStream: empty, backupTransfers: [] });
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.getByText('Hang tight — the call starts as soon as the host arrives.')).toBeInTheDocument();
    expect(screen.queryByText(/Your backup is offered/)).toBeNull();
  });

  it('keeps it off the host, whose own device holds no guest backup', () => {
    Object.assign(state, { phase: 'waiting', role: 'host', localStream: empty, backupTransfers: offered });
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.queryByText(/Your backup is offered/)).toBeNull();
    expect(screen.getByText('Share the invite link. You’ll connect automatically as people arrive.')).toBeInTheDocument();
  });

  it('keeps the note off the connecting screen', () => {
    Object.assign(state, { phase: 'connecting', role: 'guest', localStream: empty, backupTransfers: offered });
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.getByText('Joining the call. This usually takes a few seconds.')).toBeInTheDocument();
    expect(screen.queryByText(/Your backup is offered/)).toBeNull();
  });

  it('leaves the presenting note in front of it', () => {
    Object.assign(state, {
      phase: 'waiting',
      role: 'guest',
      companion: true,
      screenSharing: true,
      localStream: empty,
      backupTransfers: offered,
    });
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.getByText(/You’re presenting from this device/)).toBeInTheDocument();
    expect(screen.queryByText(/Your backup is offered/)).toBeNull();
  });
});

describe('lobby', () => {
  it('sends the chosen backup through the hook when the guest joins', async () => {
    const file = new File(['a'], 'openmeet-backup-1700000000000-abc-defg-hij.mp4', { lastModified: 1700000000000 });
    const findBackupsSpy = vi.spyOn(await import('@/lib/backup-recorder'), 'findBackups').mockResolvedValue([file]);
    URL.createObjectURL = vi.fn().mockReturnValue('blob:x');
    URL.revokeObjectURL = vi.fn();
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(empty),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
    });
    hook.sendBackups = vi.fn();
    Object.assign(state, { phase: 'lobby' });
    try {
      render(<RoomView slug="abc-defg-hij" />);
      fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Asha' } });
      const join = screen.getByRole('button', { name: /join now/i });
      await waitFor(() => expect(join).not.toBeDisabled());
      fireEvent.click(await screen.findByRole('button', { name: /^Send to host:/ }));
      fireEvent.click(join);

      await waitFor(() => expect(hook.sendBackups).toHaveBeenCalledWith([file]));
    } finally {
      findBackupsSpy.mockRestore();
      vi.unstubAllGlobals();
    }
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

  // The panel lives in CallStage, but the reading is the hook's: this is the
  // wiring between them, so a broken pass-through leaves the panel unmounted.
  it('hands the call the room’s track readings', () => {
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
    });
    hook.readTrackHealth = () => [{ key: 'own:camera', track: 'camera', bytes: 1 }];
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.getByTestId('track-health')).toBeInTheDocument();
  });

  // Same wiring as the track panel: the flag the hook derives from the handles
  // only reaches the screen through RoomView.
  it('hands the call the unprotected flag for the status line', () => {
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
      unprotectedRecording: true,
    });
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.getByTestId('status-bar')).toHaveTextContent(
      'This take isn’t protected if the browser crashes.'
    );
  });

  it('passes low-power mode and its switch to the call', () => {
    Object.assign(state, {
      phase: 'in-call',
      role: 'host',
      peerRecording: false,
      lowPower: true,
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
    hook.setLowPower = vi.fn();
    render(<RoomView slug="abc-defg-hij" />);
    fireEvent.click(screen.getByRole('button', { name: 'Turn off low-power mode' }));
    expect(hook.setLowPower).toHaveBeenCalledWith(false);
  });

  it('turns low-power mode on from the call', async () => {
    Object.assign(state, {
      phase: 'recording',
      role: 'host',
      peerRecording: true,
      lowPower: false,
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
    hook.setLowPower = vi.fn();
    vi.useFakeTimers();
    try {
      render(<RoomView slug="abc-defg-hij" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      fireEvent.click(screen.getByRole('button', { name: 'Turn on low-power mode' }));
      expect(hook.setLowPower).toHaveBeenCalledWith(true);
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

describe('returned backups', () => {
  const offered = [
    {
      id: 'backup_asha_camera_20231114T221320000Z.mp4',
      kind: 'camera',
      size: 1_500_000_000,
      status: 'offered',
      percent: 0,
      from: 'Asha',
    },
  ];

  it('saves an offered backup through the hook when the host presses the button', () => {
    const acceptBackups = vi.fn();
    hook.acceptBackups = acceptBackups;
    hook.declineBackups = vi.fn();
    Object.assign(state, inCall, { role: 'host', backupTransfers: offered });
    render(<RoomView slug="abc-defg-hij" />);

    fireEvent.click(screen.getByRole('button', { name: 'Save to folder' }));
    expect(acceptBackups).toHaveBeenCalledTimes(1);
  });

  it('declines an offered backup through the hook when the host presses Not now', () => {
    const declineBackups = vi.fn();
    hook.acceptBackups = vi.fn();
    hook.declineBackups = declineBackups;
    Object.assign(state, inCall, { role: 'host', backupTransfers: offered });
    render(<RoomView slug="abc-defg-hij" />);

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(declineBackups).toHaveBeenCalledTimes(1);
  });

  it('dismisses a stalled backup through the hook', () => {
    const dismissBackup = vi.fn();
    hook.dismissBackup = dismissBackup;
    hook.acceptBackups = vi.fn();
    hook.declineBackups = vi.fn();
    const stalled = offered.map((t) => ({ ...t, status: 'stalled', percent: 30 }));
    Object.assign(state, inCall, { role: 'host', backupTransfers: stalled });
    render(<RoomView slug="abc-defg-hij" />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(dismissBackup).toHaveBeenCalledWith(stalled[0]!.id);
  });
});

describe('interrupted take', () => {
  it('hands the resume offer and its two actions to the call screen', () => {
    const resumeRecording = vi.fn();
    const saveRecordingFromCall = vi.fn();
    Object.assign(hook, { resumeRecording, saveRecordingFromCall });
    Object.assign(state, inCall, {
      role: 'host',
      resumeOffer: { take: 1, canResume: true },
      takeNotice: null,
    });
    render(<RoomView slug="abc-defg-hij" />);

    fireEvent.click(screen.getByRole('button', { name: 'Resume recording' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save what was recorded' }));

    expect(resumeRecording).toHaveBeenCalledTimes(1);
    expect(saveRecordingFromCall).toHaveBeenCalledTimes(1);
  });

  it('hands the saved line to the call screen', () => {
    Object.assign(state, inCall, {
      role: 'host',
      resumeOffer: null,
      takeNotice: 'Saved 1 file to your folder.',
    });
    render(<RoomView slug="abc-defg-hij" />);

    expect(screen.getByText('Saved 1 file to your folder.')).toBeInTheDocument();
  });
});
