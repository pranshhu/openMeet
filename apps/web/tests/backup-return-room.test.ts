import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';
import { PeerConnection } from '@/lib/peer';
import { bindHostGuestChannel, startHostRecording } from '@/hooks/recording-controller';
import { fakeChannel, fakeFolder, flush, framesFor } from './backup-fakes';
import type { FakeChannel, FakeFolderHandle } from './backup-fakes';

// jsdom ships no Blob.prototype.arrayBuffer, and the one a real browser has is
// what a backup send reads its slices with.
if (typeof Blob !== 'undefined' && typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function () {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

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
  PeerConnection: vi.fn().mockImplementation(() => {
    const backupChannels: FakeChannel[] = [];
    return {
      start: vi.fn(),
      // A real connection takes its channels down with it, so a send that is
      // cancelled after the close can no longer say anything on it.
      close: vi.fn(() => {
        for (const channel of backupChannels) channel.close();
      }),
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
      createBackupChannel: vi.fn((name: string) => {
        const channel = fakeChannel(`backup#${name}`);
        backupChannels.push(channel);
        return channel;
      }),
    };
  }),
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
const OTHER_GUEST = { peerId: 'p-guest-2', ordinal: 3, role: 'guest', displayName: 'Bo' };

/** The PeerConnection the hook built last, whose methods these tests inspect. */
function lastPeer() {
  return vi.mocked(PeerConnection).mock.results.at(-1)!.value as unknown as {
    createBackupChannel: ReturnType<typeof vi.fn>;
  };
}

/** The handler the connection built for `peerId` was started with. */
function optsFor(peerId: string) {
  return vi.mocked(PeerConnection).mock.calls.find(
    (c) => (c[0] as { remotePeerId?: string }).remotePeerId === peerId
  )![0] as unknown as { onDataChannel?: (channel: RTCDataChannel) => void };
}

/** Every backup channel any connection was asked for, oldest first. */
function backupChannels(): FakeChannel[] {
  return vi.mocked(PeerConnection).mock.results.flatMap((r) => {
    const peer = r.value as unknown as { createBackupChannel: ReturnType<typeof vi.fn> };
    return peer.createBackupChannel.mock.results.map((result) => result.value as FakeChannel);
  });
}

function backupFile(name = BACKUP): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name);
}

/** Emits the role-assigned this tab would receive in a room holding `peers`. */
async function assigned(result: { current: ReturnType<typeof useRoom> }, role: 'host' | 'guest', peers: any[]) {
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
  await act(async () => {
    await flush();
  });
}

