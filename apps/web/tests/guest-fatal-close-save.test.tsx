import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';
import { CallStage } from '@/components/CallStage';
import { BackupRecorder } from '@/lib/backup-recorder';
import { endGuestRecording } from '@/hooks/recording-controller';

let signalHandlers: Record<string, ((m: any) => void)[]> = {};
let signalSent: any[] = [];
let onFatalCloseCallback: ((code: number, reason: string) => void) | null = null;
let endGuestRecordingCalled = false;

vi.mock('@/lib/api', () => ({
  getTurnCred: vi.fn().mockResolvedValue({ iceServers: [] }),
  getRoom: vi.fn().mockResolvedValue({ slug: 'test-room', expires_at: Date.now() + 10000 }),
  patchRecording: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/host-token', () => ({
  getHostToken: vi.fn().mockReturnValue(null),
}));

vi.mock('@/lib/signal', () => ({
  SignalClient: vi.fn().mockImplementation((opts) => {
    onFatalCloseCallback = opts.onFatalClose ?? null;
    return {
      connect: vi.fn(),
      close: vi.fn(),
      reconnect: vi.fn(),
      send: vi.fn((m) => signalSent.push(m)),
      on: vi.fn((type: string, handler: (m: any) => void) => {
        (signalHandlers[type] ??= []).push(handler);
      }),
    };
  }),
}));

vi.mock('@/lib/media', () => ({
  MediaManager: vi.fn().mockImplementation(() => ({
    adopt: vi.fn(),
    start: vi.fn().mockResolvedValue({ getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] }),
    stop: vi.fn(),
    setAudioEnabled: vi.fn(),
    setVideoEnabled: vi.fn(),
    stream: { getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] },
  })),
}));

vi.mock('@/lib/peer', () => ({
  PeerConnection: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    close: vi.fn(),
    setLocalStream: vi.fn(),
    setLocalStreamAfterFirstOffer: vi.fn(),
    createControlChannel: vi.fn(),
    addTransceiver: vi.fn(),
    restartIce: vi.fn(),
    connectionState: 'connected',
    rawConnection: null,
    setPeerCount: vi.fn(),
    whenConnected: vi.fn().mockResolvedValue(undefined),
    createRecordingChannel: vi.fn().mockReturnValue({
      readyState: 'open',
      addEventListener: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
    }),
    createRecordingAudioChannel: vi.fn().mockReturnValue(undefined),
  })),
}));

vi.mock('@/lib/recorder', async () => {
  const actual = await vi.importActual<typeof import('@/lib/recorder')>('@/lib/recorder');
  return { ...actual, pickRecordingMime: vi.fn().mockReturnValue('video/mp4') };
});

vi.mock('@/lib/backup-recorder', async () => {
  return {
    BackupRecorder: vi.fn().mockImplementation(() => ({
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(new Blob(['backup-bytes'])),
      markFinalized: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

vi.mock('@/hooks/recording-controller', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/recording-controller')>(
    '@/hooks/recording-controller'
  );
  return {
    ...actual,
    startGuestRecording: vi.fn().mockReturnValue({
      recordingId: 'rec-test-1',
      guestRecorder: { totalBytes: 100, stopAndFlush: vi.fn() },
      sender: { lastAckedIdx: 5, drain: vi.fn().mockResolvedValue(true), rebind: vi.fn() },
    }),
    endGuestRecording: vi.fn().mockImplementation(async () => {
      endGuestRecordingCalled = true;
      return {
        drained: true,
        backup: new Blob(['backup-bytes']),
      };
    }),
  };
});

function emitSignal(type: string, payload: any) {
  for (const handler of signalHandlers[type] ?? []) {
    handler(payload);
  }
}

describe('guest fatal close hold and stop-and-save action', () => {
  beforeEach(() => {
    signalHandlers = {};
    signalSent = [];
    onFatalCloseCallback = null;
    endGuestRecordingCalled = false;
    globalThis.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('provides working Stop and save my recording action for guest on fatal close hold', async () => {
    const { result } = renderHook(() => useRoom('xyz-test-room'));

    const fakeAudio = { id: 'a1', kind: 'audio', enabled: true } as unknown as MediaStreamTrack;
    const fakeVideo = { id: 'v1', kind: 'video', enabled: true } as unknown as MediaStreamTrack;
    const fakeStream = {
      getTracks: () => [fakeAudio, fakeVideo],
      getAudioTracks: () => [fakeAudio],
      getVideoTracks: () => [fakeVideo],
    } as unknown as MediaStream;

    await act(async () => {
      await result.current.join(fakeStream, 'Guest Bob');
    });

    act(() => {
      emitSignal('role-assigned', {
        type: 'role-assigned',
        role: 'guest',
        peerId: 'p-guest',
        ordinal: 2,
        peers: [{ peerId: 'p-host', ordinal: 1, role: 'host', displayName: 'Host' }],
        recording: false,
      });
    });

    await act(async () => {
      emitSignal('recording-started', {
        type: 'recording-started',
        from: 'host',
        recordingId: 'rec-host-1',
        kind: 'camera',
        filename: 'host_rec-host-1.mp4',
      });
    });

    expect(result.current.state.phase).toBe('recording');

    // Signalling closes with a fatal code (e.g. 4001 or 4006) during the take
    act(() => {
      onFatalCloseCallback?.(4001, 'room_full');
    });

    // Phase stays in recording (fatal-close hold)
    expect(result.current.state.phase).toBe('recording');
    // Banner copy must match what the button does
    expect(result.current.state.recordingError).toBe(
      'The connection to the room ended. Press Stop and save my recording to keep this recording.'
    );

    // Call endRecording (as triggered by the "Stop and save my recording" button)
    await act(async () => {
      await result.current.endRecording();
    });

    // Must not be a no-op: finalizes the local recording and backup
    expect(endGuestRecordingCalled).toBe(true);
    expect(result.current.state.phase).toBe('done');
    expect(result.current.state.backupBlobUrl).toBeTruthy();
  });

  it('renders Stop and save my recording button on CallStage for guest on fatal close hold', () => {
    const onEnd = vi.fn();
    render(
      <CallStage
        role="guest"
        phase="recording"
        localStream={null}
        remoteStream={null}
        remotePeers={[]}
        remoteScreenStream={null}
        localScreenStream={null}
        localName="Guest"
        screenSharing={false}
        canRecord={false}
        roomRecording={true}
        recordBlocked={false}
        messages={[]}
        screenShareSupported={true}
        backupUrl={null}
        wavBackupUrl={null}
        recordingError="The connection to the room ended. Press Stop and save my recording to keep this recording."
        recordUnavailableReason={null}
        syncReportUrl={null}
        onToggleMic={vi.fn()}
        onToggleCam={vi.fn()}
        onRecord={vi.fn()}
        onEnd={onEnd}
        onLeave={vi.fn()}
        onSendChat={vi.fn()}
        slug="test-slug"
        onMark={vi.fn()}
        markerCount={0}
        chaptersUrl={null}
        summary={null}
        takes={[]}
        onNewTake={vi.fn()}
        onDiscardTake={vi.fn()}
        onOpenMediaBoard={() => null}
        onToggleScreen={vi.fn()}
        capabilities={{}}
      />
    );

    // Banner is rendered
    expect(
      screen.getByText(
        'The connection to the room ended. Press Stop and save my recording to keep this recording.'
      )
    ).toBeInTheDocument();

    // Button matching the banner copy is rendered and clickable
    const stopButton = screen.getByRole('button', { name: 'Stop and save my recording' });
    expect(stopButton).toBeInTheDocument();
    stopButton.click();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
