import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';
import { endHostRecording, resumeHostRecording } from '@/hooks/recording-controller';
import { PeerConnection } from '@/lib/peer';
import { buildSyncReport } from '@/lib/sync-report';
import { findTakeJournals, type TakeJournal } from '@/lib/take-journal';

let signalHandlers: Record<string, ((m: any) => void)[]> = {};
// What Date.now() answers, so every time in the record is a known number.
let clock = 0;

const mic = { id: 'mic', kind: 'audio', enabled: true } as unknown as MediaStreamTrack;
const cam = { id: 'cam', kind: 'video', enabled: true } as unknown as MediaStreamTrack;

// jsdom has no MediaStream; this is just enough of one to hold tracks.
class FakeStream extends EventTarget {
  constructor(private tracks: MediaStreamTrack[] = []) {
    super();
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
}

vi.mock('@/lib/api', () => ({
  getTurnCred: vi.fn().mockResolvedValue({ urls: [], username: 'stub', credential: 'stub', ttl: 0 }),
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
    send: vi.fn(),
    on: vi.fn((type: string, handler: (m: any) => void) => {
      (signalHandlers[type] ??= []).push(handler);
    }),
  })),
}));

vi.mock('@/lib/media', () => ({
  MediaManager: vi.fn().mockImplementation(() => ({
    adopt: vi.fn(),
    stop: vi.fn(),
    setAudioEnabled: vi.fn(),
    setVideoEnabled: vi.fn(),
  })),
}));

vi.mock('@/lib/peer', () => ({
  PeerConnection: vi.fn().mockImplementation(() => {
    const channel = () => ({ readyState: 'open', addEventListener: vi.fn(), send: vi.fn(), close: vi.fn() });
    return {
      start: vi.fn(),
      close: vi.fn(),
      setLocalStream: vi.fn(),
      setLocalStreamAfterFirstOffer: vi.fn(),
      createControlChannel: vi.fn(),
      replaceAudioTrack: vi.fn(),
      addTransceiver: vi.fn(),
      addTrack: vi.fn(),
      restartIce: vi.fn(),
      connectionState: 'connected',
      rawConnection: null,
      setPeerCount: vi.fn(),
      whenConnected: vi.fn().mockResolvedValue(undefined),
      createRecordingChannel: vi.fn().mockImplementation(channel),
      createRecordingAudioChannel: vi.fn().mockImplementation(channel),
      cpuLimited: vi.fn().mockResolvedValue(false),
      setLowPower: vi.fn(),
      setIncomingVideoOff: vi.fn(),
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
    BackupRecorder: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn().mockResolvedValue(null) })),
  };
});

// The host's join looks for a crash copy of the room's last take. A test that needs one sets it.
vi.mock('@/lib/take-journal', async () => {
  const actual = await vi.importActual<typeof import('@/lib/take-journal')>('@/lib/take-journal');
  return { ...actual, findTakeJournals: vi.fn().mockResolvedValue([]) };
});

