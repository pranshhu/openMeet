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
});
