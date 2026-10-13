import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, renderHook, act } from '@testing-library/react';
import { WS_CLOSE_NOT_ADMITTED } from '@openmeet/protocol';
import { RoomView } from '@/components/RoomView';
import { PeoplePanel } from '@/components/PeoplePanel';
import { RoomAccess } from '@/components/RoomAccess';
import { phaseOnConnectionStateChange, phaseOnFatalClose, useRoom, type RemotePeer } from '@/hooks/useRoom';
import { readRoomAccess } from '@/lib/room-access';
import { SignalClient as RealSignalClient } from '@/lib/signal';

/**
 * The host's lock on the room, and what a person it turns away reads. The
 * network (signal, peer, REST) is replaced; the hook, the screens and the
 * panel are the real ones.
 */

let handlers: Record<string, ((m: unknown) => void)[]> = {};
let sent: unknown[] = [];
let fatalClose: ((code: number, reason: string) => void) | null = null;
// When set, RoomView draws from this instead of the real hook.
let fake: { state: Record<string, unknown>; hook: Record<string, unknown> } | null = null;

vi.mock('@/hooks/useRoom', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useRoom')>('@/hooks/useRoom');
  return {
    ...actual,
    useRoom: (slug: string) =>
      fake ? { state: fake.state, join: vi.fn(), leave: vi.fn(), ...fake.hook } : actual.useRoom(slug),
  };
});

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
  SignalClient: vi.fn().mockImplementation((opts: { onFatalClose?: (code: number, reason: string) => void }) => {
    fatalClose = opts.onFatalClose ?? null;
    return {
      connect: vi.fn(),
      close: vi.fn(),
      reconnect: vi.fn(),
      send: vi.fn((m: unknown) => sent.push(m)),
      on: vi.fn((type: string, h: (m: unknown) => void) => {
        (handlers[type] ??= []).push(h);
      }),
    };
  }),
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
  return { result, audio, video };
}

beforeEach(() => {
  handlers = {};
  sent = [];
  fatalClose = null;
  fake = null;
});

