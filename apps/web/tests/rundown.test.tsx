import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
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

describe('parseRundown: planned lengths', () => {
  it('takes a length in minutes and seconds off the end of a line', () => {
    expect(
      parseRundown(
        'Intro 2:00\nInterview with Ana  20:30\nTop 10\nBreak 0:00\nLong one 120:00\n2:00\nOdd 1:75'
      )
    ).toEqual([
      { name: 'Intro', plannedMs: 120_000 },
      { name: 'Interview with Ana', plannedMs: 1_230_000 },
      { name: 'Top 10', plannedMs: null },
      { name: 'Break', plannedMs: null },
      { name: 'Long one', plannedMs: 7_200_000 },
      { name: '2:00', plannedMs: null },
      { name: 'Odd 1:75', plannedMs: null },
    ]);
  });
});

describe('CallStage: the rundown’s timers', () => {
  const clock = () => within(strip()).getByRole('timer');

  it('says how many segments it read and how long they are planned to run', () => {
    render(<CallStage {...props} />);
    fireEvent.click(showButton());
    const count = () => within(strip()).queryByText(/^\d+ segments?\b/);
    expect(within(strip()).getByText(/end a line with its planned length, like 2:00/)).toBeInTheDocument();
    expect(count()).toBeNull();

    fireEvent.change(editor()!, { target: { value: 'Intro' } });
    expect(count()).toHaveTextContent(/^1 segment$/);
    fireEvent.change(editor()!, { target: { value: 'Intro 2:00\nInterview 20:00\nQuestions' } });
    expect(count()).toHaveTextContent(/^3 segments, 22:00 planned$/);
  });

  it('counts the running segment against its planned length, and says by how much it is over', () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem(KEY, 'Intro 0:30\nInterview');
      render(<CallStage {...props} phase="recording" />);
      fireEvent.click(showButton());
      // Nothing is timed before a segment starts.
      expect(within(strip()).queryByRole('timer')).toBeNull();
      fireEvent.click(within(strip()).getByRole('button', { name: 'Start: Intro' }));
      // The length is off the name, on the marker too.
      expect(onMark).toHaveBeenLastCalledWith('Intro');
      expect(running()).toHaveTextContent(/^1 of 2 Intro$/);
      expect(clock()).toHaveTextContent(/^0:00 \/ 0:30$/);

      act(() => {
        vi.advanceTimersByTime(12_000);
      });
      expect(clock()).toHaveTextContent(/^0:12 \/ 0:30$/);
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(clock()).toHaveTextContent(/^0:42 \/ 0:30 0:12 over$/);

      // The next segment starts its own count, and this one has no planned length.
      fireEvent.click(within(strip()).getByRole('button'));
      expect(clock()).toHaveTextContent(/^0:00$/);
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(clock()).toHaveTextContent(/^0:05$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps counting while the strip is hidden', () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem(KEY, 'Intro 0:30\nInterview');
      render(<CallStage {...props} phase="recording" />);
      fireEvent.click(showButton());
      fireEvent.click(within(strip()).getByRole('button', { name: 'Start: Intro' }));
      fireEvent.click(hideButton());
      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      fireEvent.click(showButton());
      expect(clock()).toHaveTextContent(/^0:20 \/ 0:30$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says a segment is over only once it is a whole second past its length', () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem(KEY, 'Intro 0:30\nInterview');
      render(<CallStage {...props} phase="recording" />);
      fireEvent.click(showButton());
      fireEvent.click(within(strip()).getByRole('button', { name: 'Start: Intro' }));
      // Shown again part of the way through a second: the clock reads that moment.
      fireEvent.click(hideButton());
      act(() => {
        vi.advanceTimersByTime(30_400);
      });
      fireEvent.click(showButton());
      expect(clock()).toHaveTextContent(/^0:30 \/ 0:30$/);
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(clock()).toHaveTextContent(/^0:31 \/ 0:30 0:01 over$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a length of an hour or more with hours, in the count and in the clock', () => {
    localStorage.setItem(KEY, 'Long one 90:00');
    const { rerender } = render(<CallStage {...props} />);
    fireEvent.click(showButton());
    expect(within(strip()).getByText(/^1 segment, 1:30:00 planned$/)).toBeInTheDocument();

    rerender(<CallStage {...props} phase="recording" />);
    fireEvent.click(within(strip()).getByRole('button', { name: 'Start: Long one' }));
    expect(clock()).toHaveTextContent(/^0:00 \/ 1:30:00$/);
  });

  it('shows the placeholder example the way the editor reads it', () => {
    render(<CallStage {...props} />);
    fireEvent.click(showButton());
    const example = parseRundown(editor()!.getAttribute('placeholder') ?? '');
    expect(example.map((s) => s.plannedMs)).toEqual([120_000, 1_200_000, null]);
  });

  it('says the over part in words and in the warning colour', () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem(KEY, 'Intro 0:30\nInterview');
      render(<CallStage {...props} phase="recording" />);
      fireEvent.click(showButton());
      fireEvent.click(within(strip()).getByRole('button', { name: 'Start: Intro' }));
      act(() => {
        vi.advanceTimersByTime(35_000);
      });
      expect(within(clock()).getByText(/over$/)).toHaveClass('text-[#fdd663]');
    } finally {
      vi.useRealTimers();
    }
  });

  it('is a timer that screen readers are not interrupted by every second', () => {
    localStorage.setItem(KEY, 'Intro 0:30');
    render(<CallStage {...props} phase="recording" />);
    fireEvent.click(showButton());
    fireEvent.click(within(strip()).getByRole('button', { name: 'Start: Intro' }));
    expect(clock()).toHaveAttribute('aria-live', 'off');
  });

  it('stops its timer while the strip is hidden', () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem(KEY, 'Intro 0:30');
      render(<CallStage {...props} phase="recording" />);
      fireEvent.click(showButton());
      fireEvent.click(within(strip()).getByRole('button', { name: 'Start: Intro' }));
      const shown = vi.getTimerCount();
      fireEvent.click(hideButton());
      expect(vi.getTimerCount()).toBe(shown - 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not shrink, so the clock stays whole when the name beside it is cut', () => {
    localStorage.setItem(KEY, 'Intro 0:30');
    render(<CallStage {...props} phase="recording" />);
    fireEvent.click(showButton());
    fireEvent.click(within(strip()).getByRole('button', { name: 'Start: Intro' }));
    expect(clock()).toHaveClass('shrink-0');
  });
});

