import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';
import { startHostRecording, startScreenRecording } from '@/hooks/recording-controller';
import { pickRecordingDirectory } from '@/lib/fs-writer';
import { getScreenStream } from '@/lib/screen';

let signalHandlers: Record<string, ((m: any) => void)[]> = {};
let signalSent: any[] = [];

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
    send: vi.fn((m) => signalSent.push(m)),
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
  PeerConnection: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    close: vi.fn(),
    setLocalStream: vi.fn(),
    setLocalStreamAfterFirstOffer: vi.fn(),
    createControlChannel: vi.fn(),
    addTransceiver: vi.fn(),
    addTrack: vi.fn(),
    restartIce: vi.fn(),
    connectionState: 'connected',
    rawConnection: null,
    setPeerCount: vi.fn(),
    setLowPower: vi.fn(),
    setIncomingVideoOff: vi.fn(),
    whenConnected: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@/lib/recorder', async () => {
  const actual = await vi.importActual<typeof import('@/lib/recorder')>('@/lib/recorder');
  return { ...actual, pickRecordingMime: vi.fn().mockReturnValue('video/mp4') };
});

vi.mock('@/lib/fs-writer', async () => {
  const actual = await vi.importActual<typeof import('@/lib/fs-writer')>('@/lib/fs-writer');
  return { ...actual, pickRecordingDirectory: vi.fn() };
});

vi.mock('@/hooks/recording-controller', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/recording-controller')>(
    '@/hooks/recording-controller'
  );
  return {
    ...actual,
    startHostRecording: vi.fn().mockResolvedValue({ recordingId: 'rec-host', hostStartMs: 0 }),
    startScreenRecording: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@/lib/screen', async () => {
  const actual = await vi.importActual<typeof import('@/lib/screen')>('@/lib/screen');
  return { ...actual, getScreenStream: vi.fn() };
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

describe('a host records with nobody else in the room', () => {
  beforeEach(() => {
    signalHandlers = {};
    signalSent = [];
    vi.stubGlobal('MediaStream', FakeStream);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('starts the take and tells the Room', async () => {
    const { result } = await joinAs('host', []);
    expect(result.current.state.phase).toBe('waiting');

    await act(async () => {
      await result.current.startRecording();
    });

    expect(vi.mocked(startHostRecording)).toHaveBeenCalledTimes(1);
    expect(result.current.state.phase).toBe('recording');
    expect(signalSent).toContainEqual(expect.objectContaining({ type: 'recording-started', kind: 'camera' }));
  });

  it('counts down first, and the take stays up when a guest joins', async () => {
    vi.mocked(pickRecordingDirectory).mockResolvedValue({} as never);
    const { result } = await joinAs('host', []);
    vi.useFakeTimers();
    let done = Promise.resolve();
    await act(async () => {
      done = result.current.recordWithCountdown();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state.countdownEndsAt).toBe(Date.now() + 3000);
    expect(signalSent).toContainEqual({ type: 'recording-countdown', seconds: 3 });
    expect(vi.mocked(startHostRecording)).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      await done;
    });
    vi.useRealTimers();
    expect(result.current.state.phase).toBe('recording');
    expect(result.current.state.countdownEndsAt).toBeNull();

    act(() => {
      emit('peer-joined', { peerId: 'g1', ordinal: 2, role: 'guest', displayName: 'Bob' });
    });
    expect(result.current.state.phase).toBe('recording');
    expect(result.current.state.remotePeers.map((p) => p.name)).toEqual(['Bob']);
  });
});

describe('a host presents with nobody else in the room', () => {
  const screenTrack = { kind: 'video', readyState: 'live', addEventListener: vi.fn(), stop: vi.fn() };
  const screenStream = {
    getTracks: () => [screenTrack],
    getVideoTracks: () => [screenTrack],
  } as unknown as MediaStream;

  beforeEach(() => {
    signalHandlers = {};
    signalSent = [];
    vi.stubGlobal('MediaStream', FakeStream);
    vi.mocked(getScreenStream).mockResolvedValue(screenStream);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('records the screen it starts presenting during a take', async () => {
    const { result } = await joinAs('host', []);
    await act(async () => {
      await result.current.startRecording();
    });
    await act(async () => {
      await result.current.toggleScreenShare();
    });

    expect(result.current.state.screenSharing).toBe(true);
    expect(vi.mocked(startScreenRecording)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(startScreenRecording).mock.calls[0]!;
    expect(call[1]).toBe(screenStream);
    expect(call[2]).toBe('host');
    expect(call[3]).toBeNull();
  });

  it('records a screen it was already presenting when a take starts', async () => {
    const { result } = await joinAs('host', []);
    await act(async () => {
      await result.current.toggleScreenShare();
    });
    expect(result.current.state.screenSharing).toBe(true);
    expect(vi.mocked(startScreenRecording)).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.startRecording();
    });
    expect(vi.mocked(startScreenRecording)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startScreenRecording).mock.calls[0]![1]).toBe(screenStream);
  });

  it('lets a guest with no connection to the host present nothing', async () => {
    const { result } = await joinAs('guest', []);
    await act(async () => {
      await result.current.toggleScreenShare();
    });
    expect(vi.mocked(getScreenStream)).not.toHaveBeenCalled();
    expect(result.current.state.screenSharing).toBe(false);
  });
});
