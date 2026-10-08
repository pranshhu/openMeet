import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { LoadSample } from '@/hooks/useRoom';
import { isOverloaded, useOverloadWatch } from '@/hooks/use-overload-watch';

function s(audioDroppedMs: number, cpuLimited = false): LoadSample {
  return { audioDroppedMs, cpuLimited };
}

describe('isOverloaded', () => {
  it('is not overloaded with no readings or one reading', () => {
    expect(isOverloaded([])).toBe(false);
    expect(isOverloaded([s(900, true)])).toBe(false);
  });

  it('counts audio lost inside the window, measured from the oldest reading', () => {
    expect(isOverloaded([s(500), s(599)])).toBe(false);
    expect(isOverloaded([s(500), s(600)])).toBe(true);
    expect(
      isOverloaded([s(500), s(500), s(500), s(500), s(500), s(500)])
    ).toBe(false);
  });

  it('counts processor-limited readings', () => {
    expect(
      isOverloaded([
        s(0, true),
        s(0, true),
        s(0, true),
        s(0, false),
        s(0, false),
        s(0, false),
      ])
    ).toBe(true);
    expect(
      isOverloaded([
        s(0, true),
        s(0, true),
        s(0, false),
        s(0, false),
        s(0, false),
        s(0, false),
      ])
    ).toBe(false);
  });
});

