import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { RoleLinks } from '@/components/RoleLinks';
import { WaitingRoom } from '@/components/WaitingRoom';
import { CallStage } from '@/components/CallStage';

const ARROW = 'Other links';

function withClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
  window.history.pushState({}, '', '/');
});

describe('RoleLinks', () => {
  it('stays closed until its arrow is pressed, then says what each link is', () => {
    render(<RoleLinks menuClassName="" />);
    const arrow = screen.getByRole('button', { name: ARROW });
    expect(arrow).toHaveAttribute('aria-expanded', 'false');
    // Nothing of the panel is mounted while it is closed: the page it sits in
    // has status lines of its own.
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Copy producer link/ })).toBeNull();

    fireEvent.click(arrow);
    expect(arrow).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /^Copy producer link/ })).toHaveTextContent(
      'Watches and chats. Never recorded.'
    );
    expect(screen.getByRole('button', { name: /^Copy Present-only link/ })).toHaveTextContent(
      'Shares a screen only. No camera or mic.'
    );
    expect(screen.getByRole('status')).toHaveTextContent('To record someone, send the invite link.');

    fireEvent.click(arrow);
    expect(arrow).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('copies the room link with the query each role is read from', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    withClipboard(writeText);
    // A query on the host's own page must not get into either link.
    window.history.pushState({}, '', '/r/xyz-abcd-pqr/?present=1');
    render(<RoleLinks menuClassName="" />);
    const arrow = screen.getByRole('button', { name: ARROW });
    fireEvent.click(arrow);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Copy producer link/ }));
    });
    expect(writeText).toHaveBeenLastCalledWith(`${location.origin}/r/xyz-abcd-pqr/?producer=1`);
    expect(screen.getByRole('status')).toHaveTextContent('Producer link copied.');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Copy Present-only link/ }));
    });
    expect(writeText).toHaveBeenLastCalledWith(`${location.origin}/r/xyz-abcd-pqr/?present=1`);
    expect(screen.getByRole('status')).toHaveTextContent('Present-only link copied.');

    // What was copied last time is not said again at the next opening.
    fireEvent.click(arrow);
    fireEvent.click(arrow);
    expect(screen.getByRole('status')).toHaveTextContent('To record someone, send the invite link.');
  });

  it('says how to build the link by hand when it cannot be copied', async () => {
    render(<RoleLinks menuClassName="" />);
    fireEvent.click(screen.getByRole('button', { name: ARROW }));

    // No clipboard at all: a plain-http self-host.
    fireEvent.click(screen.getByRole('button', { name: /^Copy producer link/ }));
    expect(screen.getByRole('status')).toHaveTextContent(
      'Couldn’t copy. Add ?producer=1 to this page’s address.'
    );

    // A denied permission rejects.
    withClipboard(vi.fn(() => Promise.reject(new Error('denied'))));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Copy Present-only link/ }));
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Couldn’t copy. Add ?present=1 to this page’s address.'
    );
  });

  it('closes on Escape, handing focus back to its arrow, and on a click elsewhere', () => {
    render(
      <>
        <RoleLinks menuClassName="" />
        <button type="button">Elsewhere</button>
      </>
    );
    const arrow = screen.getByRole('button', { name: ARROW });
    fireEvent.click(arrow);
    screen.getByRole('button', { name: /^Copy producer link/ }).focus();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('status')).toBeNull();
    expect(arrow).toHaveFocus();

    fireEvent.click(arrow);
    expect(screen.getByRole('status')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('gives its arrow a tooltip and 44px, and its named panel follows the arrow with the producer link first', () => {
    render(<RoleLinks menuClassName="" />);
    const arrow = screen.getByRole('button', { name: ARROW });
    expect(arrow).toHaveAttribute('title', ARROW);
    // 44px to tap on a phone.
    expect(arrow).toHaveClass('h-11', 'w-11');

    fireEvent.click(arrow);
    const panel = screen.getByRole('group', { name: ARROW });
    const producer = screen.getByRole('button', { name: /^Copy producer link/ });
    expect(panel).toContainElement(producer);
    // Tab goes from the arrow on to the items only if the panel comes after it.
    expect(arrow.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      producer.compareDocumentPosition(screen.getByRole('button', { name: /^Copy Present-only link/ })) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('stays open on any key but Escape', () => {
    render(<RoleLinks menuClassName="" />);
    fireEvent.click(screen.getByRole('button', { name: ARROW }));
    // Tab is how a keyboard gets from the arrow to the items.
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('listens on the window only while it is open', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    try {
      render(
        <>
          <RoleLinks menuClassName="" />
          <button type="button">Elsewhere</button>
        </>
      );
      const arrow = screen.getByRole('button', { name: ARROW });
      fireEvent.click(arrow);
      const mine = add.mock.calls.filter(([type]) => type === 'click' || type === 'keydown');
      expect(mine).toHaveLength(2);
      fireEvent.click(arrow);
      for (const [type, listener] of mine) expect(remove).toHaveBeenCalledWith(type, listener);

      // Closed, it leaves Escape to whatever else is open: focus stays where it is.
      const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
      elsewhere.focus();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(elsewhere).toHaveFocus();
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });
});

describe('WaitingRoom: role links', () => {
  it('gives the host the two other links beside Copy invite link, and not a guest', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    withClipboard(writeText);
    window.history.pushState({}, '', '/r/xyz-abcd-pqr/');
    const { unmount } = render(
      <WaitingRoom role="host" localStream={null} localName="Host" onLeave={vi.fn()} />
    );
    const arrow = screen.getByRole('button', { name: ARROW });
    expect(screen.getByRole('button', { name: 'Copy invite link' }).nextElementSibling).toBe(
      arrow.parentElement
    );
    // The panel is placed from the row, so the row has to be what it is measured from.
    expect(arrow.parentElement!.parentElement).toHaveClass('relative');

    fireEvent.click(arrow);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Copy producer link/ }));
    });
    expect(writeText).toHaveBeenCalledWith(`${location.origin}/r/xyz-abcd-pqr/?producer=1`);

    unmount();
    render(<WaitingRoom role="guest" localStream={null} localName="Guest" onLeave={vi.fn()} />);
    expect(screen.queryByRole('button', { name: ARROW })).toBeNull();
  });

  it('hangs the panel above its row, centred on it', () => {
    render(<WaitingRoom role="host" localStream={null} localName="Host" onLeave={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: ARROW }));
    expect(screen.getByRole('group', { name: ARROW })).toHaveClass('bottom-full', 'left-1/2', '-translate-x-1/2');
  });
});

