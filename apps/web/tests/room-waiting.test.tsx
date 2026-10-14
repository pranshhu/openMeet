import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, renderHook, act, within } from '@testing-library/react';
import { isServerMessage, isClientMessage, type WaitingPerson } from '@openmeet/protocol';
import { RoomView } from '@/components/RoomView';
import { RoomAccess } from '@/components/RoomAccess';
import { KnockNotice } from '@/components/KnockNotice';
import { CallStage } from '@/components/CallStage';
import { useRoom } from '@/hooks/useRoom';
import { readRoomAccess } from '@/lib/room-access';

/**
 * The waiting room as the page sees it. The network (signal, peer, REST) is
 * replaced; the hook, the screens and the notice are the real ones.
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

async function joinAs() {
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
  return result;
}

const seatAs = (role: 'host' | 'guest') =>
  emit('role-assigned', {
    type: 'role-assigned',
    role,
    peerId: 'p-me',
    ordinal: 2,
    peers: [],
    recording: false,
  });

beforeEach(() => {
  handlers = {};
  sent = [];
  fatalClose = null;
  fake = null;
});

const person = (over: Partial<WaitingPerson> = {}): WaitingPerson => ({
  peerId: 'w-1',
  displayName: 'Wanda',
  role: 'guest',
  ...over,
});

describe('readRoomAccess, the waiting room part', () => {
  it('reads the waiting room only from a message that says waitingRoom: true', () => {
    expect(readRoomAccess({ locked: false, waitingRoom: true, passcode: false, waiting: [] })).toEqual({
      locked: false,
      waitingRoom: true,
      passcode: false,
      waiting: [],
    });
    for (const v of [false, 1, 'true', null, undefined, [true]]) {
      expect(readRoomAccess({ locked: false, waitingRoom: v, waiting: [] }).waitingRoom).toBe(false);
    }
    expect(readRoomAccess(null)).toEqual({ locked: false, waitingRoom: false, passcode: false, waiting: [] });
    expect(readRoomAccess({ locked: true })).toEqual({ locked: true, waitingRoom: false, passcode: false, waiting: [] });
  });

  it('keeps the first eight people and drops the rest', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ peerId: `w-${i}`, displayName: `W${i}`, role: 'guest' }));
    const read = readRoomAccess({ waiting: many }).waiting;
    expect(read.map((w) => w.peerId)).toEqual(['w-0', 'w-1', 'w-2', 'w-3', 'w-4', 'w-5', 'w-6', 'w-7']);
  });

  it('drops an entry without a usable peerId, and anything that is not an object', () => {
    const read = readRoomAccess({
      waiting: [
        { displayName: 'No id', role: 'guest' },
        { peerId: '', displayName: 'Empty id' },
        { peerId: 7, displayName: 'Number id' },
        { peerId: 'x'.repeat(65), displayName: 'Long id' },
        null,
        'w-str',
        42,
        { peerId: 'x'.repeat(64), displayName: 'Longest id' },
        { peerId: 'w-ok', displayName: 'Ok' },
      ],
    }).waiting;
    expect(read.map((w) => w.displayName)).toEqual(['Longest id', 'Ok']);
  });

  it('cuts a long name to 64, reads a name that is not text as empty, and reads the role and the companion flag', () => {
    const read = readRoomAccess({
      waiting: [
        { peerId: 'a', displayName: 'n'.repeat(100), role: 'producer', companion: true },
        { peerId: 'b', displayName: 12, role: 'host', companion: 'true' },
        { peerId: 'c', role: 'weird', companion: false },
      ],
    }).waiting;
    expect(read).toEqual([
      { peerId: 'a', displayName: 'n'.repeat(64), role: 'producer', companion: true },
      { peerId: 'b', displayName: '', role: 'guest' },
      { peerId: 'c', displayName: '', role: 'guest' },
    ]);
  });

  it('reads a waiting list that is not an array as empty', () => {
    for (const v of ['w-1', 5, { 0: { peerId: 'w-1' } }, null]) {
      expect(readRoomAccess({ waiting: v }).waiting).toEqual([]);
    }
  });
});

describe('the waiting room in the protocol guards', () => {
  it('knows `door` as a server message and `admit` as a client message', () => {
    expect(isServerMessage({ type: 'door', state: 'waiting' })).toBe(true);
    expect(isClientMessage({ type: 'admit', peerId: 'w-1', admit: true })).toBe(true);
  });
});

describe('the waiting room in the hook', () => {
  it('knows no door until the Room sends one, sets it on `door`, and clears it on `role-assigned`', async () => {
    const result = await joinAs();
    expect(result.current.state.door).toBeNull();

    emit('door', { type: 'door', state: 'waiting' });
    expect(result.current.state.door).toBe('waiting');
    expect(result.current.state.phase).toBe('connecting');

    seatAs('guest');
    expect(result.current.state.door).toBeNull();
  });

  it('sets no door for a state it does not know', async () => {
    const result = await joinAs();
    emit('door', { type: 'door', state: 'open' });
    emit('door', { type: 'door' });
    expect(result.current.state.door).toBeNull();
  });

  it('clears the door when the Room closes the socket for good', async () => {
    const result = await joinAs();
    emit('door', { type: 'door', state: 'waiting' });
    act(() => fatalClose!(4008, 'refused'));
    expect(result.current.state.phase).toBe('refused');
    expect(result.current.state.door).toBeNull();
    expect(result.current.state.refusal).toBe('refused');
  });

  it('reads a refusal that says busy, and keeps no reason it does not know', async () => {
    const busy = await joinAs();
    act(() => fatalClose!(4008, 'busy'));
    expect(busy.current.state.refusal).toBe('busy');

    const other = await joinAs();
    act(() => fatalClose!(4008, 'something else'));
    expect(other.current.state.refusal).toBeNull();
  });

  it('keeps the waiting room and the list a host is told', async () => {
    const result = await joinAs();
    seatAs('host');
    emit('room-access', { type: 'room-access', locked: false, waitingRoom: true, passcode: false, waiting: [person()] });
    expect(result.current.state.access).toEqual({ locked: false, waitingRoom: true, passcode: false, waiting: [person()] });
  });

  it('sends `admit` with the id and the answer, and `room-access` with the waiting room', async () => {
    const result = await joinAs();
    seatAs('host');
    sent = [];

    act(() => result.current.admitPeer('w-1', true));
    act(() => result.current.admitPeer('w-2', false));
    act(() => result.current.setRoomAccess({ waitingRoom: true }));
    expect(sent).toEqual([
      { type: 'admit', peerId: 'w-1', admit: true },
      { type: 'admit', peerId: 'w-2', admit: false },
      { type: 'room-access', waitingRoom: true },
    ]);
  });
});

describe('the screens of a person at the door', () => {
  const baseState = {
    role: 'guest',
    companion: false,
    localStream: null,
    localName: 'Bo',
    remoteStream: null,
    remotePeers: [],
    messages: [],
    recordingError: null,
    backupBlobUrl: null,
    wavBackupBlobUrl: null,
    connectionWarning: null,
    takes: [],
  };

  for (const phase of ['connecting', 'waiting', 'peer-left']) {
    it(`says it is waiting for the host to let them in, without a spinner, in the ${phase} phase`, () => {
      fake = { state: { ...baseState, phase, door: 'waiting' }, hook: {} };
      const { container } = render(<RoomView slug="abc-defg-hij" />);
      expect(screen.getByRole('heading', { name: 'Waiting for the host to let you in' })).toBeInTheDocument();
      expect(screen.getByText('The host lets people in one at a time. Keep this tab open.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Leave' })).toBeInTheDocument();
      expect(container.querySelector('.animate-spin')).toBeNull();
    });
  }

  it('keeps the spinner of the plain connecting screen when there is no door', () => {
    fake = { state: { ...baseState, phase: 'connecting', door: null }, hook: {} };
    const { container } = render(<RoomView slug="abc-defg-hij" />);
    expect(screen.getByRole('heading', { name: 'Connecting…' })).toBeInTheDocument();
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  it('keeps the microphone and camera buttons', () => {
    const audio = { kind: 'audio', enabled: true };
    const video = { kind: 'video', enabled: true, getSettings: () => ({}) };
    const localStream = Object.assign(new EventTarget(), {
      getAudioTracks: () => [audio],
      getVideoTracks: () => [video],
    }) as unknown as MediaStream;
    const setMic = vi.fn();
    fake = { state: { ...baseState, phase: 'connecting', door: 'waiting', localStream }, hook: { setMic, setCam: vi.fn() } };
    render(<RoomView slug="abc-defg-hij" />);
    fireEvent.click(screen.getByRole('button', { name: 'Turn off microphone' }));
    expect(setMic).toHaveBeenCalledWith(false);
    expect(screen.getByRole('button', { name: 'Turn off camera' })).toBeInTheDocument();
  });

  it('says the host did not let them in, with a way to try again and a way home', () => {
    fake = { state: { ...baseState, phase: 'refused', refusal: 'refused', door: null }, hook: {} };
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.getByRole('heading', { name: 'The host didn’t let you in' })).toBeInTheDocument();
    expect(screen.getByText('Ask the host, then try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/');
  });

  it('says the waiting list is full, with a way to try again and a way home', () => {
    fake = { state: { ...baseState, phase: 'refused', refusal: 'busy', door: null }, hook: {} };
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.getByRole('heading', { name: 'Too many people are waiting' })).toBeInTheDocument();
    expect(screen.getByText('The room’s waiting list is full. Try again in a minute.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/');
  });
});

describe('Waiting room in the People panel', () => {
  it('is a second box, ticked from what the Room said, and a click asks for the opposite', () => {
    const onChange = vi.fn();
    render(<RoomAccess access={{ locked: true, waitingRoom: true, passcode: false, waiting: [] }} onChange={onChange} />);
    const box = screen.getByRole('checkbox', { name: 'Waiting room' });
    expect(box).toBeChecked();
    expect(box).toHaveAccessibleDescription('New people wait until you let them in.');
    expect(screen.getByRole('checkbox', { name: 'Lock the room' })).toBeChecked();

    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ waitingRoom: false });
    expect(box).toBeChecked();
  });

  it('is unticked while people walk in, and asks for the waiting room', () => {
    const onChange = vi.fn();
    render(<RoomAccess access={{ locked: false, waitingRoom: false, passcode: false, waiting: [] }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Waiting room' }));
    expect(onChange).toHaveBeenCalledWith({ waitingRoom: true });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Lock the room' }));
    expect(onChange).toHaveBeenLastCalledWith({ locked: true });
  });
});

describe('KnockNotice', () => {
  it('draws a row for a waiting person, and its buttons answer with the id', () => {
    const onAdmit = vi.fn();
    render(<KnockNotice role="host" waiting={[person()]} onAdmit={onAdmit} />);

    const row = screen.getByRole('status');
    expect(within(row).getByText('Wanda').tagName).toBe('BDI');
    expect(row).toHaveTextContent('Wanda wants to join');
    fireEvent.click(screen.getByRole('button', { name: 'Let Wanda in' }));
    expect(onAdmit).toHaveBeenLastCalledWith('w-1', true);
    fireEvent.click(screen.getByRole('button', { name: 'Refuse Wanda' }));
    expect(onAdmit).toHaveBeenLastCalledWith('w-1', false);
    expect(onAdmit).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Let Wanda in' })).toHaveTextContent('Let in');
    expect(screen.getByRole('button', { name: 'Let Wanda in' })).toHaveClass('min-h-11', 'bg-[#8ab4f8]');
    expect(screen.getByRole('button', { name: 'Refuse Wanda' })).toHaveClass('min-h-11');
    expect(screen.getByRole('button', { name: 'Refuse Wanda' })).not.toHaveClass('bg-[#8ab4f8]');
  });

  it('names a person with no name Guest, and a producer or a Present-only device as the People panel does', () => {
    render(
      <KnockNotice
        role="host"
        waiting={[
          person({ peerId: 'a', displayName: '' }),
          person({ peerId: 'b', displayName: 'Pia', role: 'producer' }),
          person({ peerId: 'c', displayName: 'Cam', companion: true }),
        ]}
        onAdmit={vi.fn()}
      />
    );
    const names = screen.getAllByRole('status').map((r) => r.querySelector('bdi')!.textContent);
    expect(names).toEqual(['Guest', 'Pia (Producer)', 'Cam (Presenting)']);
    expect(screen.getByRole('button', { name: 'Let Pia (Producer) in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refuse Guest' })).toBeInTheDocument();
  });

  it('draws three rows and “and 2 more waiting” for five people', () => {
    const five = Array.from({ length: 5 }, (_, i) => person({ peerId: `w-${i}`, displayName: `W${i}` }));
    render(<KnockNotice role="host" waiting={five} onAdmit={vi.fn()} />);
    expect(screen.getAllByRole('button', { name: /^Let .* in$/ })).toHaveLength(3);
    expect(screen.getByText('and 2 more waiting')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Let W3 in' })).toBeNull();
  });

  it('says nothing about more when three or fewer wait, and draws nothing when nobody does', () => {
    const three = Array.from({ length: 3 }, (_, i) => person({ peerId: `w-${i}`, displayName: `W${i}` }));
    const { container, rerender } = render(<KnockNotice role="host" waiting={three} onAdmit={vi.fn()} />);
    expect(screen.queryByText(/more waiting/)).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Let .* in$/ })).toHaveLength(3);

    rerender(<KnockNotice role="host" waiting={[]} onAdmit={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('draws nothing for a guest', () => {
    const { container } = render(<KnockNotice role="guest" waiting={[person()]} onAdmit={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('CallStage and the notice', () => {
  const stage = {
    phase: 'in-call' as const,
    localStream: null,
    remoteStream: null,
    remotePeers: [],
    remoteScreenStream: null,
    localScreenStream: null,
    localName: 'Ana',
    peerName: 'Bo',
    screenSharing: false,
    canRecord: false,
    roomRecording: false,
    recordBlocked: false,
    messages: [],
    peerPresence: null,
    screenShareSupported: true,
    backupUrl: null,
    wavBackupUrl: null,
    syncReportUrl: null,
    recordingError: null,
    recordUnavailableReason: null,
    onToggleMic: vi.fn(),
    onToggleCam: vi.fn(),
    onRecord: vi.fn(),
    onEnd: vi.fn(),
    onLeave: vi.fn(),
    onSendChat: vi.fn(),
    slug: 'abc-defg-hij',
    onMark: vi.fn(),
    markerCount: 0,
    chaptersUrl: null,
    summary: null,
    takes: [],
    onNewTake: vi.fn(),
    onDiscardTake: vi.fn(),
    onOpenMediaBoard: vi.fn(() => null),
    onToggleScreen: vi.fn(),
    capabilities: {},
  };
  const access = { locked: false, waitingRoom: true, passcode: false, waiting: [person()] };

  it('draws the row for a host, and passes the answer on', () => {
    const onAdmit = vi.fn();
    render(<CallStage {...stage} role="host" roomAccess={access} onAdmit={onAdmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Let Wanda in' }));
    expect(onAdmit).toHaveBeenCalledWith('w-1', true);
  });

  it('draws the row during a take too', () => {
    render(<CallStage {...stage} role="host" phase="recording" roomAccess={access} onAdmit={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Refuse Wanda' })).toBeInTheDocument();
  });

  it('draws no row for a guest', () => {
    render(<CallStage {...stage} role="guest" roomAccess={access} onAdmit={vi.fn()} />);
    expect(screen.queryByText('wants to join')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Let Wanda in' })).toBeNull();
  });

  it('draws no row when nobody waits', () => {
    render(<CallStage {...stage} role="host" roomAccess={{ ...access, waiting: [] }} onAdmit={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /^Let .* in$/ })).toBeNull();
  });

  it('is reached from the call screen: RoomView hands the host’s answer to admitPeer', () => {
    const admitPeer = vi.fn();
    fake = {
      state: {
        phase: 'in-call',
        role: 'host',
        companion: false,
        localStream: null,
        localName: 'Ana',
        remoteStream: null,
        remotePeers: [],
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
      },
      hook: { admitPeer },
    };
    render(<RoomView slug="abc-defg-hij" />);
    fireEvent.click(screen.getByRole('button', { name: 'Refuse Wanda' }));
    expect(admitPeer).toHaveBeenCalledWith('w-1', false);
  });
});
