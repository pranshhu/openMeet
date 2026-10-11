import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';
import { OWN_REACTION, REACTION_MIN_GAP_MS } from '@/lib/reactions';

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
  // Let anything the join started settle before a test looks at state.
  await act(async () => {});
  return hook;
}

const reactionsSent = () => signalSent.filter((m) => m.type === 'reaction');

describe('useRoom: reactions', () => {
  beforeEach(() => {
    signalHandlers = {};
    signalSent = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("takes another person's reaction for their tile, one a second from one sender", async () => {
    const { result } = await joinRoom([
      { peerId: 'h', ordinal: 1, role: 'host' },
      { peerId: 'g2', ordinal: 3, role: 'guest' },
    ]);
    const shown = (key: string) => result.current.state.reactions.get(key);
    expect(result.current.state.reactions.size).toBe(0);
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(10_000);
      act(() => {
        emitSignal('reaction', { reaction: 'clap', from: 'guest', fromPeerId: 'g2' });
      });
      expect(shown('g2')).toEqual({ reaction: 'clap', at: 10_000 });

      // Too soon after their last one: dropped, and the first one stays.
      now.mockReturnValue(10_000 + REACTION_MIN_GAP_MS - 1);
      act(() => {
        emitSignal('reaction', { reaction: 'heart', from: 'guest', fromPeerId: 'g2' });
      });
      expect(shown('g2')).toEqual({ reaction: 'clap', at: 10_000 });
      // Someone else is not held back by it.
      act(() => {
        emitSignal('reaction', { reaction: 'laugh', from: 'host', fromPeerId: 'h' });
      });
      expect(shown('h')).toEqual({ reaction: 'laugh', at: 10_000 + REACTION_MIN_GAP_MS - 1 });

      now.mockReturnValue(10_000 + REACTION_MIN_GAP_MS);
      act(() => {
        emitSignal('reaction', { reaction: 'heart', from: 'guest', fromPeerId: 'g2' });
      });
      expect(shown('g2')).toEqual({ reaction: 'heart', at: 10_000 + REACTION_MIN_GAP_MS });
      // What arrives is never sent back out.
      expect(reactionsSent()).toEqual([]);
    } finally {
      now.mockRestore();
    }
  });

  it('takes nothing that is not a known code from a sender with an id, and changes no state for it', async () => {
    const { result } = await joinRoom([{ peerId: 'g2', ordinal: 3, role: 'guest' }]);
    const before = result.current.state;

    act(() => {
      for (const reaction of ['party', '', 'CLAP', 7, null, undefined, {}, ['clap']]) {
        emitSignal('reaction', { reaction, from: 'guest', fromPeerId: 'g2' });
      }
      emitSignal('reaction', { reaction: 'clap', from: 'guest', fromPeerId: 42 });
      emitSignal('reaction', { reaction: 'clap', from: 'guest' });
    });

    // The same object: nothing was set, so nothing was drawn again.
    expect(result.current.state).toBe(before);
    expect(result.current.state.reactions.size).toBe(0);
  });

  it("shows this person's own reaction on their own tile and sends it, one a second", async () => {
    const { result } = await joinRoom([{ peerId: 'h', ordinal: 1, role: 'host' }]);
    const own = () => result.current.state.reactions.get(OWN_REACTION);
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(20_000);
      act(() => {
        result.current.sendReaction('thumbs-up');
      });
      expect(own()).toEqual({ reaction: 'thumbs-up', at: 20_000 });
      expect(reactionsSent()).toEqual([{ type: 'reaction', reaction: 'thumbs-up' }]);

      now.mockReturnValue(20_000 + REACTION_MIN_GAP_MS - 1);
      act(() => {
        result.current.sendReaction('clap');
      });
      expect(own()).toEqual({ reaction: 'thumbs-up', at: 20_000 });
      expect(reactionsSent()).toHaveLength(1);

      now.mockReturnValue(20_000 + REACTION_MIN_GAP_MS);
      act(() => {
        result.current.sendReaction('clap');
      });
      expect(own()).toEqual({ reaction: 'clap', at: 20_000 + REACTION_MIN_GAP_MS });
      expect(reactionsSent()).toEqual([
        { type: 'reaction', reaction: 'thumbs-up' },
        { type: 'reaction', reaction: 'clap' },
      ]);
    } finally {
      now.mockRestore();
    }
  });
});