// What tests/call-stage.test.tsx renders a call with.
const callProps = {
  role: 'host' as const,
  phase: 'in-call' as const,
  localStream: null,
  remoteStream: null,
  remotePeers: [],
  remoteScreenStream: null,
  localScreenStream: null,
  localName: 'Alice',
  peerName: 'Bob',
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
};

describe('CallStage: role links', () => {
  it('gives the host the two other links in the status bar, beside Copy invite link, while no take runs', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    withClipboard(writeText);
    window.history.pushState({}, '', '/r/abc-defg-hij/');
    const { rerender } = render(<CallStage {...callProps} />);
    const arrow = screen.getByRole('button', { name: ARROW });
    expect(screen.getByTestId('status-bar').contains(arrow)).toBe(true);
    expect(screen.getByRole('button', { name: 'Copy invite link' }).nextElementSibling).toBe(
      arrow.parentElement
    );

    fireEvent.click(arrow);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Copy Present-only link/ }));
    });
    expect(writeText).toHaveBeenCalledWith(`${location.origin}/r/abc-defg-hij/?present=1`);

    // A take hides Copy invite link, and the arrow with it.
    rerender(<CallStage {...callProps} phase="recording" />);
    expect(screen.queryByRole('button', { name: ARROW })).toBeNull();
  });

  it('offers them to nobody but the host', () => {
    render(<CallStage {...callProps} role="guest" canRecord={false} />);
    expect(screen.queryByRole('button', { name: ARROW })).toBeNull();
  });

  it('has no arrow while a take is saved, or after it', () => {
    const { rerender } = render(<CallStage {...callProps} phase="finalizing" />);
    expect(screen.queryByRole('button', { name: ARROW })).toBeNull();
    rerender(<CallStage {...callProps} phase="done" />);
    expect(screen.queryByRole('button', { name: ARROW })).toBeNull();
  });

  it('hangs the panel under the bar from its left inset, and leaves the bar its height', () => {
    render(<CallStage {...callProps} />);
    const arrow = screen.getByRole('button', { name: ARROW });
    expect(arrow.parentElement).toHaveClass('-my-2');
    fireEvent.click(arrow);
    expect(screen.getByRole('group', { name: ARROW })).toHaveClass('left-4', 'top-full', 'min-[861px]:left-14');
  });
});
