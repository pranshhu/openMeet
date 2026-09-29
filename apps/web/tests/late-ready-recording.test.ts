import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';
import { startGuestRecording } from '@/hooks/recording-controller';
import { BackupRecorder } from '@/lib/backup-recorder';

let signalHandlers: Record<string, ((m: any) => void)[]> = {};
let signalSent: any[] = [];
let resolveWhenConnected: (() => void) | null = null;
let fireChannelOpen: (() => void) | null = null;
let backupRecorderStartCalled = false;
let startGuestRecordingCalled = false;

vi.mock('@/lib/api', () => ({
  getTurnCred: vi.fn().mockResolvedValue({ iceServers: [] }),
  getRoom: vi.fn().mockResolvedValue({ slug: 'test-room', expires_at: Date.now() + 10000 }),
  patchRecording: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/host-token', () => ({
  getHostToken: vi.fn().mockReturnValue(null),
}));

vi.mock('@/lib/signal', () => ({
  SignalClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    close: vi.fn(),
    reconnect: vi.fn(),
    send: vi.fn((m) => signalSent.push(m)),
    on: vi.fn((type: string, handler: (m: any) => void) => {
      (signalHandlers[type] ??= []).push(handler);
    }),
  })),
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
    connectionState: 'connecting',
    rawConnection: null,
    setPeerCount: vi.fn(),
    whenConnected: vi.fn(function (this: { connectionState: string }, timeoutMs = 15_000) {
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error('ConnectionTimeoutError')), timeoutMs);
        });
      }
      // Like the real connection: resolving means connectionState is now 'connected'.
      return new Promise<void>((resolve) => {
        resolveWhenConnected = () => {
          this.connectionState = 'connected';
          resolve();
        };
      });
    }),
    createRecordingChannel: vi.fn().mockImplementation(() => ({
      readyState: 'connecting',
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (event === 'open') {
          fireChannelOpen = handler;
        }
      }),
      send: vi.fn(),
      close: vi.fn(),
    })),
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
      start: vi.fn(() => {
        backupRecorderStartCalled = true;
      }),
      stop: vi.fn().mockResolvedValue(null),
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
    startGuestRecording: vi.fn().mockImplementation(() => {
      startGuestRecordingCalled = true;
      return {
        recordingId: 'rec-test-1',
        guestRecorder: { totalBytes: 100, stopAndFlush: vi.fn() },
        sender: { lastAckedIdx: 5, drain: vi.fn().mockResolvedValue(true), rebind: vi.fn() },
      };
    }),
  };
});

function emitSignal(type: string, payload: any) {
  for (const handler of signalHandlers[type] ?? []) {
    handler(payload);
  }
}

describe('late-ready guest recording (no 15s give-up)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    signalHandlers = {};
    signalSent = [];
    resolveWhenConnected = null;
    fireChannelOpen = null;
    backupRecorderStartCalled = false;
    startGuestRecordingCalled = false;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('keeps local backup and starts streaming to host when connection/channel becomes ready after 20s', async () => {
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

    // Host presses Record: recording-started signal arrives
    await act(async () => {
      emitSignal('recording-started', {
        type: 'recording-started',
        from: 'host',
        recordingId: 'rec-host-1',
        kind: 'camera',
        filename: 'host_rec-host-1.mp4',
      });
    });

    // Local backup was started immediately
    expect(backupRecorderStartCalled).toBe(true);
    // Not streaming to host yet (peer is still connecting)
    expect(startGuestRecordingCalled).toBe(false);

    // Advance 20 seconds (beyond the old 15s timeout)
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });

    // Still no error (did not give up at 15s)
    expect(result.current.state.recordingError).toBeNull();
    expect(startGuestRecordingCalled).toBe(false);

    // Connection now reaches connected
    await act(async () => {
      resolveWhenConnected?.();
    });

    // Channel opens
    await act(async () => {
      fireChannelOpen?.();
    });

    // Now startGuestRecording is called and streaming begins
    expect(startGuestRecordingCalled).toBe(true);
    expect(result.current.state.phase).toBe('recording');
    expect(signalSent).toContainEqual(
      expect.objectContaining({
        type: 'recording-started',
        kind: 'camera',
      })
    );
  });
});
