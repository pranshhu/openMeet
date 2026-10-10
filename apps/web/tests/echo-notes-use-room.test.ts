import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';
import { startHostRecording } from '@/hooks/recording-controller';

let signalHandlers: Record<string, ((m: any) => void)[]> = {};

vi.mock('@/lib/api', () => ({
  getTurnCred: vi.fn().mockResolvedValue({ urls: [], username: 'u', credential: 'c', ttl: 100 }),
  getRoom: vi.fn().mockResolvedValue({ slug: 'abc-defg-hij', expires_at: Date.now() + 10000 }),
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

// The two ends of a host take. Everything between them is the real code: the
// take holds one guest file, in slot 0, bound to the peer 'p-guest'.
vi.mock('@/hooks/recording-controller', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/recording-controller')>(
    '@/hooks/recording-controller'
  );
  return {
    ...actual,
    startHostRecording: vi.fn().mockImplementation(async () => ({
      recordingId: 'rec-host-1',
      hostStartMs: 1_000_000,
      hostWriter: { fileName: 'host_rec-host-1.mp4', size: 1 },
      receiver: {
        fileName: 'guest_rec-host-1.mp4',
        digestHex: async () => 'abc',
        senderSha256: 'abc',
        receivedFinalized: true,
        isAbandoned: false,
        bytesWritten: 1,
      },
      slotPeerIds: new Map([[0, 'p-guest']]),
    })),
    endHostRecording: vi.fn().mockResolvedValue({ backup: null }),
  };
});

const GUEST = { peerId: 'p-guest', ordinal: 2, role: 'guest', displayName: 'Asha' };
const HOST_FILE = 'host_rec-host-1.mp4';
const GUEST_FILE = 'guest_rec-host-1.mp4';
const SECOND_GUEST_FILE = 'guest2_rec-host-1.mp4';

function emit(type: string, payload: any) {
  for (const handler of signalHandlers[type] ?? []) handler(payload);
}

/** The host's lobby stream; its microphone reports `echoCancellation`. */
function lobbyStream(echoCancellation: boolean) {
  const audio = { kind: 'audio', enabled: true, stop: vi.fn(), getSettings: () => ({ echoCancellation }) };
  return Object.assign(new EventTarget(), {
    getTracks: () => [],
    getAudioTracks: () => [audio],
    getVideoTracks: () => [{ kind: 'video' }],
  }) as unknown as MediaStream;
}

/** A host in a room with one guest. */
async function hosting(hostEcho = false) {
  const { result } = renderHook(() => useRoom('abc-defg-hij'));
  await act(async () => {
    await result.current.join(lobbyStream(hostEcho), 'Host Hana');
  });
  await act(async () => {
    emit('role-assigned', {
      type: 'role-assigned',
      role: 'host',
      peerId: 'p-host',
      ordinal: 1,
      peers: [GUEST],
      recording: false,
    });
  });
  return result;
}

/** A peer announces how it listens, as the Room relays it. */
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

/** Records a take, runs `during` in the middle of it, and returns each summary row's detail. */
async function takeDetails(result: { current: ReturnType<typeof useRoom> }, during: () => void = () => {}) {
  await act(async () => {
    await result.current.startRecording();
  });
  during();
  await act(async () => {
    await result.current.endRecording();
  });
  const files = result.current.state.summary?.fileList ?? [];
  return Object.fromEntries(files.map((f) => [f.name, f.detail]));
}

describe('useRoom: echo cancellation in the take’s notes', () => {
  beforeEach(() => {
    signalHandlers = {};
    globalThis.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    globalThis.URL.revokeObjectURL = vi.fn();
    vi.clearAllMocks();
  });

  it('marks the file of a guest who said echo cancellation, also after that guest left', async () => {
    const result = await hosting();
    says('p-guest', 'speakers-ec');
    const details = await takeDetails(result, () =>
      act(() => emit('peer-left', { type: 'peer-left', role: 'guest', reason: 'gone', peerId: 'p-guest' }))
    );
    expect(details[GUEST_FILE]).toBe('echo cancellation on');
    expect(details[HOST_FILE]).toBeUndefined();
  });

  it("marks the host's own file from what its microphone reports", async () => {
    const result = await hosting(true);
    const details = await takeDetails(result);
    expect(details[HOST_FILE]).toBe('echo cancellation on');
    expect(details[GUEST_FILE]).toBeUndefined();
  });

  it('marks nothing for a guest who said speakers without echo cancellation', async () => {
    const result = await hosting();
    says('p-guest', 'speakers');
    const details = await takeDetails(result);
    expect(Object.keys(details)).toContain(GUEST_FILE);
    expect(details[GUEST_FILE]).toBeUndefined();
  });

  // A guest who rejoins from the lobby with another answer announces it again.
  it('marks nothing for a guest whose later answer is another one', async () => {
    const result = await hosting();
    says('p-guest', 'speakers-ec');
    says('p-guest', 'headphones');
    const details = await takeDetails(result);
    expect(Object.keys(details)).toContain(GUEST_FILE);
    expect(details[GUEST_FILE]).toBeUndefined();
  });

  it('forgets the oldest peer once 64 others have said it', async () => {
    const result = await hosting();
    says('p-guest', 'speakers-ec');
    for (let i = 0; i < 64; i++) says(`other-${i}`, 'speakers-ec');
    const details = await takeDetails(result);
    expect(Object.keys(details)).toContain(GUEST_FILE);
    expect(details[GUEST_FILE]).toBeUndefined();
  });

  it('still marks a guest after 63 others have said it', async () => {
    const result = await hosting();
    says('p-guest', 'speakers-ec');
    for (let i = 0; i < 63; i++) says(`other-${i}`, 'speakers-ec');
    const details = await takeDetails(result);
    expect(details[GUEST_FILE]).toBe('echo cancellation on');
  });

  it('does not count a message whose peer id is not text', async () => {
    const result = await hosting();
    says('p-guest', 'speakers-ec');
    for (let i = 0; i < 64; i++) says(i as unknown as string, 'speakers-ec');
    const details = await takeDetails(result);
    expect(details[GUEST_FILE]).toBe('echo cancellation on');
  });

  // A browser may name the kind of cancellation instead of saying true.
  it("marks the host's own file when its microphone reports echo cancellation as a word", async () => {
    const result = await hosting('all' as unknown as boolean);
    const details = await takeDetails(result);
    expect(details[HOST_FILE]).toBe('echo cancellation on');
  });

  it('marks only the guest who said it when two are recorded', async () => {
    const received = { senderSha256: 'abc', receivedFinalized: true, isAbandoned: false, bytesWritten: 1 };
    vi.mocked(startHostRecording).mockImplementationOnce(
      async () =>
        ({
          recordingId: 'rec-host-1',
          hostStartMs: 1_000_000,
          hostWriter: { fileName: HOST_FILE, size: 1 },
          receiver: { ...received, fileName: GUEST_FILE, digestHex: async () => 'abc' },
          guestSlots: new Map([['key-2', 1]]),
          guestReceivers: new Map([
            [
              'key-2:mp4',
              {
                receiver: { ...received, digestHex: async () => 'abc' },
                writer: { fileName: SECOND_GUEST_FILE, size: 1 },
              },
            ],
          ]),
          slotPeerIds: new Map([
            [0, 'p-guest'],
            [1, 'p-second'],
          ]),
        }) as never
    );
    const result = await hosting();
    says('p-guest', 'speakers-ec');
    says('p-second', 'headphones');
    const details = await takeDetails(result);
    expect(details[GUEST_FILE]).toBe('echo cancellation on');
    expect(Object.keys(details)).toContain(SECOND_GUEST_FILE);
    expect(details[SECOND_GUEST_FILE]).toBeUndefined();
  });
});
