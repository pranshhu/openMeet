import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CallStage } from '@/components/CallStage';

const baseProps = {
  role: 'guest' as const,
  phase: 'in-call' as const,
  localStream: null,
  remoteStream: null,
  remotePeers: [],
  remoteScreenStream: null,
  localScreenStream: null,
  localName: 'Gita',
  peerName: 'Hana',
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

const ITEM = 'Send my recording later';
const ROW =
  'Your recording stays on this device during a take and goes to the host after it. Keep this tab open until the host has saved it. You can turn this off between takes.';

function openCameraMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Select camera' }));
}

describe('CallStage: send my recording later', () => {
  it('offers a guest the switch under Stop incoming video, ticked while on, and asks for the other state', () => {
    const spy = vi.fn();
    const { rerender } = render(
      <CallStage {...baseProps} onSetIncomingVideoOff={vi.fn()} onSetSendLater={spy} />
    );

    openCameraMenu();
    const item = screen.getByRole('menuitemcheckbox', { name: ITEM });
    expect(item).toHaveAttribute('aria-checked', 'false');
    // Tall enough for a thumb, and next after the other switch for a weak connection.
    expect(item).toHaveClass('min-h-11');
    expect(screen.getByRole('menuitemcheckbox', { name: 'Stop incoming video' }).nextElementSibling).toBe(item);
    fireEvent.click(item);
    expect(spy).toHaveBeenLastCalledWith(true);
    expect(screen.queryByRole('menuitemcheckbox', { name: ITEM })).toBeNull();

    rerender(<CallStage {...baseProps} onSetIncomingVideoOff={vi.fn()} sendLater onSetSendLater={spy} />);
    openCameraMenu();
    const ticked = screen.getByRole('menuitemcheckbox', { name: ITEM });
    expect(ticked).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(ticked);
    expect(spy).toHaveBeenLastCalledWith(false);
  });

  it('can be ticked during a take', () => {
    const spy = vi.fn();
    render(<CallStage {...baseProps} phase="recording" onSetSendLater={spy} />);
    openCameraMenu();
    const item = screen.getByRole('menuitemcheckbox', { name: ITEM });
    expect(item).toBeEnabled();
    fireEvent.click(item);
    expect(spy).toHaveBeenLastCalledWith(true);
  });

  it('cannot be unticked while the take it deferred records', () => {
    const spy = vi.fn();
    render(<CallStage {...baseProps} phase="recording" sendLater onSetSendLater={spy} />);
    openCameraMenu();
    const item = screen.getByRole('menuitemcheckbox', { name: ITEM });
    expect(item).toBeDisabled();
    fireEvent.click(item);
    expect(spy).not.toHaveBeenCalled();
  });

  it('says what it does for as long as it is on, in the same words during a take', () => {
    const { rerender } = render(<CallStage {...baseProps} onSetSendLater={vi.fn()} />);
    expect(screen.queryByText(ROW)).toBeNull();

    rerender(<CallStage {...baseProps} sendLater onSetSendLater={vi.fn()} />);
    expect(screen.getByText(ROW).closest('[role="status"]')).not.toBeNull();

    rerender(<CallStage {...baseProps} phase="recording" sendLater onSetSendLater={vi.fn()} />);
    expect(screen.getByText(ROW)).toBeInTheDocument();
  });

  it('gives a host neither the switch nor the row', () => {
    render(<CallStage {...baseProps} role="host" canRecord sendLater onSetSendLater={vi.fn()} />);
    expect(screen.queryByText(ROW)).toBeNull();
    openCameraMenu();
    expect(screen.queryByRole('menuitemcheckbox', { name: ITEM })).toBeNull();
  });

  it('has no switch where none was handed in', () => {
    render(<CallStage {...baseProps} />);
    openCameraMenu();
    expect(screen.queryByRole('menuitemcheckbox', { name: ITEM })).toBeNull();
  });
});
