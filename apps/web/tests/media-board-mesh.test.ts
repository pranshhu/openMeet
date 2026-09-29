import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';
import { startGuestRecording, startHostRecording } from '@/hooks/recording-controller';
import { BackupRecorder } from '@/lib/backup-recorder';

let signalHandlers: Record<string, ((m: any) => void)[]> = {};
let peers: any[] = [];

const mixed = { id: 'board-mix', kind: 'audio' } as unknown as MediaStreamTrack;
const mic = { id: 'mic', kind: 'audio', enabled: true } as unknown as MediaStreamTrack;
const cam = { id: 'cam', kind: 'video', enabled: true } as unknown as MediaStreamTrack;

// jsdom has no MediaStream; this is just enough of one to hold tracks.
class FakeStream {
  constructor(private tracks: MediaStreamTrack[] = []) {}
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

vi.mock('@/lib/media-board', () => ({
  MediaBoard: vi.fn().mockImplementation(() => ({ outputTrack: mixed, close: vi.fn() })),
}));

vi.mock('@/lib/peer', () => ({
  PeerConnection: vi.fn().mockImplementation(() => {
    const channel = () => ({ readyState: 'open', addEventListener: vi.fn(), send: vi.fn(), close: vi.fn() });
    const p = {
      start: vi.fn(),
      close: vi.fn(),
      setLocalStream: vi.fn(),
      setLocalStreamAfterFirstOffer: vi.fn(),
      createControlChannel: vi.fn(),
      replaceAudioTrack: vi.fn(),
      addTransceiver: vi.fn(),
      restartIce: vi.fn(),
      connectionState: 'connected',
      rawConnection: null,
      setPeerCount: vi.fn(),
      whenConnected: vi.fn().mockResolvedValue(undefined),
      createRecordingChannel: vi.fn().mockImplementation(channel),
      createRecordingAudioChannel: vi.fn().mockImplementation(channel),
    };
    peers.push(p);
    return p;
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

vi.mock('@/hooks/recording-controller', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/recording-controller')>(
    '@/hooks/recording-controller'
  );
  return {
    ...actual,
    startHostRecording: vi.fn().mockResolvedValue({ recordingId: 'rec-host', hostStartMs: 0 }),
    startGuestRecording: vi.fn().mockReturnValue({ recordingId: 'rec-guest' }),
  };
});

function emit(type: string, payload: any) {
  for (const h of signalHandlers[type] ?? []) h({ type, ...payload });
}

const audioOf = (s: MediaStream) => s.getAudioTracks().map((t) => t.id);
const videoOf = (s: MediaStream) => s.getVideoTracks().map((t) => t.id);

async function joinAs(role: 'host' | 'guest', others: { peerId: string; ordinal: number; role: string }[]) {
  const hook = renderHook(() => useRoom('abc-defg-hij'));
  await act(async () => {
    await hook.result.current.join(new FakeStream([mic, cam]) as unknown as MediaStream, 'Me');
  });
  act(() => {
    emit('role-assigned', {
      role,
      peerId: 'me',
      ordinal: role === 'host' ? 1 : 9,
      peers: others.map((o) => ({ ...o, displayName: o.peerId })),
      recording: false,
    });
  });
  return hook;
}

describe('media board in a mesh call', () => {
  beforeEach(() => {
    signalHandlers = {};
    peers = [];
    vi.stubGlobal('MediaStream', FakeStream);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('sends the mix to every connected peer and to a peer who joins later', async () => {
    const { result } = await joinAs('host', []);
    act(() => {
      emit('peer-joined', { peerId: 'g1', ordinal: 2, role: 'guest', displayName: 'A' });
      emit('peer-joined', { peerId: 'g2', ordinal: 3, role: 'guest', displayName: 'B' });
    });

    act(() => {
      result.current.openMediaBoard();
    });
    expect(peers).toHaveLength(2);
    for (const p of peers) expect(p.replaceAudioTrack).toHaveBeenCalledWith(mixed);

    act(() => {
      emit('peer-joined', { peerId: 'g3', ordinal: 4, role: 'guest', displayName: 'C' });
    });
    const late = peers[2].setLocalStreamAfterFirstOffer.mock.calls[0][0] as MediaStream;
    expect(audioOf(late)).toEqual(['board-mix']);
    expect(videoOf(late)).toEqual(['cam']);
  });

  it("records the host's take from the mix while the board is open", async () => {
    const { result } = await joinAs('host', []);
    act(() => {
      emit('peer-joined', { peerId: 'g1', ordinal: 2, role: 'guest', displayName: 'A' });
    });
    act(() => {
      result.current.openMediaBoard();
    });

    await act(async () => {
      await result.current.startRecording();
    });

    const recorded = vi.mocked(startHostRecording).mock.calls[0]![0].localStream;
    expect(audioOf(recorded)).toEqual(['board-mix']);
    expect(videoOf(recorded)).toEqual(['cam']);
    // The WAV master stays mic-only.
    expect(audioOf(vi.mocked(startHostRecording).mock.calls[0]![0].micStream!)).toEqual(['mic']);
  });

  it("records a guest's take (and its backup) from the mix while the board is open", async () => {
    const { result } = await joinAs('guest', [{ peerId: 'h', ordinal: 1, role: 'host' }]);
    act(() => {
      result.current.openMediaBoard();
    });

    await act(async () => {
      emit('recording-started', { from: 'host', recordingId: 'r1', kind: 'camera', filename: 'x.mp4' });
    });

    const recorded = vi.mocked(startGuestRecording).mock.calls[0]![0].localStream;
    expect(audioOf(recorded)).toEqual(['board-mix']);
    expect(videoOf(recorded)).toEqual(['cam']);
    const backupStream = vi.mocked(BackupRecorder).mock.calls[0]![0].stream;
    expect(audioOf(backupStream!)).toEqual(['board-mix']);
    expect(audioOf(vi.mocked(startGuestRecording).mock.calls[0]![0].micStream!)).toEqual(['mic']);
  });

  it('records the raw mic when no board was opened', async () => {
    const { result } = await joinAs('host', []);
    act(() => {
      emit('peer-joined', { peerId: 'g1', ordinal: 2, role: 'guest', displayName: 'A' });
    });

    await act(async () => {
      await result.current.startRecording();
    });

    expect(audioOf(vi.mocked(startHostRecording).mock.calls[0]![0].localStream)).toEqual(['mic']);
  });
});
