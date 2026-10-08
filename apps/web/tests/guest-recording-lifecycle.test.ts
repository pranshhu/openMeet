import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom, MAX_RELAYED_MARKERS } from '@/hooks/useRoom';
import { PeerConnection } from '@/lib/peer';
import { BackupRecorder } from '@/lib/backup-recorder';
import { startGuestRecording, endGuestRecording, startHostRecording, endHostRecording, startScreenRecording, collectFileChecks, syncCallCopies, resumeHostRecording, type RecordingHandles } from '@/hooks/recording-controller';
import { findTakeJournals, type TakeJournal } from '@/lib/take-journal';
import { isTakeLockHeld } from '@/lib/take-lock';
import { saveRecoveredTake } from '@/lib/take-recovery';
import { pickRecordingDirectory } from '@/lib/fs-writer';
import { patchRecording } from '@/lib/api';
import { buildSyncReport } from '@/lib/sync-report';
import { bytesPerHour, presetById } from '@/lib/quality';
import { JOURNAL_FLOOR_MINUTES } from '@/lib/preflight';
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

let mediaOptions: any;
vi.mock('@/lib/switchable-media', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/switchable-media')>();
  return {
    ...real,
    SwitchableMedia: class extends real.SwitchableMedia {
      constructor(stream: MediaStream, options: any) {
        super(stream, options);
        mediaOptions = options;
      }
    },
  };
});

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
      sender: { lastAckedIdx: 5, drain: vi.fn().mockResolvedValue(true), rebind: vi.fn(), hold: vi.fn() },
    }),
    endGuestRecording: vi.fn().mockImplementation(async () => {
      endGuestRecordingCalled = true;
      return {
        drained: true,
        backup: new Blob(['backup-bytes']),
        wavBackup: new Blob(['wav-backup-bytes']),
      };
    }),
    startHostRecording: vi.fn().mockImplementation(async () => ({
      recordingId: 'rec-host-1',
      hostStartMs: 1_000_000,
      hostWriter: { fileName: 'host_rec-host-1.mp4', size: 1 },
      guestWriter: { fileName: 'guest_rec-host-1.mp4', size: 1 },
      // Slot 0 was bound from Bob's socket; his name is only known from peer-joined.
      slotPeerIds: new Map([[0, 'p-bob']]),
      receiver: {
        fileName: 'guest_rec-host-1.mp4',
        digestHex: async () => 'abc',
        senderSha256: 'abc',
        receivedFinalized: true,
        isAbandoned: false,
        guestStartHostMs: 1_000_500,
        syncRttMs: 10,
        bytesWritten: 1,
      },
    })),
    endHostRecording: vi.fn().mockResolvedValue({ backup: null }),
    startScreenRecording: vi.fn().mockResolvedValue(undefined),
    resumeHostRecording: vi.fn(),
    collectFileChecks: vi.fn(actual.collectFileChecks),
    syncCallCopies: vi.fn(actual.syncCallCopies),
  };
});

vi.mock('@/lib/take-journal', async () => {
  const actual = await vi.importActual<typeof import('@/lib/take-journal')>('@/lib/take-journal');
  return { ...actual, findTakeJournals: vi.fn().mockResolvedValue([]) };
});

vi.mock('@/lib/take-lock', () => ({
  isTakeLockHeld: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/take-recovery', () => ({
  saveRecoveredTake: vi.fn(),
}));

vi.mock('@/lib/fs-writer', async () => {
  const actual = await vi.importActual<typeof import('@/lib/fs-writer')>('@/lib/fs-writer');
  return { ...actual, pickRecordingDirectory: vi.fn() };
});

vi.mock('@/lib/sync-report', async () => {
  const actual = await vi.importActual<typeof import('@/lib/sync-report')>('@/lib/sync-report');
  return {
    ...actual,
    buildSyncReport: vi.fn(actual.buildSyncReport),
  };
});

