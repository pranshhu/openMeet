import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';
import { PeerConnection } from '@/lib/peer';
import { fakeChannel, flush } from './backup-fakes';
import type { FakeChannel } from './backup-fakes';

// As in tests/backup-return-room.test.ts: the room, the connections and the
// recorders are replaced, and the returned-backup code runs for real.
let signalHandlers: Record<string, ((m: any) => void)[]> = {};
/** What the guest's take ends with, or the failure its ending throws. */
let ended: { drained: boolean; backup: Blob | null; wavBackup?: Blob | null } | Error;
let screens: { stop: () => Promise<Blob | null> }[] = [];
/** Whether any chunk of the camera backup reached the disk. */
let cameraOnDisk = true;
/** What the recorder hands over when the take's ending threw before it could. */
let held: Blob | null = null;

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
    start: vi.fn().mockResolvedValue({ getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] }),
    stop: vi.fn(),
    setAudioEnabled: vi.fn(),
    setVideoEnabled: vi.fn(),
    stream: Object.assign(new EventTarget(), { getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] }) as unknown as MediaStream,
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
    createBackupChannel: vi.fn((name: string) => fakeChannel(`backup#${name}`)),
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
    startGuestRecording: vi.fn().mockImplementation(() => ({
      recordingId: 'rec-guest-1',
      guestRecorder: { totalBytes: 0, stopAndFlush: vi.fn() },
      sender: {
        lastAckedIdx: 0,
        drain: vi.fn().mockResolvedValue(true),
        rebind: vi.fn(),
        hold: vi.fn(),
        giveUp: vi.fn(),
      },
      screenBackups: screens,
      backup: { stop: async () => held, wroteToDisk: cameraOnDisk },
    })),
    endGuestRecording: vi.fn().mockImplementation(async () => {
      if (ended instanceof Error) throw ended;
      return ended;
    }),
  };
});

const ROOM = 'abc-defg-hij';
const CAMERA = `openmeet-backup-1700000000000-${ROOM}.mp4`;
const WAV = `openmeet-backup-audio-1700000000001-${ROOM}.wav`;
const SCREEN = `openmeet-backup-screen-1700000000002-${ROOM}.mp4`;
const backupFile = (name: string) => new File([new Uint8Array([1, 2, 3, 4])], name);

function emitSignal(type: string, payload: any) {
  for (const handler of signalHandlers[type] ?? []) handler(payload);
}

