import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CallStage } from '@/components/CallStage';
import { MAX_RUNDOWN_LENGTH, loadRundown, parseRundown, saveRundown } from '@/lib/rundown';

const onMark = vi.fn();

// A host who can record, in the call between takes: where a rundown is written.
const props = {
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
  onMark,
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

const KEY = 'om_rundown_abc-defg-hij';
const showButton = () => screen.getByRole('button', { name: 'Show rundown' });
const hideButton = () => screen.getByRole('button', { name: 'Hide rundown' });
const strip = () => screen.getByRole('region', { name: 'Rundown' });
const editor = () => screen.queryByLabelText('Rundown segments');
const running = () => within(strip()).getByRole('status');

beforeEach(() => {
  onMark.mockClear();
  localStorage.clear();
});

describe('parseRundown', () => {
  it('reads one segment per line that has text', () => {
    expect(parseRundown('  Intro \r\n\n\tInterview\n   \nQuestions').map((s) => s.name)).toEqual([
      'Intro',
      'Interview',
      'Questions',
    ]);
    expect(parseRundown('')).toEqual([]);
  });
});

describe('CallStage: the rundown', () => {
  it('is offered to a host who can record, and to nobody else', () => {
    const { rerender } = render(<CallStage {...props} />);
    fireEvent.click(showButton());
    // Lit while the strip is shown, like the buttons beside it.
    expect(hideButton()).toHaveClass('bg-white');
    expect(strip()).toBeInTheDocument();

    rerender(<CallStage {...props} role="guest" />);
    expect(screen.queryByRole('button', { name: /rundown/i })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Rundown' })).toBeNull();
    rerender(<CallStage {...props} canRecord={false} />);
    expect(screen.queryByRole('button', { name: /rundown/i })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Rundown' })).toBeNull();
  });

  it('keeps the rundown for the room in this browser', () => {
    const first = render(<CallStage {...props} />);
    fireEvent.click(showButton());
    expect(editor()).toHaveAttribute('maxlength', String(MAX_RUNDOWN_LENGTH));
    fireEvent.change(editor()!, { target: { value: 'Intro\nInterview' } });
    expect(localStorage.getItem(KEY)).toBe('Intro\nInterview');
    first.unmount();

    const again = render(<CallStage {...props} />);
    fireEvent.click(showButton());
    expect(editor()).toHaveValue('Intro\nInterview');
    again.unmount();

    render(<CallStage {...props} slug="other-room-xyz" />);
    fireEvent.click(showButton());
    expect(editor()).toHaveValue('');
    fireEvent.change(editor()!, { target: { value: 'Cold open' } });
    expect(localStorage.getItem('om_rundown_other-room-xyz')).toBe('Cold open');
    expect(localStorage.getItem(KEY)).toBe('Intro\nInterview');
  });

  it('reads back no more than the editor takes, and nothing when storage is closed', () => {
    localStorage.setItem(KEY, 'x'.repeat(MAX_RUNDOWN_LENGTH + 500));
    expect(loadRundown('abc-defg-hij')).toHaveLength(MAX_RUNDOWN_LENGTH);
    const closed = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    try {
      expect(loadRundown('abc-defg-hij')).toBe('');
    } finally {
      closed.mockRestore();
    }
    // A write the browser refuses must not reach the editor as an error.
    const full = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    try {
      expect(() => saveRundown('abc-defg-hij', 'Intro')).not.toThrow();
    } finally {
      full.mockRestore();
    }
  });

  it('marks nothing until a segment is started, then steps through them, marking each', () => {
    localStorage.setItem(KEY, 'Intro\nInterview\nQuestions');
    const { rerender } = render(<CallStage {...props} />);
    fireEvent.click(showButton());
    rerender(<CallStage {...props} phase="recording" />);

    // The take is running and the rundown is shown: still nothing of its own.
    expect(onMark).not.toHaveBeenCalled();
    expect(running()).toHaveTextContent('Rundown not started');
    // Written between takes, not during one.
    expect(editor()).toBeNull();
    const next = within(strip()).getByRole('button');
    expect(next).toHaveTextContent('Start: Intro');

    fireEvent.click(next);
    expect(onMark).toHaveBeenCalledTimes(1);
    expect(onMark).toHaveBeenLastCalledWith('Intro');
    expect(running()).toHaveTextContent('1 of 3 Intro');
    expect(next).toHaveTextContent('Next: Interview');

    fireEvent.click(next);
    expect(onMark).toHaveBeenLastCalledWith('Interview');
    expect(running()).toHaveTextContent('2 of 3 Interview');

    fireEvent.click(next);
    expect(onMark).toHaveBeenLastCalledWith('Questions');
    expect(running()).toHaveTextContent('3 of 3 Questions');
    expect(next).toBeDisabled();
    expect(next).toHaveTextContent('Last segment');
    expect(onMark).toHaveBeenCalledTimes(3);
  });

  it('keeps its place while hidden, and forgets it when the take ends', () => {
    localStorage.setItem(KEY, 'Intro\nInterview\nQuestions');
    const { rerender } = render(<CallStage {...props} phase="recording" />);
    fireEvent.click(showButton());
    fireEvent.click(within(strip()).getByRole('button'));
    fireEvent.click(within(strip()).getByRole('button'));

    fireEvent.click(hideButton());
    expect(screen.queryByRole('region', { name: 'Rundown' })).toBeNull();
    fireEvent.click(showButton());
    expect(running()).toHaveTextContent('2 of 3 Interview');

    // The take ends and the editor is back; the next take starts from the top.
    rerender(<CallStage {...props} phase="finalizing" />);
    expect(editor()).toHaveValue('Intro\nInterview\nQuestions');
    rerender(<CallStage {...props} phase="recording" />);
    expect(running()).toHaveTextContent('Rundown not started');
    expect(onMark).toHaveBeenCalledTimes(2);
  });

  it('says so during a take when the room has no rundown', () => {
    render(<CallStage {...props} phase="recording" />);
    fireEvent.click(showButton());
    expect(
      within(strip()).getByText('No rundown for this room. Write one before the next take.')
    ).toBeInTheDocument();
    expect(within(strip()).queryByRole('button')).toBeNull();
    expect(onMark).not.toHaveBeenCalled();
  });
});