function fakeDirectory() {
  const writtenFiles = new Map<string, { data: Uint8Array; closed: boolean }>();
  const dir = {
    getFileHandle: vi.fn().mockImplementation((name: string) => {
      let writtenData = new Uint8Array(0);
      let closed = false;
      const writable = {
        write: vi.fn().mockImplementation(({ data }: { data: any }) => {
          writtenData = new Uint8Array(data);
          return Promise.resolve();
        }),
        close: vi.fn().mockImplementation(() => {
          closed = true;
          writtenFiles.set(name, { data: writtenData, closed });
          return Promise.resolve();
        }),
      };
      return Promise.resolve({ name, createWritable: vi.fn().mockResolvedValue(writable) });
    }),
  };
  return { dir, writtenFiles };
}

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
        sender: { lastAckedIdx: 5, drain: vi.fn().mockResolvedValue(true), rebind: vi.fn(), hold: vi.fn(), ...sender },
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

  it('a guest take driven to its end sends neither recording-started nor recording-completed', async () => {
    const result = await recordingGuest();
    vi.mocked(endGuestRecording).mockResolvedValueOnce({
      drained: false,
      backup: new Blob(['backup-bytes']),
      wavBackup: new Blob(['wav-backup-bytes']),
    });
    await stopTake();
    expect(result.current.state.phase).toBe('done');
    expect(result.current.state.drained).toBe(false);
    expect(result.current.state.backupBlobUrl).toBe('blob:mock-url');
    expect(result.current.state.wavBackupBlobUrl).toBe('blob:mock-url');
    expect(signalSent).not.toContainEqual(
      expect.objectContaining({ type: 'recording-started' })
    );
    expect(signalSent).not.toContainEqual(
      expect.objectContaining({ type: 'recording-completed' })
    );
  });

  it('a guest take gathers no file checks: the checks belong to the host report', async () => {
    const result = await recordingGuest();
    await stopTake();
    expect(result.current.state.phase).toBe('done');
    expect(vi.mocked(collectFileChecks)).not.toHaveBeenCalled();
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
      'The host disconnected. Keep this tab open — they can resume this recording when they come back.'
    );
    expect(result.current.state.recordingError).not.toContain('End & save');

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
    // A resumed host announces the SAME take again. The guest is already in it,
    // so the id it remembered suppresses a restart that would split its file.
    await act(async () => {
      emitSignal('recording-started', started('take-2'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(vi.mocked(endGuestRecording)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startGuestRecording)).toHaveBeenCalledTimes(2);
  });

  it('ignores a repeat of the host take it is already following', async () => {
    const result = await recordingGuest();
    expect(result.current.state.phase).toBe('recording');

    await act(async () => {
      emitSignal('recording-started', { type: 'recording-started', from: 'host', recordingId: 'rec-x', kind: 'camera', filename: 'host_rec-x.mp4' });
      await new Promise((r) => setTimeout(r, 0));
    });

    // Still the same take: no end-of-take (which would put the guest on 'done')
    // and no second start.
    expect(result.current.state.phase).toBe('recording');
    expect(result.current.state.backupBlobUrl).toBeNull();
    expect(vi.mocked(endGuestRecording)).not.toHaveBeenCalled();
    expect(vi.mocked(startGuestRecording)).toHaveBeenCalledTimes(1);
  });

  it('a guest that joined mid-take learns the host id from the acks and ignores its repeat', async () => {
    const { result } = renderHook(() => useRoom('xyz-test-room'));
    const fakeStream = {
      getTracks: () => [],
      getAudioTracks: () => [{ kind: 'audio' }],
      getVideoTracks: () => [{ kind: 'video' }],
    } as unknown as MediaStream;
    await act(async () => {
      await result.current.join(fakeStream, 'Guest Alice');
    });

    let onHostTakeId: ((id: string) => void) | undefined;
    vi.mocked(startGuestRecording).mockImplementationOnce((args) => {
      onHostTakeId = args.onHostTakeId;
      return {
        recordingId: 'rec-x',
        guestRecorder: { totalBytes: 100, stopAndFlush: vi.fn() },
        sender: { lastAckedIdx: 5, drain: vi.fn().mockResolvedValue(true), rebind: vi.fn(), hold: vi.fn() },
      } as never;
    });

    // Joined mid-take: no recording-started ever reached this socket, so the
    // catch-up path begins the take and the host's id has to come from an ack.
    await act(async () => {
      emitSignal('role-assigned', {
        type: 'role-assigned',
        role: 'guest',
        peerId: 'p-guest',
        ordinal: 2,
        peers: [{ peerId: 'p-host', ordinal: 1, role: 'host', displayName: 'Host' }],
        recording: true,
      });
    });
    expect(vi.mocked(startGuestRecording)).toHaveBeenCalledTimes(1);
    expect(onHostTakeId).toBeTypeOf('function');

    onHostTakeId!('host-take-9');
    await act(async () => {
      emitSignal('recording-started', { type: 'recording-started', from: 'host', recordingId: 'host-take-9', kind: 'camera', filename: 'host_host-take-9.mp4' });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.state.phase).toBe('recording');
    expect(vi.mocked(endGuestRecording)).not.toHaveBeenCalled();
    expect(vi.mocked(startGuestRecording)).toHaveBeenCalledTimes(1);
  });

  it('follows the take when the host id is not a short string, so its repeat still follows', async () => {
    await recordingGuest();
    // Neither a non-string nor an over-long id is remembered, so a repeat of it
    // restarts the guest exactly as the take did the first time.
    for (const recordingId of [7, 'x'.repeat(65)]) {
      for (let i = 0; i < 2; i++) {
        await act(async () => {
          emitSignal('recording-started', { type: 'recording-started', from: 'host', recordingId, kind: 'camera', filename: 'host_x.mp4' });
          await new Promise((r) => setTimeout(r, 0));
        });
      }
    }
    expect(vi.mocked(endGuestRecording)).toHaveBeenCalledTimes(4);
    expect(vi.mocked(startGuestRecording)).toHaveBeenCalledTimes(5);
  });

  it('ignores a repeat of a host take whose id is exactly 64 characters', async () => {
    await recordingGuest();
    const id64 = 'r'.repeat(64);
    await act(async () => {
      emitSignal('recording-started', {
        type: 'recording-started',
        from: 'host',
        recordingId: id64,
        kind: 'camera',
        filename: 'host_64.mp4',
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(vi.mocked(startGuestRecording)).toHaveBeenCalledTimes(2);

    // Repeat of the 64-character id: suppressed while in the take
    await act(async () => {
      emitSignal('recording-started', {
        type: 'recording-started',
        from: 'host',
        recordingId: id64,
        kind: 'camera',
        filename: 'host_64.mp4',
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(vi.mocked(startGuestRecording)).toHaveBeenCalledTimes(2);
  });

  it('handles hostile recordingId inputs from recording-started without throwing or corrupting state', async () => {
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

    const hostileValues = [
      true,
      ['bad-array'],
      null,
      undefined,
      1e308,
      NaN,
      -999,
      '',
      { obj: 1 },
      'bad\nid\n"quotes"\'more\'',
    ];

    for (const val of hostileValues) {
      await act(async () => {
        emitSignal('recording-started', {
          type: 'recording-started',
          from: 'host',
          recordingId: val,
          kind: 'camera',
          filename: 'host.mp4',
        });
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(result.current.state.phase).toBe('recording');
    }
  });

  it('a malformed host id does not suppress a take when no id is remembered yet', async () => {
    const { result } = renderHook(() => useRoom('xyz-test-room'));
    const fakeStream = {
      getTracks: () => [],
      getAudioTracks: () => [{ kind: 'audio' }],
      getVideoTracks: () => [{ kind: 'video' }],
    } as unknown as MediaStream;
    await act(async () => {
      await result.current.join(fakeStream, 'Guest Alice');
    });
    await act(async () => {
      emitSignal('role-assigned', {
        type: 'role-assigned',
        role: 'guest',
        peerId: 'p-guest',
        ordinal: 2,
        peers: [{ peerId: 'p-host', ordinal: 1, role: 'host', displayName: 'Host' }],
        recording: true,
      });
    });
    expect(vi.mocked(startGuestRecording)).toHaveBeenCalledTimes(1);

    // Nothing is remembered yet, so a malformed id must not match the empty
    // memory and pass itself off as the take already in progress.
    await act(async () => {
      emitSignal('recording-started', { type: 'recording-started', from: 'host', recordingId: 7, kind: 'camera', filename: 'host_x.mp4' });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(vi.mocked(startGuestRecording)).toHaveBeenCalledTimes(2);
    expect(result.current.state.phase).toBe('recording');
  });

  it('a recording guest ignores a recording-started that is not stamped from the host', async () => {
    await recordingGuest();

    // A different id, so the repeat guard cannot answer for the sender gate.
    await act(async () => {
      emitSignal('recording-started', { type: 'recording-started', from: 'guest', recordingId: 'rec-injected', kind: 'camera', filename: 'host_rec-injected.mp4' });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(vi.mocked(endGuestRecording)).not.toHaveBeenCalled();
    expect(vi.mocked(startGuestRecording)).toHaveBeenCalledTimes(1);
  });

  it('starts a new take for a repeated id once the guest is no longer in that take', async () => {
    const result = await recordingGuest();
    await stopTake();
    expect(result.current.state.phase).toBe('done');

    // The guest stopped, so the remembered id protects nothing: a host that
    // announces the same take again is starting capture, and the guest follows.
    await act(async () => {
      emitSignal('recording-started', { type: 'recording-started', from: 'host', recordingId: 'rec-x', kind: 'camera', filename: 'host_rec-x.mp4' });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(vi.mocked(startGuestRecording)).toHaveBeenCalledTimes(2);
    expect(result.current.state.phase).toBe('recording');
  });

  it('a recording host whose guest leaves is still told to press End & save', async () => {
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
    expect(result.current.state.phase).toBe('recording');

    // A host never follows its own broadcast; recording-started is for guests.
    await act(async () => {
      emitSignal('recording-started', { type: 'recording-started', from: 'host', recordingId: 'rec-host-1', kind: 'camera', filename: 'host_rec-host-1.mp4' });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(vi.mocked(startGuestRecording)).not.toHaveBeenCalled();

    act(() => {
      emitSignal('peer-left', { type: 'peer-left', peerId: 'p-bob', role: 'guest' });
    });

    expect(result.current.state.recordingError).toBe(
      'The other person disconnected. Press End & save to keep this recording.'
    );

    // End the take so unmounting does not close the mocked writers.
    await act(async () => {
      await result.current.endRecording();
    });
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
    expect(result.current.state.summary?.fileList).toContainEqual(
      expect.objectContaining({
        name: 'guest_rec-host-1.mp4',
        kind: 'video',
        participant: 'Bob',
      })
    );
    expect(result.current.state.summary?.integrity).toEqual({ ok: true, text: 'Every file is complete.' });
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

  /**
   * Starts one host take and stops before End & save, so a test can watch the
   * take while it is still recording. `extra` is spread into the handles
   * startHostRecording returns.
   */
  async function startHostTake(
    extra: Record<string, unknown> = {},
    peers: { peerId: string; ordinal: number; role: string; displayName: string | null }[] = [
      { peerId: 'p-guest', ordinal: 2, role: 'guest', displayName: 'Guest' },
    ]
  ) {
    const backup = { stop: vi.fn().mockResolvedValue(new Blob(['b'])), markFinalized: vi.fn().mockResolvedValue(undefined) };
    const wavBackup = { stop: vi.fn().mockResolvedValue(null), markFinalized: vi.fn().mockResolvedValue(undefined) };
    const screenBackup = { markFinalized: vi.fn().mockResolvedValue(undefined) };
    const hostWriter = { close: vi.fn().mockResolvedValue(undefined) };
    let onError: (e: unknown) => void = () => {};
    let recordingId = '';
    vi.mocked(startHostRecording).mockImplementationOnce(async (args) => {
      recordingId = args.recordingId;
      onError = args.onError ?? onError;
      return {
        recordingId: args.recordingId,
        backup,
        wavBackup,
        screenBackups: [screenBackup],
        hostWriter,
        hostStartMs: Date.now(),
        ...extra,
      } as never;
    });
    const { result, unmount } = renderHook(() => useRoom('xyz-test-room'));
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
        peers,
        recording: false,
      });
    });
    await act(async () => {
      await result.current.startRecording();
    });
    expect(result.current.state.phase).toBe('recording');
    return { backup, wavBackup, screenBackup, hostWriter, unmount, result, recordingId, onError };
  }

  /**
   * Runs one host take. `during` gets the recorder's onError and the hook's
   * result; `after` runs in its own act while the take is still recording, so
   * it sees the state an earlier act queued.
   */
  async function hostTake(
    during?: (
      onError: (e: unknown) => void,
      hook: { current: ReturnType<typeof useRoom> }
    ) => void | Promise<void>,
    extra: Record<string, unknown> = {},
    peers: { peerId: string; ordinal: number; role: string; displayName: string | null }[] = [
      { peerId: 'p-guest', ordinal: 2, role: 'guest', displayName: 'Guest' },
    ],
    after?: () => void
  ) {
    const started = await startHostTake(extra, peers);
    if (during) await act(async () => { await during(started.onError, started.result); });
    if (after) await act(async () => after());
    await act(async () => {
      await started.result.current.endRecording();
    });
    expect(started.result.current.state.phase).toBe('done');
    return started;
  }

  /** The take notes a fake journal owns, in the shape take.json holds. */
  function fakeNotes() {
    return {
      room: 'xyz-test-room',
      recordingId: 'rec-host-1',
      take: 1,
      hostStartMs: 1_000_000,
      files: [] as { file: string; kind: 'camera' | 'wav' | 'screen'; slot?: number; key?: string; who?: string }[],
      backups: [],
      markers: [] as { atMs: number; label: string; from: 'host' | 'guest' | 'producer'; name?: string }[],
    };
  }

  /** Stands in for the browser-storage journal: note() edits the notes in place. */
  const fakeJournal = (notes: ReturnType<typeof fakeNotes>) => ({
    note: (change: (n: typeof notes) => void) => change(notes),
    finish: vi.fn().mockResolvedValue(undefined),
    file: () => ({
      append: vi.fn(),
      commit: vi.fn().mockResolvedValue(undefined),
      position: vi.fn().mockResolvedValue(null),
      parts: vi.fn().mockResolvedValue([]),
      dead: false,
    }),
  });

  /** The slot-0 receiver the mocked startHostRecording hands a host take. */
  const guestReceiver = (fileName: string) => ({
    fileName,
    digestHex: async () => 'abc',
    senderSha256: 'abc',
    receivedFinalized: true,
    isAbandoned: false,
    bytesWritten: 1,
    answerResume: vi.fn(),
  });

  // The handles say whether this browser could keep a crash copy; the call has
  // to show it, and the take after it must start from a clean slate.
  it('starts with unprotectedRecording false before a take', () => {
    const { result } = renderHook(() => useRoom('xyz-test-room'));
    expect(result.current.state.unprotectedRecording).toBe(false);
  });

  it('mirrors the handles when a take has no crash copy', async () => {
    const { result } = await hostTake(undefined, { unprotected: true });
    expect(result.current.state.unprotectedRecording).toBe(true);
  });

  it('is not marked unprotected when the take has a journal', async () => {
    const { result } = await hostTake(undefined, { journal: { note: vi.fn() } });
    expect(result.current.state.unprotectedRecording).toBe(false);
  });

  it('clears the unprotected flag when the next take starts', async () => {
    const { result } = await hostTake(undefined, { unprotected: true });
    expect(result.current.state.unprotectedRecording).toBe(true);
    act(() => {
      result.current.newTake();
    });
    expect(result.current.state.unprotectedRecording).toBe(false);
  });

  // The harness's video track has no getSettings, so the take is measured at
  // the 1080p default: the host's own backup plus three guests, for ten minutes.
  const floor = (bytesPerHour(presetById('1080p'), 2) * 4 * JOURNAL_FLOOR_MINUTES) / 60;

  /** jsdom has no navigator.storage; these tests give it one for a single take. */
  function stubStorage(estimate: () => Promise<StorageEstimate>) {
    Object.defineProperty(navigator, 'storage', { value: { estimate }, configurable: true });
    return () => {
      delete (navigator as { storage?: unknown }).storage;
    };
  }

  // No storage API at all (jsdom's state, and older builds): an answer that
  // does not exist is no promise of a crash copy, and the take still records.
  it('starts the take without a journal when the browser has no storage API', async () => {
    await hostTake();
    expect(vi.mocked(startHostRecording).mock.calls[0]?.[0]?.journal).toBe(false);
  });

  it('starts the take without a journal when browser storage is short', async () => {
    const restore = stubStorage(vi.fn().mockResolvedValue({ quota: floor - 1, usage: 0 }));
    try {
      await hostTake();
      expect(vi.mocked(startHostRecording).mock.calls[0]?.[0]?.journal).toBe(false);
    } finally {
      restore();
    }
  });

  it('keeps the journal when the free quota holds the floor', async () => {
    const restore = stubStorage(vi.fn().mockResolvedValue({ quota: floor, usage: 0 }));
    try {
      await hostTake();
      expect(vi.mocked(startHostRecording).mock.calls[0]?.[0]?.journal).toBe(true);
    } finally {
      restore();
    }
  });

  it('records without a journal when the storage question never answers', async () => {
    const restore = stubStorage(vi.fn().mockReturnValue(new Promise<StorageEstimate>(() => {})));
    try {
      await hostTake();
      expect(vi.mocked(startHostRecording).mock.calls[0]?.[0]?.journal).toBe(false);
    } finally {
      restore();
    }
  });

  it('records without a journal when the storage estimate rejects', async () => {
    const restore = stubStorage(vi.fn().mockRejectedValue(new Error('no storage')));
    try {
      await hostTake();
      expect(vi.mocked(startHostRecording).mock.calls[0]?.[0]?.journal).toBe(false);
    } finally {
      restore();
    }
  });

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

  // Every file is closed, so the crash copy has nothing left to prove. Its
  // removal must not hold the take in 'finalizing'.
  it('finishes the crash journal on a clean take without waiting for the removal', async () => {
    let settle!: () => void;
    let settled = false;
    const finish = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = () => {
            settled = true;
            resolve();
          };
        })
    );
    const { result } = await hostTake(undefined, { journal: { finish } });
    expect(finish).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    expect(result.current.state.phase).toBe('done');
    settle();
  });

  // The call sits before the report work on purpose: a throw later in the try
  // must not leave a journal behind for a take whose files all closed.
  it('finishes the crash journal before a later step throws', async () => {
    const finish = vi.fn().mockResolvedValue(undefined);
    const receiver = {
      fileName: 'guest_x.mp4',
      digestHex: async () => 'abc',
      senderSha256: 'abc',
      receivedFinalized: true,
      isAbandoned: false,
      bytesWritten: 1,
      answerResume: vi.fn(),
      get guestStartHostMs(): null {
        throw new Error('report blew up');
      },
    };
    const { result } = await hostTake(undefined, { journal: { finish }, receiver });
    expect(finish).toHaveBeenCalledTimes(1);
    expect(result.current.state.phase).toBe('done');
    expect(result.current.state.recordingError).toMatch(/^Saving didn’t finish \(report blew up\)/);
  });

  // A file that did not close is the one case the crash copy is still worth
  // something, so the lobby can offer what did get committed.
  it('keeps the crash journal when a file could not be closed', async () => {
    vi.mocked(endHostRecording).mockRejectedValueOnce(new Error('disk full'));
    const finish = vi.fn().mockResolvedValue(undefined);
    const { result } = await hostTake(undefined, { journal: { finish } });
    expect(finish).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe('done');
    expect(result.current.state.recordingError).toMatch(/^Saving didn’t finish \(disk full\)/);
  });

  // A reload is the crash the journal exists for: the take is still open, so
  // the copy must stay exactly as best-effort closes find it.
  it('leaves the crash journal alone when the page hides mid-take', async () => {
    const finish = vi.fn().mockResolvedValue(undefined);
    await startHostTake({ journal: { finish } });
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(finish).not.toHaveBeenCalled();
  });

  it('leaves the crash journal alone when the tab unmounts mid-take', async () => {
    const finish = vi.fn().mockResolvedValue(undefined);
    const { unmount } = await startHostTake({ journal: { finish } });
    unmount();
    expect(finish).not.toHaveBeenCalled();
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

  it('marks backups when a silent-mic warning was shown during the take', async () => {
    const { backup, wavBackup, screenBackup, result } = await hostTake(() => mediaOptions.onMicWarning('silent'));
    expect(result.current.state.micWarning).toBe('silent');
    expect(backup.markFinalized).toHaveBeenCalled();
    expect(wavBackup.markFinalized).toHaveBeenCalled();
    expect(screenBackup.markFinalized).toHaveBeenCalled();
  });

  it('sets backupBlobUrl and wavBackupBlobUrl in state when host take finishes', async () => {
    vi.mocked(endHostRecording).mockResolvedValueOnce({
      backup: new Blob(['b']),
      wavBackup: new Blob(['w']),
    });
    const { result } = await hostTake();
    expect(result.current.state.backupBlobUrl).toBe('blob:mock-url');
    expect(result.current.state.wavBackupBlobUrl).toBe('blob:mock-url');
  });

  it('the row gets the host file’s size and no digest', async () => {
    const { backup, wavBackup, screenBackup } = await hostTake(undefined, { hostWriter: { size: 2048 } });
    expect(patchRecording).toHaveBeenCalledWith(
      expect.any(String),
      { total_bytes: 2048, status: 'finalized' },
      undefined
    );
    expect(backup.markFinalized).toHaveBeenCalled();
    expect(wavBackup.markFinalized).toHaveBeenCalled();
    expect(screenBackup.markFinalized).toHaveBeenCalled();
  });

  it('a host with no camera file sends no size', async () => {
    await hostTake(undefined, { hostWriter: undefined });
    expect(patchRecording).toHaveBeenCalledWith(
      expect.any(String),
      { status: 'finalized' },
      undefined
    );
  });

  const guestSlot0 = {
    guestWriter: { fileName: 'guest_x.mp4' },
    receiver: { digestHex: async () => 'guest-digest', senderSha256: 'guest-digest', guestStartHostMs: null, syncRttMs: null, bytesWritten: 7 },
  };

  it('a recorded guest’s byte count and digest stay out of the row', async () => {
    await hostTake(undefined, { hostWriter: { size: 2048 }, ...guestSlot0 });
    expect(vi.mocked(patchRecording).mock.calls).toEqual([
      [expect.any(String), { total_bytes: 2048, status: 'finalized' }, undefined],
    ]);
    expect(vi.mocked(patchRecording).mock.calls[0]?.[1]).not.toHaveProperty('sha256');
  });

  it('a host with no camera file sends no size even when a guest was recorded', async () => {
    await hostTake(undefined, { hostWriter: undefined, ...guestSlot0 });
    expect(vi.mocked(patchRecording).mock.calls[0]?.[1]).toStrictEqual({ status: 'finalized' });
  });

  it('the host file sizes are read after the files are flushed and closed', async () => {
    const hostWriter = { size: 0 };
    vi.mocked(endHostRecording).mockImplementationOnce(async () => {
      hostWriter.size = 2048;
      return { backup: null };
    });
    const { backup, wavBackup, screenBackup } = await hostTake(undefined, { hostWriter });
    expect(backup.markFinalized).toHaveBeenCalled();
    expect(wavBackup.markFinalized).toHaveBeenCalled();
    expect(screenBackup.markFinalized).toHaveBeenCalled();
    expect(patchRecording).toHaveBeenCalledWith(
      expect.any(String),
      { total_bytes: 2048, status: 'finalized' },
      undefined
    );
  });

  it('an empty host camera file keeps every host backup', async () => {
    const { backup, wavBackup, screenBackup, result } = await hostTake(undefined, { hostWriter: { size: 0 } });
    expect(backup.markFinalized).not.toHaveBeenCalled();
    expect(wavBackup.markFinalized).not.toHaveBeenCalled();
    expect(screenBackup.markFinalized).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe('done');
    expect(result.current.state.recordingError).toBeNull();
  });

  it('an empty host WAV keeps every host backup', async () => {
    const { backup, wavBackup, screenBackup } = await hostTake(undefined, { hostWavWriter: { size: 0 } });
    expect(backup.markFinalized).not.toHaveBeenCalled();
    expect(wavBackup.markFinalized).not.toHaveBeenCalled();
    expect(screenBackup.markFinalized).not.toHaveBeenCalled();
  });

  it('an empty host camera file sends total_bytes 0 in metadata PATCH', async () => {
    const { recordingId } = await hostTake(undefined, { hostWriter: { size: 0 } });
    expect(patchRecording).toHaveBeenCalledWith(
      recordingId,
      { total_bytes: 0, status: 'finalized' },
      undefined
    );
  });

  it('an empty screen file does not keep the host backups', async () => {
    const { backup, wavBackup, screenBackup } = await hostTake(undefined, {
      hostWriter: { size: 2048 },
      screenWriters: [{ size: 0, fileName: 'host_screen_x.mp4' }],
    });
    expect(backup.markFinalized).toHaveBeenCalled();
    expect(wavBackup.markFinalized).toHaveBeenCalled();
    expect(screenBackup.markFinalized).toHaveBeenCalled();
  });

  it('a failed metadata PATCH still ends the take with its summary and no error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(patchRecording).mockRejectedValueOnce(new Error('offline'));
    const { result } = await hostTake();
    expect(result.current.state.recordingError).toBeNull();
    expect(result.current.state.summary).not.toBeNull();
    expect(warn).toHaveBeenCalledWith('openMeet: recording metadata save failed', expect.any(Error));
    warn.mockRestore();
  });

  it('a host with no camera file marks backups when WAV master holds bytes', async () => {
    const { backup, wavBackup, screenBackup, recordingId } = await hostTake(undefined, {
      hostWriter: undefined,
      hostWavWriter: { size: 1024 },
    });
    expect(patchRecording).toHaveBeenCalledWith(
      recordingId,
      { status: 'finalized' },
      undefined
    );
    expect(backup.markFinalized).toHaveBeenCalled();
    expect(wavBackup.markFinalized).toHaveBeenCalled();
    expect(screenBackup.markFinalized).toHaveBeenCalled();
  });

  it('an empty WAV master keeps backups even when camera file has bytes', async () => {
    const { backup, wavBackup, screenBackup, recordingId } = await hostTake(undefined, {
      hostWriter: { size: 2048 },
      hostWavWriter: { size: 0 },
    });
    expect(patchRecording).toHaveBeenCalledWith(
      recordingId,
      { total_bytes: 2048, status: 'finalized' },
      undefined
    );
    expect(backup.markFinalized).not.toHaveBeenCalled();
    expect(wavBackup.markFinalized).not.toHaveBeenCalled();
    expect(screenBackup.markFinalized).not.toHaveBeenCalled();
  });

  it('wires getPeerName callback into endHostRecording', async () => {
    await hostTake();
    expect(endHostRecording).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        getPeerName: expect.any(Function),
      })
    );
    const options = vi.mocked(endHostRecording).mock.calls[0]?.[1];
    expect(options?.getPeerName?.('p-guest')).toBe('Guest');
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

  it('drives a host take to its end with a fake directory, writing sync and chat sidecars and setting sidecarsSaved: true', async () => {
    const { dir: fakeDir, writtenFiles } = fakeDirectory();

    vi.mocked(startHostRecording).mockImplementationOnce(async () => ({
      recordingId: 'rec-host-sidecars',
      take: 1,
      dir: fakeDir as never,
      hostStartMs: 10_000,
      videoFps: 25,
      hostWriter: { fileName: 'host_rec-host-sidecars.mp4' },
      guestWriter: { fileName: 'guest_rec-host-sidecars.mp4' },
      slotPeerIds: new Map([[0, 'p-guest']]),
      receiver: {
        digestHex: async () => 'abc',
        senderSha256: 'abc',
        senderFrameRate: 24,
        guestStartHostMs: 10_500,
        syncRttMs: 10,
        bytesWritten: 1,
      },
    } as never));

    const { result } = renderHook(() => useRoom('xyz-test-room'));
    const fakeStream = {
      getTracks: () => [{ kind: 'video' }, { kind: 'audio' }],
      getAudioTracks: () => [{ kind: 'audio' }],
      getVideoTracks: () => [{ kind: 'video' }],
    } as unknown as MediaStream;

    await act(async () => {
      await result.current.join(fakeStream, 'Host Ana');
    });

    act(() => {
      emitSignal('role-assigned', {
        type: 'role-assigned',
        role: 'host',
        peerId: 'p-host',
        ordinal: 1,
        peers: [{ peerId: 'p-guest', ordinal: 2, role: 'guest', displayName: 'Bob' }],
        recording: false,
      });
    });

    await act(async () => {
      await result.current.startRecording();
    });
    expect(result.current.state.phase).toBe('recording');

    act(() => {
      result.current.sendChat('hello from host during take');
    });

    await act(async () => {
      await result.current.endRecording();
    });

    expect(result.current.state.phase).toBe('done');
    expect(result.current.state.sidecarsSaved).toBe(true);
    expect(result.current.state.recordingError).toBeNull();

    expect(writtenFiles.has('sync_rec-host-sidecars.json')).toBe(true);
    const syncJson = new TextDecoder().decode(writtenFiles.get('sync_rec-host-sidecars.json')?.data);
    const parsedSync = JSON.parse(syncJson);
    expect(parsedSync).toMatchObject({ generatedBy: 'openMeet' });
    expect(parsedSync.frameRate.files.map((f: { file: string }) => f.file)).toEqual([
      'host_rec-host-sidecars.mp4',
      'guest_rec-host-sidecars.mp4',
    ]);
    expect(parsedSync.frameRate.files[0]).toMatchObject({
      file: 'host_rec-host-sidecars.mp4',
      trackFps: 25,
    });
    expect(parsedSync.frameRate.files[0].conform).toContain('host_rec-host-sidecars_cfr.mp4');
    expect(parsedSync.frameRate.files[0].conform).toContain('-vf fps=25 ');
    expect(parsedSync.frameRate.files[1]).toMatchObject({
      file: 'guest_rec-host-sidecars.mp4',
      trackFps: 24,
    });
    expect(parsedSync.frameRate.files[1].conform).toContain('-vf fps=24 ');

    expect(parsedSync.aligned.files).toContainEqual({
      file: 'guest_rec-host-sidecars.mp4',
      padMs: 500,
      cmd: expect.stringContaining('-itsoffset 0.500 '),
    });
    expect(result.current.state.summary?.commands.map((c) => c.label)).toContain(
      'Bob: aligned copy of the video (starts 0.500 s in)'
    );

    expect(writtenFiles.has('chat_rec-host-sidecars.txt')).toBe(true);
    const chatContent = new TextDecoder().decode(writtenFiles.get('chat_rec-host-sidecars.txt')?.data);
    expect(chatContent).toContain('hello from host during take');
    expect(chatContent).toContain('Host Ana');
  });

  it('puts the writers sizes into summary.fileList and sync.json', async () => {
    const { dir: fakeDir, writtenFiles } = fakeDirectory();

    const hostWriter = { fileName: 'host_rec-size.mp4', size: 0 };
    const guestWriter = { fileName: 'guest_rec-size.mp4', size: 0 };
    const hostWavWriter = { fileName: 'host_rec-size.wav', size: 0 };
    const screenWriter = { fileName: 'host_screen_rec-size.mp4', size: 0 };

    // The tail lands while the host waits for its guests: sizes are only final once this returns.
    vi.mocked(endHostRecording).mockImplementationOnce(async () => {
      hostWriter.size = 2048;
      guestWriter.size = 512;
      hostWavWriter.size = 44;
      screenWriter.size = 7;
      return { sha256: 'abc', totalBytes: 1, backup: null };
    });

    vi.mocked(startHostRecording).mockImplementationOnce(async () => ({
      recordingId: 'rec-size',
      take: 1,
      dir: fakeDir as never,
      hostStartMs: 10_000,
      videoFps: 25,
      hostWriter,
      guestWriter,
      hostWavWriter,
      screenWriters: [screenWriter],
      slotPeerIds: new Map([[0, 'p-guest']]),
      receiver: {
        digestHex: async () => 'abc',
        senderSha256: 'abc',
        guestStartHostMs: 10_500,
        syncRttMs: 10,
        bytesWritten: 1,
      },
    } as never));

    const { result } = renderHook(() => useRoom('xyz-test-room'));
    const fakeStream = {
      getTracks: () => [{ kind: 'video' }, { kind: 'audio' }],
      getAudioTracks: () => [{ kind: 'audio' }],
      getVideoTracks: () => [{ kind: 'video' }],
    } as unknown as MediaStream;

    await act(async () => {
      await result.current.join(fakeStream, 'Host Ana');
    });

    act(() => {
      emitSignal('role-assigned', {
        type: 'role-assigned',
        role: 'host',
        peerId: 'p-host',
        ordinal: 1,
        peers: [{ peerId: 'p-guest', ordinal: 2, role: 'guest', displayName: 'Bob' }],
        recording: false,
      });
    });

    await act(async () => {
      await result.current.startRecording();
    });
    expect(result.current.state.phase).toBe('recording');

    await act(async () => {
      await result.current.endRecording();
    });

    expect(result.current.state.phase).toBe('done');
    expect(result.current.state.recordingError).toBeNull();

    expect(result.current.state.summary?.fileList).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'host_rec-size.mp4', bytes: 2048 }),
        expect.objectContaining({ name: 'guest_rec-size.mp4', bytes: 512 }),
        expect.objectContaining({ name: 'host_rec-size.wav', bytes: 44 }),
        expect.objectContaining({ name: 'host_screen_rec-size.mp4', bytes: 7 }),
      ])
    );

    expect(writtenFiles.has('sync_rec-size.json')).toBe(true);
    const syncJson = new TextDecoder().decode(writtenFiles.get('sync_rec-size.json')?.data);
    const parsedSync = JSON.parse(syncJson);
    expect(parsedSync.verification).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: 'host_rec-size.mp4', bytes: 2048 }),
        expect.objectContaining({ file: 'guest_rec-size.mp4', bytes: 512 }),
        expect.objectContaining({ file: 'host_rec-size.wav', bytes: 44 }),
        expect.objectContaining({ file: 'host_screen_rec-size.mp4', bytes: 7 }),
      ])
    );
  });

  it('finalizes cleanly when reading file sizes fails', async () => {
    vi.mocked(collectFileChecks).mockImplementationOnce(() => {
      throw new Error('size read failed');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { result } = await hostTake();
      expect(result.current.state.summary).not.toBeNull();
      expect(result.current.state.recordingError).toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('finalizes cleanly when collectFileChecks rejects', async () => {
    vi.mocked(collectFileChecks).mockRejectedValueOnce(new Error('checks failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { result } = await hostTake();
      expect(result.current.state.summary).not.toBeNull();
      expect(result.current.state.recordingError).toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('leaves sidecarsSaved: false, phase: "done" and no recordingError when sidecar write fails', async () => {
    const rejectingDir = {
      getFileHandle: vi.fn().mockResolvedValue({
        name: 'sync_rec-host-fail.json',
        createWritable: vi.fn().mockRejectedValue(new Error('disk write failed')),
      }),
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.mocked(startHostRecording).mockImplementationOnce(async () => ({
      recordingId: 'rec-host-fail',
      take: 1,
      dir: rejectingDir as never,
      hostStartMs: 10_000,
      hostWriter: { fileName: 'host_rec-host-fail.mp4' },
      guestWriter: { fileName: 'guest_rec-host-fail.mp4' },
      slotPeerIds: new Map([[0, 'p-guest']]),
      receiver: {
        digestHex: async () => 'abc',
        senderSha256: 'abc',
        guestStartHostMs: 10_500,
        syncRttMs: 10,
        bytesWritten: 1,
      },
    } as never));

    const { result } = renderHook(() => useRoom('xyz-test-room'));
    const fakeStream = {
      getTracks: () => [{ kind: 'video' }, { kind: 'audio' }],
      getAudioTracks: () => [{ kind: 'audio' }],
      getVideoTracks: () => [{ kind: 'video' }],
    } as unknown as MediaStream;

    await act(async () => {
      await result.current.join(fakeStream, 'Host Ana');
    });

    act(() => {
      emitSignal('role-assigned', {
        type: 'role-assigned',
        role: 'host',
        peerId: 'p-host',
        ordinal: 1,
        peers: [{ peerId: 'p-guest', ordinal: 2, role: 'guest', displayName: 'Bob' }],
        recording: false,
      });
    });

    await act(async () => {
      await result.current.startRecording();
    });

    await act(async () => {
      await result.current.endRecording();
    });

    expect(result.current.state.phase).toBe('done');
    expect(result.current.state.sidecarsSaved).toBe(false);
    expect(result.current.state.recordingError).toBeNull();
    warnSpy.mockRestore();
  });

  it('completes take and writes sync sidecar when a malformed chat message is received during the take', async () => {
    const { dir: fakeDir, writtenFiles } = fakeDirectory();

    vi.mocked(startHostRecording).mockImplementationOnce(async () => ({
      recordingId: 'rec-host-malformed',
      take: 1,
      dir: fakeDir as never,
      hostStartMs: 10_000,
      hostWriter: { fileName: 'host_rec-host-malformed.mp4', close: vi.fn().mockResolvedValue(undefined) },
      guestWriter: { fileName: 'guest_rec-host-malformed.mp4', close: vi.fn().mockResolvedValue(undefined) },
      slotPeerIds: new Map([[0, 'p-guest']]),
      receiver: {
        digestHex: async () => 'abc',
        senderSha256: 'abc',
        guestStartHostMs: 10_500,
        syncRttMs: 10,
        bytesWritten: 1,
      },
    } as never));

    const { result } = renderHook(() => useRoom('xyz-test-room'));
    const fakeStream = {
      getTracks: () => [{ kind: 'video' }, { kind: 'audio' }],
      getAudioTracks: () => [{ kind: 'audio' }],
      getVideoTracks: () => [{ kind: 'video' }],
    } as unknown as MediaStream;

    await act(async () => {
      await result.current.join(fakeStream, 'Host Ana');
    });

    act(() => {
      emitSignal('role-assigned', {
        type: 'role-assigned',
        role: 'host',
        peerId: 'p-host',
        ordinal: 1,
        peers: [{ peerId: 'p-guest', ordinal: 2, role: 'guest', displayName: 'Bob' }],
        recording: false,
      });
    });

    await act(async () => {
      await result.current.startRecording();
    });
    expect(result.current.state.phase).toBe('recording');

    act(() => {
      emitSignal('chat', {
        type: 'chat',
        from: 'guest',
        fromName: 'Bob',
        text: 123 as any,
        ts: 11_000,
      });
    });

    await act(async () => {
      await result.current.endRecording();
    });

    expect(result.current.state.phase).toBe('done');
    expect(result.current.state.recordingError).toBeNull();
    expect(result.current.state.messages).toEqual([]);
    expect(writtenFiles.has('sync_rec-host-malformed.json')).toBe(true);
    expect(writtenFiles.has('chat_rec-host-malformed.txt')).toBe(false);
  });

  it('stamps received chat messages with local clock so sender clock cannot skew or omit lines', async () => {
    const { dir: fakeDir, writtenFiles } = fakeDirectory();

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    try {
      vi.mocked(startHostRecording).mockImplementationOnce(async () => ({
        recordingId: 'rec-host-clock',
        take: 1,
        dir: fakeDir as never,
        hostStartMs: 10_000,
        hostWriter: { fileName: 'host_rec-host-clock.mp4', close: vi.fn().mockResolvedValue(undefined) },
        guestWriter: { fileName: 'guest_rec-host-clock.mp4', close: vi.fn().mockResolvedValue(undefined) },
        slotPeerIds: new Map([[0, 'p-guest']]),
        receiver: {
          digestHex: async () => 'abc',
          senderSha256: 'abc',
          guestStartHostMs: 10_500,
          syncRttMs: 10,
          bytesWritten: 1,
        },
      } as never));

      const { result } = renderHook(() => useRoom('xyz-test-room'));
      const fakeStream = {
        getTracks: () => [{ kind: 'video' }, { kind: 'audio' }],
        getAudioTracks: () => [{ kind: 'audio' }],
        getVideoTracks: () => [{ kind: 'video' }],
      } as unknown as MediaStream;

      await act(async () => {
        await result.current.join(fakeStream, 'Host Ana');
      });

      act(() => {
        emitSignal('role-assigned', {
          type: 'role-assigned',
          role: 'host',
          peerId: 'p-host',
          ordinal: 1,
          peers: [{ peerId: 'p-guest', ordinal: 2, role: 'guest', displayName: 'Bob' }],
          recording: false,
        });
      });

      await act(async () => {
        await result.current.startRecording();
      });
      expect(result.current.state.phase).toBe('recording');

      // Message arriving at 12_000 local time (offset 0:02) with ts far in the past
      nowSpy.mockReturnValue(12_000);
      act(() => {
        emitSignal('chat', {
          type: 'chat',
          from: 'guest',
          fromName: 'Bob',
          text: 'past message',
          ts: 0,
        });
      });

      // Message arriving at 15_000 local time (offset 0:05) with ts far in the future
      nowSpy.mockReturnValue(15_000);
      act(() => {
        emitSignal('chat', {
          type: 'chat',
          from: 'guest',
          fromName: 'Bob',
          text: 'future message',
          ts: 9_999_999_999,
        });
      });

      nowSpy.mockReturnValue(20_000);
      await act(async () => {
        await result.current.endRecording();
      });

      expect(result.current.state.phase).toBe('done');
      expect(writtenFiles.has('chat_rec-host-clock.txt')).toBe(true);
      const chatContent = new TextDecoder().decode(writtenFiles.get('chat_rec-host-clock.txt')?.data);
      expect(chatContent).toBe(
        '[0:02] guest Bob: past message\n' +
        '[0:05] guest Bob: future message\n'
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('drops messages longer than 4000 characters and keeps messages of up to 4000 characters', async () => {
    const { result } = renderHook(() => useRoom('xyz-test-room'));
    const fakeStream = {
      getTracks: () => [],
      getAudioTracks: () => [],
      getVideoTracks: () => [],
    } as unknown as MediaStream;

    await act(async () => {
      await result.current.join(fakeStream, 'User');
    });

    act(() => {
      emitSignal('chat', {
        type: 'chat',
        from: 'guest',
        text: 'a'.repeat(4001),
        ts: 1000,
      });
    });
    expect(result.current.state.messages).toHaveLength(0);

    act(() => {
      emitSignal('chat', {
        type: 'chat',
        from: 'guest',
        text: 'b'.repeat(4000),
        ts: 2000,
      });
    });
    expect(result.current.state.messages).toHaveLength(1);
    expect(result.current.state.messages[0]?.text).toHaveLength(4000);
  });

  it('completes take and writes sync sidecar when chat building encounters non-string fromName', async () => {
    const { dir: fakeDir, writtenFiles } = fakeDirectory();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      vi.mocked(startHostRecording).mockImplementationOnce(async () => ({
        recordingId: 'rec-host-chat-err',
        take: 1,
        dir: fakeDir as never,
        hostStartMs: 10_000,
        hostWriter: { fileName: 'host_rec-host-chat-err.mp4', close: vi.fn().mockResolvedValue(undefined) },
        guestWriter: { fileName: 'guest_rec-host-chat-err.mp4', close: vi.fn().mockResolvedValue(undefined) },
        slotPeerIds: new Map([[0, 'p-guest']]),
        receiver: {
          digestHex: async () => 'abc',
          senderSha256: 'abc',
          guestStartHostMs: 10_500,
          syncRttMs: 10,
          bytesWritten: 1,
        },
      } as never));

      const { result } = renderHook(() => useRoom('xyz-test-room'));
      const fakeStream = {
        getTracks: () => [{ kind: 'video' }, { kind: 'audio' }],
        getAudioTracks: () => [{ kind: 'audio' }],
        getVideoTracks: () => [{ kind: 'video' }],
      } as unknown as MediaStream;

      await act(async () => {
        await result.current.join(fakeStream, 'Host Ana');
      });

      act(() => {
        emitSignal('role-assigned', {
          type: 'role-assigned',
          role: 'host',
          peerId: 'p-host',
          ordinal: 1,
          peers: [{ peerId: 'p-guest', ordinal: 2, role: 'guest', displayName: 'Bob' }],
          recording: false,
        });
      });

      await act(async () => {
        await result.current.startRecording();
      });
      expect(result.current.state.phase).toBe('recording');

      act(() => {
        emitSignal('chat', {
          type: 'chat',
          from: 'guest',
          fromName: 123 as any,
          text: 'ok',
          ts: 11_000,
        });
      });

      await act(async () => {
        await result.current.endRecording();
      });

      expect(result.current.state.phase).toBe('done');
      expect(result.current.state.recordingError).toBeNull();
      expect(writtenFiles.has('sync_rec-host-chat-err.json')).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('completes take and writes sync sidecar when malformed marker labels are received', async () => {
    const { dir: fakeDir, writtenFiles } = fakeDirectory();

    vi.mocked(startHostRecording).mockImplementationOnce(async () => ({
      recordingId: 'rec-host-bad-marker',
      take: 1,
      dir: fakeDir as never,
      hostStartMs: 10_000,
      hostWriter: { fileName: 'host_rec-host-bad-marker.mp4', close: vi.fn().mockResolvedValue(undefined) },
      guestWriter: { fileName: 'guest_rec-host-bad-marker.mp4', close: vi.fn().mockResolvedValue(undefined) },
      slotPeerIds: new Map([[0, 'p-guest']]),
      receiver: {
        digestHex: async () => 'abc',
        senderSha256: 'abc',
        guestStartHostMs: 10_500,
        syncRttMs: 10,
        bytesWritten: 1,
      },
    } as never));

    const { result } = renderHook(() => useRoom('xyz-test-room'));
    const fakeStream = {
      getTracks: () => [{ kind: 'video' }, { kind: 'audio' }],
      getAudioTracks: () => [{ kind: 'audio' }],
      getVideoTracks: () => [{ kind: 'video' }],
    } as unknown as MediaStream;

    await act(async () => {
      await result.current.join(fakeStream, 'Host Ana');
    });

    act(() => {
      emitSignal('role-assigned', {
        type: 'role-assigned',
        role: 'host',
        peerId: 'p-host',
        ordinal: 1,
        peers: [{ peerId: 'p-guest', ordinal: 2, role: 'guest', displayName: 'Bob' }],
        recording: false,
      });
    });

    await act(async () => {
      await result.current.startRecording();
    });
    expect(result.current.state.phase).toBe('recording');

    act(() => {
      emitSignal('marker', {
        type: 'marker',
        label: { toString: 0 } as any,
        from: 'guest',
      });
      emitSignal('marker', {
        type: 'marker',
        label: { a: 1 } as any,
        from: 'guest',
      });
      emitSignal('marker', {
        type: 'marker',
        label: 'x'.repeat(201),
        from: 'guest',
      });
      emitSignal('marker', {
        type: 'marker',
        label: 'y'.repeat(200),
        from: 'guest',
      });
    });

    await act(async () => {
      await result.current.endRecording();
    });

    expect(result.current.state.phase).toBe('done');
    expect(result.current.state.recordingError).toBeNull();
    expect(result.current.state.markers.map((m) => m.label)).toEqual(['', '', '', 'y'.repeat(200)]);
    expect(writtenFiles.has('sync_rec-host-bad-marker.json')).toBe(true);
  });

  it('allows host own markers after 1000 relayed markers while dropping the 1001st relayed marker', async () => {
    const { dir: fakeDir, writtenFiles } = fakeDirectory();

    vi.mocked(startHostRecording).mockImplementationOnce(async () => ({
      recordingId: 'rec-host-1000-markers',
      take: 1,
      dir: fakeDir as never,
      hostStartMs: 10_000,
      hostWriter: { fileName: 'host_rec-host-1000-markers.mp4', close: vi.fn().mockResolvedValue(undefined) },
      guestWriter: { fileName: 'guest_rec-host-1000-markers.mp4', close: vi.fn().mockResolvedValue(undefined) },
      slotPeerIds: new Map([[0, 'p-guest']]),
      receiver: {
        digestHex: async () => 'abc',
        senderSha256: 'abc',
        guestStartHostMs: 10_500,
        syncRttMs: 10,
        bytesWritten: 1,
      },
    } as never));

    const { result } = renderHook(() => useRoom('xyz-test-room'));
    const fakeStream = {
      getTracks: () => [{ kind: 'video' }, { kind: 'audio' }],
      getAudioTracks: () => [{ kind: 'audio' }],
      getVideoTracks: () => [{ kind: 'video' }],
    } as unknown as MediaStream;

    await act(async () => {
      await result.current.join(fakeStream, 'Host Ana');
    });

    act(() => {
      emitSignal('role-assigned', {
        type: 'role-assigned',
        role: 'host',
        peerId: 'p-host',
        ordinal: 1,
        peers: [{ peerId: 'p-guest', ordinal: 2, role: 'guest', displayName: 'Bob' }],
        recording: false,
      });
    });

    await act(async () => {
      await result.current.startRecording();
    });
    expect(result.current.state.phase).toBe('recording');

    act(() => {
      for (let i = 1; i <= 1001; i++) {
        emitSignal('marker', {
          type: 'marker',
          label: `m-${i}`,
          from: 'guest',
        });
      }
      result.current.addMarker('Host own marker');
    });

    await act(async () => {
      await result.current.endRecording();
    });

    expect(result.current.state.phase).toBe('done');
    expect(result.current.state.markers).toHaveLength(1001);
    expect(result.current.state.markers.some((m) => m.label === 'm-1001')).toBe(false);
    expect(result.current.state.markers.some((m) => m.label === 'Host own marker')).toBe(true);

    const chapters = new TextDecoder().decode(writtenFiles.get('chapters_rec-host-1000-markers.txt')?.data);
    expect(chapters).toContain('Host own marker');
    expect(chapters).not.toContain('m-1001');
  });

  // The take's own marker list is lost with the tab, so the notes are the only
  // record a recovered take has of what was marked and by whom.
  it('copies a relayed marker into the crash journal notes', async () => {
    const notes = fakeNotes();
    await hostTake(
      () =>
        emitSignal('marker', {
          type: 'marker',
          label: 'one',
          from: 'guest',
          fromName: 'Bob',
        }),
      { journal: fakeJournal(notes) }
    );

    expect(notes.markers).toEqual([
      { atMs: expect.any(Number), label: 'one', from: 'guest', name: 'Bob' },
    ]);
  });

  it('bounds the notes markers without dropping the take’s own', async () => {
    const notes = fakeNotes();
    notes.markers = Array.from({ length: MAX_RELAYED_MARKERS - 1 }, (_, i) => ({
      atMs: i,
      label: `m-${i}`,
      from: 'guest' as const,
    }));
    const { result } = await hostTake(
      () => {
        emitSignal('marker', { type: 'marker', label: 'last', from: 'guest' });
        emitSignal('marker', { type: 'marker', label: 'overflow', from: 'guest' });
      },
      { journal: fakeJournal(notes) }
    );

    expect(notes.markers.map((m) => m.label)).toEqual([
      ...Array.from({ length: MAX_RELAYED_MARKERS - 1 }, (_, i) => `m-${i}`),
      'last',
    ]);
    expect(result.current.state.markers.map((m) => m.label)).toEqual(['last', 'overflow']);
  });

  it('names the guest on the note its camera file opened', async () => {
    const notes = fakeNotes();
    notes.files = [{ file: 'guest_rec-host-1.mp4', kind: 'camera', slot: 0 }];
    const channel = { label: 'recording', readyState: 'open' } as unknown as RTCDataChannel;

    await hostTake(
      () => vi.mocked(PeerConnection).mock.calls.at(-1)![0].onDataChannel?.(channel),
      {
        channelRef: { current: null },
        journal: fakeJournal(notes),
        guestWriter: { fileName: 'guest_rec-host-1.mp4' },
        receiver: guestReceiver('guest_rec-host-1.mp4'),
      }
    );

    await vi.waitFor(() =>
      expect(notes.files).toEqual([
        {
          file: 'guest_rec-host-1.mp4',
          kind: 'camera',
          slot: 0,
          key: 'p-guest',
          who: 'Guest',
        },
      ])
    );
  });

  it('leaves who off the note while the guest has no name', async () => {
    const notes = fakeNotes();
    notes.files = [{ file: 'guest_rec-host-1.mp4', kind: 'camera', slot: 0 }];
    const channel = { label: 'recording', readyState: 'open' } as unknown as RTCDataChannel;

    await hostTake(
      () => vi.mocked(PeerConnection).mock.calls.at(-1)![0].onDataChannel?.(channel),
      {
        channelRef: { current: null },
        journal: fakeJournal(notes),
        guestWriter: { fileName: 'guest_rec-host-1.mp4' },
        receiver: guestReceiver('guest_rec-host-1.mp4'),
      },
      [{ peerId: 'p-guest', ordinal: 2, role: 'guest', displayName: null }]
    );

    await vi.waitFor(() =>
      expect(notes.files).toEqual([
        {
          file: 'guest_rec-host-1.mp4',
          kind: 'camera',
          slot: 0,
          key: 'p-guest',
        },
      ])
    );
  });

  it('names the guest on the note its WAV file opened', async () => {
    const notes = fakeNotes();
    const { dir } = fakeDirectory();
    const channel = {
      label: 'recording-audio',
      readyState: 'open',
      send: vi.fn(),
    } as unknown as RTCDataChannel;

    const { recordingId, result } = await hostTake(
      () => vi.mocked(PeerConnection).mock.calls.at(-1)![0].onDataChannel?.(channel),
      { dir, journal: fakeJournal(notes) }
    );

    await vi.waitFor(() =>
      expect(notes.files).toEqual([
        {
          file: `guest_${recordingId}.wav`,
          kind: 'wav',
          key: 'p-guest',
          slot: 0,
          who: 'Guest',
        },
      ])
    );
    expect(result.current.state.recordingError).toBeNull();
  });

  it('leaves the screen note naming the guest by socket peerId', async () => {
    const notes = fakeNotes();
    const { dir } = fakeDirectory();
    const channel = {
      label: 'recording-screen-1',
      readyState: 'open',
      send: vi.fn(),
      addEventListener: vi.fn(),
    } as unknown as RTCDataChannel;

    const { recordingId, result } = await hostTake(
      () => vi.mocked(PeerConnection).mock.calls.at(-1)![0].onDataChannel?.(channel),
      { dir, journal: fakeJournal(notes) }
    );

    await vi.waitFor(() =>
      expect(notes.files).toEqual([
        {
          file: `guest_screen_${recordingId}.mp4`,
          kind: 'screen',
          segment: 1,
          startedAtMs: expect.any(Number),
          who: 'p-guest',
        },
      ])
    );
    expect(result.current.state.recordingError).toBeNull();
  });

  // The host's own marker comes from the button, not a relay, and the notes are
  // the only record a recovered take has of it.
  it('copies the host own marker into the crash journal notes', async () => {
    const notes = fakeNotes();

    await hostTake(
      (_onError, hook) => hook.current.addMarker('host mark'),
      { journal: fakeJournal(notes) }
    );

    expect(notes.markers).toEqual([
      { atMs: expect.any(Number), label: 'host mark', from: 'host', name: 'Host Hana' },
    ]);
  });

  // A channel can arrive from a peer the room no longer lists. The name is
  // simply unknown then, and the bind still has to run with `who` absent.
  it('leaves who off the note when the socket peer is no longer listed', async () => {
    const notes = fakeNotes();
    notes.files = [{ file: 'guest_rec-host-1.mp4', kind: 'camera', slot: 0 }];
    const channel = { label: 'recording', readyState: 'open' } as unknown as RTCDataChannel;

    await hostTake(
      () => emitSignal('peer-left', { type: 'peer-left', peerId: 'p-guest' }),
      {
        channelRef: { current: null },
        journal: fakeJournal(notes),
        guestWriter: { fileName: 'guest_rec-host-1.mp4' },
        receiver: guestReceiver('guest_rec-host-1.mp4'),
      },
      undefined,
      () => vi.mocked(PeerConnection).mock.calls.at(-1)![0].onDataChannel?.(channel)
    );

    await vi.waitFor(() =>
      expect(notes.files).toEqual([
        { file: 'guest_rec-host-1.mp4', kind: 'camera', slot: 0, key: 'p-guest' },
      ])
    );
  });

  it('retries buildSyncReport without markers if the first call throws', async () => {
    const { dir: fakeDir, writtenFiles } = fakeDirectory();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      vi.mocked(startHostRecording).mockImplementationOnce(async () => ({
        recordingId: 'rec-host-retry-markers',
        take: 1,
        dir: fakeDir as never,
        hostStartMs: 10_000,
        hostWriter: { fileName: 'host_rec-host-retry-markers.mp4', close: vi.fn().mockResolvedValue(undefined) },
        guestWriter: { fileName: 'guest_rec-host-retry-markers.mp4', close: vi.fn().mockResolvedValue(undefined) },
        slotPeerIds: new Map([[0, 'p-guest']]),
        receiver: {
          digestHex: async () => 'abc',
          senderSha256: 'abc',
          guestStartHostMs: 10_500,
          syncRttMs: 10,
          bytesWritten: 1,
        },
      } as never));

      const { result } = renderHook(() => useRoom('xyz-test-room'));
      const fakeStream = {
        getTracks: () => [{ kind: 'video' }, { kind: 'audio' }],
        getAudioTracks: () => [{ kind: 'audio' }],
        getVideoTracks: () => [{ kind: 'video' }],
      } as unknown as MediaStream;

      await act(async () => {
        await result.current.join(fakeStream, 'Host Ana');
      });

      act(() => {
        emitSignal('role-assigned', {
          type: 'role-assigned',
          role: 'host',
          peerId: 'p-host',
          ordinal: 1,
          peers: [{ peerId: 'p-guest', ordinal: 2, role: 'guest', displayName: 'Bob' }],
          recording: false,
        });
      });

      await act(async () => {
        await result.current.startRecording();
      });
      expect(result.current.state.phase).toBe('recording');

      act(() => {
        emitSignal('marker', {
          type: 'marker',
          label: 'marker-to-fail',
          from: 'guest',
        });
      });

      vi.mocked(buildSyncReport).mockImplementationOnce(() => {
        throw new Error('first call with markers threw');
      });

      await act(async () => {
        await result.current.endRecording();
      });

      expect(result.current.state.phase).toBe('done');
      expect(result.current.state.recordingError).toBeNull();
      expect(vi.mocked(buildSyncReport)).toHaveBeenLastCalledWith(
        expect.objectContaining({ markers: [] })
      );
      expect(writtenFiles.has('sync_rec-host-retry-markers.json')).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('carries file sizes into the summary when buildSyncReport retries without markers', async () => {
    const { dir: fakeDir, writtenFiles } = fakeDirectory();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const hostWriter = { fileName: 'host_rec-retry-size.mp4', size: 1024, close: vi.fn().mockResolvedValue(undefined) };
      const guestWriter = { fileName: 'guest_rec-retry-size.mp4', size: 512, close: vi.fn().mockResolvedValue(undefined) };
      vi.mocked(startHostRecording).mockImplementationOnce(async () => ({
        recordingId: 'rec-retry-size',
        take: 1,
        dir: fakeDir as never,
        hostStartMs: 10_000,
        hostWriter,
        guestWriter,
        slotPeerIds: new Map([[0, 'p-guest']]),
        receiver: {
          digestHex: async () => 'abc',
          senderSha256: 'abc',
          guestStartHostMs: 10_500,
          syncRttMs: 10,
          bytesWritten: 1,
        },
      } as never));

      const { result } = renderHook(() => useRoom('xyz-test-room'));
      const fakeStream = {
        getTracks: () => [{ kind: 'video' }, { kind: 'audio' }],
        getAudioTracks: () => [{ kind: 'audio' }],
        getVideoTracks: () => [{ kind: 'video' }],
      } as unknown as MediaStream;

      await act(async () => {
        await result.current.join(fakeStream, 'Host Ana');
      });

      act(() => {
        emitSignal('role-assigned', {
          type: 'role-assigned',
          role: 'host',
          peerId: 'p-host',
          ordinal: 1,
          peers: [{ peerId: 'p-guest', ordinal: 2, role: 'guest', displayName: 'Bob' }],
          recording: false,
        });
      });

      await act(async () => {
        await result.current.startRecording();
      });
      expect(result.current.state.phase).toBe('recording');

      act(() => {
        emitSignal('marker', {
          type: 'marker',
          label: 'marker-to-fail',
          from: 'guest',
        });
      });

      vi.mocked(buildSyncReport).mockImplementationOnce(() => {
        throw new Error('first call with markers threw');
      });

      await act(async () => {
        await result.current.endRecording();
      });

      expect(result.current.state.phase).toBe('done');
      expect(result.current.state.recordingError).toBeNull();
      expect(result.current.state.summary?.fileList).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'host_rec-retry-size.mp4', bytes: 1024 }),
          expect.objectContaining({ name: 'guest_rec-retry-size.mp4', bytes: 512 }),
        ])
      );
      expect(writtenFiles.has('sync_rec-retry-size.json')).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('two screen channels arriving together through the call each open their own file', async () => {
    const opened: string[] = [];
    const dir = {
      getFileHandle: async (name: string) => {
        opened.push(name);
        return { name, createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
      },
      removeEntry: async () => {},
    };
    const screenChannel = () =>
      Object.assign(new EventTarget(), { label: 'recording-screen-1', readyState: 'open' }) as unknown as RTCDataChannel;
    const { recordingId } = await hostTake(() => {
      const opts = vi.mocked(PeerConnection).mock.calls.at(-1)![0];
      opts.onDataChannel?.(screenChannel());
      opts.onDataChannel?.(screenChannel());
    }, { dir });
    await vi.waitFor(() =>
      expect(opened.filter((n) => n.startsWith('guest_screen_'))).toEqual([
        `guest_screen_${recordingId}.mp4`,
        `guest_screen_${recordingId}_2.mp4`,
      ])
    );
  });

  /** One host take whose writers and receiver let the checks run for real. */
  async function hostTakeWithChecks() {
    const { dir: fakeDir, writtenFiles } = fakeDirectory();
    vi.mocked(startHostRecording).mockImplementationOnce(async () => ({
      recordingId: 'rec-v',
      take: 1,
      dir: fakeDir as never,
      hostStartMs: 10_000,
      hostWriter: { fileName: 'host_rec-v.mp4', size: 100 },
      guestWriter: { fileName: 'guest_rec-v.mp4', size: 50 },
      slotPeerIds: new Map([[0, 'p-guest']]),
      receiver: {
        fileName: 'guest_rec-v.mp4',
        digestHex: async () => 'aaa',
        senderSha256: 'bbb',
        receivedFinalized: true,
        isAbandoned: false,
        isTimedOut: false,
        guestStartHostMs: 10_500,
        syncRttMs: 10,
        bytesWritten: 50,
      },
    } as never));

    const { result } = renderHook(() => useRoom('xyz-test-room'));
    const fakeStream = {
      getTracks: () => [{ kind: 'video' }, { kind: 'audio' }],
      getAudioTracks: () => [{ kind: 'audio' }],
      getVideoTracks: () => [{ kind: 'video' }],
    } as unknown as MediaStream;

    await act(async () => {
      await result.current.join(fakeStream, 'Host Ana');
    });

    act(() => {
      emitSignal('role-assigned', {
        type: 'role-assigned',
        role: 'host',
        peerId: 'p-host',
        ordinal: 1,
        peers: [{ peerId: 'p-guest', ordinal: 2, role: 'guest', displayName: 'Bob' }],
        recording: false,
      });
    });

    await act(async () => {
      await result.current.startRecording();
    });
    expect(result.current.state.phase).toBe('recording');

    await act(async () => {
      await result.current.endRecording();
    });
    return { result, writtenFiles };
  }

  it('gives every file of the take its verdict in the summary and in the sync file', async () => {
    const { result, writtenFiles } = await hostTakeWithChecks();

    expect(result.current.state.phase).toBe('done');
    expect(result.current.state.recordingError).toBeNull();
    const guest = result.current.state.summary?.fileList.find((f) => f.name === 'guest_rec-v.mp4');
    expect(guest?.verdict?.status).toBe('incomplete');
    const host = result.current.state.summary?.fileList.find((f) => f.name === 'host_rec-v.mp4');
    expect(host?.verdict?.status).toBe('complete');

    const parsedSync = JSON.parse(new TextDecoder().decode(writtenFiles.get('sync_rec-v.json')?.data));
    expect(parsedSync.verification).toContainEqual(
      expect.objectContaining({ file: 'guest_rec-v.mp4', status: 'incomplete' })
    );
    expect(
      parsedSync.verification.find((v: { file: string }) => v.file === 'guest_rec-v.mp4').detail
    ).toContain('Bob');

    expect(result.current.state.summary?.warnings).toContain(
      "Not every file is complete and verified (1 of 2). Each file's verdict says why."
    );
    expect(result.current.state.summary?.integrity.ok).toBe(false);
  });

  it('still finalizes and says so per file when the checks cannot be gathered', async () => {
    vi.mocked(collectFileChecks).mockRejectedValueOnce(new Error('checks failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { result, writtenFiles } = await hostTakeWithChecks();

      expect(result.current.state.phase).toBe('done');
      expect(result.current.state.recordingError).toBeNull();
      const files = result.current.state.summary?.fileList ?? [];
      expect(files).toHaveLength(2);
      for (const f of files) {
        expect(f.verdict?.text).toBe('Not verified. This file was not checked.');
      }
      expect(writtenFiles.has('sync_rec-v.json')).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  describe('call-audio copies', () => {
    const stream = () => ({ id: 'remote' }) as unknown as MediaStream;
    const remoteStreamFrom = (peerId: string) =>
      vi.mocked(PeerConnection).mock.calls.map(([o]) => o).reverse().find((o) => o.remotePeerId === peerId)!
        .onRemoteStream;
    const recordingChannelFrom = (peerId: string) =>
      vi.mocked(PeerConnection).mock.calls.map(([o]) => o).reverse().find((o) => o.remotePeerId === peerId)!
        .onDataChannel;
    const channel = (label: string) =>
      Object.assign(new EventTarget(), { label, readyState: 'open' }) as unknown as RTCDataChannel;
    const lastPeers = () => vi.mocked(syncCallCopies).mock.calls.at(-1)![1];

    /** A host in a room with a guest, a second guest, a producer and a companion. */
    async function hostInRoom() {
      const { result } = renderHook(() => useRoom('xyz-test-room'));
      await act(async () => {
        await result.current.join(
          { getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream,
          'Host Hana'
        );
      });
      act(() => {
        emitSignal('role-assigned', {
          type: 'role-assigned',
          role: 'host',
          peerId: 'p-host',
          ordinal: 1,
          peers: [
            { peerId: 'p-guest', ordinal: 2, role: 'guest', displayName: 'Bob' },
            { peerId: 'p-firefox', ordinal: 3, role: 'guest', displayName: 'Fay' },
            { peerId: 'p-prod', ordinal: 4, role: 'producer', displayName: 'Pat' },
            { peerId: 'p-comp', ordinal: 5, role: 'guest', displayName: 'Cam', companion: true },
          ],
          recording: false,
        });
      });
      return result;
    }

    it('hands a guest to the copies only once its camera recording channel arrives', async () => {
      const result = await hostInRoom();
      const bob = stream();
      act(() => {
        remoteStreamFrom('p-guest')?.(bob);
      });
      await act(async () => {
        await result.current.startRecording();
      });

      expect(result.current.state.phase).toBe('recording');
      expect(lastPeers()).toEqual([]);
      expect(syncCallCopies).toHaveBeenCalledTimes(1);

      act(() => {
        recordingChannelFrom('p-guest')?.(channel('recording'));
      });

      expect(vi.mocked(syncCallCopies).mock.calls.at(-1)![0]).toMatchObject({ recordingId: 'rec-host-1' });
      expect(lastPeers().map((p) => p.peerId)).toEqual(['p-guest']);
      expect(lastPeers()[0]).toMatchObject({ name: 'Bob', stream: bob });

      let finish: (v: Awaited<ReturnType<typeof endHostRecording>>) => void = () => {};
      vi.mocked(endHostRecording).mockReturnValueOnce(new Promise((r) => { finish = r; }));
      let ending: Promise<void> = Promise.resolve();
      act(() => {
        ending = result.current.endRecording();
      });
      expect(result.current.state.phase).toBe('finalizing');
      const callsBefore = vi.mocked(syncCallCopies).mock.calls.length;
      act(() => {
        recordingChannelFrom('p-firefox')?.(channel('recording'));
      });
      expect(vi.mocked(syncCallCopies).mock.calls.length).toBe(callsBefore);
      await act(async () => {
        finish({ backup: null });
        await ending;
      });
      expect(result.current.state.phase).toBe('done');
    });

    it('an audio-master or screen channel alone does not hand a guest over', async () => {
      const result = await hostInRoom();
      await act(async () => {
        await result.current.startRecording();
      });

      act(() => {
        recordingChannelFrom('p-guest')?.(channel('recording-audio'));
        recordingChannelFrom('p-guest')?.(channel('recording-screen-1'));
      });

      expect(lastPeers()).toEqual([]);
      await act(async () => {
        await result.current.endRecording();
      });
    });

    it('a second take starts with nobody handed over until that take’s channel arrives', async () => {
      const result = await hostInRoom();
      await act(async () => {
        await result.current.startRecording();
      });
      act(() => {
        recordingChannelFrom('p-guest')?.(channel('recording'));
      });
      expect(lastPeers().map((p) => p.peerId)).toEqual(['p-guest']);
      await act(async () => {
        await result.current.endRecording();
      });

      const callsBeforeNewTake = vi.mocked(syncCallCopies).mock.calls.length;
      act(() => {
        result.current.newTake();
      });
      expect(vi.mocked(syncCallCopies).mock.calls.length).toBe(callsBeforeNewTake);

      vi.mocked(startHostRecording).mockResolvedValueOnce({
        recordingId: 'rec-host-2',
        extraWriters: [],
      } as never);
      await act(async () => {
        await result.current.startRecording();
      });
      expect(lastPeers()).toEqual([]);

      act(() => {
        recordingChannelFrom('p-guest')?.(channel('recording'));
      });
      expect(vi.mocked(syncCallCopies).mock.calls.at(-1)![0]).toMatchObject({ recordingId: 'rec-host-2' });
      expect(lastPeers().map((p) => p.peerId)).toEqual(['p-guest']);
      await act(async () => {
        await result.current.endRecording();
      });
    });

    it('follows a rebuilt connection to its new peer id and drops the old one', async () => {
      const result = await hostInRoom();
      await act(async () => {
        await result.current.startRecording();
      });
      act(() => {
        recordingChannelFrom('p-guest')?.(channel('recording'));
      });
      expect(lastPeers().map((p) => p.peerId)).toEqual(['p-guest']);

      act(() => {
        emitSignal('peer-left', { type: 'peer-left', peerId: 'p-guest', role: 'guest' });
        emitSignal('peer-joined', {
          type: 'peer-joined',
          peerId: 'p-guest-2',
          displayName: 'Bob',
          ordinal: 6,
          role: 'guest',
        });
      });
      expect(lastPeers().map((p) => p.peerId)).toEqual([]);

      act(() => {
        recordingChannelFrom('p-guest-2')?.(channel('recording'));
      });
      expect(lastPeers().map((p) => p.peerId)).toEqual(['p-guest-2']);

      await act(async () => {
        await result.current.endRecording();
      });
    });

    it('a camera channel that arrives before the take’s files are open hands nobody over', async () => {
      const result = await hostInRoom();
      let open: (h: Awaited<ReturnType<typeof startHostRecording>>) => void = () => {};
      vi.mocked(startHostRecording).mockImplementationOnce(() => new Promise((r) => { open = r; }));
      let starting: Promise<void> = Promise.resolve();
      act(() => { starting = result.current.startRecording(); });
      // Record settles the storage question before it calls startHostRecording,
      // so the file-open promise is only in `open` after that settles.
      await act(async () => {});
      act(() => { recordingChannelFrom('p-guest')?.(channel('recording')); });
      await act(async () => {
        open({ recordingId: 'rec-host-1' } as never);
        await starting;
      });
      expect(result.current.state.phase).toBe('recording');
      expect(lastPeers()).toEqual([]);
      await act(async () => { await result.current.endRecording(); });
    });

    it('a second camera channel from the same guest changes nothing', async () => {
      const result = await hostInRoom();
      await act(async () => { await result.current.startRecording(); });
      act(() => { recordingChannelFrom('p-guest')?.(channel('recording')); });
      const calls = vi.mocked(syncCallCopies).mock.calls.length;
      act(() => { recordingChannelFrom('p-guest')?.(channel('recording')); });
      expect(vi.mocked(syncCallCopies).mock.calls.length).toBe(calls);
      await act(async () => { await result.current.endRecording(); });
    });

    it('forgets a guest that left, so its id is not handed over if it comes back', async () => {
      const result = await hostInRoom();
      await act(async () => {
        await result.current.startRecording();
      });
      act(() => {
        recordingChannelFrom('p-guest')?.(channel('recording'));
      });
      expect(lastPeers().map((p) => p.peerId)).toEqual(['p-guest']);

      act(() => {
        emitSignal('peer-left', { type: 'peer-left', peerId: 'p-guest', role: 'guest' });
      });
      act(() => {
        recordingChannelFrom('p-firefox')?.(channel('recording'));
      });
      expect(lastPeers().map((p) => p.peerId)).toEqual(['p-firefox']);

      // A room can hand the same id back without a fresh camera channel.
      act(() => {
        emitSignal('peer-joined', {
          type: 'peer-joined',
          peerId: 'p-guest',
          displayName: 'Bob',
          ordinal: 6,
          role: 'guest',
        });
      });
      expect(lastPeers().map((p) => p.peerId)).toEqual(['p-firefox']);

      await act(async () => {
        await result.current.endRecording();
      });
    });

    it('never hands a producer or a companion over', async () => {
      const result = await hostInRoom();
      await act(async () => {
        await result.current.startRecording();
      });
      act(() => {
        recordingChannelFrom('p-prod')?.(channel('recording'));
        recordingChannelFrom('p-comp')?.(channel('recording'));
      });
      expect(lastPeers()).toEqual([]);
      await act(async () => {
        await result.current.endRecording();
      });
    });
  });

  // A fallback nobody is told about is not found when it is needed, so the
  // summary and the sync file both name the host's copy of a guest's audio.
  it('lists the host’s call-audio copies in the summary and the sync file', async () => {
    const { result } = await hostTake(undefined, {
      hostStartMs: 1_000_000,
      hostWriter: { fileName: 'host_rec-host-1.mp4' },
      callCopies: [
        {
          peerId: 'p-bob',
          name: 'Bob',
          track: {},
          opened: Promise.resolve(),
          writer: { fileName: 'call1_rec-host-1.m4a', size: 10 },
          startMs: 1_000_500,
        },
      ],
      callCopiesCapped: true,
    });
    expect(result.current.state.phase).toBe('done');
    expect(vi.mocked(buildSyncReport).mock.calls.at(-1)![0]).toMatchObject({
      callCopies: [{ file: 'call1_rec-host-1.m4a', offsetMs: 500, name: 'Bob' }],
      callCopiesCapped: true,
    });
    expect(result.current.state.summary?.fileList).toContainEqual(
      expect.objectContaining({
        name: 'call1_rec-host-1.m4a',
        kind: 'call',
        detail: 'Bob, +500ms',
        participant: 'Bob',
      })
    );
  });
});

describe('track panel readings in useRoom', () => {
  beforeEach(() => {
    signalHandlers = {};
    signalSent = [];
    globalThis.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    globalThis.URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => vi.clearAllMocks());

  const bob = { peerId: 'p-guest', ordinal: 2, role: 'guest', displayName: 'Bob' };
  const hostStream = {
    getTracks: () => [],
    getAudioTracks: () => [{ kind: 'audio' }],
    getVideoTracks: () => [{ kind: 'video' }],
  } as unknown as MediaStream;
  const takeHandles = {
    hostStartMs: 1,
    dir: {},
    hostRecorder: { totalBytes: 2048 },
    receiver: { bytesWritten: 512, isAbandoned: false },
    channelRef: { current: {} },
    slotPeerIds: new Map([[0, 'p-guest']]),
  };

  /** Joins as host, with `peers` already in the room, and returns the hook. */
  async function joinHost(peers: unknown[] = [bob], hook = () => useRoom('xyz-test-room')) {
    const result = renderHook(hook).result;
    await act(async () => {
      await result.current.join(hostStream, 'Host Hana');
    });
    act(() => {
      emitSignal('role-assigned', {
        type: 'role-assigned',
        role: 'host',
        peerId: 'p-host',
        ordinal: 1,
        peers,
        recording: false,
      });
    });
    return result;
  }

  /** A joined host whose take started with these handles. */
  async function hostTakeWith(
    handles: Record<string, unknown>,
    peers: unknown[] = [bob],
    hook = () => useRoom('xyz-test-room')
  ) {
    vi.mocked(startHostRecording).mockImplementationOnce(
      async (args) => ({ recordingId: args.recordingId, ...handles }) as never
    );
    const result = await joinHost(peers, hook);
    await act(async () => {
      await result.current.startRecording();
    });
    return result;
  }

  it('reads nothing before a take starts', async () => {
    const result = await joinHost();
    expect(result.current.readTrackHealth()).toEqual([]);
  });

  it('reads this browser’s files first, then each guest’s, with the sizes on disk', async () => {
    const result = await hostTakeWith(takeHandles);
    expect(result.current.readTrackHealth()).toEqual([
      { key: 'own:camera', track: 'camera', bytes: 2048 },
      { key: 'g0:mp4', who: 'Bob', track: 'camera', bytes: 512 },
    ]);
  });

  it('expects a guest’s camera unless that guest’s browser said it cannot record', async () => {
    const result = await hostTakeWith(
      {
        hostStartMs: 1,
        dir: {},
        receiver: { bytesWritten: 0, isAbandoned: false },
        channelRef: { current: null },
      },
      [
        bob,
        { peerId: 'p-prod', ordinal: 3, role: 'producer', displayName: 'Pat' },
        { peerId: 'p-old', ordinal: 0, role: 'host', displayName: 'Old tab' },
        { peerId: 'p-deck', ordinal: 4, role: 'guest', displayName: 'Deck', companion: true },
      ]
    );
    expect(result.current.readTrackHealth()).toEqual([
      { key: 'p:p-guest', who: 'Bob', track: 'camera', bytes: 0 },
    ]);
    const says = (mp4: unknown, wav: boolean) =>
      act(() => {
        emitSignal('recording-capability', {
          type: 'recording-capability',
          from: 'guest',
          fromPeerId: 'p-guest',
          mp4,
          wav,
        });
      });
    // The Room relays `mp4` as sent: only a literal false means "cannot record",
    // and a browser with no WAV capture still sends its camera.
    for (const mp4 of [true, 0, null, 'no']) {
      says(mp4, false);
      expect(result.current.readTrackHealth()).toEqual([
        { key: 'p:p-guest', who: 'Bob', track: 'camera', bytes: 0 },
      ]);
    }
    says(false, true);
    expect(result.current.readTrackHealth()).toEqual([]);
  });

  it('reads without rendering, and hands back the same function across renders', async () => {
    let renders = 0;
    const result = await hostTakeWith(takeHandles, [bob], () => {
      renders += 1;
      return useRoom('xyz-test-room');
    });

    const before = renders;
    // act flushes any update a read scheduled; outside it the count could not move.
    act(() => {
      for (let i = 0; i < 3; i += 1) expect(result.current.readTrackHealth().length).toBe(2);
    });
    expect(renders).toBe(before);

    const read = result.current.readTrackHealth;
    act(() => {
      emitSignal('chat', { type: 'chat', from: 'guest', fromPeerId: 'p-guest', text: 'hi' });
      emitSignal('presence', {
        type: 'presence',
        from: 'guest',
        fromPeerId: 'p-guest',
        micOn: false,
        camOn: true,
        screenSharing: false,
      });
      emitSignal('recording-capability', {
        type: 'recording-capability',
        from: 'guest',
        fromPeerId: 'p-guest',
        mp4: true,
        wav: true,
      });
    });
    expect(result.current.readTrackHealth).toBe(read);
  });

  it('reads a guest’s own files with what the host has acknowledged', async () => {
    handlesWithBackup({ ackedBytes: 40, isAbandoned: false });
    const result = await recordingGuest();
    expect(result.current.state.phase).toBe('recording');
    expect(result.current.readTrackHealth()).toEqual([
      { key: 'own:camera', track: 'camera', bytes: 100, acked: 40 },
    ]);
  });

  it('lists a present-only device’s screen, which only the whole roster can name', async () => {
    const result = await hostTakeWith(
      {
        hostStartMs: 1,
        dir: {},
        screenReceivers: new Map([[1, { bytesWritten: 64, isAbandoned: false }]]),
        screenLive: new Map([[1, 'p-deck']]),
      },
      [{ peerId: 'p-deck', ordinal: 4, role: 'guest', displayName: 'Deck', companion: true }]
    );
    expect(result.current.readTrackHealth()).toEqual([
      { key: 's1', who: 'Deck', track: 'screen', bytes: 64 },
    ]);
  });

  it('names a guest’s screen share that arrives through the call', async () => {
    const dir = {
      getFileHandle: async (name: string) => ({
        name,
        createWritable: async () => ({ write: async () => {}, close: async () => {} }),
      }),
      removeEntry: async () => {},
    };
    const result = await hostTakeWith({ hostStartMs: 1, dir });
    const channel = Object.assign(new EventTarget(), { label: 'recording-screen-1', readyState: 'open' });
    act(() => {
      vi.mocked(PeerConnection).mock.calls.at(-1)![0].onDataChannel?.(channel as unknown as RTCDataChannel);
    });
    await vi.waitFor(() =>
      expect(result.current.readTrackHealth()).toContainEqual({
        key: 's1',
        who: 'Bob',
        track: 'screen',
        bytes: 0,
      })
    );
  });
});

// A Room that restarts mints every socket a new peer id, and a reconnecting tab
// still holds the connections it made before. `role-assigned` describes the room
// as it stands now, so an id it does not list is a connection to let go of.
describe('role-assigned describes the whole room', () => {
  type FakePeer = {
    close: ReturnType<typeof vi.fn>;
    setLocalStream: ReturnType<typeof vi.fn>;
    createRecordingChannel: ReturnType<typeof vi.fn>;
    connectionState: string | null;
    setPeerCount: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    signalHandlers = {};
    signalSent = [];
    vi.clearAllMocks();
  });

  const stream = () =>
    ({ getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] }) as unknown as MediaStream;

  const host = (peerId: string) => ({ peerId, ordinal: 1, role: 'host', displayName: 'Host' });

  const roleAssigned = (peers: unknown[]) => ({
    type: 'role-assigned',
    role: 'guest',
    peerId: 'p-guest',
    ordinal: 3,
    peers,
    recording: false,
  });

  /** The fake connections this tab opened for one peer id, oldest first. */
  function peersFor(peerId: string): FakePeer[] {
    return vi
      .mocked(PeerConnection)
      .mock.calls.map(([opts], i) => ({
        remotePeerId: (opts as { remotePeerId: string }).remotePeerId,
        peer: vi.mocked(PeerConnection).mock.results[i]!.value as unknown as FakePeer,
      }))
      .filter((p) => p.remotePeerId === peerId)
      .map((p) => p.peer);
  }

  /** A guest in a call with the peers role-assigned lists, not recording. */
  async function joinedGuest(peers: unknown[] = [host('p-host')]) {
    const { result } = renderHook(() => useRoom('xyz-test-room'));
    await act(async () => {
      await result.current.join(stream(), 'Guest Alice');
    });
    act(() => {
      emitSignal('role-assigned', roleAssigned(peers));
    });
    return result;
  }

  it('closes the connection to an id the room no longer lists and opens one for the new id', async () => {
    const result = await joinedGuest();
    const oldHost = peersFor('p-host')[0]!;
    expect(oldHost.setLocalStream).toHaveBeenCalledTimes(1);

    act(() => {
      emitSignal('role-assigned', roleAssigned([host('p-host-2')]));
    });

    expect(oldHost.close).toHaveBeenCalled();
    // Setting the stale connection up again adds a second sender for the same
    // track, which is the throw that left both pages on "Connection lost".
    expect(oldHost.setLocalStream).toHaveBeenCalledTimes(1);
    expect(peersFor('p-host-2')).toHaveLength(1);
    expect(result.current.state.remotePeers.map((p) => p.peerId)).toEqual(['p-host-2']);
  });

  it('rebuilds the connection when the same id is listed again', async () => {
    const result = await joinedGuest();
    const oldHost = peersFor('p-host')[0]!;
    expect(oldHost.setLocalStream).toHaveBeenCalledTimes(1);

    act(() => {
      emitSignal('role-assigned', roleAssigned([host('p-host')]));
    });

    // This message answers a join, so the far end closed its side of the old
    // connection when this tab's socket dropped: only a fresh one can offer,
    // and the old one is never handed its tracks a second time.
    expect(oldHost.close).toHaveBeenCalled();
    expect(peersFor('p-host')).toHaveLength(2);
    const newHost = peersFor('p-host')[1]!;
    expect(newHost.setLocalStream).toHaveBeenCalledTimes(1);
    expect(oldHost.setLocalStream).toHaveBeenCalledTimes(1);
    expect(result.current.state.remotePeers.map((p) => p.peerId)).toEqual(['p-host']);
  });

  it('rebuilds a held peer and opens the new one, each set up once', async () => {
    const result = await joinedGuest();
    const oldHost = peersFor('p-host')[0]!;
    const bo = { peerId: 'p-bo', ordinal: 2, role: 'guest', displayName: 'Bo' };

    act(() => {
      emitSignal('role-assigned', roleAssigned([host('p-host'), bo]));
    });

    expect(oldHost.close).toHaveBeenCalled();
    expect(peersFor('p-host')).toHaveLength(2);
    expect(peersFor('p-host')[1]!.setLocalStream).toHaveBeenCalledTimes(1);
    expect(peersFor('p-bo')).toHaveLength(1);
    expect(peersFor('p-bo')[0]!.setLocalStream).toHaveBeenCalledTimes(1);
    expect(result.current.state.remotePeers.map((p) => p.peerId)).toEqual(['p-host', 'p-bo']);
  });

  it('rebuilds the connection held for a peer that stayed when it has failed', async () => {
    const result = await joinedGuest();
    const hostPeer = peersFor('p-host')[0]!;
    hostPeer.connectionState = 'failed';

    act(() => {
      emitSignal('role-assigned', roleAssigned([host('p-host')]));
    });

    // The peer's socket never dropped, so its id stays; the ICE-failure
    // reconnect is the only way back for this pair and still has to replace it.
    expect(hostPeer.close).toHaveBeenCalled();
    expect(peersFor('p-host')).toHaveLength(2);
    expect(result.current.state.remotePeers.map((p) => p.peerId)).toEqual(['p-host']);
  });

  it('closes every connection and waits again when the list comes back empty', async () => {
    const result = await joinedGuest([
      host('p-host'),
      { peerId: 'p-bo', ordinal: 2, role: 'guest', displayName: 'Bo' },
    ]);
    const hostPeer = peersFor('p-host')[0]!;
    const bo = peersFor('p-bo')[0]!;

    act(() => {
      emitSignal('role-assigned', roleAssigned([]));
    });

    expect(hostPeer.close).toHaveBeenCalled();
    expect(bo.close).toHaveBeenCalled();
    expect(result.current.state.remotePeers).toEqual([]);
    expect(result.current.state.phase).toBe('waiting');
  });

  it('resyncs send quality and removes dropped peer from the connection map when a peer leaves', async () => {
    const result = await joinedGuest([
      host('p-host'),
      { peerId: 'p-bo', ordinal: 2, role: 'guest', displayName: 'Bo' },
    ]);
    const hostPeer = peersFor('p-host')[0]!;
    const bo = peersFor('p-bo')[0]!;

    expect(hostPeer.setPeerCount).toHaveBeenLastCalledWith(3);
    expect(bo.setPeerCount).toHaveBeenLastCalledWith(3);

    act(() => {
      emitSignal('role-assigned', roleAssigned([host('p-host')]));
    });

    expect(bo.close).toHaveBeenCalled();
    expect(hostPeer.setPeerCount).toHaveBeenLastCalledWith(2);
    expect(bo.setPeerCount).toHaveBeenCalledTimes(1);
    expect(result.current.state.remotePeers.map((p) => p.peerId)).toEqual(['p-host']);
  });

  it('treats a peer list that is not a list as nobody, without throwing', async () => {
    const result = await joinedGuest();
    const hostPeer = peersFor('p-host')[0]!;

    act(() => {
      emitSignal('role-assigned', { ...roleAssigned([]), peers: null });
    });

    expect(hostPeer.close).toHaveBeenCalled();
    expect(result.current.state.remotePeers).toEqual([]);
    expect(result.current.state.phase).toBe('waiting');
  });

  it('drops an entry of the peer list that is not a peer id', async () => {
    const result = await joinedGuest();
    const before = vi.mocked(PeerConnection).mock.calls.length;

    act(() => {
      emitSignal('role-assigned', roleAssigned([{ peerId: 5, ordinal: 2, role: 'guest' }, host('p-host')]));
    });

    // The Room's list is not trusted: an entry without an id is nobody, and
    // connecting to it would put a nameless tile in the room.
    expect(vi.mocked(PeerConnection).mock.calls.length).toBe(before + 1);
    expect(result.current.state.remotePeers.map((p) => p.peerId)).toEqual(['p-host']);
  });

  it('rebinds a recording guest onto the connection it opens for the host’s new id', async () => {
    await joinedGuest();
    await act(async () => {
      emitSignal('recording-started', {
        type: 'recording-started',
        from: 'host',
        recordingId: 'rec-x',
        kind: 'camera',
        filename: 'guest_rec-x.mp4',
      });
    });
    const sender = vi.mocked(startGuestRecording).mock.results.at(-1)!.value.sender;

    await act(async () => {
      emitSignal('role-assigned', roleAssigned([host('p-host-2')]));
    });

    const newHost = peersFor('p-host-2')[0]!;
    expect(sender.rebind).toHaveBeenCalledTimes(1);
    expect(sender.rebind).toHaveBeenCalledWith(newHost.createRecordingChannel.mock.results[0]!.value);
  });

  it('rebinds a recording guest onto the rebuilt connection for the same host id', async () => {
    await joinedGuest();
    await act(async () => {
      emitSignal('recording-started', {
        type: 'recording-started',
        from: 'host',
        recordingId: 'rec-x',
        kind: 'camera',
        filename: 'guest_rec-x.mp4',
      });
    });
    const sender = vi.mocked(startGuestRecording).mock.results.at(-1)!.value.sender;

    await act(async () => {
      emitSignal('role-assigned', roleAssigned([host('p-host')]));
    });

    const rebuiltHost = peersFor('p-host')[1]!;
    expect(sender.rebind).toHaveBeenCalledTimes(1);
    expect(sender.rebind).toHaveBeenCalledWith(rebuiltHost.createRecordingChannel.mock.results[0]!.value);
  });
});

/**
 * Only the host opens guest files, and only for the peers it records. A
 * producer or a present-only companion publishes no camera or mic, so it has
 * no file to bind and must not spend a guest slot a recorded guest needs.
 */
describe('guest slots belong to the peers a host records', () => {
  beforeEach(() => {
    signalHandlers = {};
    signalSent = [];
    globalThis.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => vi.clearAllMocks());

  const guest = { peerId: 'p-guest', ordinal: 2, role: 'guest', displayName: 'Bob' };
  const producer = { peerId: 'p-prod', ordinal: 3, role: 'producer', displayName: 'Pat' };
  const companion = { peerId: 'p-comp', ordinal: 4, role: 'guest', displayName: 'Cam', companion: true };

  const channel = (label: string) =>
    Object.assign(new EventTarget(), { label, readyState: 'open', send: () => {} }) as unknown as RTCDataChannel;
  /** The real onDataChannel of the connection to one peer, whichever call created it. */
  const channelTo = (peerId: string) =>
    vi.mocked(PeerConnection).mock.calls.map(([o]) => o).reverse().find((o) => o.remotePeerId === peerId)!
      .onDataChannel!;

  /** Let every bind the channels started finish, including the file opens. */
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  /** A host in a take whose real handles write into a folder this test can read. */
  async function hostTake(opened: string[]) {
    const handles: RecordingHandles = {
      recordingId: 'rec-gate',
      take: 1,
      dir: {
        getFileHandle: async (name: string) => {
          opened.push(name);
          return { name, createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
        },
      } as unknown as NonNullable<RecordingHandles['dir']>,
      guestSlots: new Map<string, number>(),
      receiver: { bytesWritten: 0, isAbandoned: false, answerResume: () => {} } as never,
      channelRef: { current: null },
    };
    vi.mocked(startHostRecording).mockImplementationOnce(async () => handles as never);
    const { result } = renderHook(() => useRoom('xyz-test-room'));
    await act(async () => {
      await result.current.join(
        { getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream,
        'Host Hana'
      );
    });
    act(() => {
      emitSignal('role-assigned', {
        type: 'role-assigned',
        role: 'host',
        peerId: 'p-host',
        ordinal: 1,
        peers: [guest, producer, companion],
        recording: false,
      });
    });
    await act(async () => {
      await result.current.startRecording();
    });
    return { result, handles };
  }

  it('opens no file for a producer that sends camera and audio channels', async () => {
    const opened: string[] = [];
    const { result, handles } = await hostTake(opened);

    act(() => {
      channelTo('p-prod')(channel('recording#a'));
      channelTo('p-prod')(channel('recording-audio#a'));
    });
    await settle();

    expect(opened).toEqual([]);
    expect(handles.guestSlots?.size).toBe(0);
    expect(result.current.state.recordingError).toBeNull();
  });

  it('opens no file for a present-only companion that sends camera and audio channels', async () => {
    const opened: string[] = [];
    const { result, handles } = await hostTake(opened);

    act(() => {
      channelTo('p-comp')(channel('recording#a'));
      channelTo('p-comp')(channel('recording-audio#a'));
    });
    await settle();

    expect(opened).toEqual([]);
    expect(handles.guestSlots?.size).toBe(0);
    expect(result.current.state.recordingError).toBeNull();
  });

  it('leaves a recording guest alone when a peer opens keys at it', async () => {
    const result = await recordingGuest();
    expect(result.current.state.phase).toBe('recording');

    act(() => {
      channelTo('p-host')(channel('recording#a'));
      channelTo('p-host')(channel('recording#b'));
      channelTo('p-host')(channel('recording#c'));
    });
    await settle();

    expect(result.current.state.recordingError).toBeNull();
  });

  it('binds the camera and audio channels of a recorded guest', async () => {
    const opened: string[] = [];
    const { result, handles } = await hostTake(opened);
    const camera = channel('recording#g');

    act(() => {
      channelTo('p-guest')(camera);
      channelTo('p-guest')(channel('recording-audio#g'));
    });
    await settle();

    expect(opened).toEqual(['guest_rec-gate.wav']);
    expect(handles.guestSlots?.get('g')).toBe(0);
    expect(handles.channel).toBe(camera);
    expect(result.current.state.recordingError).toBeNull();
  });
});

describe('resuming a crashed take from inside the call', () => {
  beforeEach(() => {
    signalHandlers = {};
    signalSent = [];
    globalThis.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    globalThis.URL.revokeObjectURL = vi.fn();
    vi.mocked(findTakeJournals).mockResolvedValue([]);
    vi.mocked(isTakeLockHeld).mockResolvedValue(false);
    vi.mocked(resumeHostRecording).mockReset();
    vi.mocked(saveRecoveredTake).mockReset();
    vi.mocked(pickRecordingDirectory).mockReset();
  });

  afterEach(() => vi.clearAllMocks());

  const guest = { peerId: 'p-guest', ordinal: 2, role: 'guest', displayName: 'Bob' };

  /** This browser's crash copy of the room's take, as findTakeJournals hands it back. */
  function takeJournal(
    over: {
      notesOk?: boolean;
      dead?: boolean;
      room?: string;
      take?: number;
      recordingId?: string;
      files?: TakeJournal['notes']['files'];
    } = {}
  ): TakeJournal {
    return {
      dirName: 'openmeet-take-1',
      notes: {
        room: over.room ?? 'xyz-test-room',
        recordingId: over.recordingId ?? 'rec-1',
        take: over.take ?? 1,
        hostStartMs: 1_000_000,
        files: over.files ?? [{ file: 'guest_rec.mp4', kind: 'camera', key: 'R1', slot: 0 }],
        backups: [],
        markers: [],
      },
      notesOk: over.notesOk ?? true,
      dead: over.dead ?? false,
      bytes: 0,
    } as unknown as TakeJournal;
  }

  const hostCameraTrack = { kind: 'video' };
  const stream = () =>
    ({
      getTracks: () => [hostCameraTrack],
      getAudioTracks: () => [{ kind: 'audio' }],
      getVideoTracks: () => [hostCameraTrack],
    }) as unknown as MediaStream;

  /** A host back in the room after a reload: joined, told its role, nothing recording. */
  async function hostAfterReload() {
    const { result, unmount } = renderHook(() => useRoom('xyz-test-room'));
    const joinedStream = stream();
    await act(async () => {
      await result.current.join(joinedStream, 'Host Hana');
    });
    return { result, unmount, joinedStream };
  }

  /** The room's role-assigned, with the offer's storage lookups flushed. */
  async function assignHost(over: Record<string, unknown> = {}) {
    await act(async () => {
      emitSignal('role-assigned', {
        type: 'role-assigned',
        role: 'host',
        peerId: 'p-host',
        ordinal: 1,
        peers: [guest],
        recording: false,
        ...over,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  /** The real onDataChannel of the connection to the room's guest. */
  function guestChannel(label: string) {
    const channel = Object.assign(new EventTarget(), {
      label,
      readyState: 'open',
      send: vi.fn(),
      close: vi.fn(),
    }) as unknown as RTCDataChannel;
    act(() => {
      vi.mocked(PeerConnection)
        .mock.calls.map(([o]) => o)
        .reverse()
        .find((o) => o.remotePeerId === 'p-guest')!
        .onDataChannel!(channel);
    });
    return channel;
  }

  const saved = (source: 'journal' | 'failed') => ({
    name: 'guest_rec.mp4',
    bytes: source === 'failed' ? 0 : 10,
    source,
  });

  it('offers a resume after a reload only when this tab is idle and no other tab holds the take', async () => {
    const { result } = await hostAfterReload();
    vi.mocked(findTakeJournals).mockResolvedValue([takeJournal()]);

    vi.mocked(isTakeLockHeld).mockResolvedValueOnce(true);
    await assignHost();
    expect(result.current.state.resumeOffer).toBeNull();

    await assignHost();
    expect(result.current.state.resumeOffer).toEqual({ take: 1, canResume: false });

    guestChannel('recording#R1');
    await vi.waitFor(() =>
      expect(result.current.state.resumeOffer).toEqual({ take: 1, canResume: true })
    );

    await act(async () => {
      await result.current.startRecording();
    });
    expect(result.current.state.phase).toBe('recording');
    expect(result.current.state.resumeOffer).toBeNull();

    await assignHost();
    expect(result.current.state.resumeOffer).toBeNull();

    await act(async () => {
      await result.current.endRecording();
    });
  });

  it('is not offered to a guest, nor for another room, an unreadable or a dead journal', async () => {
    const { result } = await hostAfterReload();
    vi.mocked(findTakeJournals).mockResolvedValue([
      takeJournal({ room: 'other-room' }),
      takeJournal({ notesOk: false }),
      takeJournal({ dead: true }),
    ]);

    await assignHost();
    expect(result.current.state.resumeOffer).toBeNull();

    vi.mocked(findTakeJournals).mockResolvedValue([takeJournal()]);
    await assignHost({
      role: 'guest',
      peerId: 'p-guest',
      peers: [{ peerId: 'p-host', ordinal: 1, role: 'host', displayName: 'Host' }],
    });
    expect(result.current.state.resumeOffer).toBeNull();
  });

  it('keeps a screen channel without offering it, and leaves the state alone while the offer stands', async () => {
    const { result } = await hostAfterReload();
    vi.mocked(findTakeJournals).mockResolvedValue([takeJournal()]);
    await assignHost();
    expect(result.current.state.resumeOffer).toEqual({ take: 1, canResume: false });

    // A screen channel carries the key of the guest's file, but a screen
    // segment is never resumed, so the offer must not change — and an offer
    // that does not change must not cost a render.
    const before = result.current.state;
    guestChannel('recording-screen-1#R1');
    expect(result.current.state.resumeOffer).toEqual({ take: 1, canResume: false });
    expect(result.current.state).toBe(before);

    guestChannel('recording#R1');
    await vi.waitFor(() =>
      expect(result.current.state.resumeOffer).toEqual({ take: 1, canResume: true })
    );
  });

  it('replaces a rebinding channel instead of stacking it', async () => {
    const { result } = await hostAfterReload();
    vi.mocked(findTakeJournals).mockResolvedValue([
      takeJournal({ files: [{ file: 'guest_rec.mp4', kind: 'camera', key: 'R2', slot: 0 }] }),
    ]);
    await assignHost();
    vi.mocked(resumeHostRecording).mockResolvedValue({
      recordingId: 'rec-1',
      take: 1,
      hostStartMs: 1_000,
    });

    guestChannel('recording#R1');
    const other = guestChannel('recording#R2');
    const rebound = guestChannel('recording#R1');

    await act(async () => {
      await result.current.resumeRecording();
    });

    const channels = vi.mocked(resumeHostRecording).mock.calls[0]![0].channels;
    expect(channels).toHaveLength(2);
    expect(channels[0]!.channel).toBe(other);
    expect(channels[1]!.channel).toBe(rebound);

    await act(async () => {
      await result.current.endRecording();
    });
  });

  it('normalises screen sequence numbers so repeated shares do not stack', async () => {
    const { result } = await hostAfterReload();
    vi.mocked(findTakeJournals).mockResolvedValue([takeJournal()]);
    await assignHost();

    guestChannel('recording-screen-1#R1');
    const screen2 = guestChannel('recording-screen-2#R1');

    await act(async () => {
      await result.current.resumeRecording();
    });

    const channels = vi.mocked(resumeHostRecording).mock.calls[0]![0].channels;
    expect(channels).toHaveLength(1);
    expect(channels[0]!.channel).toBe(screen2);

    await act(async () => {
      await result.current.endRecording();
    });
  });

  it('binds only the most recent twelve pending channels', async () => {
    const { result } = await hostAfterReload();
    vi.mocked(findTakeJournals).mockResolvedValue([takeJournal()]);
    await assignHost();
    vi.mocked(resumeHostRecording).mockResolvedValue({
      recordingId: 'rec-1',
      take: 1,
      hostStartMs: 1_000,
    });

    const sent = Array.from({ length: 14 }, (_, i) => guestChannel(`recording#R${i + 1}`));

    await act(async () => {
      await result.current.resumeRecording();
    });

    const channels = vi.mocked(resumeHostRecording).mock.calls[0]![0].channels;
    expect(channels).toHaveLength(12);
    expect(channels[0]!.channel).toBe(sent[2]);
    expect(channels[11]!.channel).toBe(sent[13]);

    await act(async () => {
      await result.current.endRecording();
    });
  });

  it('resumes the same take and re-announces its id', async () => {
    const { result, joinedStream } = await hostAfterReload();
    const journal = takeJournal();
    vi.mocked(findTakeJournals).mockResolvedValue([journal]);
    await assignHost();
    guestChannel('recording#R1');
    await vi.waitFor(() =>
      expect(result.current.state.resumeOffer).toEqual({ take: 1, canResume: true })
    );

    vi.mocked(resumeHostRecording).mockResolvedValue({
      recordingId: 'rec-1',
      take: 1,
      hostStartMs: 1_000,
    });
    signalSent = [];

    await act(async () => {
      await result.current.resumeRecording();
    });

    const args = vi.mocked(resumeHostRecording).mock.calls[0]![0];
    expect(args.journal).toBe(journal);
    expect(args.channels.map((c) => c.channel.label)).toEqual(['recording#R1']);
    // The host's own post-crash part is recorded from the tracks this tab
    // joined with: the MP4 stream (no board, so its own tracks unmixed) and the
    // raw mic.
    expect(args.localStream.getVideoTracks()).toEqual([joinedStream.getVideoTracks()[0]]);
    expect(args.micStream?.getTracks()).toEqual(joinedStream.getTracks());
    expect(signalSent).toContainEqual({
      type: 'recording-started',
      recordingId: 'rec-1',
      kind: 'camera',
      filename: 'host_rec-1_resumed.mp4',
    });
    expect(result.current.state.phase).toBe('recording');
    expect(result.current.state.peerRecording).toBe(true);
    expect(result.current.state.resumeOffer).toBeNull();

    // A marker taken now still sits on the original take's timeline: the
    // resumed take anchors it to the crash's hostStartMs (1_000 here), not to
    // the moment this tab rejoined.
    const markerFloor = Date.now() - 1_000;
    act(() => {
      result.current.addMarker('after resume');
    });
    const atMs = result.current.state.markers.at(-1)!.atMs;
    expect(atMs).toBeGreaterThanOrEqual(markerFloor);
    expect(atMs).toBeLessThan(markerFloor + 5_000);

    await act(async () => {
      await result.current.endRecording();
    });
  });

  it('saves what was recorded into the chosen folder and reports it', async () => {
    const { result } = await hostAfterReload();
    const journal = takeJournal();
    vi.mocked(findTakeJournals).mockResolvedValue([journal]);
    await assignHost();
    const folder = fakeDirectory().dir;
    vi.mocked(pickRecordingDirectory).mockResolvedValue(folder as never);
    vi.mocked(saveRecoveredTake).mockResolvedValue({
      files: [saved('journal'), saved('failed')],
      json: 'sync_rec-1.json',
      chapters: false,
    });

    await act(async () => {
      await result.current.saveRecordingFromCall();
    });

    expect(vi.mocked(pickRecordingDirectory)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveRecoveredTake).mock.calls[0]![0]).toBe(journal);
    expect(vi.mocked(saveRecoveredTake).mock.calls[0]![1]).toBe(folder);
    expect(result.current.state.resumeOffer).toBeNull();
    expect(result.current.state.takeNotice).toBe('Saved 1 file to your folder.');
  });

  it('starts no second save while the folder prompt is open', async () => {
    const { result } = await hostAfterReload();
    vi.mocked(findTakeJournals).mockResolvedValue([takeJournal()]);
    await assignHost();

    let openPrompt: (dir: unknown) => void = () => {};
    vi.mocked(pickRecordingDirectory).mockReturnValue(
      new Promise((resolve) => {
        openPrompt = resolve;
      }) as never
    );
    vi.mocked(saveRecoveredTake).mockResolvedValue({
      files: [saved('journal')],
      json: 'sync_rec-1.json',
      chapters: false,
    });

    let first = Promise.resolve();
    let second = Promise.resolve();
    await act(async () => {
      first = result.current.saveRecordingFromCall();
      second = result.current.saveRecordingFromCall();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(vi.mocked(pickRecordingDirectory)).toHaveBeenCalledTimes(1);

    await act(async () => {
      openPrompt(fakeDirectory().dir);
      await first;
      await second;
    });
    expect(vi.mocked(saveRecoveredTake)).toHaveBeenCalledTimes(1);
    expect(result.current.state.takeNotice).toBe('Saved 1 file to your folder.');
  });

  it('keeps the offer when the sync file could not be written', async () => {
    const { result } = await hostAfterReload();
    vi.mocked(findTakeJournals).mockResolvedValue([takeJournal()]);
    await assignHost();
    vi.mocked(pickRecordingDirectory).mockResolvedValue(fakeDirectory().dir as never);
    vi.mocked(saveRecoveredTake).mockResolvedValue({
      files: [saved('journal')],
      json: null,
      chapters: false,
    });

    await act(async () => {
      await result.current.saveRecordingFromCall();
    });

    expect(result.current.state.resumeOffer).toEqual({ take: 1, canResume: false });
    expect(result.current.state.takeNotice).toMatch(/The sync file could not be written\.$/);
  });

  it('changes nothing when the folder prompt is cancelled', async () => {
    const { result } = await hostAfterReload();
    vi.mocked(findTakeJournals).mockResolvedValue([takeJournal()]);
    await assignHost();
    vi.mocked(pickRecordingDirectory).mockRejectedValue(
      Object.assign(new Error('cancelled'), { name: 'AbortError' })
    );

    await act(async () => {
      await result.current.saveRecordingFromCall();
    });

    expect(vi.mocked(saveRecoveredTake)).not.toHaveBeenCalled();
    expect(result.current.state.resumeOffer).toEqual({ take: 1, canResume: false });
    expect(result.current.state.recordingError).toBeNull();

    vi.mocked(resumeHostRecording).mockRejectedValueOnce(
      Object.assign(new Error('cancelled'), { name: 'AbortError' })
    );
    await act(async () => {
      await result.current.resumeRecording();
    });
    expect(result.current.state.recordingError).toBeNull();
    expect(result.current.state.resumeOffer).toEqual({ take: 1, canResume: false });
  });

  it('clears the offer and the saved notice when a new take starts', async () => {
    const { result } = await hostAfterReload();
    vi.mocked(findTakeJournals).mockResolvedValue([takeJournal()]);
    await assignHost();
    vi.mocked(pickRecordingDirectory).mockResolvedValue(fakeDirectory().dir as never);
    vi.mocked(saveRecoveredTake).mockResolvedValue({
      files: [saved('journal')],
      json: 'sync_rec-1.json',
      chapters: false,
    });
    await act(async () => {
      await result.current.saveRecordingFromCall();
    });
    expect(result.current.state.takeNotice).toBe('Saved 1 file to your folder.');

    await assignHost();
    expect(result.current.state.resumeOffer).toEqual({ take: 1, canResume: false });
    await act(async () => {
      await result.current.startRecording();
    });
    expect(result.current.state.resumeOffer).toBeNull();
    expect(result.current.state.takeNotice).toBeNull();

    await act(async () => {
      await result.current.endRecording();
    });
    await assignHost();
    expect(result.current.state.resumeOffer).toEqual({ take: 1, canResume: false });
    await act(async () => {
      await result.current.saveRecordingFromCall();
    });
    expect(result.current.state.takeNotice).toBe('Saved 1 file to your folder.');

    act(() => {
      result.current.newTake();
    });
    expect(result.current.state.resumeOffer).toBeNull();
    expect(result.current.state.takeNotice).toBeNull();
  });
});
