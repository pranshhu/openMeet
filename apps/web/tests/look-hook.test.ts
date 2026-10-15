import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';
import { saveLook } from '@/lib/look';

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

const SLUG = 'xyz-test-room';

/** A tab in a room with the people listed, in the given role. */
async function joinRoom(role: 'host' | 'guest', others: { peerId: string; ordinal: number; role: string }[]) {
  const hook = renderHook(() => useRoom(SLUG));
  await act(async () => {
    await hook.result.current.join(fakeStream(), 'Me');
  });
  act(() => {
    emitSignal('role-assigned', {
      role,
      peerId: 'me',
      ordinal: role === 'host' ? 1 : 9,
      peers: others.map((o) => ({ ...o, displayName: o.peerId })),
      recording: false,
    });
  });
  return hook;
}

const looks = () => signalSent.filter((m) => m.type === 'look');
const joined = { peerId: 'g2', ordinal: 3, role: 'guest', displayName: 'B' };

describe('useRoom: the look of the show', () => {
  beforeEach(() => {
    signalHandlers = {};
    signalSent = [];
    localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sends the host look on joining and to each person who joins later, and holds it', async () => {
    saveLook(SLUG, { accent: 'red' });
    const { result } = await joinRoom('host', []);
    expect(looks()).toEqual([{ type: 'look', accent: 'red' }]);
    expect(result.current.state.look).toEqual({ accent: 'red' });

    act(() => {
      emitSignal('peer-joined', joined);
    });
    expect(looks()).toEqual([
      { type: 'look', accent: 'red' },
      { type: 'look', accent: 'red' },
    ]);
  });

  it('sends the plain look when the host has none, so a taken-away look is taken away', async () => {
    saveLook(SLUG, {});
    const { result } = await joinRoom('host', []);
    expect(looks()).toEqual([{ type: 'look' }]);
    expect(result.current.state.look).toEqual({});

    act(() => {
      emitSignal('peer-joined', joined);
    });
    expect(looks()).toEqual([{ type: 'look' }, { type: 'look' }]);
  });

  it('sends no look from a guest, and holds the one the host sends', async () => {
    saveLook(SLUG, { accent: 'blue' });
    const { result } = await joinRoom('guest', [{ peerId: 'h', ordinal: 1, role: 'host' }]);
    expect(result.current.state.look).toEqual({});

    act(() => {
      emitSignal('look', { accent: 'green' });
    });
    expect(result.current.state.look).toEqual({ accent: 'green' });

    act(() => {
      emitSignal('peer-joined', joined);
    });
    expect(looks()).toEqual([]);

    // The plain look takes the colour away.
    act(() => {
      emitSignal('look', {});
    });
    expect(result.current.state.look).toEqual({});
  });

  it('takes only an accent on the list from an incoming look', async () => {
    const { result } = await joinRoom('guest', [{ peerId: 'h', ordinal: 1, role: 'host' }]);
    act(() => {
      emitSignal('look', { accent: 'pink' });
    });
    for (const junk of ['url(x)', 7, null, {}, ['pink']]) {
      act(() => {
        emitSignal('look', { accent: junk });
      });
      expect(result.current.state.look).toEqual({});
    }
  });

  it('keeps its own look when a look arrives at a host', async () => {
    saveLook(SLUG, { accent: 'yellow' });
    const { result } = await joinRoom('host', []);
    act(() => {
      emitSignal('look', { accent: 'red' });
    });
    expect(result.current.state.look).toEqual({ accent: 'yellow' });
  });
});

// The first 24 bytes of a PNG: signature, the IHDR chunk header, width, height.
function logoOf(width: number, height: number): string {
  const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(width), ...be32(height)];
  return 'data:image/png;base64,' + btoa(String.fromCharCode(...head)) + 'AAAA';
}

describe('useRoom: the logo of the show', () => {
  beforeEach(() => {
    signalHandlers = {};
    signalSent = [];
    localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sends a host with a saved logo to the room in look, on joining and to each person who joins later', async () => {
    const logo = logoOf(160, 80);
    saveLook(SLUG, { accent: 'red', logo });
    const { result } = await joinRoom('host', []);
    expect(looks()).toEqual([{ type: 'look', accent: 'red', logo }]);
    expect(result.current.state.look).toEqual({ accent: 'red', logo });

    act(() => {
      emitSignal('peer-joined', joined);
    });
    expect(looks()).toEqual([
      { type: 'look', accent: 'red', logo },
      { type: 'look', accent: 'red', logo },
    ]);
  });

  it('takes a good logo from the host into the state, and replaces it with each look', async () => {
    const { result } = await joinRoom('guest', [{ peerId: 'h', ordinal: 1, role: 'host' }]);
    const logo = logoOf(40, 40);
    act(() => {
      emitSignal('look', { accent: 'green', logo });
    });
    expect(result.current.state.look).toEqual({ accent: 'green', logo });

    act(() => {
      emitSignal('look', { accent: 'green' });
    });
    expect(result.current.state.look).toEqual({ accent: 'green' });
  });

  it('drops a bad logo and keeps the accent of the same message', async () => {
    const { result } = await joinRoom('guest', [{ peerId: 'h', ordinal: 1, role: 'host' }]);
    for (const bad of [logoOf(20000, 20000), 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'url(x)', 7, null, {}]) {
      act(() => {
        emitSignal('look', { accent: 'pink', logo: bad });
      });
      expect(result.current.state.look).toEqual({ accent: 'pink' });
    }
  });
});
