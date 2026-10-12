import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';

// As in tests/guest-fatal-close-save.test.tsx: the room, the connections and
// the recorders are replaced. deferGuestStreams runs for real, on senders that
// only count.
let signalHandlers: Record<string, ((m: any) => void)[]> = {};
/** Where the take's camera backup says it is kept: null is a browser that could not keep it on disk. */
let backupDir: string | null = null;
let wavBackupDir: string | null = null;
/** Settles when the backup's storage has answered. */
let storageOpen: Promise<void> = Promise.resolve();
let wavStorageOpen: Promise<void> = Promise.resolve();
/** Every stream sender a take was given, oldest first: two a take. */
let senders: { defer: ReturnType<typeof vi.fn> }[] = [];

vi.mock('@/lib/api', () => ({
  getTurnCred: vi.fn().mockResolvedValue({ iceServers: [] }),
  getRoom: vi.fn().mockResolvedValue({ slug: 'abc-defg-hij', expires_at: Date.now() + 10000 }),
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
    send: vi.fn(() => true),
    on: vi.fn((type: string, handler: (m: any) => void) => {
      (signalHandlers[type] ??= []).push(handler);
    }),
  })),
}));

vi.mock('@/lib/media', () => ({
  MediaManager: vi.fn().mockImplementation(() => ({
    adopt: vi.fn(),
    start: vi.fn().mockResolvedValue(
      Object.assign(new EventTarget(), { getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] })
    ),
    stop: vi.fn(),
    setAudioEnabled: vi.fn(),
    setVideoEnabled: vi.fn(),
    stream: Object.assign(new EventTarget(), {
      getTracks: () => [],
      getAudioTracks: () => [],
      getVideoTracks: () => [],
    }),
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
    createRecordingAudioChannel: vi.fn().mockReturnValue(undefined),
    createBackupChannel: vi.fn().mockReturnValue({
      readyState: 'connecting',
      addEventListener: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
    }),
  })),
}));

vi.mock('@/lib/recorder', async () => {
  const actual = await vi.importActual<typeof import('@/lib/recorder')>('@/lib/recorder');
  return { ...actual, pickRecordingMime: vi.fn().mockReturnValue('video/mp4') };
});

vi.mock('@/lib/backup-recorder', async () => {
  const actual = await vi.importActual<typeof import('@/lib/backup-recorder')>('@/lib/backup-recorder');
  return {
    ...actual,
    BackupRecorder: vi.fn().mockImplementation((opts: { mimeType?: string }) => {
      const wav = opts?.mimeType === 'audio/wav';
      return {
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue(null),
        markFinalized: vi.fn().mockResolvedValue(undefined),
        whenOpen: vi.fn(() => (wav ? wavStorageOpen : storageOpen)),
        get dirName() {
          return wav ? wavBackupDir : backupDir;
        },
      };
    }),
  };
});

vi.mock('@/hooks/recording-controller', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/recording-controller')>(
    '@/hooks/recording-controller'
  );
  const sender = () => {
    const s = {
      lastAckedIdx: 0,
      isAbandoned: false,
      drain: vi.fn().mockResolvedValue(false),
      rebind: vi.fn(),
      hold: vi.fn(),
      giveUp: vi.fn(),
      defer: vi.fn(),
    };
    senders.push(s);
    return s;
  };
  return {
    ...actual,
    // The take's handles carry the backup the hook made, as the real one does.
    startGuestRecording: vi.fn().mockImplementation((args: { backup: unknown; wavBackup?: unknown }) => ({
      recordingId: 'rec-guest-1',
      backup: args.backup,
      wavBackup: args.wavBackup ?? args.backup,
      guestRecorder: { totalBytes: 0, stopAndFlush: vi.fn() },
      sender: sender(),
      wavSender: sender(),
    })),
    endGuestRecording: vi.fn().mockResolvedValue({ drained: false, backup: null }),
  };
});

const ROOM = 'abc-defg-hij';
const ON_DISK = 'openmeet-backup-1700000000000-abc-defg-hij';
const REFUSED = 'This browser can’t keep your recording on disk, so it is sent to the host while it records.';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function emitSignal(type: string, payload: any) {
  for (const handler of signalHandlers[type] ?? []) handler(payload);
}

