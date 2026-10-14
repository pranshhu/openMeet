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

let peerOpts: Record<string, any> = {};

vi.mock('@/lib/peer', () => ({
  PeerConnection: vi.fn().mockImplementation((opts: any) => {
    if (opts.remotePeerId) peerOpts[opts.remotePeerId] = opts;
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

const others = [
  { peerId: 'a', ordinal: 1, role: 'guest', displayName: 'Ana' },
  { peerId: 'b', ordinal: 2, role: 'guest', displayName: 'Bo' },
];

function roleAssigned() {
  emitSignal('role-assigned', { role: 'guest', peerId: 'me', ordinal: 9, peers: others, recording: false });
}

/** A guest in a room with two other people, `a` and `b`. */
async function joinRoom() {
  const hook = renderHook(() => useRoom('xyz-test-room'));
  await act(async () => {
    await hook.result.current.join(fakeStream(), 'Me');
  });
  act(roleAssigned);
  return hook;
}

const present = (peerId: string, stream: MediaStream) => act(() => peerOpts[peerId].onRemoteScreen(stream));
const ended = (peerId: string, stream: MediaStream) => act(() => peerOpts[peerId].onRemoteScreenEnded(stream));
const presence = (fromPeerId: unknown, screenSharing: boolean) =>
  act(() => emitSignal('presence', { from: 'guest', fromPeerId, micOn: true, camOn: true, screenSharing }));

describe('useRoom: two people present', () => {
  beforeEach(() => {
    signalHandlers = {};
    signalSent = [];
    peerOpts = {};
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows the screen of the one who started first and keeps both, oldest first', async () => {
    const { result } = await joinRoom();
    const sa = fakeStream();
    const sb = fakeStream();
    present('a', sa);
    present('b', sb);
    expect(result.current.state.remoteScreens.map((r) => r.peerId)).toEqual(['a', 'b']);
    expect(result.current.state.remoteScreens[0]?.stream).toBe(sa);
    expect(result.current.state.remoteScreens[1]?.stream).toBe(sb);
    expect(result.current.state.remoteScreenStream).toBe(sa);
  });

  it('starts with no screens', async () => {
    const { result } = await joinRoom();
    expect(result.current.state.remoteScreens).toEqual([]);
    expect(result.current.state.remoteScreenStream).toBeNull();
  });

  it('drops the sender of a presence that says it stopped, and nobody else', async () => {
    const first = await joinRoom();
    const sa = fakeStream();
    const sb = fakeStream();
    present('a', sa);
    present('b', sb);
    presence('a', false);
    expect(first.result.current.state.remoteScreenStream).toBe(sb);
    expect(first.result.current.state.remoteScreens.map((r) => r.peerId)).toEqual(['b']);

    signalHandlers = {};
    peerOpts = {};
    const second = await joinRoom();
    present('a', sa);
    present('b', sb);
    presence('b', false);
    expect(second.result.current.state.remoteScreenStream).toBe(sa);
    expect(second.result.current.state.remoteScreens.map((r) => r.peerId)).toEqual(['a']);
  });

  it('reads the stop of a presence as anything but a true', async () => {
    const { result } = await joinRoom();
    present('a', fakeStream());
    act(() => emitSignal('presence', { from: 'guest', fromPeerId: 'a', micOn: true, camOn: true, screenSharing: 'yes' }));
    expect(result.current.state.remoteScreens).toEqual([]);
  });

  it('keeps the screens when a presence that says it still presents arrives', async () => {
    const { result } = await joinRoom();
    const sa = fakeStream();
    present('a', sa);
    presence('a', true);
    expect(result.current.state.remoteScreenStream).toBe(sa);
  });

  it('drops nothing for a stopped presence with no usable sender id', async () => {
    const { result } = await joinRoom();
    const sa = fakeStream();
    present('a', sa);
    presence(undefined, false);
    presence(7, false);
    expect(result.current.state.remoteScreenStream).toBe(sa);
    expect(result.current.state.remoteScreens).toHaveLength(1);
  });

  it('shows the screen that is left when the first presenter leaves and the call goes on', async () => {
    const { result } = await joinRoom();
    const sa = fakeStream();
    const sb = fakeStream();
    present('a', sa);
    present('b', sb);
    act(() => emitSignal('peer-left', { peerId: 'a' }));
    expect(result.current.state.remoteScreenStream).toBe(sb);
    expect(result.current.state.remoteScreens.map((r) => r.peerId)).toEqual(['b']);
  });

  it('empties the list when the Room lists everyone again', async () => {
    const { result } = await joinRoom();
    present('a', fakeStream());
    present('b', fakeStream());
    act(roleAssigned);
    expect(result.current.state.remoteScreens).toEqual([]);
    expect(result.current.state.remoteScreenStream).toBeNull();
  });

  it('empties the list when the last other person leaves', async () => {
    const { result } = await joinRoom();
    present('b', fakeStream());
    act(() => emitSignal('peer-left', { peerId: 'a' }));
    expect(result.current.state.remoteScreens).toHaveLength(1);
    act(() => emitSignal('peer-left', { peerId: 'b' }));
    expect(result.current.state.remoteScreens).toEqual([]);
    expect(result.current.state.remoteScreenStream).toBeNull();
  });

  it('empties the list when the Room says everyone left without naming anyone', async () => {
    const { result } = await joinRoom();
    present('a', fakeStream());
    act(() => emitSignal('peer-left', {}));
    expect(result.current.state.remoteScreens).toEqual([]);
    expect(result.current.state.remoteScreenStream).toBeNull();
  });

  it('empties the list when this person leaves the call', async () => {
    const { result } = await joinRoom();
    present('a', fakeStream());
    await act(async () => {
      await result.current.leave();
    });
    expect(result.current.state.remoteScreens).toEqual([]);
    expect(result.current.state.remoteScreenStream).toBeNull();
  });

  it('keeps the newer screen when the end of an older one of the same person is reported', async () => {
    const { result } = await joinRoom();
    const s1 = fakeStream();
    const s2 = fakeStream();
    present('a', s1);
    present('a', s2);
    ended('a', s1);
    expect(result.current.state.remoteScreenStream).toBe(s2);
    ended('a', s2);
    expect(result.current.state.remoteScreenStream).toBeNull();
    expect(result.current.state.remoteScreens).toEqual([]);
  });

  it('leaves the state object as it is when the end of a screen nobody holds is reported', async () => {
    const { result } = await joinRoom();
    const before = result.current.state;
    ended('a', fakeStream());
    expect(result.current.state).toBe(before);
  });

  it('leaves the state object as it is when a person presents the stream they already hold', async () => {
    const { result } = await joinRoom();
    const sa = fakeStream();
    present('a', sa);
    const before = result.current.state;
    present('a', sa);
    expect(result.current.state).toBe(before);
  });
});