describe('the lock as the page connects to the Room', () => {
  class FakeWS {
    static instances: FakeWS[] = [];
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onclose: ((ev: { code: number; reason: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) {
      FakeWS.instances.push(this);
    }
    send() {}
    close() {
      this.readyState = 3;
    }
  }

  beforeEach(() => {
    FakeWS.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('does not reconnect after a close with 4008, and reports the code and the reason', async () => {
    const { SignalClient } = await vi.importActual<{ SignalClient: typeof RealSignalClient }>('@/lib/signal');
    const onFatalClose = vi.fn();
    new SignalClient({
      slug: 'abc-defg-hij',
      wsBase: 'ws://localhost:8787',
      displayName: 'Bo',
      userAgent: 'ua',
      onFatalClose,
      wsFactory: (url) => new FakeWS(url) as unknown as WebSocket,
    }).connect();
    const ws = FakeWS.instances[0]!;
    ws.readyState = 1;
    ws.onopen?.();
    ws.readyState = 3;
    ws.onclose?.({ code: WS_CLOSE_NOT_ADMITTED, reason: 'locked' });

    vi.advanceTimersByTime(60_000);
    expect(FakeWS.instances).toHaveLength(1);
    expect(onFatalClose).toHaveBeenCalledWith(4008, 'locked');
  });
});

describe('phaseOnFatalClose for a refused join (4008)', () => {
  it('gives the refused screen, and holds a take that is running', () => {
    expect(phaseOnFatalClose('connecting', 4008)).toEqual({ phase: 'refused' });
    expect(phaseOnFatalClose('in-call', 4008)).toEqual({ phase: 'refused' });
    expect(phaseOnFatalClose('recording', 4008)).toBeNull();
    expect(phaseOnFatalClose('finalizing', 4008)).toBeNull();
  });

  it('is not pulled back into the call by a connection that comes up late', () => {
    expect(phaseOnConnectionStateChange('refused', 'connected')).toBe('refused');
  });
});

describe('readRoomAccess', () => {
  it('reads a lock only from a message that says locked: true', () => {
    expect(readRoomAccess({ type: 'room-access', locked: true })).toEqual({
      locked: true,
      waitingRoom: false,
      waiting: [],
    });
    expect(readRoomAccess({ type: 'room-access', locked: false })).toEqual({
      locked: false,
      waitingRoom: false,
      waiting: [],
    });
    expect(readRoomAccess(null)).toEqual({ locked: false, waitingRoom: false, waiting: [] });
    expect(readRoomAccess('locked')).toEqual({ locked: false, waitingRoom: false, waiting: [] });
    expect(readRoomAccess({ locked: 1 })).toEqual({ locked: false, waitingRoom: false, waiting: [] });
    expect(readRoomAccess({ locked: 'true' })).toEqual({ locked: false, waitingRoom: false, waiting: [] });
    expect(readRoomAccess(undefined)).toEqual({ locked: false, waitingRoom: false, waiting: [] });
  });
});

describe('the lock in the hook', () => {
  it('knows nothing until the Room says, then keeps what a host is told', async () => {
    const { result } = await joinAs('host');
    expect(result.current.state.access).toBeNull();

    emit('room-access', { type: 'room-access', locked: true });
    expect(result.current.state.access).toEqual({ locked: true, waitingRoom: false, waiting: [] });
    emit('room-access', { type: 'room-access', locked: false });
    expect(result.current.state.access).toEqual({ locked: false, waitingRoom: false, waiting: [] });
    emit('room-access', { type: 'room-access', locked: 'yes' });
    expect(result.current.state.access).toEqual({ locked: false, waitingRoom: false, waiting: [] });
  });

  it('does not keep it for a guest', async () => {
    const { result } = await joinAs('guest');
    emit('room-access', { type: 'room-access', locked: true });
    expect(result.current.state.access).toBeNull();
  });

  it('sends one message for a change and leaves the screen to the Room’s answer', async () => {
    const { result } = await joinAs('host');
    emit('room-access', { type: 'room-access', locked: false });
    sent = [];

    act(() => result.current.setRoomAccess({ locked: true }));
    expect(sent).toEqual([{ type: 'room-access', locked: true }]);
    expect(result.current.state.access).toEqual({ locked: false, waitingRoom: false, waiting: [] });
  });

  it('shows the locked screen for a refusal that says locked, and the plain one for any other reason', async () => {
    const { result, audio, video } = await joinAs('guest');
    act(() => fatalClose!(4008, 'locked'));
    expect(result.current.state.phase).toBe('refused');
    expect(result.current.state.refusal).toBe('locked');
    expect(audio.stop).toHaveBeenCalled();
    expect(video.stop).toHaveBeenCalled();
  });

  it('keeps no reason that is not the one it knows', async () => {
    const { result } = await joinAs('guest');
    act(() => fatalClose!(4008, 'something else'));
    expect(result.current.state.phase).toBe('refused');
    expect(result.current.state.refusal).toBeNull();
  });
});

describe('the refused screen', () => {
  const baseState = {
    role: null,
    companion: false,
    localStream: null,
    localName: 'Bo',
    remoteStream: null,
    remotePeers: [],
    messages: [],
    recordingError: null,
    backupBlobUrl: null,
    wavBackupBlobUrl: null,
  };

  it('says the room is locked, and offers the lobby and a way home', () => {
    fake = { state: { ...baseState, phase: 'refused', refusal: 'locked' }, hook: {} };
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.getByRole('heading', { name: 'This room is locked' })).toBeInTheDocument();
    expect(
      screen.getByText('The host locked it, so nobody new can join. Ask the host to unlock it, then try again.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/');
  });

  it('says less when it was not told why', () => {
    fake = { state: { ...baseState, phase: 'refused', refusal: null }, hook: {} };
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.getByRole('heading', { name: 'You can’t join this room right now' })).toBeInTheDocument();
    expect(screen.getByText('Ask the host, then try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('Lock the room in the People panel', () => {
  const bo: RemotePeer = { peerId: 'p-bo', name: 'Bo', stream: null, role: 'guest' };

  const hostCall = (access: { locked: boolean; waitingRoom: boolean; waiting: never[] } | null) => ({
    phase: 'in-call',
    role: 'host',
    companion: false,
    localStream: null,
    localName: 'Ana',
    remoteStream: null,
    remotePeers: [{ ...bo, presence: { micOn: true, camOn: true, screenSharing: false } }],
    remoteScreenStream: null,
    localScreenStream: null,
    screenSharing: false,
    peerRecording: false,
    capabilities: {},
    finalizingGuests: [],
    messages: [],
    markers: [],
    takes: [],
    summary: null,
    recordingError: null,
    connectionWarning: null,
    syncReportUrl: null,
    chaptersUrl: null,
    backupBlobUrl: null,
    wavBackupBlobUrl: null,
    drained: true,
    sidecarsSaved: false,
    access,
  });

  it('is ticked from what the Room said, and a click only asks for the opposite', () => {
    const onChange = vi.fn();
    render(
      <PeoplePanel people={[bo]} onMute={vi.fn()} onClose={vi.fn()}>
        <RoomAccess access={{ locked: true, waitingRoom: false, waiting: [] }} onChange={onChange} />
      </PeoplePanel>
    );
    const box = screen.getByRole('checkbox', { name: 'Lock the room' });
    expect(box).toBeChecked();
    expect(box).toHaveAccessibleDescription('Nobody new can join. People already here can reconnect.');

    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ locked: false });
    expect(box).toBeChecked();
  });

  it('is unticked while the room is open, and asks to lock it', () => {
    const onChange = vi.fn();
    render(
      <PeoplePanel people={[bo]} onMute={vi.fn()} onClose={vi.fn()}>
        <RoomAccess access={{ locked: false, waitingRoom: false, waiting: [] }} onChange={onChange} />
      </PeoplePanel>
    );
    const box = screen.getByRole('checkbox', { name: 'Lock the room' });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith({ locked: true });
    expect(box).not.toBeChecked();
  });

  it('is not there when the panel is given nothing to draw above its list', () => {
    render(<PeoplePanel people={[bo]} onMute={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('is drawn by the call screen for a host who has been told, and sends the change', () => {
    const setRoomAccess = vi.fn();
    fake = {
      state: hostCall({ locked: false, waitingRoom: false, waiting: [] }),
      hook: { mutePeer: vi.fn(), setRoomAccess },
    };
    render(<RoomView slug="abc-defg-hij" />);
    fireEvent.click(screen.getByRole('button', { name: 'People' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Lock the room' }));
    expect(setRoomAccess).toHaveBeenCalledWith({ locked: true });
  });

  it('is not drawn by the call screen until the Room has told the host', () => {
    fake = {
      state: hostCall(null),
      hook: { mutePeer: vi.fn(), setRoomAccess: vi.fn() },
    };
    render(<RoomView slug="abc-defg-hij" />);
    fireEvent.click(screen.getByRole('button', { name: 'People' }));
    expect(screen.getByRole('region', { name: 'People' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
