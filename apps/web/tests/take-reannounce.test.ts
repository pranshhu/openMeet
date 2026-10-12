import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';
import { endHostRecording } from '@/hooks/recording-controller';

let signalHandlers: Record<string, ((m: any) => void)[]> = {};
let signalSent: any[] = [];

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
  PeerConnection: vi.fn().mockImplementation(() => {
    const channel = () => ({ readyState: 'open', addEventListener: vi.fn(), send: vi.fn(), close: vi.fn() });
    return {
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
      createRecordingChannel: vi.fn().mockImplementation(channel),
      createRecordingAudioChannel: vi.fn().mockImplementation(channel),
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

vi.mock('@/hooks/recording-controller', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/recording-controller')>(
    '@/hooks/recording-controller'
  );
  return {
    ...actual,
    startHostRecording: vi.fn().mockResolvedValue({ recordingId: 'rec-host', hostStartMs: 0 }),
    endHostRecording: vi.fn().mockResolvedValue({ backup: null }),
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

const GUEST = { peerId: 'g1', ordinal: 2, role: 'guest' };

/** The Room's answer to a join, as a host whose socket came back gets it. */
const hostIsBack = (recording: boolean) => ({
  role: 'host',
  peerId: 'me-again',
  ordinal: 7,
  peers: [{ ...GUEST, displayName: 'g1' }],
  recording,
});

const announced = () => signalSent.filter((m) => m.type === 'recording-started');

/** A host with one guest and a take running; what it has sent so far is forgotten. */
async function recordingHost() {
  const hook = await joinAs('host', [GUEST]);
  await act(async () => {
    await hook.result.current.startRecording();
  });
  expect(hook.result.current.state.phase).toBe('recording');
  signalSent = [];
  return hook;
}

describe('a take the Room has forgotten', () => {
  beforeEach(() => {
    signalHandlers = {};
    signalSent = [];
    vi.stubGlobal('MediaStream', FakeStream);
    globalThis.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('is announced again by its host, under the same id', async () => {
    const { result } = await recordingHost();
    act(() => emit('role-assigned', hostIsBack(false)));

    expect(announced()).toEqual([
      { type: 'recording-started', recordingId: 'rec-host', kind: 'camera', filename: 'host_rec-host.mp4' },
    ]);
    expect(result.current.state.phase).toBe('recording');
  });

  it('is not announced again while the Room still holds it', async () => {
    await recordingHost();
    act(() => emit('role-assigned', hostIsBack(true)));
    expect(announced()).toEqual([]);
  });

  it('is not announced by a host with no take running', async () => {
    await joinAs('host', [GUEST]);
    signalSent = [];
    act(() => emit('role-assigned', hostIsBack(false)));
    expect(announced()).toEqual([]);
  });

  it('is not announced while it is being saved', async () => {
    let finish: (v: { backup: null }) => void = () => {};
    vi.mocked(endHostRecording).mockReturnValueOnce(
      new Promise<{ backup: null }>((resolve) => {
        finish = resolve;
      })
    );
    const { result } = await recordingHost();
    let ending = Promise.resolve();
    await act(async () => {
      ending = result.current.endRecording();
      await Promise.resolve();
    });
    signalSent = [];

    act(() => emit('role-assigned', hostIsBack(false)));
    expect(announced()).toEqual([]);

    await act(async () => {
      finish({ backup: null });
      await ending;
    });
    expect(result.current.state.phase).toBe('done');
  });

  it('is never announced by a guest whose own connection came back', async () => {
    const { result } = await joinAs('guest', [{ peerId: 'h', ordinal: 1, role: 'host' }]);
    await act(async () => {
      emit('recording-started', { from: 'host', recordingId: 'r1', kind: 'camera', filename: 'x.mp4' });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.state.phase).toBe('recording');
    signalSent = [];

    act(() =>
      emit('role-assigned', {
        role: 'guest',
        peerId: 'me-again',
        ordinal: 9,
        peers: [{ peerId: 'h2', ordinal: 1, role: 'host', displayName: 'h2' }],
        recording: false,
      })
    );
    expect(announced()).toEqual([]);
  });
});
