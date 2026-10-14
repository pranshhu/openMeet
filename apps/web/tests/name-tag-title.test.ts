import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom, applyRemotePeerPresence, type RemotePeer } from '@/hooks/useRoom';
import { chooseTitle } from '@/lib/name-tag';

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

const titleOf = (result: { current: ReturnType<typeof useRoom> }, peerId: string) =>
  result.current.state.remotePeers.find((p) => p.peerId === peerId)?.title;

describe('useRoom: a title under the name', () => {
  beforeEach(() => {
    signalHandlers = {};
    signalSent = [];
  });

  afterEach(() => {
    chooseTitle('');
    vi.clearAllMocks();
  });

  it('sends the title the lobby chose with presence, and no field when there is none', async () => {
    chooseTitle('Founder');
    const first = await joinRoom([{ peerId: 'h', ordinal: 1, role: 'host' }]);
    expect(presences().length).toBeGreaterThan(0);
    expect(presences().at(-1)).toMatchObject({ type: 'presence', title: 'Founder' });
    first.unmount();

    signalSent = [];
    chooseTitle('');
    await joinRoom([{ peerId: 'h', ordinal: 1, role: 'host' }]);
    expect(presences().length).toBeGreaterThan(0);
    for (const m of presences()) expect(m).not.toHaveProperty('title');
  });

  it('tells someone who joins later', async () => {
    chooseTitle('Founder');
    await joinRoom([{ peerId: 'h', ordinal: 1, role: 'host' }]);
    const before = presences().length;
    act(() => {
      emitSignal('peer-joined', { peerId: 'g2', ordinal: 3, role: 'guest', displayName: 'B' });
    });
    expect(presences()).toHaveLength(before + 1);
    expect(presences().at(-1)).toMatchObject({ title: 'Founder' });
  });

  it("keeps another person's title from their presence, and only a usable one", async () => {
    const { result } = await joinRoom([
      { peerId: 'h', ordinal: 1, role: 'host' },
      { peerId: 'g2', ordinal: 3, role: 'guest' },
    ]);

    act(() => {
      emitSignal('presence', { ...here, from: 'guest', fromPeerId: 'g2', title: 'Founder, Acme' });
    });
    expect(titleOf(result, 'g2')).toBe('Founder, Acme');
    expect(titleOf(result, 'h')).toBeUndefined();

    const junk = ['x'.repeat(61), 7, {}, ['x'], null, '   '];
    for (const title of junk) {
      act(() => {
        emitSignal('presence', { ...here, from: 'host', fromPeerId: 'h', title });
      });
      expect(titleOf(result, 'h')).toBeUndefined();
    }
  });
});

describe('applyRemotePeerPresence: a title', () => {
  const peer = (extra: Partial<RemotePeer> = {}): RemotePeer => ({ peerId: 'p', name: 'P', stream: null, ...extra });

  it('takes the trimmed title for a peer that exists and for one it adds', () => {
    expect(applyRemotePeerPresence([peer()], { ...here, fromPeerId: 'p', title: ' Founder ' })[0]?.title).toBe('Founder');
    expect(applyRemotePeerPresence([], { ...here, fromPeerId: 'n', title: 'Founder' })[0]?.title).toBe('Founder');
  });

  it('removes the title when a later presence has none or a bad one', () => {
    const titled = [peer({ title: 'Founder' })];
    expect(applyRemotePeerPresence(titled, { ...here, fromPeerId: 'p' })[0]?.title).toBeUndefined();
    expect(applyRemotePeerPresence(titled, { ...here, fromPeerId: 'p', title: 'x'.repeat(61) })[0]?.title).toBeUndefined();
  });
});
