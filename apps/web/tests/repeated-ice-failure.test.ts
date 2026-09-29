import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';

let signalHandlers: Record<string, ((m: any) => void)[]> = {};
let signalReconnectMock = vi.fn();
let lastPeerConnectionOpts: any = null;
let lastPeerInstance: any = null;

vi.mock('@/lib/api', () => ({
  getTurnCred: vi.fn().mockResolvedValue({
    urls: ['stun:stun.cloudflare.com:3478'],
    username: 'stub',
    credential: 'stub',
    ttl: 0,
  }),
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
    reconnect: signalReconnectMock,
    send: vi.fn(),
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
  PeerConnection: vi.fn().mockImplementation((opts) => {
    lastPeerConnectionOpts = opts;
    const instance = {
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
    };
    lastPeerInstance = instance;
    return instance;
  }),
}));

function emitSignal(type: string, payload: any) {
  for (const handler of signalHandlers[type] ?? []) {
    handler(payload);
  }
}

describe('repeated ICE failure recovery', () => {
  beforeEach(() => {
    signalHandlers = {};
    signalReconnectMock = vi.fn();
    lastPeerConnectionOpts = null;
    lastPeerInstance = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('triggers a full signalling reconnect on repeated ICE failure instead of staying dead', async () => {
    const { result } = renderHook(() => useRoom('xyz-test-room'));

    const fakeStream = {
      getTracks: () => [],
      getAudioTracks: () => [],
      getVideoTracks: () => [],
    } as unknown as MediaStream;

    let joinPromise: Promise<void>;
    act(() => {
      joinPromise = result.current.join(fakeStream, 'Guest Bob');
    });
    await act(async () => {
      await joinPromise;
    });

    act(() => {
      emitSignal('role-assigned', {
        type: 'role-assigned',
        role: 'guest',
        peerId: 'p-guest',
        ordinal: 2,
        peers: [{ peerId: 'p-host', ordinal: 1, role: 'host', displayName: 'Host' }],
        recording: false,
      });
    });

    expect(lastPeerConnectionOpts).not.toBeNull();

    // First ICE failure: attempts peer.restartIce()
    act(() => {
      lastPeerConnectionOpts.onConnectionStateChange('failed');
    });
    expect(lastPeerInstance.restartIce).toHaveBeenCalledTimes(1);
    expect(signalReconnectMock).not.toHaveBeenCalled();

    // Second ICE failure: must trigger a full signalling reconnect
    act(() => {
      lastPeerConnectionOpts.onConnectionStateChange('failed');
    });
    expect(signalReconnectMock).toHaveBeenCalledTimes(1);

    // The same pair fails twice again right away (e.g. no TURN): no second
    // rebuild inside the cooldown, or every healthy connection churns with it.
    act(() => {
      lastPeerConnectionOpts.onConnectionStateChange('connected');
      lastPeerConnectionOpts.onConnectionStateChange('failed');
      lastPeerConnectionOpts.onConnectionStateChange('failed');
    });
    expect(signalReconnectMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a STUN-only server', ['stun:stun.cloudflare.com:3478'], /this server has no relay \(TURN\)/],
    ['a server with a TURN relay', ['stun:stun.example.com', 'turn:turn.example.com:3478'], /A firewall on one of your networks/],
  ])('after the second failure, the warning fits %s', async (_, urls, expected) => {
    const api = await import('@/lib/api');
    vi.mocked(api.getTurnCred).mockResolvedValueOnce({ urls, username: 'u', credential: 'c', ttl: 60 });
    const { result } = renderHook(() => useRoom('xyz-test-room'));
    const fakeStream = { getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream;
    await act(async () => {
      await result.current.join(fakeStream, 'Guest Bob');
    });
    act(() => {
      emitSignal('role-assigned', {
        type: 'role-assigned',
        role: 'guest',
        peerId: 'p-guest',
        ordinal: 2,
        peers: [{ peerId: 'p-host', ordinal: 1, role: 'host', displayName: 'Host' }],
        recording: false,
      });
    });
    act(() => {
      lastPeerConnectionOpts.onConnectionStateChange('failed');
      lastPeerConnectionOpts.onConnectionStateChange('failed');
    });
    expect(result.current.state.connectionWarning).toMatch(expected);
  });
});
