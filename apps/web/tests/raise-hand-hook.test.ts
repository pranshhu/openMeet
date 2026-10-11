import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';

let signalHandlers: Record<string, ((m: any) => void)[]> = {};
let signalSent: any[] = [];

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
    send: vi.fn((m: any) => signalSent.push(m)),
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
    restartIce: vi.fn(),
    connectionState: 'new',
    rawConnection: null,
    setPeerCount: vi.fn(),
    whenConnected: vi.fn().mockResolvedValue(undefined),
  })),
}));

function emitSignal(type: string, payload: any) {
  for (const handler of signalHandlers[type] ?? []) handler({ type, ...payload });
}

function fakeStream(): MediaStream {
  const audio = { id: 'a1', kind: 'audio', enabled: true } as unknown as MediaStreamTrack;
  const video = { id: 'v1', kind: 'video', enabled: true } as unknown as MediaStreamTrack;
  return Object.assign(new EventTarget(), {
    getTracks: () => [audio, video],
    getAudioTracks: () => [audio],
    getVideoTracks: () => [video],
  }) as unknown as MediaStream;
}

/** A guest in a room with the people listed. */
async function joinRoom(others: { peerId: string; ordinal: number; role: string }[]) {
  const hook = renderHook(() => useRoom('xyz-test-room'));
  await act(async () => {
    await hook.result.current.join(fakeStream(), 'Me');
  });
  act(() => {
    emitSignal('role-assigned', {
      role: 'guest',
      peerId: 'me',
      ordinal: 9,
      peers: others.map((o) => ({ ...o, displayName: o.peerId })),
      recording: false,
    });
  });
  return hook;
}

const presences = () => signalSent.filter((m) => m.type === 'presence');
const here = { micOn: true, camOn: true, screenSharing: false };

describe('useRoom: raise hand', () => {
  beforeEach(() => {
    signalHandlers = {};
    signalSent = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('says a raised hand to the room and keeps it in state, and takes both back', async () => {
    const { result } = await joinRoom([{ peerId: 'h', ordinal: 1, role: 'host' }]);
    expect(result.current.state.handRaised).toBe(false);
    // What the room was told on joining: no field at all while the hand is down.
    expect(presences().length).toBeGreaterThan(0);
    expect(presences().at(-1)).not.toHaveProperty('handRaised');

    act(() => {
      result.current.setHandRaised(true);
    });
    expect(result.current.state.handRaised).toBe(true);
    expect(presences().at(-1)).toMatchObject({ type: 'presence', handRaised: true });

    act(() => {
      result.current.setHandRaised(false);
    });
    expect(result.current.state.handRaised).toBe(false);
    expect(presences().at(-1)).not.toHaveProperty('handRaised');
  });

  it('tells someone who joins later that the hand is up', async () => {
    const { result } = await joinRoom([{ peerId: 'h', ordinal: 1, role: 'host' }]);
    act(() => {
      result.current.setHandRaised(true);
    });
    const before = presences().length;

    act(() => {
      emitSignal('peer-joined', { peerId: 'g2', ordinal: 3, role: 'guest', displayName: 'B' });
    });
    expect(presences()).toHaveLength(before + 1);
    expect(presences().at(-1)).toMatchObject({ type: 'presence', handRaised: true });
  });

  it("marks another person's raised hand from their presence, and only a real true", async () => {
    const { result } = await joinRoom([
      { peerId: 'h', ordinal: 1, role: 'host' },
      { peerId: 'g2', ordinal: 3, role: 'guest' },
    ]);
    const hand = (peerId: string) =>
      result.current.state.remotePeers.find((p) => p.peerId === peerId)?.presence?.handRaised;

    act(() => {
      emitSignal('presence', { ...here, from: 'guest', fromPeerId: 'g2', handRaised: true });
    });
    expect(hand('g2')).toBe(true);
    expect(hand('h')).toBeUndefined();

    // Lowered: the next presence carries no field.
    act(() => {
      emitSignal('presence', { ...here, from: 'guest', fromPeerId: 'g2' });
    });
    expect(hand('g2')).toBeUndefined();
    expect(result.current.state.remotePeers.find((p) => p.peerId === 'g2')?.presence).toEqual(here);

    // The field is another participant's: anything but `true` is no hand.
    for (const junk of ['true', 1, {}, [], null, false]) {
      act(() => {
        emitSignal('presence', { ...here, from: 'host', fromPeerId: 'h', handRaised: junk });
      });
      expect(hand('h')).toBeUndefined();
    }
  });
});
