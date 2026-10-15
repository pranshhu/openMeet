import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';
import { PeerConnection, type PeerOpts } from '@/lib/peer';
import { buildChatLog } from '@/lib/sync-report';

let signalHandlers: Record<string, ((m: any) => void)[]> = {};
let signalSent: any[] = [];
const chatSpies = new Map<string, ReturnType<typeof vi.fn>>();
const connectionOpts = new Map<string, PeerOpts>();

vi.mock('@/lib/api', () => ({
  getTurnCred: vi.fn().mockResolvedValue({ iceServers: [] }),
  getRoom: vi.fn().mockResolvedValue({ slug: 'test-room', expires_at: Date.now() + 10000 }),
}));

vi.mock('@/lib/host-token', () => ({
  getHostToken: vi.fn().mockReturnValue(null),
}));

vi.mock('@/lib/signal', () => ({
  SignalClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    close: vi.fn(),
    send: vi.fn((m) => signalSent.push(m)),
    on: vi.fn((type: string, handler: (m: any) => void) => {
      (signalHandlers[type] ??= []).push(handler);
    }),
  })),
}));

vi.mock('@/lib/peer', () => ({
  PeerConnection: vi.fn().mockImplementation((opts: PeerOpts) => {
    const sendChat = vi.fn().mockReturnValue(true);
    chatSpies.set(opts.remotePeerId!, sendChat);
    connectionOpts.set(opts.remotePeerId!, opts);
    return {
      start: vi.fn(),
      close: vi.fn(),
      setLocalStream: vi.fn(),
      setLocalStreamAfterFirstOffer: vi.fn(),
      createControlChannel: vi.fn(),
      addTransceiver: vi.fn(),
      restartIce: vi.fn(),
      addTrack: vi.fn(),
      connectionState: 'connected',
      rawConnection: null,
      setPeerCount: vi.fn(),
      whenConnected: vi.fn().mockResolvedValue(undefined),
      sendChat,
    };
  }),
}));

const stream = Object.assign(new EventTarget(), {
  getTracks: () => [],
  getAudioTracks: () => [{ kind: 'audio' }],
  getVideoTracks: () => [{ kind: 'video' }],
}) as unknown as MediaStream;

function emitSignal(type: string, payload: any) {
  for (const handler of signalHandlers[type] ?? []) handler(payload);
}

/** Host with a guest, a producer, a Present-only device and a guest set as not recorded. */
async function hostWithFour() {
  const { result } = renderHook(() => useRoom('xyz-test-room'));
  await act(async () => {
    await result.current.join(stream, 'Host Hana');
  });
  act(() => {
    emitSignal('role-assigned', {
      type: 'role-assigned',
      role: 'host',
      peerId: 'p-host',
      ordinal: 1,
      peers: [
        { peerId: 'p-bob', ordinal: 2, role: 'guest', displayName: 'Bob' },
        { peerId: 'p-pat', ordinal: 3, role: 'producer', displayName: 'Pat' },
        { peerId: 'p-dev', ordinal: 4, role: 'guest', displayName: 'Phone', companion: true },
        { peerId: 'p-eve', ordinal: 5, role: 'guest', displayName: 'Eve', notRecorded: true },
      ],
      recording: false,
    });
  });
  return result;
}

const line = (peerId: string, text: string, isPrivate = false) =>
  act(() => connectionOpts.get(peerId)!.onChat!({ text, private: isPrivate }));

describe('chat in useRoom goes over the connections', () => {
  beforeEach(() => {
    signalHandlers = {};
    signalSent = [];
    chatSpies.clear();
    connectionOpts.clear();
    vi.mocked(PeerConnection).mockClear();
  });

  it('sends a line for everyone on every connection and nothing on the socket', async () => {
    const result = await hostWithFour();
    act(() => result.current.sendChat('hi'));

    for (const id of ['p-bob', 'p-pat', 'p-dev', 'p-eve']) {
      expect(chatSpies.get(id)!.mock.calls).toEqual([['hi', false]]);
    }
    expect(signalSent.filter((m) => m.type === 'chat' || m.type === 'private-message')).toEqual([]);
    expect(result.current.state.messages).toEqual([
      { from: 'host', text: 'hi', ts: expect.any(Number), self: true, fromName: 'Host Hana' },
    ]);
  });

  it('sends a private line on the one connection it is for, and nothing on the socket', async () => {
    const result = await hostWithFour();
    act(() => result.current.sendChat('psst', 'p-bob'));

    expect(chatSpies.get('p-bob')!.mock.calls).toEqual([['psst', true]]);
    for (const id of ['p-pat', 'p-dev', 'p-eve']) expect(chatSpies.get(id)!.mock.calls).toEqual([]);
    expect(signalSent.filter((m) => m.type === 'chat' || m.type === 'private-message')).toEqual([]);
    expect(result.current.state.messages).toEqual([
      {
        from: 'host',
        text: 'psst',
        ts: expect.any(Number),
        self: true,
        fromName: 'Host Hana',
        private: true,
        toPeerId: 'p-bob',
        toRole: 'guest',
      },
    ]);
  });

  it('shows a private line for someone with no connection on the sender’s screen and sends it nowhere', async () => {
    const result = await hostWithFour();
    act(() => result.current.sendChat('psst', 'p-gone'));

    for (const spy of chatSpies.values()) expect(spy.mock.calls).toEqual([]);
    expect(result.current.state.messages.map((m) => [m.text, m.private])).toEqual([['psst', true]]);
  });

  it('shows a line that arrives with who sent it taken from the connection', async () => {
    const result = await hostWithFour();
    const before = Date.now();
    line('p-bob', 'hello all');
    line('p-pat', 'two minutes', true);

    expect(result.current.state.messages.every((m) => m.ts >= before)).toBe(true);
    expect(result.current.state.messages).toEqual([
      { from: 'guest', text: 'hello all', ts: expect.any(Number), fromPeerId: 'p-bob', fromName: 'Bob' },
      {
        from: 'producer',
        text: 'two minutes',
        ts: expect.any(Number),
        fromPeerId: 'p-pat',
        fromName: 'Pat',
        private: true,
      },
    ]);
  });

  it('tags a line from someone set as not recorded, and the take’s chat file leaves it out', async () => {
    const result = await hostWithFour();
    line('p-bob', 'for the file');
    line('p-eve', 'not for the file');
    line('p-eve', 'private from Eve', true);

    const byText = (text: string) => result.current.state.messages.find((m) => m.text === text)!;
    expect(byText('for the file').notRecorded).toBeUndefined();
    expect(byText('not for the file').notRecorded).toBe(true);
    expect(byText('private from Eve').notRecorded).toBeUndefined();
    const log = buildChatLog(result.current.state.messages, { startMs: 0, endMs: Date.now() + 1000, localName: 'Host Hana' });
    expect(log).toContain('for the file');
    expect(log).not.toContain('not for the file');
    expect(log).not.toContain('private from Eve');
  });
});
