import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';

let signalHandlers: Record<string, ((m: any) => void)[]> = {};
let signalSent: any[] = [];
let signalClientConstructed = false;
let peerConnectionConstructed = false;
let lastPeerConnectionOpts: any = null;

vi.mock('@/lib/api', () => ({
  getTurnCred: vi.fn(),
  getRoom: vi.fn().mockResolvedValue({ slug: 'test-room', expires_at: Date.now() + 10000 }),
  patchRecording: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/host-token', () => ({
  getHostToken: vi.fn().mockReturnValue(null),
}));

vi.mock('@/lib/signal', () => ({
  SignalClient: vi.fn().mockImplementation((opts) => {
    signalClientConstructed = true;
    return {
      connect: vi.fn(),
      close: vi.fn(),
      send: vi.fn((m) => signalSent.push(m)),
      on: vi.fn((type: string, handler: (m: any) => void) => {
        (signalHandlers[type] ??= []).push(handler);
      }),
    };
  }),
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
    peerConnectionConstructed = true;
    lastPeerConnectionOpts = opts;
    return {
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
  }),
}));

function emitSignal(type: string, payload: any) {
  for (const handler of signalHandlers[type] ?? []) {
    handler(payload);
  }
}

describe('room joining flow', () => {
  beforeEach(async () => {
    signalHandlers = {};
    signalSent = [];
    signalClientConstructed = false;
    peerConnectionConstructed = false;
    lastPeerConnectionOpts = null;
    const api = await import('@/lib/api');
    vi.mocked(api.getTurnCred).mockReset();
    vi.mocked(api.getTurnCred).mockResolvedValue({
      urls: ['turn:turn.example.com:3478'],
      username: 'user',
      credential: 'secret',
      ttl: 600,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('joins with disabled audio track: micOn is false in presence after role-assigned and on peer-joined', async () => {
    const { result } = renderHook(() => useRoom('xyz-test-room'));

    const disabledAudioTrack = { id: 'a1', kind: 'audio', enabled: false } as unknown as MediaStreamTrack;
    const enabledVideoTrack = { id: 'v1', kind: 'video', enabled: true } as unknown as MediaStreamTrack;
    const fakeStream = {
      getTracks: () => [disabledAudioTrack, enabledVideoTrack],
      getAudioTracks: () => [disabledAudioTrack],
      getVideoTracks: () => [enabledVideoTrack],
    } as unknown as MediaStream;

    let joinPromise: Promise<void>;
    act(() => {
      joinPromise = result.current.join(fakeStream, 'Guest Alice');
    });

    // Before role-assigned, phase must not be 'waiting' (it is in a neutral joining state)
    expect(result.current.state.phase).not.toBe('waiting');
    expect(result.current.state.phase).toBe('connecting');

    await act(async () => {
      await joinPromise;
    });

    // Deliver role-assigned with existing peer
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

    // Phase stays 'connecting' since peer is present (never flashed 'waiting')
    expect(result.current.state.phase).toBe('connecting');

    // Presence must have been sent with micOn: false, camOn: true
    const presenceMessages = signalSent.filter((m) => m.type === 'presence');
    expect(presenceMessages.length).toBeGreaterThanOrEqual(1);
    expect(presenceMessages[0]).toEqual({
      type: 'presence',
      micOn: false,
      camOn: true,
      screenSharing: false,
    });

    // Another peer joins
    act(() => {
      emitSignal('peer-joined', {
        type: 'peer-joined',
        peerId: 'p-guest-2',
        displayName: 'Guest 2',
        ordinal: 3,
        role: 'guest',
      });
    });

    // Presence sent again on peer-joined with micOn: false
    const presenceAfterPeerJoined = signalSent.filter((m) => m.type === 'presence');
    expect(presenceAfterPeerJoined.length).toBeGreaterThanOrEqual(2);
    expect(presenceAfterPeerJoined[presenceAfterPeerJoined.length - 1]).toEqual({
      type: 'presence',
      micOn: false,
      camOn: true,
      screenSharing: false,
    });
  });

  it('moves to waiting phase on role-assigned only when alone in the room', async () => {
    const { result } = renderHook(() => useRoom('xyz-test-room'));

    const fakeStream = {
      getTracks: () => [],
      getAudioTracks: () => [],
      getVideoTracks: () => [],
    } as unknown as MediaStream;

    await act(async () => {
      await result.current.join(fakeStream, 'Host Alice');
    });

    // Before role-assigned: connecting, not waiting
    expect(result.current.state.phase).toBe('connecting');

    // Deliver role-assigned with no peers
    act(() => {
      emitSignal('role-assigned', {
        type: 'role-assigned',
        role: 'host',
        peerId: 'p-host',
        ordinal: 1,
        peers: [],
        recording: false,
      });
    });

    // Now phase moves to 'waiting'
    expect(result.current.state.phase).toBe('waiting');
  });

  it('falls back to STUN stub when getTurnCred rejects, logging error and connecting WS', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const api = await import('@/lib/api');
    vi.mocked(api.getTurnCred).mockRejectedValue(new Error('getTurnCred failed: 429'));

    const { result } = renderHook(() => useRoom('xyz-test-room'));

    const fakeStream = {
      getTracks: () => [],
      getAudioTracks: () => [],
      getVideoTracks: () => [],
    } as unknown as MediaStream;

    await act(async () => {
      await result.current.join(fakeStream, 'Alice');
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'turn:cred_failed',
      expect.any(Error)
    );

    // SignalClient was constructed and phase is connecting
    expect(signalClientConstructed).toBe(true);
    expect(result.current.state.phase).toBe('connecting');

    // Deliver role-assigned to verify peer creation uses stub ICE servers
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

    expect(peerConnectionConstructed).toBe(true);
    expect(lastPeerConnectionOpts.iceServers).toEqual([
      { urls: ['stun:stun.cloudflare.com:3478'] },
    ]);
  });
});
