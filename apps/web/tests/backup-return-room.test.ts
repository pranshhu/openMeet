import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';
import { PeerConnection } from '@/lib/peer';
import { bindHostGuestChannel, startHostRecording } from '@/hooks/recording-controller';
import { fakeChannel, fakeFolder, flush, framesFor } from './backup-fakes';
import type { FakeChannel, FakeFolderHandle } from './backup-fakes';

let signalHandlers: Record<string, ((m: any) => void)[]> = {};
let signalSent: any[] = [];

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
    startHostRecording: vi.fn().mockImplementation(async () => ({
      recordingId: 'rec-host-1',
      hostStartMs: 1_000_000,
      hostWriter: { fileName: 'host_rec-host-1.mp4', size: 1 },
      receiver: {
        fileName: 'guest_rec-host-1.mp4',
        digestHex: async () => 'abc',
        senderSha256: 'abc',
        receivedFinalized: true,
        isAbandoned: false,
        bytesWritten: 1,
      },
    })),
    endHostRecording: vi.fn().mockResolvedValue({ backup: null }),
    startScreenRecording: vi.fn().mockResolvedValue(undefined),
    bindHostGuestChannel: vi.fn().mockResolvedValue(undefined),
    syncCallCopies: vi.fn(actual.syncCallCopies),
  };
});

const ROOM = 'abc-defg-hij';
const BACKUP = 'openmeet-backup-1700000000000-abc-defg-hij.mp4';
const BACKUP_2 = 'openmeet-backup-1700000000001-abc-defg-hij.mp4';
const OFFER = JSON.stringify({ type: 'backup_offer', size: 4096, key: 'k1' });

const GUEST = { peerId: 'p-guest', ordinal: 2, role: 'guest', displayName: 'Asha' };
const HOST = { peerId: 'p-host', ordinal: 1, role: 'host', displayName: 'Hana' };

function fakeStream() {
  return {
    getTracks: () => [],
    getAudioTracks: () => [{ kind: 'audio' }],
    getVideoTracks: () => [{ kind: 'video' }],
  } as unknown as MediaStream;
}

function emitSignal(type: string, payload: any) {
  for (const handler of signalHandlers[type] ?? []) handler(payload);
}

function backupChannel(name = BACKUP): FakeChannel {
  return fakeChannel(`backup#${name}`);
}

/** A joined tab, with the handler the last PeerConnection was started with. */
async function joined(role: 'host' | 'guest', peers: any[]) {
  const { result, unmount } = renderHook(() => useRoom(ROOM));
  await act(async () => {
    await result.current.join(fakeStream(), role === 'host' ? 'Host Hana' : 'Guest Gita');
  });
  act(() => {
    emitSignal('role-assigned', {
      type: 'role-assigned',
      role,
      peerId: role === 'host' ? 'p-host' : 'p-guest',
      ordinal: role === 'host' ? 1 : 2,
      peers,
      recording: false,
    });
  });
  const opts = vi.mocked(PeerConnection).mock.calls.at(-1)![0] as unknown as {
    onDataChannel?: (channel: RTCDataChannel) => void;
  };
  return { result, unmount, opts };
}

/** Hands the handler a backup channel carrying one offer, as a guest would send it. */
async function offerBackup(
  opts: { onDataChannel?: (channel: RTCDataChannel) => void },
  name = BACKUP
): Promise<FakeChannel> {
  const channel = backupChannel(name);
  await act(async () => {
    opts.onDataChannel!(channel as unknown as RTCDataChannel);
    channel.deliver(OFFER);
    await flush();
  });
  return channel;
}