/** Every backup channel any connection was asked for, oldest first. */
function backupChannels(): FakeChannel[] {
  return vi.mocked(PeerConnection).mock.results.flatMap((r) => {
    const peer = r.value as unknown as { createBackupChannel: ReturnType<typeof vi.fn> };
    return peer.createBackupChannel.mock.results.map((result) => result.value as FakeChannel);
  });
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

/** A guest in a take the host started: joined, told its role, and recording. */
async function recordingGuest() {
  const { result } = renderHook(() => useRoom(ROOM));
  const audio = { id: 'a1', kind: 'audio', enabled: true } as unknown as MediaStreamTrack;
  const video = { id: 'v1', kind: 'video', enabled: true } as unknown as MediaStreamTrack;
  const stream = Object.assign(new EventTarget(), {
    getTracks: () => [audio, video],
    getAudioTracks: () => [audio],
    getVideoTracks: () => [video],
  }) as unknown as MediaStream;
  await act(async () => {
    await result.current.join(stream, 'Guest Gita');
  });
  act(() => {
    emitSignal('role-assigned', {
      type: 'role-assigned',
      role: 'guest',
      peerId: 'p-guest',
      ordinal: 2,
      peers: [{ peerId: 'p-host', ordinal: 1, role: 'host', displayName: 'Hana' }],
      recording: false,
    });
  });
  await hostStarts('rec-host-1');
  expect(result.current.state.phase).toBe('recording');
  return result;
}

describe('a guest whose take did not all reach the host', () => {
  beforeEach(() => {
    signalHandlers = {};
    screens = [];
    cameraOnDisk = true;
    held = null;
    ended = { drained: true, backup: null };
    globalThis.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('offers its camera and WAV backups to the host when the host ends the take', async () => {
    ended = { drained: false, backup: backupFile(CAMERA), wavBackup: backupFile(WAV) };
    const result = await recordingGuest();
    await hostStops('rec-host-1');

    expect(result.current.state.phase).toBe('done');
    expect(result.current.state.drained).toBe(false);
    expect(result.current.state.backupQueued).toBe(true);
    expect(result.current.state.backupTransfers.map((t) => [t.id, t.status])).toEqual([
      [CAMERA, 'offered'],
      [WAV, 'offered'],
    ]);
    expect(backupChannels().map((c) => c.label)).toEqual([`backup#${CAMERA}`, `backup#${WAV}`]);
    expect(JSON.parse(backupChannels()[0]!.sent[0] as string)).toMatchObject({ type: 'backup_offer', size: 4 });
  });

  it('says a camera backup that has no name is held in memory only', async () => {
    ended = { drained: false, backup: new Blob([new Uint8Array([1, 2, 3, 4])]) };
    cameraOnDisk = false;
    const result = await recordingGuest();
    await hostStops('rec-host-1');
    expect(result.current.state.backupInMemory).toBe(true);
  });

  it('does not say so of a camera backup that has a name', async () => {
    ended = { drained: false, backup: backupFile(CAMERA) };
    const result = await recordingGuest();
    await hostStops('rec-host-1');
    expect(result.current.state.backupInMemory).toBe(false);
  });

  it('says so of a camera backup that has a name but took no chunk on the disk', async () => {
    ended = { drained: false, backup: backupFile(CAMERA) };
    cameraOnDisk = false;
    const result = await recordingGuest();
    await hostStops('rec-host-1');
    expect(result.current.state.backupInMemory).toBe(true);
  });

  it('offers the backup of each screen stretch with them', async () => {
    ended = { drained: false, backup: backupFile(CAMERA), wavBackup: backupFile(WAV) };
    screens = [{ stop: async () => backupFile(SCREEN) }];
    const result = await recordingGuest();
    await hostStops('rec-host-1');

    expect(result.current.state.backupTransfers.map((t) => t.id)).toEqual([CAMERA, WAV, SCREEN]);
  });

  it('offers the backup of every screen stretch, also one whose stream was finished', async () => {
    ended = { drained: false, backup: backupFile(CAMERA), wavBackup: backupFile(WAV) };
    const whole = { stop: async () => backupFile(`openmeet-backup-screen-1700000000003-${ROOM}.mp4`) };
    const keptBack = { stop: async () => backupFile(SCREEN) };
    screens = [whole, keptBack];
    const result = await recordingGuest();
    await hostStops('rec-host-1');

    expect(result.current.state.backupTransfers.map((t) => t.id)).toEqual([
      CAMERA,
      WAV,
      `openmeet-backup-screen-1700000000003-${ROOM}.mp4`,
      SCREEN,
    ]);
  });

  it('offers nothing when the whole take reached the host', async () => {
    ended = { drained: true, backup: backupFile(CAMERA), wavBackup: backupFile(WAV) };
    const result = await recordingGuest();
    await hostStops('rec-host-1');

    expect(result.current.state.phase).toBe('done');
    expect(result.current.state.backupQueued).toBe(false);
    expect(result.current.state.backupTransfers).toEqual([]);
    expect(backupChannels()).toEqual([]);
  });

  it('offers nothing when a new take, not the host’s stop, ended the take', async () => {
    ended = { drained: false, backup: backupFile(CAMERA) };
    const result = await recordingGuest();
    await hostStarts('rec-host-2');

    expect(result.current.state.phase).toBe('recording');
    expect(result.current.state.backupQueued).toBe(false);
    expect(result.current.state.backupTransfers).toEqual([]);
  });

  it('offers nothing when the host set this guest as not recorded', async () => {
    ended = { drained: false, backup: backupFile(CAMERA) };
    const result = await recordingGuest();
    // After a host reload the Room lets this through while the guest still captures.
    await act(async () => {
      emitSignal('peer-recorded', { type: 'peer-recorded', peerId: 'p-guest', recorded: false });
      await flush();
      await flush();
    });

    expect(result.current.state.phase).toBe('done');
    expect(result.current.state.notRecorded).toBe(true);
    expect(result.current.state.backupQueued).toBe(false);
    expect(result.current.state.backupTransfers).toEqual([]);
  });

  it('offers nothing when the backup was kept in memory only', async () => {
    ended = { drained: false, backup: new Blob(['backup-bytes']) };
    const result = await recordingGuest();
    await hostStops('rec-host-1');

    expect(result.current.state.phase).toBe('done');
    expect(result.current.state.backupQueued).toBe(false);
    expect(result.current.state.backupTransfers).toEqual([]);
  });

  it('drops the flag when the next take fails to end', async () => {
    ended = { drained: false, backup: backupFile(CAMERA) };
    const result = await recordingGuest();
    await hostStops('rec-host-1');
    expect(result.current.state.backupQueued).toBe(true);

    await hostStarts('rec-host-2');
    expect(result.current.state.phase).toBe('recording');
    ended = new Error('storage');
    await hostStops('rec-host-2');

    expect(result.current.state.phase).toBe('done');
    expect(result.current.state.drained).toBe(false);
    expect(result.current.state.backupQueued).toBe(false);
  });

  it('says the backup is in memory only when the take failed to end and it has no name', async () => {
    held = new Blob([new Uint8Array([1, 2, 3, 4])]);
    ended = new Error('storage');
    cameraOnDisk = false;
    const result = await recordingGuest();
    await hostStops('rec-host-1');

    expect(result.current.state.phase).toBe('done');
    expect(result.current.state.backupBlobUrl).not.toBeNull();
    expect(result.current.state.backupInMemory).toBe(true);
  });

  it('says so when the take failed to end and the backup has a name but took no chunk on the disk', async () => {
    held = backupFile(CAMERA);
    ended = new Error('storage');
    cameraOnDisk = false;
    const result = await recordingGuest();
    await hostStops('rec-host-1');

    expect(result.current.state.phase).toBe('done');
    expect(result.current.state.backupInMemory).toBe(true);
  });

  it('offers nothing when the guest leaves during the take', async () => {
    ended = { drained: false, backup: backupFile(CAMERA), wavBackup: backupFile(WAV) };
    const result = await recordingGuest();
    await act(async () => {
      await result.current.leave();
      await flush();
    });
    expect(result.current.state.phase).toBe('left');
    expect(result.current.state.backupQueued).toBe(false);
    expect(backupChannels()).toEqual([]);
  });

  it('ends the take all the same when the offer cannot be made', async () => {
    ended = { drained: false, backup: backupFile(CAMERA), wavBackup: backupFile(WAV) };
    const result = await recordingGuest();
    const ids = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      throw new Error('no ids');
    });
    try {
      await hostStops('rec-host-1');
    } finally {
      ids.mockRestore();
    }
    expect(result.current.state.phase).toBe('done');
    expect(result.current.state.drained).toBe(false);
    expect(result.current.state.backupQueued).toBe(false);
    expect(result.current.state.recordingError ?? '').not.toContain('finish');
  });
});