describe('useOverloadWatch', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never reads while no take is recording', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => s(150)).mockResolvedValueOnce(s(0));
    renderHook(() => useOverloadWatch(false, read));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(read).not.toHaveBeenCalled();
  });

  it('turns true once audio is lost and stays true for the rest of the take', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => s(150)).mockResolvedValueOnce(s(0));
    const { result } = renderHook(() => useOverloadWatch(true, read));

    expect(result.current).toBe(false);

    // After 10 s (two samples: 0 ms at 5s, 150 ms at 10s; diff = 150 >= 100)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current).toBe(true);

    // After another 60 s (jump has left the 6-sample window), stays true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current).toBe(true);
  });

  it('starts clean on the next take', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => s(150)).mockResolvedValueOnce(s(0));
    const { result, rerender } = renderHook(
      ({ active }) => useOverloadWatch(active, read),
      { initialProps: { active: true } }
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current).toBe(true);

    // Next take: rerender with active false then true; false at once and still false after 30 s of flat readings
    rerender({ active: false });
    rerender({ active: true });
    expect(result.current).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current).toBe(false);
  });

  it('forgets audio lost before the six readings kept', async () => {
    vi.useFakeTimers();
    const read = vi
      .fn(async () => s(120))
      .mockResolvedValueOnce(s(0))
      .mockResolvedValueOnce(s(60))
      .mockResolvedValueOnce(s(60))
      .mockResolvedValueOnce(s(60))
      .mockResolvedValueOnce(s(60))
      .mockResolvedValueOnce(s(60));
    const { result } = renderHook(() => useOverloadWatch(true, read));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(35_000);
    });

    expect(read).toHaveBeenCalledTimes(7);
    expect(result.current).toBe(false);
  });

  it('measures across all six readings kept', async () => {
    vi.useFakeTimers();
    const read = vi
      .fn(async () => s(120))
      .mockResolvedValueOnce(s(0))
      .mockResolvedValueOnce(s(60))
      .mockResolvedValueOnce(s(60))
      .mockResolvedValueOnce(s(60))
      .mockResolvedValueOnce(s(60));
    const { result } = renderHook(() => useOverloadWatch(true, read));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    expect(result.current).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(result.current).toBe(true);
  });

  it('stops reading on unmount', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => s(150)).mockResolvedValueOnce(s(0));
    const { unmount } = renderHook(() => useOverloadWatch(true, read));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    const callCount = read.mock.calls.length;

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(read.mock.calls.length).toBe(callCount);
  });

  it('ignores a reading that fails', async () => {
    vi.useFakeTimers();
    const read = vi
      .fn(async () => s(150))
      .mockRejectedValueOnce(new Error('Sample failed'))
      .mockResolvedValueOnce(s(0));

    const { result } = renderHook(() => useOverloadWatch(true, read));

    // First sample at 5s rejected, second at 10s is 0 -> only 1 sample, diff not >= 100
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current).toBe(false);

    // Third sample at 15s is 150 -> diff = 150 - 0 = 150 >= 100 -> true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(result.current).toBe(true);
  });

  it('drops a reading that lands after the take ended', async () => {
    vi.useFakeTimers();
    let land!: (v: LoadSample) => void;
    const late = new Promise<LoadSample>((r) => (land = r));
    const read = vi.fn(() => late).mockResolvedValueOnce(s(0));

    const { result, rerender } = renderHook(
      ({ active }) => useOverloadWatch(active, read),
      { initialProps: { active: true } }
    );

    // Advance 10 s: sample 1 (0 ms at 5s) done, sample 2 (in flight) triggered at 10s
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    // Take ends
    rerender({ active: false });

    // Late reading lands after take ended
    await act(async () => {
      land(s(150));
    });

    expect(result.current).toBe(false);
  });

  it('starts the evidence over when low-power mode changes', async () => {
    vi.useFakeTimers();
    let val = 150;
    const read = vi.fn(async () => s(val)).mockResolvedValueOnce(s(0));
    const { result, rerender } = renderHook(
      ({ lowPower }) => useOverloadWatch(true, read, lowPower),
      { initialProps: { lowPower: false } }
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current).toBe(true);

    rerender({ lowPower: true });
    expect(result.current).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current).toBe(false);

    val = 300;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(result.current).toBe(true);
  });

  it('never shows a verdict reached in the other mode, not even for one render', async () => {
    vi.useFakeTimers();
    let val = 150;
    const read = vi.fn(async () => s(val)).mockResolvedValueOnce(s(0));
    const renders: { lowPower: boolean; overloaded: boolean }[] = [];
    const { rerender } = renderHook(
      ({ lowPower }) => {
        const overloaded = useOverloadWatch(true, read, lowPower);
        renders.push({ lowPower, overloaded });
        return overloaded;
      },
      { initialProps: { lowPower: false } }
    );
    expect(renders[0]).toEqual({ lowPower: false, overloaded: false });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(renders[renders.length - 1]).toEqual({ lowPower: false, overloaded: true });

    rerender({ lowPower: true });
    const lowPowerRenders = renders.filter((r) => r.lowPower);
    expect(lowPowerRenders.length).toBeGreaterThanOrEqual(1);
    expect(renders.some((r) => r.lowPower && r.overloaded)).toBe(false);
  });

  it('never shows a verdict reached with the mode on once it is turned off', async () => {
    vi.useFakeTimers();
    let lost = 0;
    const read = vi.fn(async () => s((lost += 150)));
    const renders: { lowPower: boolean; overloaded: boolean }[] = [];
    const { rerender } = renderHook(
      ({ lowPower }) => {
        const overloaded = useOverloadWatch(true, read, lowPower);
        renders.push({ lowPower, overloaded });
        return overloaded;
      },
      { initialProps: { lowPower: true } }
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(renders[renders.length - 1]).toEqual({ lowPower: true, overloaded: true });
    rerender({ lowPower: false });
    expect(renders.some((r) => !r.lowPower)).toBe(true);
    expect(renders.some((r) => !r.lowPower && r.overloaded)).toBe(false);
  });

  it('counts only lost audio while low-power mode is on', async () => {
    vi.useFakeTimers();
    let lost = 0;
    const read = vi.fn(async () => s(lost, true));
    const renders: boolean[] = [];
    const { result } = renderHook(() => {
      const v = useOverloadWatch(true, read, true);
      renders.push(v);
      return v;
    });
    expect(renders[0]).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current).toBe(false);

    lost = 150;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(result.current).toBe(true);
  });

  it('counts processor limits when low-power mode is off by default', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => s(0, true));
    const { result } = renderHook(() => useOverloadWatch(true, read));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(result.current).toBe(true);
  });

  it('does not poll or throw when read is undefined', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useOverloadWatch(true, undefined));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current).toBe(false);
  });

  it('starts evidence over when read function changes', async () => {
    vi.useFakeTimers();
    const read1 = vi.fn(async () => s(150)).mockResolvedValueOnce(s(0));
    const { result, rerender } = renderHook(
      ({ read }) => useOverloadWatch(true, read),
      { initialProps: { read: read1 } }
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current).toBe(true);

    const read2 = vi.fn(async () => s(0));
    rerender({ read: read2 });
    expect(result.current).toBe(false);
  });

  it('drops the verdict when the take ends', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => s(150)).mockResolvedValueOnce(s(0));
    const { result, rerender } = renderHook(
      ({ active }) => useOverloadWatch(active, read),
      { initialProps: { active: true } }
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current).toBe(true);
    rerender({ active: false });
    expect(result.current).toBe(false);
  });
});