/** A tab that joined and was told its role, with the host in the room when it is a guest. */
async function joined(role: 'host' | 'guest') {
  const { result } = renderHook(() => useRoom(ROOM));
  const audio = { id: 'a1', kind: 'audio', enabled: true } as unknown as MediaStreamTrack;
  const video = { id: 'v1', kind: 'video', enabled: true } as unknown as MediaStreamTrack;
  const stream = Object.assign(new EventTarget(), {
    getTracks: () => [audio, video],
    getAudioTracks: () => [audio],
    getVideoTracks: () => [video],
  }) as unknown as MediaStream;
  await act(async () => {
    await result.current.join(stream, role === 'host' ? 'Host Hana' : 'Guest Gita');
  });
  await act(async () => {
    emitSignal('role-assigned', {
      type: 'role-assigned',
      role,
      peerId: role === 'host' ? 'p-host' : 'p-guest',
      ordinal: role === 'host' ? 1 : 2,
      peers: role === 'host' ? [] : [{ peerId: 'p-host', ordinal: 1, role: 'host', displayName: 'Hana' }],
      recording: false,
    });
    await flush();
  });
  return result;
}

async function hostStarts(recordingId: string) {
  await act(async () => {
    emitSignal('recording-started', {
      type: 'recording-started',
      from: 'host',
      recordingId,
      kind: 'camera',
      filename: `host_${recordingId}.mp4`,
    });
    await flush();
    await flush();
  });
}

async function hostStops(recordingId: string) {
  await act(async () => {
    emitSignal('recording-stop', { type: 'recording-stop', from: 'host', recordingId });
    await flush();
    await flush();
  });
}

