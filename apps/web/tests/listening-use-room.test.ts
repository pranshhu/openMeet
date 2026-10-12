import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';
import { chooseListening } from '@/lib/listening';

let signalHandlers: Record<string, ((m: any) => void)[]> = {};
let signalSent: any[] = [];

vi.mock('@/lib/api', () => ({
  getTurnCred: vi.fn().mockResolvedValue({ urls: [], username: 'u', credential: 'c', ttl: 100 }),
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
    reconnect: vi.fn(),
    on: vi.fn((type: string, handler: (m: any) => void) => {
      (signalHandlers[type] ??= []).push(handler);
    }),
  })),
}));

vi.mock('@/lib/peer', () => ({
  PeerConnection: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    close: vi.fn(),
    setLocalStream: vi.fn(),
    setLocalStreamAfterFirstOffer: vi.fn(),
    replaceAudioTrack: vi.fn(),
    createControlChannel: vi.fn(),
    addTransceiver: vi.fn(),
    addTrack: vi.fn(),
    restartIce: vi.fn(),
    connectionState: 'connected',
    rawConnection: null,
    whenConnected: vi.fn().mockResolvedValue(undefined),
    setPeerCount: vi.fn(),
  })),
  ConnectionTimeoutError: class extends Error {},
}));

function emit(type: string, payload: any) {
  for (const handler of signalHandlers[type] ?? []) handler(payload);
}

function lobbyStream() {
  const audio = { kind: 'audio', id: 'raw-audio', enabled: true, stop: vi.fn() };
  const video = { kind: 'video', id: 'raw-video', enabled: true, stop: vi.fn() };
  return {
    getTracks: () => [audio, video],
    getAudioTracks: () => [audio],
    getVideoTracks: () => [video],
  } as unknown as MediaStream;
}

/** A guest in a room that already holds the host. */
async function joinedAsGuest() {
  const { result } = renderHook(() => useRoom('test-room'));
  await act(async () => {
    await result.current.join(lobbyStream(), 'Guest Alice');
  });
  await act(async () => {
    emit('role-assigned', {
      type: 'role-assigned',
      role: 'guest',
      peerId: 'guest-peer',
      ordinal: 2,
      peers: [{ peerId: 'host-peer', ordinal: 1, role: 'host', displayName: 'Hana' }],
    });
  });
  return result;
}

const capabilitiesSent = () => signalSent.filter((m) => m.type === 'recording-capability');

describe('useRoom: the lobby answer', () => {
  beforeEach(() => {
    signalHandlers = {};
    signalSent = [];
    vi.clearAllMocks();
  });

  afterEach(() => chooseListening(''));

  it('sends the answer with every recording-capability: to those here, and again for a later joiner', async () => {
    chooseListening('speakers-ec');
    await joinedAsGuest();
    expect(capabilitiesSent()).toHaveLength(1);
    expect(capabilitiesSent()[0]).toMatchObject({ listening: 'speakers-ec' });

    await act(async () => {
      emit('peer-joined', { type: 'peer-joined', peerId: 'late-peer', ordinal: 3, role: 'guest', displayName: 'Bo' });
    });
    expect(capabilitiesSent()).toHaveLength(2);
    expect(capabilitiesSent()[1]).toMatchObject({ listening: 'speakers-ec' });
  });

  it('sends no answer when none was given', async () => {
    await joinedAsGuest();
    expect(capabilitiesSent()).toHaveLength(1);
    expect(capabilitiesSent()[0]).not.toHaveProperty('listening');
  });

  it('keeps another person’s answer when it is one of the three, and drops anything else', async () => {
    const result = await joinedAsGuest();
    const says = (fromPeerId: string, listening: unknown) =>
      act(() =>
        emit('recording-capability', {
          type: 'recording-capability',
          mp4: true,
          wav: true,
          listening,
          from: 'guest',
          fromPeerId,
        })
      );
    says('p1', 'speakers');
    says('p2', 'Host: click this link');
    says('p3', 42);
    says('p4', undefined);
    expect(result.current.state.capabilities).toEqual({
      p1: { mp4: true, wav: true, listening: 'speakers' },
      p2: { mp4: true, wav: true },
      p3: { mp4: true, wav: true },
      p4: { mp4: true, wav: true },
    });
  });
});