/** A tab that queued `files` before joining, then joins a room holding `peers`. */
async function queuedBeforeJoining(
  role: 'host' | 'guest',
  files: File[],
  peers: any[]
) {
  const { result, unmount } = renderHook(() => useRoom(ROOM));
  act(() => {
    result.current.sendBackups(files);
  });
  await act(async () => {
    await result.current.join(fakeStream(), role === 'host' ? 'Host Hana' : 'Guest Gita');
  });
  await assigned(result, role, peers);
  return { result, unmount };
}

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

  it('dismissBackup drops a stalled transfer and frees its name for a new key', async () => {
    const folder = fakeFolder();
    usePicker(folder);
    const { result, opts } = await joined('host', [GUEST]);
    const first = await offerBackup(opts);
    await act(async () => {
      await result.current.acceptBackups();
    });
    await writeBytes(first);
    act(() => {
      first.close();
    });
    expect(result.current.state.backupTransfers.map((t) => t.status)).toEqual(['stalled']);

    await act(async () => {
      await result.current.dismissBackup(BACKUP);
    });
    expect(result.current.state.backupTransfers).toEqual([]);
    // A partial file stays on the disk; only the record goes.
    const name = [...folder.files.keys()][0]!;
    expect(folder.files.get(name)!.closed).toBe(true);
    expect(folder.removed).toEqual([]);

    // The guest's tab reloaded with a new key: the name it offers is free again.
    const second = backupChannel(BACKUP);
    await act(async () => {
      opts.onDataChannel!(second as unknown as RTCDataChannel);
      second.deliver(JSON.stringify({ type: 'backup_offer', size: 4096, key: 'k2' }));
      await flush();
    });
    expect(result.current.state.backupTransfers.map((t) => [t.id, t.status])).toEqual([
      [BACKUP, 'offered'],
    ]);
    expect(second.readyState).toBe('open');
  });

  it('counts waiting offers per sender: one guest at the limit does not crowd out another', async () => {
    usePicker(fakeFolder());
    const { result } = await joined('host', [GUEST, OTHER_GUEST]);
    const name = (n: number) => `openmeet-backup-170000000000${n}-abc-defg-hij.mp4`;
    for (let n = 0; n < 8; n++) await offerBackup(optsFor('p-guest'), name(n));
    const ninth = await offerBackup(optsFor('p-guest'), name(8));
    expect(ninth.readyState).toBe('closed');
    const other = await offerBackup(optsFor('p-guest-2'), name(9));
    expect(other.readyState).toBe('open');
    expect(result.current.state.backupTransfers.map((t) => t.from)).toEqual([
      ...Array(8).fill('Asha'),
      'Bo',
    ]);
  });

  it('a Save takes only what was listed when it was pressed, however long the folder prompt stays open', async () => {
    const folder = fakeFolder();
    let resolvePicker!: (f: unknown) => void;
    (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker = vi.fn(
      () => new Promise((r) => { resolvePicker = r; })
    );
    const { result, opts } = await joined('host', [GUEST]);
    await offerBackup(opts);
    let accepting!: Promise<void>;
    act(() => { accepting = result.current.acceptBackups(); });
    const swap = backupChannel(BACKUP);
    const extra = backupChannel(BACKUP_2);
    await act(async () => {
      opts.onDataChannel!(swap as unknown as RTCDataChannel);
      swap.deliver(JSON.stringify({ type: 'backup_offer', size: Number.MAX_SAFE_INTEGER, key: 'k1' }));
      opts.onDataChannel!(extra as unknown as RTCDataChannel);
      extra.deliver(JSON.stringify({ type: 'backup_offer', size: 123456789, key: 'k9' }));
      await flush();
    });
    await act(async () => { resolvePicker(folder); await accepting; await flush(); });
    expect(result.current.state.backupTransfers.map((t) => t.status)).toEqual(['offered', 'offered']);
    expect([...folder.files.keys()]).toEqual([]);
  });

  it('a Save takes only the offers listed when it was pressed, even when the folder prompt opens', async () => {
    const folder = fakeFolder();
    let pick!: (f: FakeFolderHandle) => void;
    (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker = vi.fn(
      () => new Promise<FakeFolderHandle>((r) => { pick = r; })
    );
    const { result } = await joined('host', [GUEST, OTHER_GUEST]);
    const first = await offerBackup(optsFor('p-guest'));

    let saving!: Promise<void>;
    act(() => { saving = result.current.acceptBackups(); });
    await act(async () => { await flush(); });

    // The prompt is open: another participant offers a backup the host has not seen.
    const late = backupChannel(BACKUP_2);
    await act(async () => {
      optsFor('p-guest-2').onDataChannel!(late as unknown as RTCDataChannel);
      late.deliver(JSON.stringify({ type: 'backup_offer', size: Number.MAX_SAFE_INTEGER, key: 'k2' }));
      await flush();
    });
    await act(async () => { pick(folder); await saving; await flush(); });

    expect(result.current.state.backupTransfers.map((t) => [t.from, t.status])).toEqual([
      ['Asha', 'active'],
      ['Bo', 'offered'],
    ]);
    expect([...folder.files.keys()]).toEqual(['backup_asha_camera_20231114T221320000Z.mp4']);
    expect(first.sent.map((s) => JSON.parse(s as string).type)).toEqual(['resume_offset']);
    expect(late.sent).toEqual([]);
  });

  it('an offer whose size changed while the folder prompt was open waits for the next Save', async () => {
    const folder = fakeFolder();
    let pick!: (f: FakeFolderHandle) => void;
    (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker = vi.fn(
      () => new Promise<FakeFolderHandle>((r) => { pick = r; })
    );
    const { result } = await joined('host', [GUEST]);
    const asha = optsFor('p-guest');
    await offerBackup(asha);
    let saving!: Promise<void>;
    act(() => { saving = result.current.acceptBackups(); });
    await act(async () => { await flush(); });
    const again = backupChannel(BACKUP);
    await act(async () => {
      asha.onDataChannel!(again as unknown as RTCDataChannel);
      again.deliver(JSON.stringify({ type: 'backup_offer', size: 8_000_000_000_000, key: 'k1' }));
      await flush();
    });
    await act(async () => { pick(folder); await saving; await flush(); });
    expect(result.current.state.backupTransfers.map((t) => [t.size, t.status])).toEqual([
      [8_000_000_000_000, 'offered'],
    ]);
    expect(folder.files.size).toBe(0);
  });

  it('stopBackup ends a running transfer the way a failure does', async () => {
    const folder = fakeFolder();
    usePicker(folder);
    const { result, opts } = await joined('host', [GUEST]);
    const channel = await offerBackup(opts);
    await act(async () => {
      await result.current.acceptBackups();
    });
    expect(result.current.state.backupTransfers.map((t) => t.status)).toEqual(['active']);

    act(() => {
      result.current.stopBackup(BACKUP);
    });
    await act(async () => {
      await flush();
    });

    expect(result.current.state.backupTransfers.map((t) => t.status)).toEqual(['failed']);
    expect(folder.removed).toEqual(['backup_asha_camera_20231114T221320000Z.mp4']);
    expect(JSON.parse(channel.sent.at(-1) as string)).toEqual({
      type: 'recording-finalized',
      recordingId: '',
      totalBytes: 0,
      sha256: '',
    });
    expect(channel.readyState).toBe('closed');
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

describe('a guest offering leftover backups', () => {
  beforeEach(() => {
    signalHandlers = {};
    signalSent = [];
    delete (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('offers a queued backup to the host as soon as the host is there', async () => {
    const { result } = await queuedBeforeJoining('guest', [backupFile()], [HOST]);
    const channels = backupChannels();
    expect(channels.map((c) => c.label)).toEqual([`backup#${BACKUP}`]);
    expect(JSON.parse(channels[0]!.sent[0] as string)).toEqual({
      type: 'backup_offer',
      size: 4,
      key: expect.any(String),
    });
    expect(result.current.state.backupTransfers).toEqual([
      expect.objectContaining({ id: BACKUP, status: 'offered', size: 4 }),
    ]);
  });

  it('queues the same backup once', async () => {
    const { result } = await queuedBeforeJoining('guest', [backupFile(), backupFile()], [HOST]);
    expect(backupChannels().map((c) => c.label)).toEqual([`backup#${BACKUP}`]);
    expect(result.current.state.backupTransfers.map((t) => t.id)).toEqual([BACKUP]);
  });

  it('gives each newly queued backup exactly one more channel, leaving the first alone', async () => {
    const { result } = await joined('guest', [HOST]);
    await act(async () => {
      result.current.sendBackups([backupFile()]);
      await flush();
    });
    const first = backupChannels()[0]!;
    await act(async () => {
      result.current.sendBackups([backupFile(BACKUP_2)]);
      await flush();
    });
    const channels = backupChannels();
    expect(channels.map((c) => c.label)).toEqual([`backup#${BACKUP}`, `backup#${BACKUP_2}`]);
    expect(channels[0]).toBe(first);
    expect(first.sent).toHaveLength(1);
  });

  it('waits with no channel while only another guest is in the room', async () => {
    const { result } = await queuedBeforeJoining('guest', [backupFile()], [OTHER_GUEST]);
    expect(backupChannels()).toEqual([]);
    expect(result.current.state.backupTransfers.map((t) => [t.id, t.status])).toEqual([
      [BACKUP, 'offered'],
    ]);
  });

  it('follows the host onto a rebuilt connection', async () => {
    const { result } = await joined('guest', [HOST]);
    await act(async () => {
      result.current.sendBackups([backupFile()]);
      await flush();
    });
    expect(backupChannels()).toHaveLength(1);
    act(() => {
      emitSignal('peer-joined', {
        type: 'peer-joined',
        peerId: 'p-host-2',
        ordinal: 1,
        role: 'host',
        displayName: 'Hana',
      });
    });
    await act(async () => {
      await flush();
    });
    expect(lastPeer().createBackupChannel).toHaveBeenCalledWith(BACKUP);
    expect(backupChannels().map((c) => c.label)).toEqual([
      `backup#${BACKUP}`,
      `backup#${BACKUP}`,
    ]);
  });

  it('holds a backup while a take records here, then sends it', async () => {
    const { result } = await joined('guest', [HOST]);
    await act(async () => {
      emitSignal('recording-started', {
        type: 'recording-started',
        from: 'host',
        recordingId: 'rec-x',
        kind: 'camera',
        filename: 'host_rec-x.mp4',
      });
    });
    await act(async () => {
      result.current.sendBackups([backupFile()]);
      await flush();
    });
    const channel = backupChannels()[0]!;
    act(() => {
      channel.deliver(
        JSON.stringify({ type: 'resume_offset', recordingId: 'x', lastByte: 0, lastIdx: -1 })
      );
    });
    await act(async () => {
      await flush();
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(channel.sent.filter((d) => d instanceof ArrayBuffer)).toHaveLength(0);

    await act(async () => {
      emitSignal('recording-stop', {
        type: 'recording-stop',
        from: 'host',
        recordingId: 'rec-x',
      });
      await flush();
    });
    await act(async () => {
      await vi.waitFor(
        () => {
          expect(channel.sent.filter((d) => d instanceof ArrayBuffer)).toHaveLength(1);
        },
        { timeout: 3000 }
      );
    });
  });

  it('sequences multiple sends so the second waits for the first to finish', async () => {
    const { result } = await joined('guest', [HOST]);
    await act(async () => {
      result.current.sendBackups([backupFile(BACKUP), backupFile(BACKUP_2)]);
      await flush();
    });
    const [first, second] = backupChannels();
    act(() => {
      first!.deliver(
        JSON.stringify({ type: 'resume_offset', recordingId: 'x', lastByte: 0, lastIdx: -1 })
      );
      second!.deliver(
        JSON.stringify({ type: 'resume_offset', recordingId: 'y', lastByte: 0, lastIdx: -1 })
      );
    });
    await act(async () => {
      await flush();
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(first!.sent.filter((d) => d instanceof ArrayBuffer)).toHaveLength(1);
    expect(second!.sent.filter((d) => d instanceof ArrayBuffer)).toEqual([]);
  });

  it('allows queuing the same backup again once its first send has settled', async () => {
    const { result } = await joined('guest', [HOST]);
    await act(async () => {
      result.current.sendBackups([backupFile()]);
      await flush();
    });
    const firstChannel = backupChannels()[0]!;
    act(() => {
      firstChannel.deliver(
        JSON.stringify({ type: 'recording-finalized', sha256: 'wrong', totalBytes: 0 })
      );
    });
    await act(async () => {
      await flush();
    });
    expect(result.current.state.backupTransfers[0]?.status).toBe('failed');

    await act(async () => {
      result.current.sendBackups([backupFile()]);
      await flush();
    });
    expect(backupChannels().map((c) => c.label)).toEqual([
      `backup#${BACKUP}`,
      `backup#${BACKUP}`,
    ]);
  });

  it('cancels an unfinished send on leave, telling the host before the connection goes', async () => {
    const { result } = await joined('guest', [HOST]);
    await act(async () => {
      result.current.sendBackups([backupFile()]);
      await flush();
    });
    const channel = backupChannels()[0]!;
    await act(async () => {
      await result.current.leave();
      await flush();
    });
    expect(result.current.state.backupTransfers.map((t) => t.status)).toEqual(['failed']);
    expect(JSON.parse(channel.sent.at(-1) as string)).toEqual({
      type: 'stream-abandoned',
      recordingId: BACKUP,
      lastIdx: -1,
    });
    expect(channel.readyState).toBe('closed');
  });

  it('never creates a backup channel on a host tab, even with one queued', async () => {
    const { result } = await queuedBeforeJoining('host', [backupFile()], [GUEST]);
    expect(backupChannels()).toEqual([]);
    // The tab owns the take, so the backup it queued for a host is dropped.
    expect(result.current.state.backupTransfers).toEqual([]);
  });

  it('cancels a queued send when the room names this tab the host', async () => {
    const { result } = await joined('guest', [HOST]);
    await act(async () => {
      result.current.sendBackups([backupFile()]);
      await flush();
    });
    const channel = backupChannels()[0]!;
    expect(channel.readyState).toBe('open');

    await assigned(result, 'host', [GUEST]);

    expect(JSON.parse(channel.sent.at(-1) as string)).toEqual({
      type: 'stream-abandoned',
      recordingId: BACKUP,
      lastIdx: -1,
    });
    expect(channel.readyState).toBe('closed');
    expect(result.current.state.backupTransfers).toEqual([]);
  });

  it('never creates a backup channel on a host tab that hears of a host', async () => {
    const { result } = await queuedBeforeJoining('host', [backupFile()], []);
    act(() => {
      emitSignal('peer-joined', {
        type: 'peer-joined',
        peerId: 'p-host-2',
        ordinal: 1,
        role: 'host',
        displayName: 'Other',
      });
    });
    await act(async () => {
      await flush();
    });
    expect(backupChannels()).toEqual([]);
    expect(result.current.state.backupTransfers).toEqual([]);
  });

  it('cancels an unfinished send when the tab goes away', async () => {
    const { result, unmount } = await joined('guest', [HOST]);
    await act(async () => {
      result.current.sendBackups([backupFile()]);
      await flush();
    });
    const channel = backupChannels()[0]!;
    unmount();
    await act(async () => {
      await flush();
    });
    expect(JSON.parse(channel.sent.at(-1) as string)).toEqual({
      type: 'stream-abandoned',
      recordingId: BACKUP,
      lastIdx: -1,
    });
    expect(channel.readyState).toBe('closed');
  });

  it('leaves a waiting send alone on pagehide, which holds no file', async () => {
    const { result } = await joined('guest', [HOST]);
    await act(async () => {
      result.current.sendBackups([backupFile()]);
      await flush();
    });
    const channel = backupChannels()[0]!;
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await act(async () => {
      await flush();
    });
    expect(result.current.state.backupTransfers.map((t) => t.status)).toEqual(['offered']);
    expect(channel.readyState).toBe('open');
    expect(channel.sent).toHaveLength(1);
  });
});
