import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup, act } from '@testing-library/react';
import { RoomView } from '@/components/RoomView';
import { PeoplePanel } from '@/components/PeoplePanel';
import { CallStage } from '@/components/CallStage';
import { parseViewLink } from '@/lib/view-link';
import type { RemotePeer } from '@/hooks/useRoom';
import type { HelpAsk } from '@openmeet/protocol';

/**
 * The host's controls over the other people in the call, and what the person
 * on the other end sees. RoomView is drawn with the hook replaced by a fixed
 * state, so the path from the hook to the buttons is what is tested.
 */

let state: Record<string, unknown>;
let hook: Record<string, unknown>;

vi.mock('@/hooks/useRoom', () => ({
  useRoom: () => ({ state, join: vi.fn(), leave: vi.fn(), setMic: vi.fn(), setCam: vi.fn(), ...hook }),
}));

const mic = (micOn: boolean) => ({ micOn, camOn: true, screenSharing: false });
const bo: RemotePeer = { peerId: 'p-bo', name: 'Bo', stream: null, role: 'guest', presence: mic(true) };

beforeEach(() => {
  hook = {};
  state = {
    phase: 'in-call',
    role: 'host',
    companion: false,
    localStream: null,
    localName: 'Ana',
    remoteStream: null,
    remotePeers: [bo],
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
  };
});

