import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MAX_SCRIPT_LENGTH } from '@openmeet/protocol';
import { useRoom } from '@/hooks/useRoom';

let signalHandlers: Record<string, ((m: any) => void)[]> = {};
// What reached the room, and whether the socket is open: like the real client,
// the double drops a message and answers false while it is not.
let sent: any[] = [];
let socketOpen = true;

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
    send: vi.fn((m: any) => {
      if (socketOpen) sent.push(m);
      return socketOpen;
    }),
    on: vi.fn((type: string, handler: (m: any) => void) => {
      (signalHandlers[type] ??= []).push(handler);
    }),
  })),
}));

vi.mock('@/lib/media', () => ({
  MediaManager: vi.fn().mockImplementation(() => ({
    adopt: vi.fn(),
    start: vi.fn().mockResolvedValue(
      Object.assign(new EventTarget(), {
        getTracks: () => [],
        getAudioTracks: () => [],
        getVideoTracks: () => [],
      }) as unknown as MediaStream
    ),
    stop: vi.fn(),
    setAudioEnabled: vi.fn(),
    setVideoEnabled: vi.fn(),
    stream: Object.assign(new EventTarget(), {
      getTracks: () => [],
      getAudioTracks: () => [],
      getVideoTracks: () => [],
    }) as unknown as MediaStream,
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

const mic = { id: 'a1', kind: 'audio', enabled: true } as unknown as MediaStreamTrack;
const cam = { id: 'v1', kind: 'video', enabled: true } as unknown as MediaStreamTrack;
const stream = Object.assign(new EventTarget(), {
  getTracks: () => [mic, cam],
  getAudioTracks: () => [mic],
  getVideoTracks: () => [cam],
}) as unknown as MediaStream;

function emit(type: string, payload: any) {
  for (const h of signalHandlers[type] ?? []) h({ type, ...payload });
}

// A guest joins a room the host is in; a host joins alone.
async function joinAs(role: 'host' | 'guest') {
  const hook = renderHook(() => useRoom('abc-defg-hij'));
  await act(async () => {
    await hook.result.current.join(stream, 'Me');
  });
  act(() => {
    emit('role-assigned', {
      role,
      peerId: 'me',
      ordinal: role === 'host' ? 1 : 2,
      peers: role === 'host' ? [] : [{ peerId: 'p-host', ordinal: 1, role: 'host', displayName: 'Host' }],
      recording: false,
    });
  });
  return hook;
}

const scripts = () => sent.filter((m) => m.type === 'script');

beforeEach(() => {
  signalHandlers = {};
  sent = [];
  socketOpen = true;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useRoom: a script from the host', () => {
  it('holds the newest script until the person answers, and changes nothing else', async () => {
    const { result } = await joinAs('guest');
    expect(result.current.state.incomingScript).toBeNull();

    // Whatever the join left pending settles first, so `before` is the state
    // the script arrives in.
    await act(async () => {});
    const before = result.current.state;
    act(() => {
      emit('script', { text: 'First draft' });
    });
    expect(result.current.state).toEqual({ ...before, incomingScript: 'First draft' });

    act(() => {
      emit('script', { text: 'Second draft' });
    });
    expect(result.current.state.incomingScript).toBe('Second draft');

    act(() => {
      result.current.dismissIncomingScript();
    });
    expect(result.current.state.incomingScript).toBeNull();
  });

  it('drops what is not a script: no text, blank text, or more than the bound', async () => {
    const { result } = await joinAs('guest');
    for (const text of [undefined, null, 7, {}, ['a'], '', '  \n ', 'a'.repeat(MAX_SCRIPT_LENGTH + 1)]) {
      act(() => {
        emit('script', { text });
      });
      expect(result.current.state.incomingScript).toBeNull();
    }

    const longest = 'a'.repeat(MAX_SCRIPT_LENGTH);
    act(() => {
      emit('script', { text: longest });
    });
    expect(result.current.state.incomingScript).toBe(longest);

    // A bad one after a good one leaves the good one waiting.
    act(() => {
      emit('script', { text: 7 });
    });
    expect(result.current.state.incomingScript).toBe(longest);
  });
});

describe('useRoom.sendScript', () => {
  it('sends the script to the room and says whether it went out', async () => {
    const { result } = await joinAs('host');
    expect(result.current.sendScript('Welcome to the show')).toBe(true);
    expect(scripts()).toEqual([{ type: 'script', text: 'Welcome to the show' }]);

    socketOpen = false;
    expect(result.current.sendScript('Second draft')).toBe(false);
    expect(scripts()).toHaveLength(1);
  });

  it('says not sent before this tab has joined the room', async () => {
    const { result } = renderHook(() => useRoom('abc-defg-hij'));
    await act(async () => {});
    expect(result.current.sendScript('Welcome to the show')).toBe(false);
    expect(scripts()).toEqual([]);
  });
});