const usePicker = (folder: FakeFolderHandle) => {
  const picker = vi.fn().mockResolvedValue(folder);
  (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker = picker;
  return picker;
};

/** Puts a few bytes into an accepted transfer, so closing it keeps the file. */
async function writeBytes(channel: FakeChannel) {
  const { frames } = await framesFor(new Uint8Array([1, 2, 3, 4]));
  await act(async () => {
    for (const f of frames) channel.deliver(f);
    await flush();
  });
}

describe('a host taking returned backups', () => {
  beforeEach(() => {
    signalHandlers = {};
    signalSent = [];
    globalThis.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    globalThis.URL.revokeObjectURL = vi.fn();
    delete (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });

  afterEach(() => {
    delete (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    vi.clearAllMocks();
  });

  it('lists an offered backup, from the sender, before any Save', async () => {
    usePicker(fakeFolder());
    const { result, opts } = await joined('host', [GUEST]);
    await offerBackup(opts);
    expect(result.current.state.backupTransfers).toEqual([
      expect.objectContaining({ id: BACKUP, status: 'offered', from: 'Asha', size: 4096, percent: 0 }),
    ]);
  });

  it('does not bind a backup channel as a guest camera while a take runs', async () => {
    usePicker(fakeFolder());
    const { result, opts } = await joined('host', [GUEST]);
    await act(async () => {
      await result.current.startRecording();
    });
    await offerBackup(opts);
    expect(vi.mocked(bindHostGuestChannel)).not.toHaveBeenCalled();
    expect(result.current.state.backupTransfers.map((t) => t.status)).toEqual(['offered']);
    await act(async () => {
      await result.current.endRecording();
    });
  });

  it('accepts every shown offer into the folder, prompting once and reusing it', async () => {
    const folder = fakeFolder();
    const picker = usePicker(folder);
    const { result, opts } = await joined('host', [GUEST]);
    const first = await offerBackup(opts);
    await act(async () => {
      await result.current.acceptBackups();
    });
    expect(picker).toHaveBeenCalledTimes(1);
    expect(JSON.parse(first.sent[0] as string)).toEqual({
      type: 'resume_offset',
      recordingId: BACKUP,
      lastByte: 0,
      lastIdx: -1,
    });
    expect(result.current.state.backupTransfers.map((t) => t.status)).toEqual(['active']);

    const second = await offerBackup(opts, BACKUP_2);
    await act(async () => {
      await result.current.acceptBackups();
    });
    expect(picker).toHaveBeenCalledTimes(1);
    expect([...folder.files.keys()].sort()).toEqual([
      'backup_asha_camera_20231114T221320000Z.mp4',
      'backup_asha_camera_20231114T221320001Z.mp4',
    ]);
    expect(second.sent.map((s) => JSON.parse(s as string).type)).toEqual(['resume_offset']);
    expect(result.current.state.backupTransfers.map((t) => t.status)).toEqual(['active', 'active']);
  });

  it('remembers the folder it chose for the next take', async () => {
    const folder = fakeFolder();
    usePicker(folder);
    const { result, opts } = await joined('host', [GUEST]);
    await offerBackup(opts);
    await act(async () => {
      await result.current.acceptBackups();
    });
    await act(async () => {
      await result.current.startRecording();
    });
    expect(vi.mocked(startHostRecording).mock.calls.at(-1)![0].dir).toBe(folder);
    await act(async () => {
      await result.current.endRecording();
    });
  });

  it('leaves the offers waiting when the folder prompt is dismissed', async () => {
    const abort = Object.assign(new Error('dismissed'), { name: 'AbortError' });
    (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker = vi
      .fn()
      .mockRejectedValue(abort);
    const { result, opts } = await joined('host', [GUEST]);
    await offerBackup(opts);
    await act(async () => {
      await result.current.acceptBackups();
    });
    expect(result.current.state.backupTransfers.map((t) => t.status)).toEqual(['offered']);
    expect(result.current.state.recordingError).toBeNull();
  });

  it('declineBackups drops the offer and tells the sender', async () => {
    usePicker(fakeFolder());
    const { result, opts } = await joined('host', [GUEST]);
    const channel = await offerBackup(opts);
    expect(result.current.state.backupTransfers.map((t) => t.status)).toEqual(['offered']);
    act(() => {
      result.current.declineBackups();
    });
    expect(result.current.state.backupTransfers).toEqual([]);
    expect(JSON.parse(channel.sent[0] as string)).toEqual({
      type: 'recording-finalized',
      recordingId: '',
      totalBytes: 0,
      sha256: '',
    });
    expect(channel.readyState).toBe('closed');
  });

  it('keeps the transfer list across a new take', async () => {
    const folder = fakeFolder();
    usePicker(folder);
    const { result, opts } = await joined('host', [GUEST]);
    await offerBackup(opts);
    await act(async () => {
      await result.current.acceptBackups();
    });
    act(() => {
      result.current.newTake();
    });
    expect(result.current.state.backupTransfers.map((t) => [t.id, t.status])).toEqual([
      [BACKUP, 'active'],
    ]);
  });

  it('closes an accepted file when the host leaves', async () => {
    const folder = fakeFolder();
    usePicker(folder);
    const { result, opts } = await joined('host', [GUEST]);
    const channel = await offerBackup(opts);
    await act(async () => {
      await result.current.acceptBackups();
    });
    await writeBytes(channel);
    const name = [...folder.files.keys()][0]!;
    expect(folder.files.get(name)!.closed).toBe(false);
    await act(async () => {
      await result.current.leave();
      await flush();
    });
    expect(folder.files.get(name)!.closed).toBe(true);
  });

  it('closes an accepted file on pagehide with no take running', async () => {
    const folder = fakeFolder();
    usePicker(folder);
    const { result, opts } = await joined('host', [GUEST]);
    const channel = await offerBackup(opts);
    await act(async () => {
      await result.current.acceptBackups();
    });
    await writeBytes(channel);
    const name = [...folder.files.keys()][0]!;
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await act(async () => {
      await flush();
    });
    expect(folder.files.get(name)!.closed).toBe(true);
  });

  it('closes an accepted file when the hook unmounts', async () => {
    const folder = fakeFolder();
    usePicker(folder);
    const { result, unmount, opts } = await joined('host', [GUEST]);
    const channel = await offerBackup(opts);
    await act(async () => {
      await result.current.acceptBackups();
    });
    await writeBytes(channel);
    const name = [...folder.files.keys()][0]!;
    unmount();
    await act(async () => {
      await flush();
    });
    expect(folder.files.get(name)!.closed).toBe(true);
  });
});

describe('a tab that cannot take a returned backup', () => {
  beforeEach(() => {
    signalHandlers = {};
    signalSent = [];
    delete (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });

  afterEach(() => {
    delete (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    vi.clearAllMocks();
  });

  const refused = (channel: FakeChannel) => {
    expect(JSON.parse(channel.sent[0] as string)).toEqual({
      type: 'recording-finalized',
      recordingId: '',
      totalBytes: 0,
      sha256: '',
    });
    expect(channel.readyState).toBe('closed');
  };

  it('answers a guest tab with a refusal and lists nothing', async () => {
    // Even a guest that could write to a folder takes no backups: the host owns the take.
    usePicker(fakeFolder());
    const { result, opts } = await joined('guest', [HOST]);
    const channel = backupChannel();
    await act(async () => {
      opts.onDataChannel!(channel as unknown as RTCDataChannel);
      channel.deliver(OFFER);
      await flush();
    });
    refused(channel);
    expect(result.current.state.backupTransfers).toEqual([]);
    expect(result.current.state.recordingError).toBeNull();
  });

  it('answers a host whose browser cannot write to a folder with a refusal', async () => {
    const { result, opts } = await joined('host', [GUEST]);
    const channel = backupChannel();
    await act(async () => {
      opts.onDataChannel!(channel as unknown as RTCDataChannel);
      channel.deliver(OFFER);
      await flush();
    });
    refused(channel);
    expect(result.current.state.backupTransfers).toEqual([]);
    expect(result.current.state.recordingError).toBeNull();
  });
});
