import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CallStage } from '@/components/CallStage';
import { fakeBoard } from './board-fakes';

const props = {
  role: 'host' as const,
  phase: 'recording' as const,
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

/** A board whose pads reach the take that is already recording. */
const recordedBoard = () => Object.assign(fakeBoard(), { recordsInRunningTake: true });

const MIC_ONLY = 'This take keeps your mic only — pads are recorded from the next take.';
const MIC_OFF =
  'Your microphone is off, so this take is not recording the pads you play. Turn it on to record them.';

const openBoard = () => fireEvent.click(screen.getByRole('button', { name: 'Media board' }));

describe('CallStage: a media board first opened during a take', () => {
  it('says nothing about the take while that take records the pads', () => {
    render(<CallStage {...props} onOpenMediaBoard={recordedBoard} />);
    openBoard();

    expect(screen.getByText(/Load intros, stingers or ad reads/)).toBeInTheDocument();
    expect(screen.queryByText(MIC_ONLY)).toBeNull();
    expect(screen.queryByText(MIC_OFF)).toBeNull();
  });

  it('says the pads are not being recorded while the microphone is off', () => {
    render(<CallStage {...props} onOpenMediaBoard={recordedBoard} />);
    openBoard();

    fireEvent.click(screen.getByRole('button', { name: 'Turn off microphone' }));
    expect(screen.getByText(MIC_OFF)).toHaveAttribute('role', 'status');
    expect(screen.queryByText(MIC_ONLY)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Turn on microphone' }));
    expect(screen.queryByText(MIC_OFF)).toBeNull();
  });

  it('keeps the old line, and only that one, where the take cannot be given the pads', () => {
    render(<CallStage {...props} onOpenMediaBoard={() => fakeBoard()} />);
    openBoard();

    expect(screen.getByText(MIC_ONLY)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Turn off microphone' }));
    expect(screen.getByText(MIC_ONLY)).toBeInTheDocument();
    expect(screen.queryByText(MIC_OFF)).toBeNull();
  });

  it('says nothing about a board opened between takes, microphone off or on', () => {
    render(<CallStage {...props} phase="in-call" onOpenMediaBoard={recordedBoard} />);
    openBoard();

    fireEvent.click(screen.getByRole('button', { name: 'Turn off microphone' }));
    expect(screen.queryByText(MIC_OFF)).toBeNull();
    expect(screen.queryByText(MIC_ONLY)).toBeNull();
  });

  it('sets the take line only for a board this click makes, not for one already handed in', () => {
    const open = vi.fn(() => fakeBoard());
    render(<CallStage {...props} board={fakeBoard()} onBoard={vi.fn()} onOpenMediaBoard={open} />);
    openBoard();

    expect(screen.getByText(/Load intros, stingers or ad reads/)).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByText(MIC_ONLY)).toBeNull();
  });

  it('does not count a handed-in board as new to the microphone-off line either', () => {
    render(<CallStage {...props} board={recordedBoard()} onBoard={vi.fn()} />);
    openBoard();

    fireEvent.click(screen.getByRole('button', { name: 'Turn off microphone' }));
    expect(screen.queryByText(MIC_OFF)).toBeNull();
    expect(screen.queryByText(MIC_ONLY)).toBeNull();
  });

  it('hands the board this click makes to its owner', () => {
    const made = fakeBoard();
    const onBoard = vi.fn();
    render(<CallStage {...props} board={null} onBoard={onBoard} onOpenMediaBoard={() => made} />);
    openBoard();

    expect(onBoard).toHaveBeenCalledWith(made);
    expect(screen.getByText(MIC_ONLY)).toBeInTheDocument();
  });
});
