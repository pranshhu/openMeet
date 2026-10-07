import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { DC_BUFFERED_HIGH_WATERMARK } from '@openmeet/protocol';
import {
  classifyTracks,
  RecordingHealth,
  BACKLOG_WARN_BYTES,
  TRACK_STALL_MS,
  HEALTH_SAMPLE_MS,
  type TrackMemory,
} from '@/components/RecordingHealth';
import type { TrackReading } from '@/hooks/recording-controller';

afterEach(() => {
  vi.useRealTimers();
});

describe('classifyTracks', () => {
  it('starts new tracks and marks them ok once bytes change', () => {
    const r1: TrackReading[] = [{ key: 'own:camera', track: 'camera', bytes: 1000 }];
    const first = classifyTracks(r1, new Map(), 1000);
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]?.state).toBe('starting');
    expect(first.rows[0]?.idleMs).toBe(0);

    const second = classifyTracks(r1, first.seen, 2000);
    expect(second.rows[0]?.state).toBe('starting');
    expect(second.rows[0]?.idleMs).toBe(1000);

    const r2: TrackReading[] = [{ key: 'own:camera', track: 'camera', bytes: 2000 }];
    const third = classifyTracks(r2, second.seen, 3000);
    expect(third.rows[0]?.state).toBe('ok');
    expect(third.rows[0]?.idleMs).toBe(0);

    const fourth = classifyTracks(r2, third.seen, 4000);
    expect(fourth.rows[0]?.state).toBe('ok');
    expect(fourth.rows[0]?.idleMs).toBe(1000);
  });

  it('marks a track quiet after stall threshold and not 1 ms earlier', () => {
    const r1: TrackReading[] = [{ key: 'own:camera', track: 'camera', bytes: 1000 }];
    const first = classifyTracks(r1, new Map(), 0);

    const r2: TrackReading[] = [{ key: 'own:camera', track: 'camera', bytes: 2000 }];
    const grew = classifyTracks(r2, first.seen, 1000);
    expect(grew.rows[0]?.state).toBe('ok');

    const almost = classifyTracks(r2, grew.seen, 1000 + TRACK_STALL_MS - 1);
    expect(almost.rows[0]?.state).toBe('ok');
    expect(almost.rows[0]?.idleMs).toBe(TRACK_STALL_MS - 1);

    const stalled = classifyTracks(r2, grew.seen, 1000 + TRACK_STALL_MS);
    expect(stalled.rows[0]?.state).toBe('quiet');
    expect(stalled.rows[0]?.idleMs).toBe(TRACK_STALL_MS);
  });

  it('turns zero-byte tracks quiet after stall threshold', () => {
    const zero: TrackReading[] = [{ key: 'p:guest1', who: 'Guest', track: 'camera', bytes: 0 }];
    const first = classifyTracks(zero, new Map(), 5000);
    expect(first.rows[0]?.state).toBe('starting');

    const almost = classifyTracks(zero, first.seen, 5000 + TRACK_STALL_MS - 1);
    expect(almost.rows[0]?.state).toBe('starting');

    const stalled = classifyTracks(zero, first.seen, 5000 + TRACK_STALL_MS);
    expect(stalled.rows[0]?.state).toBe('quiet');
    expect(stalled.rows[0]?.idleMs).toBe(TRACK_STALL_MS);
  });

  it('prioritizes stopped over a growing track', () => {
    const r1: TrackReading[] = [{ key: 'g0:mp4', who: 'Bob', track: 'camera', bytes: 1000 }];
    const first = classifyTracks(r1, new Map(), 0);

    const rStopped: TrackReading[] = [
      { key: 'g0:mp4', who: 'Bob', track: 'camera', bytes: 2000, stopped: true },
    ];
    const res = classifyTracks(rStopped, first.seen, 1000);
    expect(res.rows[0]?.state).toBe('stopped');
  });

  it('stopped wins over quiet', () => {
    const r: TrackReading[] = [
      { key: 'g0:mp4', who: 'Bob', track: 'camera', bytes: 1000, stopped: true },
    ];
    const first = classifyTracks(r, new Map(), 0);
    const later = classifyTracks(r, first.seen, TRACK_STALL_MS);
    expect(later.rows[0]?.idleMs).toBe(TRACK_STALL_MS);
    expect(later.rows[0]?.state).toBe('stopped');
  });

  it('keeps grown screen tracks ok while never-grown screen turns quiet', () => {
    const screenZero: TrackReading[] = [{ key: 'own:screen:0', track: 'screen', bytes: 0 }];
    const s1 = classifyTracks(screenZero, new Map(), 0);
    expect(s1.rows[0]?.state).toBe('starting');

    const sStalled = classifyTracks(screenZero, s1.seen, TRACK_STALL_MS);
    expect(sStalled.rows[0]?.state).toBe('quiet');

    const screenGrowing: TrackReading[] = [{ key: 'own:screen:0', track: 'screen', bytes: 50_000 }];
    const sGrew = classifyTracks(screenGrowing, s1.seen, 1000);
    expect(sGrew.rows[0]?.state).toBe('ok');

    const sSilent = classifyTracks(screenGrowing, sGrew.seen, 1000 + 300_000);
    expect(sSilent.rows[0]?.state).toBe('ok');
    expect(sSilent.rows[0]?.idleMs).toBe(300_000);
  });

  it('returns rows in the order of the readings', () => {
    const readings: TrackReading[] = [
      { key: 'own:camera', track: 'camera', bytes: 1 },
      { key: 'own:wav', track: 'wav', bytes: 1 },
      { key: 'g0:mp4', who: 'Asha', track: 'camera', bytes: 1 },
    ];
    expect(classifyTracks(readings, new Map(), 0).rows.map((r) => r.key)).toEqual([
      'own:camera',
      'own:wav',
      'g0:mp4',
    ]);
  });

  it('tracks seen keys for current readings only and preserves prev', () => {
    const prev: TrackMemory = new Map([
      ['drop-me', { bytes: 500, at: 100, grew: true }],
      ['keep-me', { bytes: 1000, at: 200, grew: false }],
    ]);
    const prevSnapshot = structuredClone(prev);

    const readings: TrackReading[] = [
      { key: 'keep-me', track: 'camera', bytes: 2000 },
      { key: 'new-key', track: 'wav', bytes: 0 },
    ];

    const { seen } = classifyTracks(readings, prev, 500);

    expect(prev).toEqual(prevSnapshot);
    expect([...seen.keys()]).toEqual(['keep-me', 'new-key']);
    expect(seen.has('drop-me')).toBe(false);
  });

  it('leaves the entries of prev as they were when a count changes', () => {
    const prev: TrackMemory = new Map([['k', { bytes: 1, at: 100, grew: false }]]);
    const prevSnapshot = structuredClone(prev);
    classifyTracks([{ key: 'k', track: 'camera', bytes: 2 }], prev, 500);
    expect(prev).toEqual(prevSnapshot);
  });

  it('judges a guest’s own camera on the host’s acknowledgements', () => {
    const r1: TrackReading[] = [{ key: 'own:camera', track: 'camera', bytes: 1000, acked: 0 }];
    const first = classifyTracks(r1, new Map(), 0);
    expect(first.rows[0]?.state).toBe('starting');

    const r2: TrackReading[] = [{ key: 'own:camera', track: 'camera', bytes: 9000, acked: 0 }];
    const second = classifyTracks(r2, first.seen, 2000);
    expect(second.rows[0]?.state).toBe('starting');
    expect(second.rows[0]?.idleMs).toBe(2000);

    const third = classifyTracks(r2, second.seen, TRACK_STALL_MS);
    expect(third.rows[0]?.state).toBe('quiet');
    expect(third.rows[0]?.idleMs).toBe(TRACK_STALL_MS);
  });

  it('marks a guest’s own camera ok on rising acknowledgements and quiet when they stop', () => {
    const r1: TrackReading[] = [{ key: 'own:camera', track: 'camera', bytes: 1000, acked: 0 }];
    const first = classifyTracks(r1, new Map(), 0);

    const r2: TrackReading[] = [{ key: 'own:camera', track: 'camera', bytes: 9000, acked: 4000 }];
    const grew = classifyTracks(r2, first.seen, 2000);
    expect(grew.rows[0]?.state).toBe('ok');
    expect(grew.rows[0]?.idleMs).toBe(0);

    const r3: TrackReading[] = [{ key: 'own:camera', track: 'camera', bytes: 50_000, acked: 4000 }];
    const stalled = classifyTracks(r3, grew.seen, 2000 + TRACK_STALL_MS);
    expect(stalled.rows[0]?.state).toBe('quiet');
    expect(stalled.rows[0]?.idleMs).toBe(TRACK_STALL_MS);
  });

  it('judges a guest’s own screen on its own bytes while acknowledgements stay at zero', () => {
    const r1: TrackReading[] = [{ key: 'own:screen:1', track: 'screen', bytes: 1000, acked: 0 }];
    const first = classifyTracks(r1, new Map(), 0);
    expect(first.rows[0]?.state).toBe('starting');

    const r2: TrackReading[] = [{ key: 'own:screen:1', track: 'screen', bytes: 2000, acked: 0 }];
    const grew = classifyTracks(r2, first.seen, 1000);
    expect(grew.rows[0]?.state).toBe('ok');

    const silent = classifyTracks(r2, grew.seen, 1000 + 300_000);
    expect(silent.rows[0]?.state).toBe('ok');
    expect(silent.rows[0]?.idleMs).toBe(300_000);
  });

  it('marks a row behind at the backlog watermark and ok one byte below it', () => {
    // Built from the protocol's own high mark, so the panel's copy of it is
    // what the boundary is measured against.
    const first = classifyTracks(
      [{ key: 'own:camera', track: 'camera', bytes: DC_BUFFERED_HIGH_WATERMARK + 100, acked: 100 }],
      new Map(),
      0
    );
    const atMark = classifyTracks(
      [{ key: 'own:camera', track: 'camera', bytes: DC_BUFFERED_HIGH_WATERMARK + 200, acked: 200 }],
      first.seen,
      1000
    );
    expect(atMark.rows[0]?.state).toBe('behind');

    const below = classifyTracks(
      [{ key: 'own:camera', track: 'camera', bytes: DC_BUFFERED_HIGH_WATERMARK + 200, acked: 201 }],
      atMark.seen,
      2000
    );
    expect(below.rows[0]?.state).toBe('ok');
  });

  it('warns about a screen’s backlog while the screen’s own bytes look fine', () => {
    const first = classifyTracks(
      [{ key: 'own:screen:1', track: 'screen', bytes: DC_BUFFERED_HIGH_WATERMARK + 100, acked: 100 }],
      new Map(),
      0
    );
    const atMark = classifyTracks(
      [{ key: 'own:screen:1', track: 'screen', bytes: DC_BUFFERED_HIGH_WATERMARK + 200, acked: 200 }],
      first.seen,
      1000
    );
    expect(atMark.rows[0]?.state).toBe('behind');
  });

  it('ranks quiet over behind and stopped over both', () => {
    const backlog: TrackReading[] = [
      { key: 'own:camera', track: 'camera', bytes: BACKLOG_WARN_BYTES + 1000, acked: 1000 },
    ];
    const first = classifyTracks(backlog, new Map(), 0);

    const stalled = classifyTracks(backlog, first.seen, TRACK_STALL_MS);
    expect(stalled.rows[0]?.state).toBe('quiet');

    const abandoned: TrackReading[] = [
      { key: 'own:camera', track: 'camera', bytes: BACKLOG_WARN_BYTES + 1000, acked: 2000, stopped: true },
    ];
    const stopped = classifyTracks(abandoned, stalled.seen, TRACK_STALL_MS + 1000);
    expect(stopped.rows[0]?.state).toBe('stopped');
  });

  it('judges a guest’s own WAV on the host’s acknowledgements too', () => {
    const first = classifyTracks([{ key: 'own:wav', track: 'wav', bytes: 1000, acked: 0 }], new Map(), 0);
    const later = classifyTracks(
      [{ key: 'own:wav', track: 'wav', bytes: 9000, acked: 0 }],
      first.seen,
      TRACK_STALL_MS
    );
    expect(later.rows[0]?.state).toBe('quiet');
  });
});

