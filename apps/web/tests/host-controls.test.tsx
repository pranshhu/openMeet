import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { RoomView } from '@/components/RoomView';
import { PeoplePanel } from '@/components/PeoplePanel';
import type { RemotePeer } from '@/hooks/useRoom';

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
      'AnaMute',
      'BoMuted',
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
