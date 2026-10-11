import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import { CallStage } from '@/components/CallStage';
import { ReactionBadge } from '@/components/ReactionBadge';
import { ReactionMenu } from '@/components/ReactionMenu';
import { RoomView } from '@/components/RoomView';
import { OWN_REACTION, REACTION_SHOWN_MS, type ShownReactions } from '@/lib/reactions';

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

describe('ReactionBadge', () => {
  it('shows the picture under its name, and takes itself away when its time is up', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(100_000);
      render(<ReactionBadge reaction="thumbs-up" at={100_000} />);
      expect(screen.getByRole('img', { name: 'Thumbs up' })).toHaveTextContent('👍');
      // At the top left, clear of the marks and the name tag, and still for a person who asked for reduced motion.
      expect(screen.getByRole('img', { name: 'Thumbs up' })).toHaveClass(
        'pointer-events-none',
        'absolute',
        'left-2',
        'top-2',
        'sm:left-3',
        'sm:top-3',
        'animate-bounce',
        'motion-reduce:animate-none'
      );

      act(() => {
        vi.advanceTimersByTime(REACTION_SHOWN_MS - 1);
      });
      expect(screen.getByRole('img', { name: 'Thumbs up' })).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.queryByRole('img', { name: 'Thumbs up' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // A new layout draws new tiles: an old reaction must not play again on them.
  it('shows the rest of a reaction when it is drawn again, and nothing of an old one', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(100_000);
      const late = render(<ReactionBadge reaction="clap" at={100_000 - REACTION_SHOWN_MS + 1000} />);
      expect(screen.getByRole('img', { name: 'Applause' })).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.queryByRole('img', { name: 'Applause' })).toBeNull();
      late.unmount();

      render(<ReactionBadge reaction="clap" at={100_000 - 60_000} />);
      expect(screen.queryByRole('img', { name: 'Applause' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // A time ahead of this page's clock shows for REACTION_SHOWN_MS at most, not for the whole gap.
  it('takes a reaction whose time is ahead of this clock away after REACTION_SHOWN_MS', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(100_000);
      render(<ReactionBadge reaction="heart" at={100_000 + 60_000} />);
      expect(screen.getByRole('img', { name: 'Heart' })).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(REACTION_SHOWN_MS);
      });
      expect(screen.queryByRole('img', { name: 'Heart' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('draws each code as its own emoji', () => {
    const now = Date.now();
    render(
      <>
        <ReactionBadge reaction="thumbs-up" at={now} />
        <ReactionBadge reaction="clap" at={now} />
        <ReactionBadge reaction="laugh" at={now} />
        <ReactionBadge reaction="heart" at={now} />
      </>
    );
    expect(screen.getAllByRole('img').map((b) => b.textContent)).toEqual(['👍', '👏', '😂', '❤️']);
  });
});

describe('ReactionMenu', () => {
  it('stays closed until its arrow is pressed, then offers the four reactions by name', () => {
    render(<ReactionMenu onReact={vi.fn()} />);
    const arrow = screen.getByRole('button', { name: 'Reactions' });
    expect(arrow).toHaveAttribute('aria-expanded', 'false');
    expect(arrow).toHaveAttribute('aria-haspopup', 'menu');
    expect(arrow).toHaveAttribute('title', 'Reactions');
    expect(arrow).toHaveClass('h-12');
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(arrow);
    expect(arrow).toHaveAttribute('aria-expanded', 'true');
    const row = screen.getByRole('menu', { name: 'Reactions' });
    // Above the pill, its right edge on the pill's right edge, and shown only from sm up.
    expect(row).toHaveClass('absolute', 'bottom-full', 'right-0', 'hidden', 'sm:flex');
    expect(within(row).getAllByRole('menuitem').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Thumbs up',
      'Applause',
      'Laugh',
      'Heart',
    ]);
    const choices = within(row).getAllByRole('menuitem');
    expect(choices.map((b) => b.textContent)).toEqual(['👍', '👏', '😂', '❤️']);
    for (const choice of choices) expect(choice).toHaveClass('h-11', 'w-11');

    fireEvent.click(arrow);
    expect(arrow).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps the row open for a click on the row itself', () => {
    render(<ReactionMenu onReact={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reactions' }));
    fireEvent.click(screen.getByRole('menu', { name: 'Reactions' }));
    expect(screen.getByRole('menu', { name: 'Reactions' })).toBeInTheDocument();
  });

  it('hands back the chosen reaction, closes, and returns focus to the arrow', () => {
    const onReact = vi.fn();
    render(<ReactionMenu onReact={onReact} />);
    const arrow = screen.getByRole('button', { name: 'Reactions' });
    fireEvent.click(arrow);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Applause' }));

    expect(onReact).toHaveBeenCalledTimes(1);
    expect(onReact).toHaveBeenCalledWith('clap');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(arrow);
  });

  it('closes on Escape, with focus back on the arrow, and on a click anywhere else', () => {
    render(
      <div>
        <ReactionMenu onReact={vi.fn()} />
        <button type="button">elsewhere</button>
      </div>
    );
    const arrow = screen.getByRole('button', { name: 'Reactions' });

    fireEvent.click(arrow);
    screen.getByRole('menuitem', { name: 'Heart' }).focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(arrow);

    fireEvent.click(arrow);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('CallStage: reactions', () => {
  it("draws a reaction on its sender's tile, and on nobody else's", () => {
    const reactions: ShownReactions = new Map([
      ['p-bob', { reaction: 'clap', at: Date.now() }],
      ['p-carol', { reaction: 'laugh', at: Date.now() }],
    ]);
    render(<CallStage {...props} reactions={reactions} />);

    expect(within(tileOf('Bob')).getByRole('img', { name: 'Applause' })).toBeInTheDocument();
    expect(within(tileOf('Bob')).queryByRole('img', { name: 'Laugh' })).toBeNull();
    expect(within(tileOf('Carol')).getByRole('img', { name: 'Laugh' })).toBeInTheDocument();
    expect(within(tileOf('Carol')).queryByRole('img', { name: 'Applause' })).toBeNull();
    expect(within(tileOf('Alice (You)')).queryByRole('img')).toBeNull();
  });

  it("draws this person's own reaction on their own tile, beside a raised hand", () => {
    const reactions: ShownReactions = new Map([[OWN_REACTION, { reaction: 'heart', at: Date.now() }]]);
    render(<CallStage {...props} handRaised reactions={reactions} />);

    const own = within(tileOf('Alice (You)'));
    expect(own.getByRole('img', { name: 'Heart' })).toBeInTheDocument();
    expect(own.getByRole('img', { name: 'Hand raised' })).toBeInTheDocument();
    expect(within(tileOf('Bob')).queryByRole('img', { name: 'Heart' })).toBeNull();
  });

  it('shows a second reaction from the same person after the first has gone', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(500_000);
      const first: ShownReactions = new Map([['p-bob', { reaction: 'clap', at: 500_000 }]]);
      const { rerender } = render(<CallStage {...props} reactions={first} />);
      expect(within(tileOf('Bob')).getByRole('img', { name: 'Applause' })).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(REACTION_SHOWN_MS);
      });
      expect(within(tileOf('Bob')).queryByRole('img', { name: 'Applause' })).toBeNull();

      const second: ShownReactions = new Map([['p-bob', { reaction: 'heart', at: 500_000 + REACTION_SHOWN_MS }]]);
      rerender(<CallStage {...props} reactions={second} />);
      expect(within(tileOf('Bob')).getByRole('img', { name: 'Heart' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers the reactions in one pill with Raise hand, and only with a way to send them', () => {
    const onReact = vi.fn();
    render(<CallStage {...props} onSetHandRaised={vi.fn()} onReact={onReact} />);
    const arrow = screen.getByRole('button', { name: 'Reactions' });
    const pill = screen.getByRole('button', { name: 'Raise hand' }).parentElement!;
    expect(arrow.parentElement).toBe(pill);
    // The row hangs from the pill, and a phone gets neither.
    expect(pill.className).toMatch(/(^|\s)relative(\s|$)/);
    expect(pill.className).toMatch(/(^|\s)hidden(\s|$)/);
    // The arrow is hidden below sm by itself: a raised hand keeps the pill in
    // a narrow window, and the row is too wide to hang from it there.
    expect(arrow.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(arrow.className).toMatch(/(^|\s)sm:inline-flex(\s|$)/);
    expect(pill).toHaveClass('items-center', 'rounded-full', 'bg-[#3c4043]');

    fireEvent.click(arrow);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Heart' }));
    expect(onReact).toHaveBeenCalledWith('heart');
    cleanup();

    render(<CallStage {...props} onSetHandRaised={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Raise hand' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reactions' })).toBeNull();
    cleanup();

    render(<CallStage {...props} role="producer" onSetHandRaised={vi.fn()} onReact={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Reactions' })).toBeNull();
    cleanup();

    // With the arrow beside it, a raised hand still keeps its button at every width.
    render(<CallStage {...props} handRaised onSetHandRaised={vi.fn()} onReact={vi.fn()} />);
    const raised = screen.getByRole('button', { name: 'Lower hand' }).parentElement!;
    expect(raised.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(raised.className).toMatch(/(^|\s)inline-flex(\s|$)/);
  });

  // Two menus over the same strip of the stage must never be open together.
  it('closes the camera menu when the reactions open, and closes when the camera menu opens', () => {
    render(<CallStage {...props} onSetHandRaised={vi.fn()} onReact={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Select camera' }));
    expect(screen.getByText('No cameras found')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reactions' }));
    expect(screen.queryByText('No cameras found')).toBeNull();
    expect(screen.getByRole('menu', { name: 'Reactions' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Select camera' }));
    expect(screen.queryByRole('menu', { name: 'Reactions' })).toBeNull();
    expect(screen.getByText('No cameras found')).toBeInTheDocument();
  });
});

describe('RoomView: reactions', () => {
  beforeEach(() => {
    hook = { setHandRaised: vi.fn(), sendReaction: vi.fn() };
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
      handRaised: false,
      reactions: new Map([[OWN_REACTION, { reaction: 'laugh', at: Date.now() }]]),
    };
  });

  it('hands the call the reactions and the way to send one', () => {
    render(<RoomView slug="abc-defg-hij" />);
    expect(within(tileOf('Ana (You)')).getByRole('img', { name: 'Laugh' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reactions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Thumbs up' }));
    expect(hook.sendReaction).toHaveBeenCalledWith('thumbs-up');
  });
});