describe('a guest sending its recording later', () => {
  beforeEach(() => {
    signalHandlers = {};
    senders = [];
    backupDir = ON_DISK;
    wavBackupDir = ON_DISK;
    storageOpen = Promise.resolve();
    wavStorageOpen = Promise.resolve();
    globalThis.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('is off until it is chosen, and a take is then streamed', async () => {
    const result = await joined('guest');
    expect(result.current.state.sendLater).toBe(false);
    await hostStarts('rec-host-1');

    expect(result.current.state.phase).toBe('recording');
    expect(senders).toHaveLength(2);
    for (const s of senders) expect(s.defer).not.toHaveBeenCalled();
  });

  it('defers a take that starts while it is on', async () => {
    const result = await joined('guest');
    act(() => result.current.setSendLater(true));
    expect(result.current.state.sendLater).toBe(true);
    await hostStarts('rec-host-1');

    expect(result.current.state.phase).toBe('recording');
    expect(senders).toHaveLength(2);
    for (const s of senders) expect(s.defer).toHaveBeenCalledTimes(1);
    expect(result.current.state.sendLater).toBe(true);
    expect(result.current.state.recordingError).not.toBe(REFUSED);
  });

  it('turned on during a take, stops that take’s streams at once', async () => {
    const result = await joined('guest');
    await hostStarts('rec-host-1');
    for (const s of senders) expect(s.defer).not.toHaveBeenCalled();

    act(() => result.current.setSendLater(true));
    for (const s of senders) expect(s.defer).toHaveBeenCalledTimes(1);
    expect(result.current.state.sendLater).toBe(true);
  });

  it('cannot be turned off while the take it deferred records, and can afterwards', async () => {
    const result = await joined('guest');
    act(() => result.current.setSendLater(true));
    await hostStarts('rec-host-1');

    act(() => result.current.setSendLater(false));
    expect(result.current.state.sendLater).toBe(true);

    await hostStops('rec-host-1');
    expect(result.current.state.phase).toBe('done');
    act(() => result.current.setSendLater(false));
    expect(result.current.state.sendLater).toBe(false);
  });

  it('streams the next take again once it is off', async () => {
    const result = await joined('guest');
    act(() => result.current.setSendLater(true));
    await hostStarts('rec-host-1');
    await hostStops('rec-host-1');
    act(() => result.current.setSendLater(false));

    await hostStarts('rec-host-2');
    expect(result.current.state.phase).toBe('recording');
    expect(senders).toHaveLength(4);
    for (const s of senders.slice(2)) expect(s.defer).not.toHaveBeenCalled();
  });

  it('is refused during a take whose backup is not kept on disk, and says why', async () => {
    backupDir = null;
    const result = await joined('guest');
    await hostStarts('rec-host-1');

    act(() => result.current.setSendLater(true));
    expect(result.current.state.sendLater).toBe(false);
    for (const s of senders) expect(s.defer).not.toHaveBeenCalled();
    expect(result.current.state.recordingError).toBe(REFUSED);
  });

  it('chosen before a take whose backup is not kept on disk: the take is streamed and the choice taken back', async () => {
    backupDir = null;
    const result = await joined('guest');
    act(() => result.current.setSendLater(true));
    await hostStarts('rec-host-1');

    expect(result.current.state.phase).toBe('recording');
    expect(result.current.state.sendLater).toBe(false);
    for (const s of senders) expect(s.defer).not.toHaveBeenCalled();
    expect(result.current.state.recordingError).toBe(REFUSED);

    // Taken back for good: the take that follows is streamed without asking again.
    await hostStops('rec-host-1');
    await hostStarts('rec-host-2');
    expect(result.current.state.recordingError).not.toBe(REFUSED);
  });

  it('is not given to a host', async () => {
    const result = await joined('host');
    act(() => result.current.setSendLater(true));
    expect(result.current.state.sendLater).toBe(false);
  });

  it('is not given to a present-only device', async () => {
    const { result } = renderHook(() => useRoom(ROOM));
    const none = Object.assign(new EventTarget(), {
      getTracks: () => [],
      getAudioTracks: () => [],
      getVideoTracks: () => [],
    }) as unknown as MediaStream;
    await act(async () => {
      await result.current.join(none, 'Gita, screen', false, true);
    });
    await act(async () => {
      emitSignal('role-assigned', {
        type: 'role-assigned',
        role: 'guest',
        peerId: 'p-screen',
        ordinal: 2,
        peers: [],
        recording: false,
      });
      await flush();
    });
    act(() => result.current.setSendLater(true));
    expect(result.current.state.sendLater).toBe(false);
  });

  it('waits for the backup’s storage to answer before it decides', async () => {
    let answer!: () => void;
    storageOpen = new Promise<void>((r) => {
      answer = r;
    });
    // Not known yet: a decision taken here would refuse a take that can be deferred.
    backupDir = null;
    const result = await joined('guest');
    act(() => result.current.setSendLater(true));
    await hostStarts('rec-host-1');
    expect(result.current.state.recordingError).not.toBe(REFUSED);
    expect(result.current.state.sendLater).toBe(true);

    backupDir = ON_DISK;
    await act(async () => {
      answer();
      await flush();
      await flush();
    });
    expect(result.current.state.phase).toBe('recording');
    expect(senders).toHaveLength(2);
    for (const s of senders) expect(s.defer).toHaveBeenCalledTimes(1);
    expect(result.current.state.recordingError).not.toBe(REFUSED);
  });

  it('a take the host stopped while storage was still answering is not started again', async () => {
    let answer!: () => void;
    storageOpen = new Promise<void>((r) => {
      answer = r;
    });
    const result = await joined('guest');
    act(() => result.current.setSendLater(true));
    await hostStarts('rec-host-1');
    await hostStops('rec-host-1');
    expect(result.current.state.phase).toBe('done');

    await act(async () => {
      answer();
      await flush();
      await flush();
    });
    expect(result.current.state.phase).toBe('done');
    for (const s of senders) expect(s.defer).not.toHaveBeenCalled();
  });

  it('waits for the WAV backup’s storage as well before it decides', async () => {
    const result = await joined('guest');
    // With PCM capture the hook keeps a WAV backup of its own.
    (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor = class {};
    try {
      let answer!: () => void;
      wavStorageOpen = new Promise<void>((r) => {
        answer = r;
      });
      wavBackupDir = null;
      act(() => result.current.setSendLater(true));
      await hostStarts('rec-host-1');
      for (const s of senders) expect(s.defer).not.toHaveBeenCalled();

      wavBackupDir = ON_DISK;
      await act(async () => {
        answer();
        await flush();
        await flush();
      });
      expect(result.current.state.phase).toBe('recording');
      expect(senders).toHaveLength(2);
      for (const s of senders) expect(s.defer).toHaveBeenCalledTimes(1);
    } finally {
      delete (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor;
    }
  });

  it('turned off while the backup’s storage is still answering, the take is streamed', async () => {
    let answer!: () => void;
    storageOpen = new Promise<void>((r) => {
      answer = r;
    });
    const result = await joined('guest');
    act(() => result.current.setSendLater(true));
    await hostStarts('rec-host-1');
    act(() => result.current.setSendLater(false));
    expect(result.current.state.sendLater).toBe(false);

    await act(async () => {
      answer();
      await flush();
      await flush();
    });
    expect(result.current.state.phase).toBe('recording');
    expect(result.current.state.sendLater).toBe(false);
    for (const s of senders) expect(s.defer).not.toHaveBeenCalled();
    expect(result.current.state.recordingError).not.toBe(REFUSED);
  });

  it('ticked while a take is starting, before its streams exist, defers that take once they do', async () => {
    const result = await joined('guest');
    await act(async () => {
      emitSignal('recording-started', {
        type: 'recording-started',
        from: 'host',
        recordingId: 'rec-host-1',
        kind: 'camera',
        filename: 'host_rec-host-1.mp4',
      });
      // The take has its backups and no streams yet, and storage has not answered.
      backupDir = null;
      result.current.setSendLater(true);
      backupDir = ON_DISK;
      await flush();
      await flush();
    });
    expect(result.current.state.sendLater).toBe(true);
    expect(result.current.state.recordingError).not.toBe(REFUSED);
    expect(result.current.state.phase).toBe('recording');
    expect(senders).toHaveLength(2);
    for (const s of senders) expect(s.defer).toHaveBeenCalledTimes(1);
  });
});