vi.mock('@/lib/take-lock', () => ({
  isTakeLockHeld: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/hooks/recording-controller', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/recording-controller')>(
    '@/hooks/recording-controller'
  );
  return {
    ...actual,
    // A new object for every take: the hook keeps state on the handles.
    startHostRecording: vi.fn().mockImplementation(async () => ({ recordingId: 'rec-host', hostStartMs: 1_000_000 })),
    endHostRecording: vi.fn().mockResolvedValue({ backup: null }),
    resumeHostRecording: vi.fn(),
    bindHostGuestChannel: vi.fn().mockResolvedValue(undefined),
    bindHostAudioChannel: vi.fn().mockResolvedValue(undefined),
    bindHostScreenChannel: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@/lib/sync-report', async () => {
  const actual = await vi.importActual<typeof import('@/lib/sync-report')>('@/lib/sync-report');
  return { ...actual, buildSyncReport: vi.fn(actual.buildSyncReport) };
});

function emit(type: string, payload: any) {
  for (const h of signalHandlers[type] ?? []) h({ type, ...payload });
}

const ROOM = [
  { peerId: 'p-bob', ordinal: 2, role: 'guest', displayName: 'Bob' },
  { peerId: 'p-pat', ordinal: 3, role: 'producer', displayName: 'Pat' },
  { peerId: 'p-cam', ordinal: 4, role: 'guest', displayName: 'Cam', companion: true },
  { peerId: 'p-nora', ordinal: 5, role: 'guest', displayName: 'Nora', notRecorded: true },
];

/** A host in the room with `peers`, the lookups its join starts already answered. */
async function hostIn(peers: typeof ROOM = ROOM) {
  const { result } = renderHook(() => useRoom('abc-defg-hij'));
  await act(async () => {
    await result.current.join(new FakeStream([mic, cam]) as unknown as MediaStream, 'Hana');
  });
  await act(async () => {
    emit('role-assigned', { role: 'host', peerId: 'p-host', ordinal: 1, peers, recording: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return result;
}

/** Hand the hook a channel with this label, as if it arrived from `peerId`. */
function channelFrom(peerId: string, label: string) {
  const channel = Object.assign(new EventTarget(), { label, readyState: 'open', send: vi.fn(), close: vi.fn() });
  act(() => {
    vi.mocked(PeerConnection)
      .mock.calls.map(([options]) => options)
      .reverse()
      .find((options) => options.remotePeerId === peerId)!
      .onDataChannel!(channel as unknown as RTCDataChannel);
  });
}

/** The recordingNotice section of the last sync file the hook built. */
const lastNotice = () =>
  JSON.parse((vi.mocked(buildSyncReport).mock.results.at(-1)!.value as { json: string }).json).recordingNotice;

describe('the record of who was told, in a take', () => {
  let nowSpy: { mockRestore(): void };

  beforeEach(() => {
    signalHandlers = {};
    clock = 999_000;
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    vi.stubGlobal('MediaStream', FakeStream);
    globalThis.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    nowSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    // clearAllMocks keeps what a mock answers, and the next join must find no crash copy.
    vi.mocked(findTakeJournals).mockResolvedValue([]);
    vi.mocked(resumeHostRecording).mockReset();
  });

  it('writes who the room held at the announcement, who joined later and whose channel arrived into the sync file', async () => {
    const result = await hostIn();
    clock = 1_000_040;
    await act(async () => {
      await result.current.startRecording();
    });
    expect(result.current.state.phase).toBe('recording');

    clock = 1_000_400;
    channelFrom('p-bob', 'recording#K1');
    clock = 1_000_700;
    channelFrom('p-cam', 'recording-screen-1');
    // Closed before anything is opened for it, so it confirms nothing.
    channelFrom('p-nora', 'recording#K9');

    clock = 1_060_000;
    await act(async () => {
      emit('peer-joined', { peerId: 'p-dee', ordinal: 6, role: 'guest', displayName: 'Dee', userAgent: 'x' });
    });
    // The audio master's channel is not the proof; the camera's is.
    channelFrom('p-dee', 'recording-audio#K7');

    clock = 1_090_000;
    await act(async () => {
      await result.current.endRecording();
    });
    expect(result.current.state.phase).toBe('done');

    const notice = lastNotice();
    expect(notice.announcedAtMs).toBe(40);
    expect(notice.people).toEqual([
      { name: 'Bob', role: 'guest', listedAtMs: 40, confirmedAtMs: 400 },
      { name: 'Pat', role: 'producer', listedAtMs: 40, confirmedAtMs: null },
      { name: 'Cam', role: 'guest', presentOnly: true, listedAtMs: 40, confirmedAtMs: 700 },
      { name: null, role: 'guest', setAsNotRecorded: true, listedAtMs: 40, confirmedAtMs: null },
      { name: 'Dee', role: 'guest', listedAtMs: 60_000, confirmedAtMs: null },
    ]);
  });

  it('starts the record again with each take', async () => {
    const result = await hostIn([ROOM[0]!]);
    clock = 1_000_040;
    await act(async () => {
      await result.current.startRecording();
    });
    clock = 1_000_400;
    channelFrom('p-bob', 'recording#K1');
    await act(async () => {
      await result.current.endRecording();
    });
    expect(lastNotice().people).toEqual([{ name: 'Bob', role: 'guest', listedAtMs: 40, confirmedAtMs: 400 }]);

    act(() => {
      result.current.newTake();
    });
    clock = 1_000_900;
    await act(async () => {
      await result.current.startRecording();
    });
    await act(async () => {
      await result.current.endRecording();
    });

    const notice = lastNotice();
    expect(notice.announcedAtMs).toBe(900);
    expect(notice.people).toEqual([{ name: 'Bob', role: 'guest', listedAtMs: 900, confirmedAtMs: null }]);
  });

  it('gives a take resumed in this page no record from before the resume, also after a save that failed', async () => {
    const result = await hostIn([ROOM[0]!]);
    clock = 1_000_040;
    await act(async () => {
      await result.current.startRecording();
    });
    clock = 1_000_400;
    channelFrom('p-bob', 'recording#K1');
    // A full disk: the files do not close, no sync file is built and the
    // take's crash copy stays in browser storage.
    vi.mocked(endHostRecording).mockRejectedValueOnce(new Error('disk full'));
    await act(async () => {
      await result.current.endRecording();
    });
    expect(result.current.state.phase).toBe('done');
    expect(buildSyncReport).not.toHaveBeenCalled();

    // The Room hands out roles again (a reconnect), the page offers that take
    // and the host resumes it.
    const interrupted = {
      dirName: 'openmeet-take-1',
      notes: {
        room: 'abc-defg-hij',
        recordingId: 'rec-host',
        take: 1,
        hostStartMs: 1_000_000,
        files: [],
        backups: [],
        markers: [],
      },
      notesOk: true,
      dead: false,
      bytes: 0,
    } as unknown as TakeJournal;
    vi.mocked(findTakeJournals).mockResolvedValue([interrupted]);
    vi.mocked(resumeHostRecording).mockResolvedValue({
      recordingId: 'rec-host',
      take: 1,
      hostStartMs: 1_000_000,
    } as never);
    await act(async () => {
      emit('role-assigned', { role: 'host', peerId: 'p-host', ordinal: 1, peers: [ROOM[0]!], recording: false });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.state.resumeOffer).not.toBeNull();

    clock = 1_200_000;
    await act(async () => {
      await result.current.resumeRecording();
    });
    expect(result.current.state.phase).toBe('recording');
    await act(async () => {
      await result.current.endRecording();
    });

    expect(lastNotice()).toBeUndefined();
  });
});
