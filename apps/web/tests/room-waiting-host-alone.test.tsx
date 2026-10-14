import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { WaitingPerson } from '@openmeet/protocol';
import { RoomView } from '@/components/RoomView';
import { WaitingRoom } from '@/components/WaitingRoom';
import { CallStage } from '@/components/CallStage';

/**
 * What a host sees while alone: the people at the door and the room controls,
 * on the waiting screen and in the People panel. RoomView is drawn with the
 * hook replaced by a fixed state.
 */

let state: Record<string, unknown>;
let hook: Record<string, unknown>;

vi.mock('@/hooks/useRoom', () => ({
  useRoom: () => ({ state, join: vi.fn(), leave: vi.fn(), setMic: vi.fn(), setCam: vi.fn(), ...hook }),
}));

const stream = Object.assign(new EventTarget(), {
  getTracks: () => [],
  getAudioTracks: () => [],
  getVideoTracks: () => [],
}) as unknown as MediaStream;

const person = (over: Partial<WaitingPerson> = {}): WaitingPerson => ({
  peerId: 'w-1',
  displayName: 'Wanda',
  role: 'guest',
  ...over,
});

const access = (waiting: WaitingPerson[] = [person()]) => ({ locked: false, waitingRoom: true, passcode: false, waiting });

beforeEach(() => {
  hook = { admitPeer: vi.fn(), setRoomAccess: vi.fn() };
  state = {
    phase: 'waiting',
    door: null,
    role: 'host',
    companion: false,
    localStream: stream,
    localName: 'Ana',
    connectionWarning: null,
    takes: [],
    remotePeers: [],
    remoteStream: null,
    access: access(),
  };
});

describe('WaitingRoom extra', () => {
  const props = { role: 'host' as const, localStream: stream, localName: 'Ana', onLeave: vi.fn() };

  it('draws what it is given under the buttons', () => {
    render(<WaitingRoom {...props} extra={<p>Extra line</p>} />);
    const leave = screen.getByRole('button', { name: 'Leave' });
    const extra = screen.getByText('Extra line');
    expect(leave.compareDocumentPosition(extra) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(extra.closest('main')?.contains(leave)).toBe(true);
    expect(extra.parentElement).toHaveClass('items-center', 'lg:items-start');
  });

  it('has no extra container without it', () => {
    const { container } = render(<WaitingRoom {...props} />);
    const plain = container.querySelectorAll('*').length;
    const { container: withExtra } = render(<WaitingRoom {...props} extra={<p>Extra line</p>} />);
    // The line itself and the one container around it.
    expect(withExtra.querySelectorAll('*').length).toBe(plain + 2);
  });
});

describe.each(['waiting', 'peer-left'] as const)('a host alone, phase %s', (phase) => {
  beforeEach(() => {
    state.phase = phase;
  });

  it('sees who is waiting and the room controls, and answers them through the hook', () => {
    render(<RoomView slug="abc-defg-hij" />);

    expect(screen.getByText('Wanda')).toBeInTheDocument();
    expect(screen.getByText('wants to join')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Waiting room' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Lock the room' })).not.toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Let Wanda in' }));
    expect(hook.admitPeer).toHaveBeenCalledWith('w-1', true);
    fireEvent.click(screen.getByRole('button', { name: 'Refuse Wanda' }));
    expect(hook.admitPeer).toHaveBeenLastCalledWith('w-1', false);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Waiting room' }));
    expect(hook.setRoomAccess).toHaveBeenCalledWith({ waitingRoom: false });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Lock the room' }));
    expect(hook.setRoomAccess).toHaveBeenLastCalledWith({ locked: true });
  });

  it('shows the controls alone when nobody waits', () => {
    state.access = access([]);
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.queryByText('wants to join')).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Waiting room' })).toBeInTheDocument();
  });

  it('shows a guest neither the rows nor the controls', () => {
    Object.assign(state, { role: 'guest', access: access() });
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.queryByText('wants to join')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Let .* in/ })).toBeNull();
  });

  it('shows a host the Room has sent no access neither', () => {
    state.access = null;
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.queryByText('wants to join')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});

describe('a host connecting', () => {
  it('sees the rows and the controls under the spinner’s note', () => {
    state.phase = 'connecting';
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.getByRole('heading', { name: 'Connecting…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Let Wanda in' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Waiting room' })).toBeInTheDocument();
  });
});

describe('CallStage with nobody else in the call', () => {
  const baseProps = {
    role: 'host' as const,
    phase: 'in-call' as const,
    localStream: null,
    remoteStream: null,
    remotePeers: [],
    remoteScreenStream: null,
    localScreenStream: null,
    localName: 'Ana',
    peerName: null,
    screenSharing: false,
    canRecord: true,
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
    onMutePeer: vi.fn(),
    onRoomAccess: vi.fn(),
    onAdmit: vi.fn(),
  };

  it('offers People to a host with room access, and the panel holds the controls alone', () => {
    render(<CallStage {...baseProps} roomAccess={access([])} />);
    fireEvent.click(screen.getByRole('button', { name: 'People' }));
    const panel = screen.getByRole('region', { name: 'People' });
    expect(within(panel).getByRole('checkbox', { name: 'Lock the room' })).toBeInTheDocument();
    expect(within(panel).getByRole('checkbox', { name: 'Waiting room' })).toBeInTheDocument();
    expect(within(panel).queryByRole('listitem')).toBeNull();
  });

  it('offers no People button without room access', () => {
    render(<CallStage {...baseProps} />);
    expect(screen.queryByRole('button', { name: 'People' })).toBeNull();
  });

  it('says how many wait on the People button, and keeps Hide people while open', () => {
    render(
      <CallStage
        {...baseProps}
        roomAccess={access([person(), person({ peerId: 'w-2', displayName: 'Walt' })])}
      />
    );
    const button = screen.getByRole('button', { name: 'People, 2 waiting to join' });
    expect(within(button).getByTestId('badge')).toBeInTheDocument();
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: 'Hide people' })).toBeInTheDocument();
  });

  it('names the button People, with no dot, while nobody waits', () => {
    render(<CallStage {...baseProps} roomAccess={access([])} />);
    expect(within(screen.getByRole('button', { name: 'People' })).queryByTestId('badge')).toBeNull();
  });
});