describe('the host mutes a person', () => {
  it('opens People from the control bar and hands the mute to the room', () => {
    hook.mutePeer = vi.fn();
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.queryByRole('region', { name: 'People' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'People' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mute Bo' }));
    expect(hook.mutePeer).toHaveBeenCalledTimes(1);
    expect(hook.mutePeer).toHaveBeenCalledWith('p-bo');

    fireEvent.click(screen.getByRole('button', { name: 'Hide people' }));
    expect(screen.queryByRole('region', { name: 'People' })).toBeNull();
  });

  it('is offered to the host only, and only while someone else is in the call', () => {
    hook.mutePeer = vi.fn();
    Object.assign(state, { role: 'guest' });
    const { unmount } = render(<RoomView slug="abc-defg-hij" />);
    expect(screen.queryByRole('button', { name: 'People' })).toBeNull();
    unmount();

    Object.assign(state, { role: 'host', remotePeers: [] });
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.queryByRole('button', { name: 'People' })).toBeNull();
  });

  // On a phone the two panels sit in the same place.
  it('shares its place with the media board: opening one closes the other', () => {
    hook.mutePeer = vi.fn();
    hook.openMediaBoard = vi.fn(() => null);
    render(<RoomView slug="abc-defg-hij" />);

    fireEvent.click(screen.getByRole('button', { name: 'Media board' }));
    expect(screen.getByRole('button', { name: 'Close media board' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'People' }));
    expect(screen.queryByRole('button', { name: 'Close media board' })).toBeNull();
    expect(screen.getByRole('region', { name: 'People' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Media board' }));
    expect(screen.queryByRole('region', { name: 'People' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close media board' })).toBeInTheDocument();
  });
});

describe('the People panel in the call', () => {
  it('is closed by its own close button, which hands focus back to People', async () => {
    hook.mutePeer = vi.fn();
    render(<RoomView slug="abc-defg-hij" />);
    fireEvent.click(screen.getByRole('button', { name: 'People' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close people' }));
    expect(screen.queryByRole('region', { name: 'People' })).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'People' })).toHaveFocus());
  });
});

describe('a person the host muted', () => {
  it('sees the microphone off and is told, and their own button turns it back on', () => {
    const audio = { kind: 'audio', enabled: true };
    // An EventTarget: the tile that draws it listens on the stream.
    const stream = Object.assign(new EventTarget(), {
      getAudioTracks: () => [audio],
      getVideoTracks: () => [],
    }) as unknown as MediaStream;
    hook.setMic = vi.fn();
    Object.assign(state, { role: 'guest', localStream: stream, hostMuted: false });
    const { rerender } = render(<RoomView slug="abc-defg-hij" />);
    expect(screen.getByRole('button', { name: 'Turn off microphone' })).toBeInTheDocument();
    expect(screen.queryByText(/The host muted your microphone/)).toBeNull();

    state = { ...state, hostMuted: true };
    rerender(<RoomView slug="abc-defg-hij" />);
    const note = screen.getByText('The host muted your microphone. Turn it back on when you want to speak.');
    expect(note).toHaveAttribute('role', 'status');
    fireEvent.click(screen.getByRole('button', { name: 'Turn on microphone' }));
    expect(hook.setMic).toHaveBeenCalledWith(true);
  });

  it('is told during their own capture that the recording has no sound', () => {
    Object.assign(state, { role: 'guest', phase: 'recording', peerRecording: true, hostMuted: true });
    render(<RoomView slug="abc-defg-hij" />);
    expect(
      screen.getByText('The host muted your microphone. Your recording has no sound until you turn it back on.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/Turn it back on when you want to speak/)).toBeNull();
  });
});

describe('PeoplePanel', () => {
  const people: RemotePeer[] = [
    { peerId: 'p-ana', name: 'Ana', stream: null, role: 'guest', presence: mic(true) },
    { peerId: 'p-bo', name: 'Bo', stream: null, role: 'guest', presence: mic(false) },
    { peerId: 'p-cy', name: 'Cy', stream: null, role: 'producer' },
    { peerId: 'p-di', name: 'Di', stream: null, role: 'guest', companion: true },
    { peerId: 'p-new', name: null, stream: null, role: 'guest' },
  ];

  it('lists everyone else, and asks for the microphone of the person whose Mute is pressed', () => {
    const onMute = vi.fn();
    render(<PeoplePanel people={people} onMute={onMute} onClose={vi.fn()} />);

    const panel = screen.getByRole('region', { name: 'People' });
    expect(within(panel).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'AnaMuteView link',
      'BoMutedView link',
      'Cy (Producer)',
      'Di (Presenting)',
      'GuestMute',
    ]);

    fireEvent.click(within(panel).getByRole('button', { name: 'Mute Ana' }));
    expect(onMute).toHaveBeenCalledTimes(1);
    expect(onMute).toHaveBeenCalledWith('p-ana');
  });

  it('asks nothing of a person who is muted already', () => {
    const onMute = vi.fn();
    render(<PeoplePanel people={people} onMute={onMute} onClose={vi.fn()} />);

    const muted = screen.getByRole('button', { name: 'Bo is muted' });
    expect(muted).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(muted);
    expect(onMute).not.toHaveBeenCalled();
  });

  it('takes focus when it opens, and its close button closes it', () => {
    const onClose = vi.fn();
    render(<PeoplePanel people={people} onMute={vi.fn()} onClose={onClose} />);

    const close = screen.getByRole('button', { name: 'Close people' });
    expect(close).toHaveFocus();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('acts on the person whose row is pressed, not on the first', () => {
    const onMute = vi.fn();
    const onRemove = vi.fn();
    render(<PeoplePanel people={people} onMute={onMute} onRemove={onRemove} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Mute Guest' }));
    expect(onMute).toHaveBeenCalledTimes(1);
    expect(onMute).toHaveBeenCalledWith('p-new');

    fireEvent.click(screen.getByRole('button', { name: 'Remove Di' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Di from the call' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith('p-di');
  });
});

describe('the host removes a person', () => {
  it('asks in the row first, and hands the removal to the room only on the second Remove', () => {
    hook.mutePeer = vi.fn();
    hook.removePeer = vi.fn();
    render(<RoomView slug="abc-defg-hij" />);
    fireEvent.click(screen.getByRole('button', { name: 'People' }));

    fireEvent.click(screen.getByRole('button', { name: 'Remove Bo' }));
    expect(hook.removePeer).not.toHaveBeenCalled();
    expect(screen.getByText('Remove Bo? Their tab can’t rejoin this call.')).toBeInTheDocument();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Remove Bo from the call' });
    expect(cancel).toHaveFocus();
    // Cancel is last, at the row's right end where Remove was: a second click there never confirms.
    expect(confirm.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(cancel);
    expect(hook.removePeer).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Remove Bo\?/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Bo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Bo from the call' }));
    expect(hook.removePeer).toHaveBeenCalledTimes(1);
    expect(hook.removePeer).toHaveBeenCalledWith('p-bo');
    expect(screen.queryByText(/^Remove Bo\?/)).toBeNull();
  });

  // A producer is in no file, and neither is a guest the host set as not recorded.
  it('says during a take that a recorded person’s recording ends here, and only theirs', () => {
    hook.mutePeer = vi.fn();
    hook.removePeer = vi.fn();
    const cy: RemotePeer = { peerId: 'p-cy', name: 'Cy', stream: null, role: 'producer' };
    const di: RemotePeer = { peerId: 'p-di', name: 'Di', stream: null, role: 'guest', notRecorded: true };
    Object.assign(state, { phase: 'recording', peerRecording: true, remotePeers: [bo, cy, di] });
    render(<RoomView slug="abc-defg-hij" />);
    fireEvent.click(screen.getByRole('button', { name: 'People' }));

    fireEvent.click(screen.getByRole('button', { name: 'Remove Bo' }));
    expect(
      screen.getByText('Remove Bo? Their recording here ends now, and their tab can’t rejoin this call.')
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: 'Remove Cy' }));
    expect(screen.getByText('Remove Cy? Their tab can’t rejoin this call.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: 'Remove Di' }));
    expect(screen.getByText('Remove Di? Their tab can’t rejoin this call.')).toBeInTheDocument();
  });

  // After a host reload the guests are still capturing the take the host can resume.
  it('says so too while an interrupted take can still be resumed', () => {
    hook.mutePeer = vi.fn();
    hook.removePeer = vi.fn();
    Object.assign(state, { resumeOffer: { take: 1, canResume: true } });
    render(<RoomView slug="abc-defg-hij" />);
    fireEvent.click(screen.getByRole('button', { name: 'People' }));

    fireEvent.click(screen.getByRole('button', { name: 'Remove Bo' }));
    expect(
      screen.getByText('Remove Bo? Their recording here ends now, and their tab can’t rejoin this call.')
    ).toBeInTheDocument();
  });
});

describe('PeoplePanel: the host asks a person for help', () => {
  const people: RemotePeer[] = [
    { peerId: 'p-ana', name: 'Ana', stream: null, role: 'guest', presence: mic(true) },
    { peerId: 'p-cy', name: 'Cy', stream: null, role: 'producer' },
    { peerId: 'p-di', name: 'Di', stream: null, role: 'guest', companion: true },
  ];
  const panel = (onAsk?: (peerId: string, ask: HelpAsk) => boolean) => (
    <PeoplePanel people={people} onMute={vi.fn()} onRemove={vi.fn()} onAsk={onAsk} onClose={vi.fn()} />
  );

  it('asks for a restart of the row that was pressed, and says the person answers on their own screen', () => {
    const onAsk = vi.fn().mockReturnValue(true);
    render(panel(onAsk));

    fireEvent.click(screen.getByRole('button', { name: 'Help Ana' }));
    expect(screen.getByText('Ask Ana to:')).toBeInTheDocument();
    expect(onAsk).not.toHaveBeenCalled();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const restart = screen.getByRole('button', { name: 'Restart connection' });
    expect(cancel).toHaveFocus();
    expect(restart.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // On a narrow screen the buttons go to a second line instead of out of the panel.
    expect(restart.parentElement).toHaveClass('flex-wrap');

    fireEvent.click(restart);
    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(onAsk).toHaveBeenCalledWith('p-ana', 'reconnect');
    expect(screen.queryByText('Ask Ana to:')).toBeNull();
    expect(screen.getByRole('button', { name: 'Help Ana' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Asked Ana. They answer on their own screen.');
  });

  it('asks for the person whose Help was pressed, not the first', () => {
    const onAsk = vi.fn().mockReturnValue(true);
    render(panel(onAsk));

    fireEvent.click(screen.getByRole('button', { name: 'Help Di' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restart connection' }));
    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(onAsk).toHaveBeenCalledWith('p-di', 'reconnect');
  });

  it('says so when the ask did not go out', () => {
    render(panel(vi.fn().mockReturnValue(false)));

    fireEvent.click(screen.getByRole('button', { name: 'Help Ana' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restart connection' }));
    expect(screen.getByRole('status')).toHaveTextContent('Could not ask Ana. Try again.');
  });

  it('keeps only the line of the latest ask', () => {
    render(panel(vi.fn().mockReturnValueOnce(false).mockReturnValue(true)));

    fireEvent.click(screen.getByRole('button', { name: 'Help Ana' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restart connection' }));
    fireEvent.click(screen.getByRole('button', { name: 'Help Di' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restart connection' }));
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Asked Di. They answer on their own screen.');
  });

  it('asks nothing on Cancel and shows no line', () => {
    const onAsk = vi.fn();
    render(panel(onAsk));

    fireEvent.click(screen.getByRole('button', { name: 'Help Ana' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onAsk).not.toHaveBeenCalled();
    expect(screen.queryByText('Ask Ana to:')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('offers Help between Mute and Remove, on a producer’s and a present-only device’s row too', () => {
    render(panel(vi.fn()));

    const rows = screen.getAllByRole('listitem');
    expect(rows.map((li) => li.textContent)).toEqual([
      'AnaMuteHelpView linkRemove',
      'Cy (Producer)HelpRemove',
      'Di (Presenting)HelpRemove',
    ]);
    expect(screen.getByRole('button', { name: 'Help Cy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Help Di' })).toBeInTheDocument();
  });

  it('offers no Help without a way to ask', () => {
    render(panel(undefined));
    expect(screen.queryByRole('button', { name: /^Help / })).toBeNull();
  });

  it('shows one swapped row at a time: Help closes a Remove question and the other way round', () => {
    render(panel(vi.fn()));

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ana' }));
    expect(screen.getByText(/^Remove Ana\?/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ana' }));
    fireEvent.click(screen.getByRole('button', { name: 'Help Cy' }));
    expect(screen.queryByText(/^Remove Ana\?/)).toBeNull();
    expect(screen.getByText('Ask Cy to:')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Help Cy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ana' }));
    expect(screen.queryByText('Ask Cy to:')).toBeNull();
    expect(screen.getByText(/^Remove Ana\?/)).toBeInTheDocument();
  });

  it('opens from the call screen and hands the ask to the room', () => {
    hook.mutePeer = vi.fn();
    hook.askPeer = vi.fn().mockReturnValue(true);
    render(<RoomView slug="abc-defg-hij" />);
    fireEvent.click(screen.getByRole('button', { name: 'People' }));

    fireEvent.click(screen.getByRole('button', { name: 'Help Bo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restart connection' }));
    expect(hook.askPeer).toHaveBeenCalledTimes(1);
    expect(hook.askPeer).toHaveBeenCalledWith('p-bo', 'reconnect');
  });
});

describe('the person asked to restart their connection', () => {
  const question = 'The host asks you to restart your connection. The call drops for a few seconds.';

  beforeEach(() => {
    Object.assign(state, { role: 'guest', helpAsk: 'reconnect' });
  });

  it('reads the question, restarts only on Restart, and drops it on Not now', () => {
    hook.restartConnection = vi.fn();
    hook.dismissHelpAsk = vi.fn();
    render(<RoomView slug="abc-defg-hij" />);

    expect(screen.getByText(question)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(question);
    expect(screen.queryByText(/Your recording goes on/)).toBeNull();
    expect(hook.restartConnection).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(hook.dismissHelpAsk).toHaveBeenCalledTimes(1);
    expect(hook.restartConnection).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(hook.restartConnection).toHaveBeenCalledTimes(1);
  });

  it('puts Restart before Not now', () => {
    render(<RoomView slug="abc-defg-hij" />);
    const restart = screen.getByRole('button', { name: 'Restart' });
    const notNow = screen.getByRole('button', { name: 'Not now' });
    expect(restart.compareDocumentPosition(notNow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // At least 44 px tall below the sm width.
    expect(restart).toHaveClass('min-h-11');
    expect(notNow).toHaveClass('min-h-11');
  });

  it('says during a take that the recording goes on', () => {
    Object.assign(state, { phase: 'recording' });
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.getByText(`${question} Your recording goes on.`)).toBeInTheDocument();
  });

  it('is not drawn while the take is being finished, nor when nothing was asked', () => {
    Object.assign(state, { phase: 'finalizing' });
    const { unmount } = render(<RoomView slug="abc-defg-hij" />);
    expect(screen.queryByText(question)).toBeNull();
    unmount();

    Object.assign(state, { phase: 'in-call', helpAsk: null });
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.queryByText(question)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull();
  });
});

describe('PeoplePanel: the host asks a person to switch microphone or camera', () => {
  const people: RemotePeer[] = [
    { peerId: 'p-ana', name: 'Ana', stream: null, role: 'guest', presence: mic(true) },
    { peerId: 'p-cy', name: 'Cy', stream: null, role: 'producer' },
    { peerId: 'p-di', name: 'Di', stream: null, role: 'guest', companion: true },
  ];
  const open = (name: string, onAsk = vi.fn().mockReturnValue(true)) => {
    render(<PeoplePanel people={people} onMute={vi.fn()} onRemove={vi.fn()} onAsk={onAsk} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: `Help ${name}` }));
    return onAsk;
  };

  it("offers a guest the three asks, each sending its own code, in that order, then Cancel", () => {
    for (const [button, code] of [
      ['Switch microphone', 'microphone'],
      ['Switch camera', 'camera'],
      ['Restart connection', 'reconnect'],
    ] as const) {
      const onAsk = open('Ana');
      const row = screen.getByRole('button', { name: 'Cancel' }).parentElement!;
      expect(Array.from(row.children).map((b) => b.textContent)).toEqual([
        'Switch microphone',
        'Switch camera',
        'Restart connection',
        'Cancel',
      ]);
      fireEvent.click(screen.getByRole('button', { name: button }));
      expect(onAsk).toHaveBeenCalledTimes(1);
      expect(onAsk).toHaveBeenCalledWith('p-ana', code);
      expect(screen.getByRole('status')).toHaveTextContent('Asked Ana. They answer on their own screen.');
      cleanup();
    }
  });

  it('wraps the four buttons inside the panel, each at least 44 px tall on a phone', () => {
    open('Ana');
    for (const name of ['Switch microphone', 'Switch camera', 'Restart connection', 'Cancel']) {
      expect(screen.getByRole('button', { name })).toHaveClass('min-h-11');
    }
    expect(screen.getByRole('button', { name: 'Switch camera' }).parentElement).toHaveClass('flex-wrap');
  });

  it('offers a producer and a present-only device the restart alone', () => {
    for (const name of ['Cy', 'Di']) {
      open(name);
      expect(screen.getByRole('button', { name: 'Restart connection' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Switch microphone' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Switch camera' })).toBeNull();
      cleanup();
    }
  });
});

describe('the person asked to switch microphone or camera', () => {
  const callStageProps = {
    role: 'guest' as const,
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
  const device = (deviceId: string, kind: MediaDeviceKind, label: string) =>
    ({ deviceId, kind, label, groupId: deviceId, toJSON: () => ({}) }) as MediaDeviceInfo;

  beforeEach(() => {
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue([
          device('mic-1', 'audioinput', 'Desk Mic'),
          device('mic-2', 'audioinput', 'USB Mic'),
          device('cam-1', 'videoinput', 'Built-in Camera'),
          device('cam-2', 'videoinput', 'Webcam'),
        ]),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const draw = (ask: HelpAsk, extra: Record<string, unknown> = {}) => {
    const onDismissHelpAsk = vi.fn();
    const onSwitchMic = vi.fn().mockResolvedValue(undefined);
    const onSwitchCamera = vi.fn().mockResolvedValue(undefined);
    render(
      <CallStage
        {...callStageProps}
        helpAsk={ask}
        onDismissHelpAsk={onDismissHelpAsk}
        onSwitchMic={onSwitchMic}
        onSwitchCamera={onSwitchCamera}
        {...extra}
      />
    );
    return { onDismissHelpAsk, onSwitchMic, onSwitchCamera };
  };

  it.each([
    ['microphone', 'Choose microphone', 'Select microphone', 'Desk Mic', 'USB Mic'],
    ['camera', 'Choose camera', 'Select camera', 'Built-in Camera', 'Webcam'],
  ] as const)(
    'reads the %s question, opens only its own list on Choose, and switches only on a press in it',
    async (ask, choose, arrow, first, second) => {
      const { onDismissHelpAsk, onSwitchMic, onSwitchCamera } = draw(ask);
      await act(async () => {});

      expect(screen.getByText(`The host asks you to switch ${ask}.`)).toBeInTheDocument();
      const choice = screen.getByRole('button', { name: choose });
      const notNow = screen.getByRole('button', { name: 'Not now' });
      expect(choice.compareDocumentPosition(notNow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(choice).toHaveClass('min-h-11');
      expect(screen.queryByRole('menu')).toBeNull();

      fireEvent.click(choice);
      expect(onDismissHelpAsk).toHaveBeenCalledTimes(1);
      expect(screen.getAllByRole('menu')).toHaveLength(1);
      expect(screen.getByRole('button', { name: arrow })).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('menuitemradio', { name: first })).toBeInTheDocument();
      expect(screen.getByRole('menuitemradio', { name: second })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: arrow })).toHaveFocus();
      expect(onSwitchMic).not.toHaveBeenCalled();
      expect(onSwitchCamera).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('menuitemradio', { name: second }));
      const [switched, other] = ask === 'microphone' ? [onSwitchMic, onSwitchCamera] : [onSwitchCamera, onSwitchMic];
      expect(switched).toHaveBeenCalledTimes(1);
      expect(switched).toHaveBeenCalledWith(ask === 'microphone' ? 'mic-2' : 'cam-2');
      expect(other).not.toHaveBeenCalled();
    }
  );

  it('keeps the list open when another list was open and the click lands outside the control bar', async () => {
    draw('camera');
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Select microphone' }));
    expect(screen.getByRole('menuitemradio', { name: 'Desk Mic' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Choose camera' }));
    expect(screen.getByRole('menuitemradio', { name: 'Webcam' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitemradio', { name: 'Desk Mic' })).toBeNull();
  });

  it.each(['Choose what to present', 'Choose who is recorded'])(
    'closes the list that %s opened when it opens its own',
    async (opener) => {
      draw('microphone', {
        role: 'host',
        canRecord: true,
        remoteStream: new EventTarget() as unknown as MediaStream,
        remotePeers: [{ peerId: 'p-bo', name: 'Bo', stream: null, role: 'guest' }],
        onSetPeerRecorded: vi.fn(),
      });
      await act(async () => {});
      fireEvent.click(screen.getByRole('button', { name: opener }));
      expect(screen.getAllByRole('menu')).toHaveLength(1);

      fireEvent.click(screen.getByRole('button', { name: 'Choose microphone' }));
      const menus = screen.getAllByRole('menu');
      expect(menus).toHaveLength(1);
      expect(within(menus[0]!).getByRole('menuitemradio', { name: 'Desk Mic' })).toBeInTheDocument();
    }
  );

  it('opens the list in the control bar even when chat had covered it', async () => {
    draw('microphone');
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /chat/i }));
    expect(screen.getByTestId('stage-column').querySelector('.hidden')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Choose microphone' }));
    const arrow = screen.getByRole('button', { name: 'Select microphone' });
    expect(arrow).toHaveFocus();
    expect(arrow.closest('.hidden')).toBeNull();
  });

  it('opens no list on Not now', async () => {
    const { onDismissHelpAsk } = draw('microphone');
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onDismissHelpAsk).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('PeoplePanel: the host copies a guest’s view link', () => {
  const people: RemotePeer[] = [
    { peerId: 'p-ana', name: 'Ana Lee', stream: null, role: 'guest', presence: mic(true) },
    { peerId: 'p-cy', name: 'Cy', stream: null, role: 'producer' },
    { peerId: 'p-di', name: 'Di', stream: null, role: 'guest', companion: true },
    { peerId: 'p-new', name: null, stream: null, role: 'guest' },
    { peerId: 'p-hal', name: 'Hal', stream: null, role: 'host' },
  ];

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
    window.history.pushState({}, '', '/');
  });

  function draw() {
    render(<PeoplePanel people={people} onMute={vi.fn()} onRemove={vi.fn()} onAsk={vi.fn()} onClose={vi.fn()} />);
  }

  it('copies the guest’s view link and says so', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    window.history.pushState({}, '', '/r/xyz-abcd-pqr/?producer=1');
    draw();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy view link for Ana Lee' }));
    });
    expect(writeText).toHaveBeenCalledWith(`${location.origin}/r/xyz-abcd-pqr/?view=guest&name=Ana%20Lee`);
    expect(screen.getByRole('status')).toHaveTextContent('View link for Ana Lee copied.');
  });

  it('copies an address the view page reads back as the same guest, whatever the name holds', async () => {
    const writeText = vi.fn((_: string) => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const name = 'Ana & Zoë 田中=1?#';
    render(
      <PeoplePanel
        people={[{ peerId: 'p-x', name, stream: null, role: 'guest' }]}
        onMute={vi.fn()}
        onClose={vi.fn()}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: `Copy view link for ${name}` }));
    });
    const address = new URL(writeText.mock.calls[0]![0]);
    expect(parseViewLink(address.search)).toEqual({ kind: 'guest', name });
    expect(screen.getByRole('status')).toHaveTextContent(`View link for ${name} copied.`);
  });

  it('sits before Remove in the guest’s row', () => {
    draw();
    const row = screen.getByRole('button', { name: 'Copy view link for Ana Lee' }).closest('li')!;
    expect(within(row).getAllByRole('button').map((b) => b.textContent)).toEqual(['Mute', 'Help', 'View link', 'Remove']);
    expect(within(row).getByRole('button', { name: 'Copy view link for Ana Lee' })).toHaveClass(
      'min-h-11',
      'shrink-0',
      'rounded-full',
      'ring-1'
    );
  });

  it('gives no View link to a producer, a Present-only device, a host or a guest with no name', () => {
    draw();
    expect(screen.getAllByRole('button', { name: /^Copy view link for / })).toHaveLength(1);
    for (const text of ['Cy (Producer)', 'Di (Presenting)', 'Guest', 'Hal']) {
      const row = screen.getByText(text).closest('li')!;
      expect(within(row).queryByRole('button', { name: /view link/i })).toBeNull();
    }
  });

  it('says so when the link cannot be copied', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) },
      configurable: true,
    });
    draw();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy view link for Ana Lee' }));
    });
    expect(screen.getByRole('status')).toHaveTextContent('Couldn’t copy the view link for Ana Lee.');
  });

  it('says so when there is no clipboard', () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'Copy view link for Ana Lee' }));
    expect(screen.getByRole('status')).toHaveTextContent('Couldn’t copy the view link for Ana Lee.');
  });
});
