import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';
import { PeerConnection } from '@/lib/peer';

let signalHandlers: Record<string, ((m: any) => void)[]> = {};

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

function emit(type: string, payload: any) {
  for (const h of signalHandlers[type] ?? []) h({ type, ...payload });
}

async function joined() {
  const hook = renderHook(() => useRoom('abc-defg-hij'));
  await act(async () => {
    await hook.result.current.join(new FakeStream([mic, cam]) as unknown as MediaStream, 'Me');
  });
  return hook;
}

/** What each connection was built with, keyed by the peer it is to. */
function builtWith() {
  const seen: Record<string, boolean | undefined> = {};
  for (const [opts] of vi.mocked(PeerConnection).mock.calls) {
    seen[opts.remotePeerId!] = opts.audioOnly;
  }
  return seen;
}

describe('a connection to a seat the Room admitted as microphone only', () => {
  beforeEach(() => {
    signalHandlers = {};
    vi.stubGlobal('MediaStream', FakeStream);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('is built with audioOnly for exactly the role-assigned entries that carry true', async () => {
    const { result } = await joined();
    act(() => {
      emit('role-assigned', {
        role: 'guest',
        peerId: 'me',
        ordinal: 9,
        recording: false,
        peers: [
          { peerId: 'mic-seat', ordinal: 1, role: 'guest', displayName: 'A', audioOnly: true },
          { peerId: 'cam-seat', ordinal: 2, role: 'guest', displayName: 'B' },
          { peerId: 'string-seat', ordinal: 3, role: 'guest', displayName: 'C', audioOnly: 'true' },
        ],
      });
    });
    expect(builtWith()).toEqual({ 'mic-seat': true, 'cam-seat': false, 'string-seat': false });
    expect(result.current.state.remotePeers.map((p) => [p.peerId, p.audioOnly])).toEqual([
      ['mic-seat', true],
      ['cam-seat', false],
      ['string-seat', false],
    ]);
  });

  it.each([
    ['true', true, true],
    ['missing', undefined, false],
    ['the string "true"', 'true', false],
  ])('is built from a peer-joined with audioOnly %s', async (_label, value, expected) => {
    const { result } = await joined();
    act(() => {
      emit('role-assigned', { role: 'guest', peerId: 'me', ordinal: 9, recording: false, peers: [] });
    });
    act(() => {
      emit('peer-joined', {
        role: 'guest',
        peerId: 'newcomer',
        ordinal: 4,
        displayName: 'N',
        userAgent: 'ua',
        ...(value === undefined ? {} : { audioOnly: value }),
      });
    });
    expect(builtWith()).toEqual({ newcomer: expected });
    expect(result.current.state.remotePeers.find((p) => p.peerId === 'newcomer')?.audioOnly).toBe(expected);
  });

  it('marks a person whose presence arrived before their peer-joined', async () => {
    const { result } = await joined();
    act(() => {
      emit('role-assigned', { role: 'guest', peerId: 'me', ordinal: 9, recording: false, peers: [] });
    });
    act(() => {
      emit('presence', { fromPeerId: 'early', fromName: 'E', micOn: true, camOn: true, screenSharing: false });
    });
    expect(result.current.state.remotePeers.find((p) => p.peerId === 'early')?.audioOnly).toBeUndefined();
    act(() => {
      emit('peer-joined', { role: 'guest', peerId: 'early', ordinal: 4, displayName: 'E', userAgent: 'ua', audioOnly: true });
    });
    expect(result.current.state.remotePeers.find((p) => p.peerId === 'early')?.audioOnly).toBe(true);
  });
});
