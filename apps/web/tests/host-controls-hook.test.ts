import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { phaseOnConnectionStateChange, phaseOnFatalClose, useRoom } from '@/hooks/useRoom';

/**
 * The host's controls as the hook sees them: the real useRoom, with the
 * network (signal, peer, REST) replaced.
 */

let handlers: Record<string, ((m: unknown) => void)[]> = {};
let sent: unknown[] = [];

vi.mock('@/lib/api', () => ({
  getRoom: vi.fn().mockResolvedValue({ slug: 'abc-defg-hij', expires_at: Date.now() + 60_000 }),
  getTurnCred: vi.fn().mockResolvedValue({
    urls: ['stun:stun.example.com'],
    username: 'stub',
    credential: 'stub',
    ttl: 0,
  }),
  patchRecording: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/host-token', () => ({
  getHostToken: vi.fn().mockReturnValue(null),
  storeHostToken: vi.fn(),
}));

vi.mock('@/lib/signal', () => ({
  SignalClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    close: vi.fn(),
    reconnect: vi.fn(),
    send: vi.fn((m: unknown) => sent.push(m)),
    on: vi.fn((type: string, h: (m: unknown) => void) => {
      (handlers[type] ??= []).push(h);
    }),
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

function emit(type: string, m: unknown) {
  act(() => {
    for (const h of handlers[type] ?? []) h(m);
  });
}

/** Join a room that already holds one other person, as the host or as a guest. */
async function joinAs(role: 'host' | 'guest') {
  const audio = { kind: 'audio', enabled: true, stop: vi.fn() };
  const video = { kind: 'video', enabled: true, stop: vi.fn() };
  const stream = Object.assign(new EventTarget(), {
    id: 'local',
    getTracks: () => [audio, video],
    getAudioTracks: () => [audio],
    getVideoTracks: () => [video],
  }) as unknown as MediaStream;
  const { result } = renderHook(() => useRoom('abc-defg-hij'));
  await act(async () => {
    await result.current.join(stream, 'Ana');
  });
  emit('role-assigned', {
    type: 'role-assigned',
    role,
    peerId: 'p-me',
    ordinal: 2,
    peers: [{ peerId: 'p-other', ordinal: 1, role: role === 'host' ? 'guest' : 'host', displayName: 'Bo' }],
    recording: false,
  });
  return { result, audio };
}

const presences = () => sent.filter((m) => (m as { type?: string }).type === 'presence');

beforeEach(() => {
  handlers = {};
  sent = [];
});

describe('a microphone the host mutes', () => {
  it('is turned off by this page, said to the room, and turned back on by its own switch', async () => {
    const { result, audio } = await joinAs('guest');
    sent = [];

    emit('peer-mute', { type: 'peer-mute' });
    expect(audio.enabled).toBe(false);
    expect(result.current.state.hostMuted).toBe(true);
    expect(presences()).toEqual([{ type: 'presence', micOn: false, camOn: true, screenSharing: false }]);

    act(() => result.current.setMic(true));
    expect(audio.enabled).toBe(true);
    expect(result.current.state.hostMuted).toBe(false);
  });

  it('leaves a microphone that is already off as it is, with no note and nothing sent', async () => {
    const { result, audio } = await joinAs('guest');
    act(() => result.current.setMic(false));
    sent = [];

    emit('peer-mute', { type: 'peer-mute' });
    expect(audio.enabled).toBe(false);
    expect(result.current.state.hostMuted).toBe(false);
    expect(presences()).toEqual([]);
  });

  it('never mutes the host', async () => {
    const { result, audio } = await joinAs('host');
    emit('peer-mute', { type: 'peer-mute' });
    expect(audio.enabled).toBe(true);
    expect(result.current.state.hostMuted).toBe(false);
  });

  it("sends the host's request for one person to the room", async () => {
    const { result } = await joinAs('host');
    sent = [];
    act(() => result.current.mutePeer('p-other'));
    expect(sent).toContainEqual({ type: 'peer-mute', peerId: 'p-other' });
  });
});

describe('removing a person', () => {
  it("sends the host's removal of one person to the room", async () => {
    const { result } = await joinAs('host');
    sent = [];
    act(() => result.current.removePeer('p-other'));
    expect(sent).toContainEqual({ type: 'peer-remove', peerId: 'p-other' });
  });
});

describe('removed by the host (close code 4007)', () => {
  it('ends the room on a screen of its own when no take is running', () => {
    expect(phaseOnFatalClose('in-call', 4007)).toEqual({ phase: 'removed' });
    expect(phaseOnFatalClose('connecting', 4007)).toEqual({ phase: 'removed' });
    expect(phaseOnFatalClose('done', 4007)).toEqual({ phase: 'removed' });
  });

  it('holds a take that is running, so its files can still be closed', () => {
    expect(phaseOnFatalClose('recording', 4007)).toBeNull();
    expect(phaseOnFatalClose('finalizing', 4007)).toBeNull();
  });

  it('is not pulled back into the call by a connection that comes up late', () => {
    expect(phaseOnConnectionStateChange('removed', 'connected')).toBe('removed');
  });
});
