import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';
import { startGuestRecording, startHostRecording } from '@/hooks/recording-controller';

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
      cpuLimited: vi.fn().mockResolvedValue(false),
      setLowPower: vi.fn(),
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

describe('useRoom.readLoad', () => {
  beforeEach(() => {
    signalHandlers = {};
    peers = [];
    vi.stubGlobal('MediaStream', FakeStream);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("reads the running take's skipped audio", async () => {
    const { result } = await joinAs('host', []);
    act(() => {
      emit('peer-joined', { peerId: 'g1', ordinal: 2, role: 'guest', displayName: 'A' });
    });

    expect(await result.current.readLoad()).toEqual({ audioDroppedMs: 0, cpuLimited: false });

    vi.mocked(startHostRecording).mockResolvedValueOnce({
      recordingId: 'rec-host',
      hostStartMs: 0,
      hostPcm: { droppedMs: 120 },
    } as never);

    await act(async () => {
      await result.current.startRecording();
    });

    const load = await result.current.readLoad();
    expect(load.audioDroppedMs).toBe(120);
  });

  it("reads a guest's own recorder", async () => {
    const { result } = await joinAs('guest', [{ peerId: 'h', ordinal: 1, role: 'host' }]);

    vi.mocked(startGuestRecording).mockReturnValueOnce({
      recordingId: 'rec-guest',
      guestPcm: { droppedMs: 40 },
    } as never);

    await act(async () => {
      emit('recording-started', { from: 'host', recordingId: 'r1', kind: 'camera', filename: 'x.mp4' });
    });

    const load = await result.current.readLoad();
    expect(load.audioDroppedMs).toBe(40);
  });

  it('says limited when any connection is', async () => {
    const { result } = await joinAs('host', []);
    act(() => {
      emit('peer-joined', { peerId: 'g1', ordinal: 2, role: 'guest', displayName: 'A' });
      emit('peer-joined', { peerId: 'g2', ordinal: 3, role: 'guest', displayName: 'B' });
    });

    expect(peers).toHaveLength(2);
    expect((await result.current.readLoad()).cpuLimited).toBe(false);

    peers[1].cpuLimited.mockResolvedValue(true);
    expect((await result.current.readLoad()).cpuLimited).toBe(true);
  });

  it('is the same function on every render', async () => {
    const { result } = await joinAs('host', []);
    const first = result.current.readLoad;
    expect(first).toEqual(expect.any(Function));

    act(() => {
      emit('peer-joined', { peerId: 'g1', ordinal: 2, role: 'guest', displayName: 'A' });
    });

    expect(result.current.readLoad).toBe(first);
  });
});

describe('useRoom.setLowPower', () => {
  beforeEach(() => {
    signalHandlers = {};
    peers = [];
    vi.stubGlobal('MediaStream', FakeStream);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('turns low-power on and off for every connection and says so in state', async () => {
    const { result } = await joinAs('host', [
      { peerId: 'g1', ordinal: 2, role: 'guest' },
      { peerId: 'g2', ordinal: 3, role: 'guest' },
    ]);

    expect(peers).toHaveLength(2);
    expect(result.current.state.lowPower).toBe(false);

    act(() => {
      result.current.setLowPower(true);
    });

    expect(peers[0].setLowPower).toHaveBeenLastCalledWith(true);
    expect(peers[1].setLowPower).toHaveBeenLastCalledWith(true);
    expect(result.current.state.lowPower).toBe(true);

    act(() => {
      result.current.setLowPower(false);
    });

    expect(peers[0].setLowPower).toHaveBeenLastCalledWith(false);
    expect(peers[1].setLowPower).toHaveBeenLastCalledWith(false);
    expect(result.current.state.lowPower).toBe(false);
  });

  it('tells a connection that opens later, and only while the mode is on', async () => {
    const { result } = await joinAs('host', []);

    act(() => {
      emit('peer-joined', { peerId: 'g1', ordinal: 2, role: 'guest', displayName: 'A' });
    });

    expect(peers).toHaveLength(1);
    expect(peers[0].setLowPower).not.toHaveBeenCalled();

    act(() => {
      result.current.setLowPower(true);
    });

    act(() => {
      emit('peer-joined', { peerId: 'g2', ordinal: 3, role: 'guest', displayName: 'B' });
    });

    expect(peers).toHaveLength(2);
    expect(peers[1].setLowPower).toHaveBeenCalledWith(true);

    act(() => {
      result.current.newTake();
    });
    expect(result.current.state.lowPower).toBe(true);
    expect(peers[1].setLowPower).toHaveBeenLastCalledWith(true);

    act(() => {
      result.current.setLowPower(false);
    });

    act(() => {
      emit('peer-joined', { peerId: 'g3', ordinal: 4, role: 'guest', displayName: 'C' });
    });

    expect(peers).toHaveLength(3);
    expect(peers[2].setLowPower).not.toHaveBeenCalled();
  });
});
