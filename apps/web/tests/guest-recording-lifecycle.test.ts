import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';
import { BackupRecorder } from '@/lib/backup-recorder';
import { startGuestRecording, startHostRecording, endHostRecording, startScreenRecording } from '@/hooks/recording-controller';
import type { ServerMessage } from '@openmeet/protocol';

let signalHandlers: Record<string, ((m: any) => void)[]> = {};
let signalSent: any[] = [];
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
  SignalClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    close: vi.fn(),
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
    addTrack: vi.fn(),
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
    createRecordingAudioChannel: vi.fn().mockReturnValue({
      readyState: 'open',
      addEventListener: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
    }),
  })),
}));

// jsdom has no MediaRecorder: pretend the codec probe succeeds and stub the
// backup recorder the guest now starts before waiting for the connection.
vi.mock('@/lib/recorder', async () => {
  const actual = await vi.importActual<typeof import('@/lib/recorder')>('@/lib/recorder');
  return { ...actual, pickRecordingMime: vi.fn().mockReturnValue('video/mp4') };
});

vi.mock('@/lib/backup-recorder', async () => {
  const actual = await vi.importActual<typeof import('@/lib/backup-recorder')>('@/lib/backup-recorder');
  return {
    ...actual,
    BackupRecorder: vi.fn().mockImplementation(() => ({
      start: vi.fn(),
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
    startGuestRecording: vi.fn().mockReturnValue({
      recordingId: 'rec-test-1',
      guestRecorder: { totalBytes: 100, stopAndFlush: vi.fn() },
      sender: { lastAckedIdx: 5, drain: vi.fn().mockResolvedValue(true), rebind: vi.fn() },
    }),
    endGuestRecording: vi.fn().mockImplementation(async () => {
      endGuestRecordingCalled = true;
      return {
        drained: true,
        sha256: 'mock-sha256',
        backup: new Blob(['backup-bytes']),
        wavBackup: new Blob(['wav-backup-bytes']),
      };
    }),
    startHostRecording: vi.fn().mockImplementation(async () => ({
      recordingId: 'rec-host-1',
      hostStartMs: 1_000_000,
      hostWriter: { fileName: 'host_rec-host-1.mp4' },
      guestWriter: { fileName: 'guest_rec-host-1.mp4' },
      // Slot 0 was bound from Bob's socket; his name is only known from peer-joined.
      slotPeerIds: new Map([[0, 'p-bob']]),
      receiver: { digestHex: async () => 'abc', senderSha256: 'abc', guestStartHostMs: 1_000_500, syncRttMs: 10, bytesWritten: 1 },
    })),
    endHostRecording: vi.fn().mockResolvedValue({ sha256: 'abc', totalBytes: 1, backup: null }),
    startScreenRecording: vi.fn().mockResolvedValue(undefined),
  };
});

function emitSignal(type: string, payload: any) {
  for (const handler of signalHandlers[type] ?? []) {
    handler(payload);
  }
}

/** A joined guest whose capture the host has just started. */
async function recordingGuest() {
  const { result } = renderHook(() => useRoom('xyz-test-room'));
  const fakeStream = {
    getTracks: () => [],
    getAudioTracks: () => [{ kind: 'audio' }],
    getVideoTracks: () => [{ kind: 'video' }],
  } as unknown as MediaStream;
  await act(async () => {
    await result.current.join(fakeStream, 'Guest Alice');
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
    emitSignal('recording-started', { type: 'recording-started', from: 'host', recordingId: 'rec-x', kind: 'camera', filename: 'host_rec-x.mp4' });
  });
  return result;
}

const stopTake = () =>
  act(async () => {
    emitSignal('recording-stop', { type: 'recording-stop', from: 'host', recordingId: 'rec-x' });
  });

/** The real handles carry the pre-started backup; the default mock drops it. */
function handlesWithBackup(sender: Record<string, unknown> = {}) {
  vi.mocked(startGuestRecording).mockImplementationOnce(
    (args) =>
      ({
        recordingId: 'rec-x',
        guestRecorder: { totalBytes: 100, stopAndFlush: vi.fn() },
        sender: { lastAckedIdx: 5, drain: vi.fn().mockResolvedValue(true), rebind: vi.fn(), ...sender },
        backup: args.backup,
      }) as never
  );
}

const lastBackup = () =>
  vi.mocked(BackupRecorder).mock.results.at(-1)!.value as { markFinalized: ReturnType<typeof vi.fn> };

describe('guest recording lifecycle in useRoom', () => {
  beforeEach(() => {
    signalHandlers = {};
    signalSent = [];
    endGuestRecordingCalled = false;
    globalThis.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('endRecording is a no-op for a guest outside recording-stop/leave', async () => {
    const { result } = renderHook(() => useRoom('xyz-test-room'));

    const fakeStream = {
      getTracks: () => [],
      getAudioTracks: () => [{ kind: 'audio' }],
      getVideoTracks: () => [{ kind: 'video' }],
    } as unknown as MediaStream;

    await act(async () => {
      await result.current.join(fakeStream, 'Guest Alice');
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
        recordingId: 'rec-test-1',
        kind: 'camera',
        filename: 'guest_rec-test-1.mp4',
      });
    });

    expect(result.current.state.role).toBe('guest');
    expect(result.current.state.peerRecording).toBe(true);

    // Call endRecording directly (as a guest outside recording-stop / leave)
    await act(async () => {
      await result.current.endRecording();
    });

    // It should be a no-op for the guest
    expect(endGuestRecordingCalled).toBe(false);
    expect(result.current.state.phase).not.toBe('finalizing');
    expect(result.current.state.phase).not.toBe('done');

    // When the host sends recording-stop, endGuestRecording should be executed
    await act(async () => {
      emitSignal('recording-stop', {
        type: 'recording-stop',
        from: 'host',
        recordingId: 'rec-test-1',
      });
    });

    expect(endGuestRecordingCalled).toBe(true);
    expect(result.current.state.phase).toBe('done');
  });

  it('clears disconnect banner when peer rejoins', async () => {
    const { result } = renderHook(() => useRoom('xyz-test-room'));

    const fakeStream = {
      getTracks: () => [],
      getAudioTracks: () => [{ kind: 'audio' }],
      getVideoTracks: () => [{ kind: 'video' }],
    } as unknown as MediaStream;

    await act(async () => {
      await result.current.join(fakeStream, 'Guest Alice');
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

    // Start recording from host
    await act(async () => {
      emitSignal('recording-started', {
        type: 'recording-started',
        from: 'host',
        recordingId: 'rec-test-2',
        kind: 'camera',
        filename: 'guest_rec-test-2.mp4',
      });
    });

    expect(result.current.state.phase).toBe('recording');

    // Host drops
    act(() => {
      emitSignal('peer-left', {
        type: 'peer-left',
        peerId: 'p-host',
      });
    });

    expect(result.current.state.recordingError).toBe(
      'The other person disconnected. Press End & save to keep this recording.'
    );

    // Host rejoins
    act(() => {
      emitSignal('peer-joined', {
        type: 'peer-joined',
        peerId: 'p-host',
        displayName: 'Host',
        ordinal: 1,
        role: 'host',
      });
    });

    expect(result.current.state.recordingError).toBeNull();
  });

  it('keeps done phase and backup link when host leaves after a take', async () => {
    const { result } = renderHook(() => useRoom('xyz-test-room'));

    const fakeStream = {
      getTracks: () => [],
      getAudioTracks: () => [{ kind: 'audio' }],
      getVideoTracks: () => [{ kind: 'video' }],
    } as unknown as MediaStream;

    await act(async () => {
      await result.current.join(fakeStream, 'Guest Alice');
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
        recordingId: 'rec-test-3',
        kind: 'camera',
        filename: 'guest_rec-test-3.mp4',
      });
    });

    // Recording stops normally
    await act(async () => {
      emitSignal('recording-stop', {
        type: 'recording-stop',
        from: 'host',
        recordingId: 'rec-test-3',
      });
    });

    expect(result.current.state.phase).toBe('done');
    expect(result.current.state.backupBlobUrl).toBe('blob:mock-url');
    expect(result.current.state.wavBackupBlobUrl).toBe('blob:mock-url');

    // Host leaves after the take
    act(() => {
      emitSignal('peer-left', {
        type: 'peer-left',
        peerId: 'p-host',
      });
    });

    expect(result.current.state.phase).toBe('done');
    expect(result.current.state.backupBlobUrl).toBe('blob:mock-url');
    expect(result.current.state.wavBackupBlobUrl).toBe('blob:mock-url');
  });
  it('a recording guest that gets a new host take ends its current take first', async () => {
    const { result } = renderHook(() => useRoom('xyz-test-room'));
    const fakeStream = {
      getTracks: () => [],
      getAudioTracks: () => [{ kind: 'audio' }],
      getVideoTracks: () => [{ kind: 'video' }],
    } as unknown as MediaStream;
    await act(async () => {
      await result.current.join(fakeStream, 'Guest Alice');
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
    const started = (id: string) => ({ type: 'recording-started', from: 'host', recordingId: id, kind: 'camera', filename: `host_${id}.mp4` });
    await act(async () => {
      emitSignal('recording-started', started('take-1'));
    });
    expect(endGuestRecordingCalled).toBe(false);
    // A second host take (e.g. a host tab that took over) must end the first one.
    await act(async () => {
      emitSignal('recording-started', started('take-2'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(endGuestRecordingCalled).toBe(true);
  });

  it('counts a guest’s own markers, so pressing M visibly lands', async () => {
    const result = await recordingGuest();
    act(() => result.current.addMarker(''));
    expect(signalSent).toContainEqual({ type: 'marker', label: '' });
    expect(result.current.state.markers).toHaveLength(1);

    // Each take counts from zero, as the host's does.
    await stopTake();
    await act(async () => {
      emitSignal('recording-started', { type: 'recording-started', from: 'host', recordingId: 'rec-y', kind: 'camera', filename: 'host_rec-y.mp4' });
    });
    expect(result.current.state.markers).toHaveLength(0);
  });

  it('never marks a guest backup finalized: the host copy is not known to be saved', async () => {
    handlesWithBackup();
    await recordingGuest();
    await stopTake();
    expect(lastBackup().markFinalized).not.toHaveBeenCalled();
  });

  // endRecording is memoised once per room, so reading state inside it saw the
  // mount-time peer list — empty — and every guest came out unnamed.
  it('names guests in the host report by who is in the room now, not at mount', async () => {
    const { result } = renderHook(() => useRoom('xyz-test-room'));
    const fakeStream = {
      getTracks: () => [],
      getAudioTracks: () => [{ kind: 'audio' }],
      getVideoTracks: () => [{ kind: 'video' }],
    } as unknown as MediaStream;
    await act(async () => {
      await result.current.join(fakeStream, 'Host Hana');
    });
    act(() => {
      emitSignal('role-assigned', {
        type: 'role-assigned',
        role: 'host',
        peerId: 'p-host',
        ordinal: 1,
        peers: [],
        recording: false,
      });
    });
    act(() => {
      emitSignal('peer-joined', { type: 'peer-joined', peerId: 'p-bob', displayName: 'Bob', ordinal: 2, role: 'guest' });
    });
    await act(async () => {
      await result.current.startRecording();
    });
    await act(async () => {
      await result.current.endRecording();
    });
    expect(result.current.state.phase).toBe('done');
    expect(result.current.state.summary?.fileList).toContainEqual({
      name: 'guest_rec-host-1.mp4',
      kind: 'video',
      participant: 'Bob',
    });
  });
});

describe('host backup after a take in useRoom', () => {
  beforeEach(() => {
    signalHandlers = {};
    signalSent = [];
    globalThis.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    globalThis.URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => vi.clearAllMocks());

  /** Runs one host take; `during` gets the recorder's onError to misbehave with. */
  async function hostTake(during?: (onError: (e: unknown) => void) => void) {
    const backup = { stop: vi.fn().mockResolvedValue(new Blob(['b'])), markFinalized: vi.fn().mockResolvedValue(undefined) };
    const wavBackup = { stop: vi.fn().mockResolvedValue(null), markFinalized: vi.fn().mockResolvedValue(undefined) };
    const screenBackup = { markFinalized: vi.fn().mockResolvedValue(undefined) };
    const hostWriter = { close: vi.fn().mockResolvedValue(undefined) };
    let onError: (e: unknown) => void = () => {};
    vi.mocked(startHostRecording).mockImplementationOnce(async (args) => {
      onError = args.onError ?? onError;
      return {
        recordingId: args.recordingId,
        backup,
        wavBackup,
        screenBackups: [screenBackup],
        hostWriter,
        hostStartMs: Date.now(),
      } as never;
    });
    const { result } = renderHook(() => useRoom('xyz-test-room'));
    const fakeStream = {
      getTracks: () => [],
      getAudioTracks: () => [{ kind: 'audio' }],
      getVideoTracks: () => [{ kind: 'video' }],
    } as unknown as MediaStream;
    await act(async () => {
      await result.current.join(fakeStream, 'Host Hana');
    });
    act(() => {
      emitSignal('role-assigned', {
        type: 'role-assigned',
        role: 'host',
        peerId: 'p-host',
        ordinal: 1,
        peers: [{ peerId: 'p-guest', ordinal: 2, role: 'guest', displayName: 'Guest' }],
        recording: false,
      });
    });
    await act(async () => {
      await result.current.startRecording();
    });
    expect(result.current.state.phase).toBe('recording');
    if (during) act(() => during(onError));
    await act(async () => {
      await result.current.endRecording();
    });
    expect(result.current.state.phase).toBe('done');
    return { backup, wavBackup, screenBackup, hostWriter, result };
  }

  // A full disk makes the errored writer reject its close, so the finalize
  // throws. That used to hold 'finalizing' for good: Leave off, and a toast
  // still promising a save.
  it('leaves finalizing with the error and the backup when saving throws', async () => {
    vi.mocked(endHostRecording).mockRejectedValueOnce(new Error('disk full'));
    const { backup, hostWriter, result } = await hostTake();
    expect(result.current.state.recordingError).toMatch(/^Saving didn’t finish \(disk full\)/);
    expect(result.current.state.finalizingGuests).toEqual([]);
    expect(result.current.state.summary).toBeNull();
    expect(result.current.state.backupBlobUrl).toBe('blob:mock-url');
    expect(backup.markFinalized).not.toHaveBeenCalled();
    expect(hostWriter.close).toHaveBeenCalled();
    // Leave now leaves, without running the failed finalize a second time.
    await act(async () => {
      await result.current.leave();
    });
    expect(endHostRecording).toHaveBeenCalledTimes(1);
    expect(result.current.state.phase).toBe('left');
  });

  it('marks the host’s camera, WAV, and screen backups when its take finalized normally', async () => {
    const { backup, wavBackup, screenBackup } = await hostTake();
    expect(backup.markFinalized).toHaveBeenCalled();
    expect(wavBackup.markFinalized).toHaveBeenCalled();
    expect(screenBackup.markFinalized).toHaveBeenCalled();
  });

  it('keeps the host’s camera, WAV, and screen backups when a write failed during the take', async () => {
    const { backup, wavBackup, screenBackup } = await hostTake((onError) => onError(new Error('disk went away')));
    expect(backup.markFinalized).not.toHaveBeenCalled();
    expect(wavBackup.markFinalized).not.toHaveBeenCalled();
    expect(screenBackup.markFinalized).not.toHaveBeenCalled();
  });

  it('sets backupBlobUrl and wavBackupBlobUrl in state when host take finishes', async () => {
    vi.mocked(endHostRecording).mockResolvedValueOnce({
      sha256: 'abc',
      totalBytes: 1,
      backup: new Blob(['b']),
      wavBackup: new Blob(['w']),
    });
    const { result } = await hostTake();
    expect(result.current.state.backupBlobUrl).toBe('blob:mock-url');
    expect(result.current.state.wavBackupBlobUrl).toBe('blob:mock-url');
  });

  it('a guest companion starts screen recording on recording-started without camera recording', async () => {
    const { result } = renderHook(() => useRoom('xyz-test-room'));
    const fakeScreenTrack = { kind: 'video', stop: vi.fn(), addEventListener: vi.fn() };
    const fakeScreen = {
      getTracks: () => [fakeScreenTrack],
      getVideoTracks: () => [fakeScreenTrack],
      getAudioTracks: () => [],
    } as unknown as MediaStream;

    const fakeEmptyStream = {
      getTracks: () => [],
      getAudioTracks: () => [],
      getVideoTracks: () => [],
    } as unknown as MediaStream;

    await act(async () => {
      await result.current.join(fakeEmptyStream, 'Companion Alice', false, true, fakeScreen);
    });

    act(() => {
      emitSignal('role-assigned', {
        type: 'role-assigned',
        role: 'guest',
        peerId: 'p-companion',
        ordinal: 2,
        peers: [{ peerId: 'p-host', ordinal: 1, role: 'host', displayName: 'Host' }],
        recording: false,
      });
    });

    await act(async () => {
      emitSignal('recording-started', {
        type: 'recording-started',
        from: 'host',
        recordingId: 'rec-companion',
        kind: 'camera',
        filename: 'host_rec-companion.mp4',
      });
    });

    expect(startGuestRecording).not.toHaveBeenCalled();
    expect(startScreenRecording).toHaveBeenCalled();
    expect(result.current.state.phase).toBe('recording');
  });
});
