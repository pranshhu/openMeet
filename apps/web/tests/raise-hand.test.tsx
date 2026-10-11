import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { CallStage } from '@/components/CallStage';
import { PresenceBadge } from '@/components/PresenceBadge';
import { RoomView } from '@/components/RoomView';

// RoomView is drawn from a fixed state, as in room-view-screens.test.tsx.
let state: Record<string, unknown>;
let hook: Record<string, unknown>;

vi.mock('@/hooks/useRoom', () => ({
  useRoom: () => ({ state, join: vi.fn(), leave: vi.fn(), setMic: vi.fn(), setCam: vi.fn(), ...hook }),
}));

// EventTargets, because a tile listens on the stream it is given.
const bob = Object.assign(new EventTarget(), { id: 'stream-bob' }) as unknown as MediaStream;
const carol = Object.assign(new EventTarget(), { id: 'stream-carol' }) as unknown as MediaStream;
const on = { micOn: true, camOn: true, screenSharing: false };

const props = {
  role: 'guest' as const,
  phase: 'in-call' as const,
  localStream: null,
  remoteStream: bob,
  remotePeers: [
    { peerId: 'p-bob', name: 'Bob', stream: bob, presence: on },
    { peerId: 'p-carol', name: 'Carol', stream: carol, presence: on },
  ],
  remoteScreenStream: null,
  localScreenStream: null,
  localName: 'Alice',
  screenSharing: false,
  canRecord: false,
  roomRecording: false,
  recordBlocked: false,
  messages: [],
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

/** The tile whose name tag reads exactly `name`. */
const tileOf = (name: string) => screen.getByText(name).parentElement!;
const HAND = { name: 'Hand raised' };

describe('PresenceBadge: raised hand', () => {
  it('names a raised hand, and shows none while the hand is down', () => {
    const { rerender } = render(<PresenceBadge {...on} handRaised />);
    expect(screen.getByRole('img', HAND)).toBeInTheDocument();
    expect(screen.getByRole('img', HAND)).toHaveAttribute('title', 'Hand raised');
    rerender(<PresenceBadge {...on} />);
    expect(screen.queryByRole('img', HAND)).toBeNull();
  });

  it('puts the hand first among the marks', () => {
    render(<PresenceBadge micOn={false} camOn={false} screenSharing={false} handRaised />);
    expect(screen.getAllByRole('img')[0]).toHaveAccessibleName('Hand raised');
  });
});

describe('CallStage: raise hand', () => {
  it('raises the hand from the control bar, then offers to lower it', () => {
    const spy = vi.fn();
    const { rerender } = render(<CallStage {...props} onSetHandRaised={spy} />);
    const raise = screen.getByRole('button', { name: 'Raise hand' });
    expect(raise.querySelector('svg path')).not.toBeNull();
    fireEvent.click(raise);
    expect(spy).toHaveBeenLastCalledWith(true);

    rerender(<CallStage {...props} handRaised onSetHandRaised={spy} />);
    expect(screen.queryByRole('button', { name: 'Raise hand' })).toBeNull();
    const lower = screen.getByRole('button', { name: 'Lower hand' });
    // The bar's "on" skin, as the other toggles carry while they are on.
    expect(lower.className).toMatch(/bg-white text-\[#202124\]/);
    fireEvent.click(lower);
    expect(spy).toHaveBeenLastCalledWith(false);
  });

  it("marks the person's own tile while their hand is up", () => {
    const { rerender } = render(<CallStage {...props} />);
    expect(within(tileOf('Alice (You)')).queryByRole('img', HAND)).toBeNull();

    rerender(<CallStage {...props} handRaised />);
    expect(within(tileOf('Alice (You)')).getByRole('img', HAND)).toBeInTheDocument();
    // Nothing else is said about their own tile: no muted or camera mark.
    expect(within(tileOf('Alice (You)')).getAllByRole('img')).toHaveLength(1);
    expect(within(tileOf('Bob')).queryByRole('img', HAND)).toBeNull();
  });

  it("marks every other person's tile from their presence, and says who is waiting", () => {
    const raised = { ...on, handRaised: true };
    const { rerender } = render(
      <CallStage
        {...props}
        remotePeers={[
          { peerId: 'p-bob', name: 'Bob', stream: bob, presence: raised },
          { peerId: 'p-carol', name: 'Carol', stream: carol, presence: on },
        ]}
      />
    );
    expect(within(tileOf('Bob')).getByRole('img', HAND)).toBeInTheDocument();
    expect(within(tileOf('Carol')).queryByRole('img', HAND)).toBeNull();
    expect(within(tileOf('Alice (You)')).queryByRole('img', HAND)).toBeNull();
    const said = within(screen.getByTestId('status-bar')).getByText('Hand raised: Bob');
    expect(said.className).toMatch(/\bsr-only\b/);

    rerender(
      <CallStage
        {...props}
        remotePeers={[
          { peerId: 'p-bob', name: 'Bob', stream: bob, presence: raised },
          { peerId: 'p-carol', name: 'Carol', stream: carol, presence: raised },
        ]}
      />
    );
    expect(within(screen.getByTestId('status-bar')).getByText('Hand raised: Bob, Carol')).toBeInTheDocument();

    rerender(<CallStage {...props} />);
    expect(screen.getByTestId('status-bar')).not.toHaveTextContent('Hand raised');
  });

  it('says a raiser with no name as a guest', () => {
    render(
      <CallStage
        {...props}
        remotePeers={[{ peerId: 'p-anon', name: null, stream: carol, presence: { ...on, handRaised: true } }]}
      />
    );
    expect(within(screen.getByTestId('status-bar')).getByText('Hand raised: A guest')).toBeInTheDocument();
  });

  // A producer and a present-only device have no tile. One that sends the flag
  // anyway must not be announced as waiting.
  it('reads out nobody who has no tile', () => {
    const raised = { ...on, handRaised: true };
    render(
      <CallStage
        {...props}
        remotePeers={[
          { peerId: 'p-bob', name: 'Bob', stream: bob, presence: on },
          { peerId: 'p-pat', name: 'Pat', stream: null, role: 'producer' as const, presence: raised },
          { peerId: 'p-dana', name: 'Dana', stream: null, role: 'guest' as const, companion: true, presence: raised },
        ]}
      />
    );
    expect(screen.getByTestId('status-bar')).not.toHaveTextContent('Hand raised');
    expect(screen.queryByRole('img', HAND)).toBeNull();
  });

  it('has no button for a producer or a present-only device, and none in a narrow window until the hand is up', () => {
    render(<CallStage {...props} role="producer" onSetHandRaised={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Raise hand' })).toBeNull();
    cleanup();

    render(<CallStage {...props} companion onSetHandRaised={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Raise hand' })).toBeNull();
    cleanup();

    // No way to raise it, no button.
    render(<CallStage {...props} />);
    expect(screen.queryByRole('button', { name: 'Raise hand' })).toBeNull();
    cleanup();

    // Hidden below sm: a phone's bar is full while a take runs.
    render(<CallStage {...props} onSetHandRaised={vi.fn()} />);
    const box = screen.getByRole('button', { name: 'Raise hand' }).parentElement!;
    expect(box.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(box.className).toMatch(/(^|\s)sm:inline-flex(\s|$)/);
    cleanup();

    // A hand that is up can be lowered at every width: a phone turned back
    // upright must not be left with a mark and no button.
    render(<CallStage {...props} handRaised onSetHandRaised={vi.fn()} />);
    const shown = screen.getByRole('button', { name: 'Lower hand' }).parentElement!;
    expect(shown.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(shown.className).toMatch(/(^|\s)inline-flex(\s|$)/);
  });
});

describe('RoomView: raise hand', () => {
  beforeEach(() => {
    hook = { setHandRaised: vi.fn() };
    state = {
      phase: 'in-call',
      role: 'guest',
      companion: false,
      localStream: null,
      localName: 'Ana',
      connectionWarning: null,
      syncReportUrl: null,
      chaptersUrl: null,
      backupBlobUrl: null,
      wavBackupBlobUrl: null,
      peerRecording: false,
      remoteStream: null,
      remotePeers: [],
      remoteScreenStream: null,
      localScreenStream: null,
      screenSharing: false,
      capabilities: {},
      finalizingGuests: [],
      messages: [],
      markers: [],
      takes: [],
      summary: null,
      recordingError: null,
      drained: true,
      sidecarsSaved: false,
      handRaised: true,
    };
  });

  it('hands the call the hand and its switch', () => {
    render(<RoomView slug="abc-defg-hij" />);
    expect(within(tileOf('Ana (You)')).getByRole('img', HAND)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Lower hand' }));
    expect(hook.setHandRaised).toHaveBeenCalledWith(false);
  });
});