describe('RecordingHealth', () => {
  it('renders nothing when read returns []', () => {
    const read = vi.fn<() => TrackReading[]>(() => []);
    const { container } = render(<RecordingHealth read={read} />);
    expect(screen.queryByTestId('track-health')).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows each row’s name, track, size and status', () => {
    const read = vi.fn<() => TrackReading[]>(() => [
      { key: 'own:camera', track: 'camera', bytes: 1_500_000 },
      { key: 'g0:wav', who: 'Asha', track: 'wav', bytes: 124_300_000 },
      { key: 'own:screen:0', track: 'screen', bytes: 1_250_000_000 },
    ]);

    render(<RecordingHealth read={read} />);

    expect(screen.getByTestId('track-health')).toBeInTheDocument();
    expect(screen.getAllByText('You')).toHaveLength(2);
    expect(screen.getByText('Camera')).toBeInTheDocument();
    expect(screen.getByText('1.5 MB')).toBeInTheDocument();
    expect(screen.getAllByText('Starting…')).toHaveLength(3);

    expect(screen.getByText('Asha')).toBeInTheDocument();
    expect(screen.getByText('WAV master')).toBeInTheDocument();
    expect(screen.getByText('124.3 MB')).toBeInTheDocument();

    expect(screen.getByText('Screen')).toBeInTheDocument();
    expect(screen.getByText('1.25 GB')).toBeInTheDocument();
  });

  it('formats exactly 1 GB with two decimals', () => {
    const read = vi.fn<() => TrackReading[]>(() => [
      { key: 'own:camera', track: 'camera', bytes: 1_000_000_000 },
    ]);
    render(<RecordingHealth read={read} />);
    expect(screen.getByText('1.00 GB')).toBeInTheDocument();
  });

  it('updates sizes, healthy status and check mark on sample timer', () => {
    vi.useFakeTimers();
    let sampleCount = 0;
    const read = vi.fn<() => TrackReading[]>(() => {
      sampleCount++;
      return [
        { key: 'own:camera', track: 'camera', bytes: sampleCount * 1_000_000 },
        { key: 'g0:mp4', who: 'Bob', track: 'camera', bytes: sampleCount * 2_000_000 },
      ];
    });

    render(<RecordingHealth read={read} />);
    expect(screen.getByText('1.0 MB')).toBeInTheDocument();
    expect(screen.getByText('2.0 MB')).toBeInTheDocument();
    expect(screen.getByText('Tracks starting')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByText('2.0 MB')).toBeInTheDocument();
    expect(screen.getByText('4.0 MB')).toBeInTheDocument();
    expect(screen.getByText('OK')).toBeInTheDocument();
    expect(screen.getByText('Receiving')).toBeInTheDocument();
    expect(screen.getByText('Tracks OK')).toBeInTheDocument();
    expect(screen.getByText('✓')).toBeInTheDocument();
  });

  it('indicates tracks starting while a row is starting', () => {
    const read = vi.fn<() => TrackReading[]>(() => [
      { key: 'own:camera', track: 'camera', bytes: 1_000_000 },
    ]);
    render(<RecordingHealth read={read} />);
    expect(screen.getByText('Tracks starting')).toBeInTheDocument();
    expect(screen.getByText('…')).toBeInTheDocument();
  });

  it('says Tracks starting while one row is starting beside an ok row', () => {
    vi.useFakeTimers();
    let n = 0;
    const read = vi.fn<() => TrackReading[]>(() => {
      n++;
      return [
        { key: 'own:camera', track: 'camera', bytes: n * 1_000_000 },
        { key: 'g0:mp4', who: 'Bob', track: 'camera', bytes: 0 },
      ];
    });
    render(<RecordingHealth read={read} />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText('OK')).toBeInTheDocument();
    expect(screen.getByText('Starting…')).toBeInTheDocument();
    expect(screen.getByText('Tracks starting')).toBeInTheDocument();
  });

  it('shows quiet duration at multiple intervals and checks tracks', () => {
    vi.useFakeTimers();
    const read = vi.fn<() => TrackReading[]>(() => [
      { key: 'own:camera', track: 'camera', bytes: 1_000_000 },
    ]);
    render(<RecordingHealth read={read} />);

    act(() => {
      vi.advanceTimersByTime(TRACK_STALL_MS);
    });

    expect(screen.getByText('No data for 15 s')).toBeInTheDocument();
    expect(screen.getByText('Check tracks')).toBeInTheDocument();
    expect(screen.getByText('!')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(65_000);
    });
    expect(screen.getByText('No data for 1 min 20 s')).toBeInTheDocument();
  });

  it('shows stopped status even while another row is starting', () => {
    const read = vi.fn<() => TrackReading[]>(() => [
      { key: 'own:camera', track: 'camera', bytes: 1_000_000 },
      { key: 'g0:mp4', who: 'Bob', track: 'camera', bytes: 500_000, stopped: true },
    ]);
    render(<RecordingHealth read={read} />);

    expect(screen.getByText('Stopped. Their backup has the rest.')).toBeInTheDocument();
    expect(screen.getByText('Check tracks')).toBeInTheDocument();
    expect(screen.getByText('!')).toBeInTheDocument();
  });

  it('a stopped row still says Stopped after stall threshold without data', () => {
    vi.useFakeTimers();
    const read = vi.fn<() => TrackReading[]>(() => [
      { key: 'g0:mp4', who: 'Bob', track: 'camera', bytes: 500_000, stopped: true },
    ]);
    render(<RecordingHealth read={read} />);
    act(() => {
      vi.advanceTimersByTime(TRACK_STALL_MS * 2);
    });
    expect(screen.getByText('Stopped. Their backup has the rest.')).toBeInTheDocument();
    expect(screen.queryByText(/^No data for/)).toBeNull();
  });

  it('renders participant names as plain text', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const read = vi.fn<() => TrackReading[]>(() => [
      { key: 'g0:mp4', who: payload, track: 'camera', bytes: 1_000 },
    ]);
    const { container } = render(<RecordingHealth read={read} />);

    expect(screen.getByText(payload)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('retains last rows when read throws', () => {
    vi.useFakeTimers();
    let call = 0;
    const read = vi.fn<() => TrackReading[]>(() => {
      call++;
      if (call === 1) {
        return [{ key: 'own:camera', track: 'camera', bytes: 1_000_000 }];
      }
      throw new Error('read failed');
    });

    render(<RecordingHealth read={read} />);
    expect(screen.getByText('1.0 MB')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByText('1.0 MB')).toBeInTheDocument();
  });

  it('stops sampling on unmount', () => {
    vi.useFakeTimers();
    const read = vi.fn<() => TrackReading[]>(() => [
      { key: 'own:camera', track: 'camera', bytes: 1_000_000 },
    ]);
    const { unmount } = render(<RecordingHealth read={read} />);
    expect(read).toHaveBeenCalledTimes(1);

    unmount();

    act(() => {
      vi.advanceTimersByTime(1000 * 5);
    });

    expect(read).toHaveBeenCalledTimes(1);
  });

  it('lists rows in the order read with own tracks first', () => {
    const read = vi.fn<() => TrackReading[]>(() => [
      { key: 'own:camera', track: 'camera', bytes: 1_000_000 },
      { key: 'g0:mp4', who: 'Asha', track: 'camera', bytes: 2_000_000 },
      { key: 'g1:mp4', who: 'Bo', track: 'camera', bytes: 3_000_000 },
    ]);
    render(<RecordingHealth read={read} />);
    const items = within(screen.getByTestId('track-health-panel')).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringMatching(/^You/),
      expect.stringMatching(/^Asha/),
      expect.stringMatching(/^Bo/),
    ]);
  });

  it('measures silence on the clock rather than sample ticks', () => {
    vi.useFakeTimers();
    const read = vi.fn<() => TrackReading[]>(() => [
      { key: 'own:camera', track: 'camera', bytes: 1_000_000 },
    ]);
    render(<RecordingHealth read={read} />);
    vi.setSystemTime(Date.now() + TRACK_STALL_MS);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.getByText('No data for 16 s')).toBeInTheDocument();
  });

  it('follows a new read function and preserves track memory', () => {
    vi.useFakeTimers();
    const a = vi.fn<() => TrackReading[]>(() => [
      { key: 'own:camera', track: 'camera', bytes: 1_000_000 },
    ]);
    const b = vi.fn<() => TrackReading[]>(() => [
      { key: 'own:camera', track: 'camera', bytes: 2_000_000 },
    ]);
    const { rerender } = render(<RecordingHealth read={a} />);
    rerender(<RecordingHealth read={b} />);
    expect(screen.getByText('2.0 MB')).toBeInTheDocument();
    expect(screen.getByText('OK')).toBeInTheDocument();
    const before = a.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(1000 * 3);
    });
    expect(a).toHaveBeenCalledTimes(before);
    expect(b.mock.calls.length).toBeGreaterThan(1);
  });

  it('shows the check mark when every track is healthy', () => {
    vi.useFakeTimers();
    let n = 0;
    const read = vi.fn<() => TrackReading[]>(() => {
      n++;
      return [{ key: 'own:camera', track: 'camera', bytes: n * 1_000_000 }];
    });
    render(<RecordingHealth read={read} />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText('Tracks OK')).toBeInTheDocument();
    expect(screen.getByText('✓')).toBeInTheDocument();
  });

  it('marks panel aria-live off and positions it absolute', () => {
    const read = vi.fn<() => TrackReading[]>(() => [
      { key: 'own:camera', track: 'camera', bytes: 1_000_000 },
    ]);
    render(<RecordingHealth read={read} />);
    const panel = screen.getByTestId('track-health-panel');
    expect(panel).toHaveAttribute('aria-live', 'off');
    expect(panel.className).toMatch(/\babsolute\b/);
  });

  it('opens on summary click and closes only on Escape', () => {
    const read = vi.fn<() => TrackReading[]>(() => [
      { key: 'own:camera', track: 'camera', bytes: 1_000_000 },
    ]);
    render(<RecordingHealth read={read} />);
    const details = screen.getByTestId('track-health') as HTMLDetailsElement;
    const summary = details.querySelector('summary')!;

    expect(details.open).toBe(false);

    fireEvent.click(summary);
    expect(details.open).toBe(true);

    fireEvent.keyDown(details, { key: 'Tab' });
    expect(details.open).toBe(true);

    fireEvent.keyDown(details, { key: 'Escape' });
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(summary);
  });

  it('says a guest’s own camera is reaching the host once acknowledgements rise', () => {
    vi.useFakeTimers();
    let n = 0;
    const read = vi.fn<() => TrackReading[]>(() => {
      n++;
      return [{ key: 'own:camera', track: 'camera', bytes: n * 1_000_000, acked: n * 500_000 }];
    });

    render(<RecordingHealth read={read} />);
    expect(screen.getByText('Starting…')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(HEALTH_SAMPLE_MS);
    });

    expect(screen.getByText('Reaching the host')).toBeInTheDocument();
    expect(screen.getByText('Tracks OK')).toBeInTheDocument();
    expect(screen.getByText('✓')).toBeInTheDocument();
  });

  it('says a guest’s own camera is not reaching the host after a stall', () => {
    vi.useFakeTimers();
    let n = 0;
    const read = vi.fn<() => TrackReading[]>(() => {
      n++;
      return [{ key: 'own:camera', track: 'camera', bytes: n * 1_000_000, acked: 0 }];
    });

    render(<RecordingHealth read={read} />);

    act(() => {
      vi.advanceTimersByTime(TRACK_STALL_MS);
    });

    expect(screen.getByText('Not reaching the host for 15 s')).toBeInTheDocument();
    expect(screen.getByText('Check tracks')).toBeInTheDocument();
    expect(screen.queryByText('Reaching the host')).toBeNull();
    expect(screen.queryByText('OK')).toBeNull();
  });

  it('warns how much is still waiting to be sent', () => {
    let n = 0;
    const read = vi.fn<() => TrackReading[]>(() => {
      n++;
      return [{ key: 'own:camera', track: 'camera', bytes: 18_200_000 + n * 1_000, acked: n * 1_000 }];
    });

    render(<RecordingHealth read={read} />);

    expect(screen.getByText('18.2 MB still to send')).toBeInTheDocument();
    expect(screen.getByText('Check tracks')).toBeInTheDocument();
    expect(screen.getByText('!')).toBeInTheDocument();
  });

  it('paints the backlog warning like the other warnings', () => {
    const read = vi.fn<() => TrackReading[]>(() => [
      { key: 'own:camera', track: 'camera', bytes: 18_200_000, acked: 0 },
    ]);

    render(<RecordingHealth read={read} />);
    expect(screen.getByText('18.2 MB still to send').className).toContain('text-[#fdd663]');
  });

  it('says a guest’s own abandoned track is in their backup', () => {
    const read = vi.fn<() => TrackReading[]>(() => [
      { key: 'own:camera', track: 'camera', bytes: 1_000_000, acked: 0, stopped: true },
    ]);

    render(<RecordingHealth read={read} />);

    expect(screen.getByText('Stopped. Your backup has the rest.')).toBeInTheDocument();
    expect(screen.queryByText('Stopped. Their backup has the rest.')).toBeNull();
  });

  it('still tells the host a guest’s abandoned track is in their backup', () => {
    const read = vi.fn<() => TrackReading[]>(() => [
      { key: 'g0:mp4', who: 'Bob', track: 'camera', bytes: 500_000, stopped: true },
    ]);

    render(<RecordingHealth read={read} />);

    expect(screen.getByText('Stopped. Their backup has the rest.')).toBeInTheDocument();
    expect(screen.queryByText('Stopped. Your backup has the rest.')).toBeNull();
  });

  it('keeps a guest’s own screen row saying OK while its bytes grow', () => {
    vi.useFakeTimers();
    let n = 0;
    const read = vi.fn<() => TrackReading[]>(() => {
      n++;
      return [{ key: 'own:screen:1', track: 'screen', bytes: n * 1_000_000, acked: 0 }];
    });

    render(<RecordingHealth read={read} />);
    act(() => {
      vi.advanceTimersByTime(HEALTH_SAMPLE_MS);
    });

    expect(screen.getByText('OK')).toBeInTheDocument();
    expect(screen.getByText('Tracks OK')).toBeInTheDocument();
    expect(screen.queryByText('Reaching the host')).toBeNull();
  });

  it('subtracts acknowledged bytes from total bytes when reporting backlog', () => {
    const read = vi.fn<() => TrackReading[]>(() => [
      { key: 'own:camera', track: 'camera', bytes: 28_200_000, acked: 10_000_000 },
    ]);

    render(<RecordingHealth read={read} />);

    expect(screen.getByText('18.2 MB still to send')).toBeInTheDocument();
    expect(screen.queryByText('28.2 MB still to send')).toBeNull();
  });
});
