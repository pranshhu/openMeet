import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, renderHook, act } from '@testing-library/react';
import { isServerMessage, isClientMessage, type ServerMessage } from '@openmeet/protocol';
import { RoomView } from '@/components/RoomView';
import { RoomAccess } from '@/components/RoomAccess';
import { PasscodeForm } from '@/components/PasscodeForm';
import { useRoom } from '@/hooks/useRoom';
import { readRoomAccess } from '@/lib/room-access';

/**
 * The room passcode as the page sees it. The network (signal, peer, REST) is
 * replaced for the hook and the screens; the client of the signalling socket
 * is tested on its own against a fake socket.
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

vi.mock('@/lib/signal', async () => {
  const actual = await vi.importActual<typeof import('@/lib/signal')>('@/lib/signal');
  return {
    ...actual,
    SignalClient: vi.fn().mockImplementation((opts: { onFatalClose?: (code: number, reason: string) => void }) => {
      fatalClose = opts.onFatalClose ?? null;
      return {
        connect: vi.fn(),
        close: vi.fn(),
        reconnect: vi.fn(),
        send: vi.fn((m: unknown) => sent.push(m)),
        rejoin: vi.fn((passcode: string) => sent.push({ rejoin: passcode })),
        on: vi.fn((type: string, h: (m: unknown) => void) => {
          (handlers[type] ??= []).push(h);
        }),
      };
    }),
  };
});

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

const { SignalClient: RealSignalClient } = await vi.importActual<typeof import('@/lib/signal')>('@/lib/signal');

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

beforeEach(() => {
  handlers = {};
  sent = [];
  fatalClose = null;
  fake = null;
});

class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeWS.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  fireOpen() {
    this.readyState = 1;
    this.onopen?.();
  }
  fireMessage(m: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  fireClose(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }
  joins() {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>).filter((m) => m.type === 'join');
  }
}

describe('SignalClient and the passcode', () => {
  beforeEach(() => {
    FakeWS.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const client = () =>
    new RealSignalClient({
      slug: 'xyz-abcd-pqr',
      wsBase: 'ws://localhost:8787',
      displayName: 'Alice',
      userAgent: 'ua',
      clientId: 'tab-1',
      wsFactory: () => new FakeWS() as unknown as WebSocket,
    });

  it('sends a first join with no passcode, and rejoin sends a join with it on the open socket', () => {
    const c = client();
    c.connect();
    const ws = FakeWS.instances[0]!;
    ws.fireOpen();
    expect(ws.joins()).toEqual([{ type: 'join', displayName: 'Alice', userAgent: 'ua', clientId: 'tab-1' }]);

    c.rejoin('tuesday7');
    expect(ws.joins()).toHaveLength(2);
    expect(ws.joins()[1]).toEqual({
      type: 'join',
      displayName: 'Alice',
      userAgent: 'ua',
      clientId: 'tab-1',
      passcode: 'tuesday7',
    });
    c.close();
  });

  it('carries the passcode in the join of a reconnect', () => {
    const c = client();
    c.connect();
    FakeWS.instances[0]!.fireOpen();
    c.rejoin('tuesday7');
    FakeWS.instances[0]!.fireClose();
    vi.advanceTimersByTime(60_000);
    const second = FakeWS.instances[1]!;
    second.fireOpen();
    expect(second.joins()[0]).toMatchObject({ type: 'join', passcode: 'tuesday7' });
    c.close();
  });

  it('forgets the passcode when the Room asks for one again, so a wrong one is not sent twice', () => {
    const c = client();
    c.connect();
    const first = FakeWS.instances[0]!;
    first.fireOpen();
    c.rejoin('wrong-one');
    first.fireMessage({ type: 'door', state: 'passcode', wrong: true });
    first.fireClose();
    vi.advanceTimersByTime(60_000);
    const second = FakeWS.instances[1]!;
    second.fireOpen();
    expect(second.joins()[0]).not.toHaveProperty('passcode');
    c.close();
  });

  it('keeps the passcode through a door that says waiting', () => {
    const c = client();
    c.connect();
    const first = FakeWS.instances[0]!;
    first.fireOpen();
    c.rejoin('tuesday7');
    first.fireMessage({ type: 'door', state: 'waiting' });
    first.fireClose();
    vi.advanceTimersByTime(60_000);
    const second = FakeWS.instances[1]!;
    second.fireOpen();
    expect(second.joins()[0]).toMatchObject({ passcode: 'tuesday7' });
    c.close();
  });
});

describe('the passcode in the protocol guards and readRoomAccess', () => {
  it('knows both door states and a join and room-access that carry a passcode', () => {
    expect(isServerMessage({ type: 'door', state: 'passcode', wrong: true })).toBe(true);
    expect(isClientMessage({ type: 'room-access', passcode: null })).toBe(true);
    expect(isClientMessage({ type: 'join', displayName: 'A', userAgent: 'u', passcode: 'tuesday7' })).toBe(true);
  });

  it('reads a passcode only from a message that says passcode: true', () => {
    expect(readRoomAccess({ locked: false, waitingRoom: false, passcode: true, waiting: [] }).passcode).toBe(true);
    for (const v of [false, 1, 'true', null, undefined, ['x'], 'tuesday7']) {
      expect(readRoomAccess({ passcode: v }).passcode).toBe(false);
    }
    expect(readRoomAccess(null).passcode).toBe(false);
  });
});

describe('the passcode in the hook', () => {
  it('maps the two door messages to two states, and role-assigned clears them', async () => {
    const result = await joinAs();
    emit('door', { type: 'door', state: 'passcode' });
    expect(result.current.state.door).toBe('passcode');
    emit('door', { type: 'door', state: 'passcode', wrong: true });
    expect(result.current.state.door).toBe('wrong-passcode');
    emit('door', { type: 'door', state: 'passcode', wrong: 'yes' });
    expect(result.current.state.door).toBe('passcode');
    emit('door', { type: 'door', state: 'passcode', wrong: true });
    emit('role-assigned', { type: 'role-assigned', role: 'guest', peerId: 'p-me', ordinal: 2, peers: [], recording: false });
    expect(result.current.state.door).toBeNull();
  });

  it('sends the passcode through the socket with sendPasscode', async () => {
    const result = await joinAs();
    sent = [];
    act(() => result.current.sendPasscode('tuesday7'));
    expect(sent).toEqual([{ rejoin: 'tuesday7' }]);
  });

  it('sends room-access with a passcode, or null', async () => {
    const result = await joinAs();
    emit('role-assigned', { type: 'role-assigned', role: 'host', peerId: 'p-me', ordinal: 2, peers: [], recording: false });
    sent = [];
    act(() => result.current.setRoomAccess({ passcode: 'tuesday7' }));
    act(() => result.current.setRoomAccess({ passcode: null }));
    expect(sent).toEqual([
      { type: 'room-access', passcode: 'tuesday7' },
      { type: 'room-access', passcode: null },
    ]);
  });

  it('keeps whether the host set a passcode', async () => {
    const result = await joinAs();
    emit('role-assigned', { type: 'role-assigned', role: 'host', peerId: 'p-me', ordinal: 2, peers: [], recording: false });
    emit('room-access', { type: 'room-access', locked: false, waitingRoom: false, passcode: true, waiting: [] });
    expect(result.current.state.access?.passcode).toBe(true);
  });

  it('reads the refusal of a room whose passcode was tried too often', async () => {
    const result = await joinAs();
    emit('door', { type: 'door', state: 'passcode', wrong: true });
    act(() => fatalClose!(4008, 'passcode'));
    expect(result.current.state.phase).toBe('refused');
    expect(result.current.state.refusal).toBe('passcode');
    expect(result.current.state.door).toBeNull();
  });
});

describe('the screens of a person asked for a passcode', () => {
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
    it(`draws the form, with the focus in the field and no spinner, in the ${phase} phase`, () => {
      fake = { state: { ...baseState, phase, door: 'passcode' }, hook: {} };
      const { container } = render(<RoomView slug="abc-defg-hij" />);
      expect(screen.getByRole('heading', { name: 'This room needs a passcode' })).toBeInTheDocument();
      expect(screen.getByText('Ask the host for it.')).toBeInTheDocument();
      const field = screen.getByLabelText('Passcode');
      expect(field).toHaveAttribute('type', 'password');
      expect(field).toHaveFocus();
      expect(screen.getByRole('button', { name: 'Join' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Leave' })).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(container.querySelector('.animate-spin')).toBeNull();
    });
  }

  it('says the passcode was not right after a wrong one', () => {
    fake = { state: { ...baseState, phase: 'connecting', door: 'wrong-passcode' }, hook: {} };
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.getByRole('alert')).toHaveTextContent('That passcode isn’t right. Try again.');
    expect(screen.getByLabelText('Passcode')).toHaveValue('');
    expect(screen.getByLabelText('Passcode')).toHaveFocus();
  });

  it('hands what was typed to sendPasscode', () => {
    const sendPasscode = vi.fn();
    fake = { state: { ...baseState, phase: 'connecting', door: 'passcode' }, hook: { sendPasscode } };
    render(<RoomView slug="abc-defg-hij" />);
    fireEvent.change(screen.getByLabelText('Passcode'), { target: { value: 'tuesday7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(sendPasscode).toHaveBeenCalledTimes(1);
    expect(sendPasscode).toHaveBeenCalledWith('tuesday7');
  });

  it('does not draw the form while the host is asked to let the person in', () => {
    fake = { state: { ...baseState, phase: 'connecting', door: 'waiting' }, hook: {} };
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.queryByLabelText('Passcode')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Waiting for the host to let you in' })).toBeInTheDocument();
  });

  for (const phase of ['in-call', 'recording']) {
    it(`keeps the call screen of a person in the ${phase} phase, with no field`, () => {
      fake = {
        state: {
          ...baseState,
          phase,
          door: 'passcode',
          remoteScreenStream: null,
          localScreenStream: null,
          screenSharing: false,
          peerRecording: false,
          capabilities: {},
          finalizingGuests: [],
          markers: [],
          summary: null,
          syncReportUrl: null,
          chaptersUrl: null,
          drained: true,
          sidecarsSaved: false,
          access: null,
        },
        hook: {},
      };
      render(<RoomView slug="abc-defg-hij" />);
      expect(screen.queryByLabelText('Passcode')).toBeNull();
      expect(screen.queryByRole('heading', { name: 'This room needs a passcode' })).toBeNull();
    });
  }

  it('says too many wrong passcodes, with a way to try again and a way home', () => {
    fake = { state: { ...baseState, phase: 'refused', refusal: 'passcode', door: null }, hook: {} };
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.getByRole('heading', { name: 'Too many wrong passcodes' })).toBeInTheDocument();
    expect(screen.getByText('Wait ten minutes, then try again, or ask the host.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/');
  });
});

describe('PasscodeForm', () => {
  it('submits what was typed, empties the field and keeps the focus in it', () => {
    const onSubmit = vi.fn();
    render(<PasscodeForm wrong={false} onSubmit={onSubmit} />);
    const field = screen.getByLabelText('Passcode');
    expect(field).toHaveAttribute('maxlength', '64');
    expect(field).toHaveAttribute('autocomplete', 'off');
    fireEvent.change(field, { target: { value: 'tuesday7' } });
    expect(screen.getByRole('button', { name: 'Join' })).toBeEnabled();
    screen.getByRole('button', { name: 'Join' }).focus();
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('tuesday7');
    expect(field).toHaveValue('');
    expect(field).toHaveFocus();
  });

  it('submits on Enter, and does not submit an empty field', () => {
    const onSubmit = vi.fn();
    render(<PasscodeForm wrong={false} onSubmit={onSubmit} />);
    const field = screen.getByLabelText('Passcode');
    fireEvent.submit(field.closest('form')!);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: 'tuesday7' } });
    fireEvent.submit(field.closest('form')!);
    expect(onSubmit).toHaveBeenCalledWith('tuesday7');
  });

  it('has a field and a button 44 px tall, side by side', () => {
    render(<PasscodeForm wrong={false} onSubmit={vi.fn()} />);
    const field = screen.getByLabelText('Passcode');
    const join = screen.getByRole('button', { name: 'Join' });
    expect(field).toHaveClass('h-11');
    expect(join).toHaveClass('h-11');
    expect(field.parentElement).toBe(join.parentElement);
    expect(field.parentElement).toHaveClass('flex');
  });
});

describe('Passcode in the People panel', () => {
  const none = { locked: false, waitingRoom: false, passcode: false, waiting: [] };

  it('shows a field and a Set passcode button, disabled under six characters, while none is set', () => {
    const onChange = vi.fn();
    render(<RoomAccess access={none} onChange={onChange} />);
    const field = screen.getByLabelText('Passcode');
    expect(field).toHaveAttribute('type', 'text');
    expect(field).toHaveAttribute('maxlength', '64');
    expect(field).toHaveAttribute('autocomplete', 'off');
    expect(field).toHaveAccessibleDescription('6 to 64 characters. Guests type it before they join.');
    expect(screen.queryByRole('button', { name: 'Remove passcode' })).toBeNull();

    const set = screen.getByRole('button', { name: 'Set passcode' });
    fireEvent.change(field, { target: { value: 'abcde' } });
    expect(set).toBeDisabled();
    fireEvent.click(set);
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: 'abcdef' } });
    expect(set).toBeEnabled();
    fireEvent.click(set);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ passcode: 'abcdef' });
  });

  it('keeps showing the field after a click, until the Room says a passcode is set, and then empties it', () => {
    const { rerender } = render(<RoomAccess access={none} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Passcode'), { target: { value: 'abcdef' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set passcode' }));
    expect(screen.getByLabelText('Passcode')).toHaveValue('abcdef');

    rerender(<RoomAccess access={{ ...none, passcode: true }} onChange={vi.fn()} />);
    expect(screen.queryByLabelText('Passcode')).toBeNull();
    rerender(<RoomAccess access={none} onChange={vi.fn()} />);
    expect(screen.getByLabelText('Passcode')).toHaveValue('');
  });

  it('says a passcode is set, and Remove passcode asks for null', () => {
    const onChange = vi.fn();
    render(<RoomAccess access={{ ...none, passcode: true }} onChange={onChange} />);
    expect(screen.getByText('A passcode is set. openMeet can’t show it again.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Passcode')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set passcode' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove passcode' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ passcode: null });
    expect(screen.getByText('A passcode is set. openMeet can’t show it again.')).toBeInTheDocument();
  });
});