describe('CallStage: the rundown, starting any segment next', () => {
  const picker = () =>
    within(strip()).getByRole('combobox', { name: 'Segment to start next' }) as HTMLSelectElement;
  // A take that is running with no segment started: also what a resumed take looks like.
  const taking = <CallStage {...props} phase="recording" />;

  it('starts the segment chosen in the list, and choosing one marks nothing', () => {
    localStorage.setItem(KEY, 'Intro\nInterview\nQuestions');
    render(taking);
    fireEvent.click(showButton());
    expect(Array.from(picker().options).map((o) => o.textContent)).toEqual([
      '1. Intro',
      '2. Interview',
      '3. Questions',
    ]);
    expect(picker()).toHaveValue('0');

    fireEvent.change(picker(), { target: { value: '2' } });
    expect(onMark).not.toHaveBeenCalled();
    expect(running()).toHaveTextContent('Rundown not started');
    const next = within(strip()).getByRole('button');
    expect(next).toHaveTextContent('Start: Questions');

    fireEvent.click(next);
    expect(onMark).toHaveBeenCalledTimes(1);
    expect(onMark).toHaveBeenLastCalledWith('Questions');
    expect(running()).toHaveTextContent('3 of 3 Questions');

    // Nothing follows the last segment, and an earlier one can still be chosen.
    expect(next).toBeDisabled();
    expect(picker()).toHaveDisplayValue('End of the rundown');
    fireEvent.change(picker(), { target: { value: '0' } });
    expect(next).toBeEnabled();
    expect(next).toHaveTextContent('Next: Intro');
    fireEvent.click(next);
    expect(onMark).toHaveBeenLastCalledWith('Intro');
    expect(running()).toHaveTextContent('1 of 3 Intro');

    // Back on the segment that follows the one that is running.
    expect(picker()).toHaveValue('1');
    expect(next).toHaveTextContent('Next: Interview');
    expect(onMark).toHaveBeenCalledTimes(2);
  });

  it('forgets a choice when the take ends', () => {
    localStorage.setItem(KEY, 'Intro\nInterview\nQuestions');
    const { rerender } = render(taking);
    fireEvent.click(showButton());
    fireEvent.change(picker(), { target: { value: '2' } });
    rerender(<CallStage {...props} phase="finalizing" />);
    rerender(taking);
    expect(picker()).toHaveValue('0');
    expect(onMark).not.toHaveBeenCalled();
  });

  it('cuts a long name in the list, and keeps it whole on the marker', () => {
    const long = 'A very long segment name that goes on and on past thirty characters';
    localStorage.setItem(KEY, `Intro\n${long}`);
    render(taking);
    fireEvent.click(showButton());
    expect(picker().options[1]!.textContent).toBe(`2. ${long.slice(0, 29)}…`);
    fireEvent.change(picker(), { target: { value: '1' } });
    fireEvent.click(within(strip()).getByRole('button'));
    expect(onMark).toHaveBeenLastCalledWith(long);
  });

  it('cuts a name only when it is longer than thirty characters', () => {
    localStorage.setItem(KEY, `${'a'.repeat(30)}\n${'b'.repeat(31)}`);
    render(taking);
    fireEvent.click(showButton());
    expect(picker().options[0]!.textContent).toBe(`1. ${'a'.repeat(30)}`);
    expect(picker().options[1]!.textContent).toBe(`2. ${'b'.repeat(29)}…`);
  });

  it('gives the list a tooltip with the same words as its name', () => {
    localStorage.setItem(KEY, 'Intro');
    render(taking);
    fireEvent.click(showButton());
    expect(picker()).toHaveAttribute('title', 'Segment to start next');
  });

  it('lists the end of the rundown as a row that cannot be chosen', () => {
    localStorage.setItem(KEY, 'Intro');
    render(taking);
    fireEvent.click(showButton());
    fireEvent.click(within(strip()).getByRole('button'));
    expect(within(picker()).getByRole('option', { name: 'End of the rundown' })).toBeDisabled();
  });

  it('is as tall as a phone button and takes the row the button leaves', () => {
    localStorage.setItem(KEY, 'Intro');
    render(taking);
    fireEvent.click(showButton());
    expect(picker()).toHaveClass('h-11', 'min-w-0', 'flex-1');
  });

  it('sits in the row the button is in, so the running view keeps its height', () => {
    localStorage.setItem(KEY, 'Intro');
    render(taking);
    fireEvent.click(showButton());
    expect(picker().parentElement).toBe(within(strip()).getByRole('button').parentElement);
  });

  it('comes before the button in the tab order', () => {
    localStorage.setItem(KEY, 'Intro');
    render(taking);
    fireEvent.click(showButton());
    const button = within(strip()).getByRole('button');
    expect(picker().compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('parseRundown: where a length is read', () => {
  it('reads a length only at the end of a line, and of at most three digits of minutes', () => {
    expect(
      parseRundown('Recap of 2:00 interview\nNews at 9:30 with Ana 5:00\nMarathon 1000:00\nLong 999:59')
    ).toEqual([
      { name: 'Recap of 2:00 interview', plannedMs: null },
      { name: 'News at 9:30 with Ana', plannedMs: 300_000 },
      { name: 'Marathon 1000:00', plannedMs: null },
      { name: 'Long', plannedMs: 59_999_000 },
    ]);
  });
});

describe('CallStage: the rundown, who has it and when it is an editor', () => {
  it('is offered to a host who joined to present only', () => {
    render(<CallStage {...props} companion />);
    fireEvent.click(showButton());
    expect(strip()).toBeInTheDocument();
  });

  it('describes the editor by its hint, which says that starting a segment adds a chapter marker', () => {
    render(<CallStage {...props} />);
    fireEvent.click(showButton());
    expect(editor()).toHaveAccessibleDescription(
      'One segment per line; end a line with its planned length, like 2:00. During a take, each segment you start adds a chapter marker.'
    );
  });

  it('is an editor again once the take is saved, and starts nothing there', () => {
    localStorage.setItem(KEY, 'Intro\nInterview');
    const { rerender } = render(<CallStage {...props} phase="recording" />);
    fireEvent.click(showButton());
    fireEvent.click(within(strip()).getByRole('button'));
    rerender(<CallStage {...props} phase="done" />);
    expect(editor()).toHaveValue('Intro\nInterview');
    expect(within(strip()).queryByRole('button')).toBeNull();
    expect(onMark).toHaveBeenCalledTimes(1);
  });

  it('shows the running segment whole on the line above the list', () => {
    const long = 'A very long segment name that goes on and on past thirty characters';
    localStorage.setItem(KEY, long);
    render(<CallStage {...props} phase="recording" />);
    fireEvent.click(showButton());
    fireEvent.click(within(strip()).getByRole('button'));
    expect(running()).toHaveTextContent(`1 of 1 ${long}`);
  });
});
