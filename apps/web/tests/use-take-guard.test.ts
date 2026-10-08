import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useTakeGuard,
  formatHiddenDuration,
  batteryNoteFor,
} from '@/hooks/use-take-guard';

describe('formatHiddenDuration', () => {
  it('formats seconds under one minute', () => {
    expect(formatHiddenDuration(5000)).toBe('5 s');
    expect(formatHiddenDuration(12000)).toBe('12 s');
    expect(formatHiddenDuration(59000)).toBe('59 s');
  });

  it('formats minutes and seconds', () => {
    expect(formatHiddenDuration(60000)).toBe('1 min');
    expect(formatHiddenDuration(80000)).toBe('1 min 20 s');
    expect(formatHiddenDuration(125000)).toBe('2 min 5 s');
  });
});

describe('batteryNoteFor', () => {
  it('returns a warning when battery is exactly 10% and not charging', () => {
    expect(batteryNoteFor({ charging: false, level: 0.1 })).toBe(
      'Battery at 10% and not charging. Plug in, or end the take soon.'
    );
  });

  it('returns a warning when battery is below 10% and not charging', () => {
    expect(batteryNoteFor({ charging: false, level: 0.08 })).toBe(
      'Battery at 8% and not charging. Plug in, or end the take soon.'
    );
  });

  it('returns null when charging even if level is 10% or below', () => {
    expect(batteryNoteFor({ charging: true, level: 0.1 })).toBeNull();
    expect(batteryNoteFor({ charging: true, level: 0.05 })).toBeNull();
  });

  it('returns null when battery level is above 10%', () => {
    expect(batteryNoteFor({ charging: false, level: 0.11 })).toBeNull();
    expect(batteryNoteFor({ charging: false, level: 0.8 })).toBeNull();
  });
});

describe('useTakeGuard screen wake lock', () => {
  let requestMock: ReturnType<typeof vi.fn>;
  let releaseMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    releaseMock = vi.fn().mockResolvedValue(undefined);
    requestMock = vi.fn().mockResolvedValue({
      release: releaseMock,
      released: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    Object.defineProperty(navigator, 'wakeLock', {
      value: { request: requestMock },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'wakeLock');
  });


  it('requests screen wake lock when active', async () => {
    renderHook(() => useTakeGuard(true));
    expect(requestMock).toHaveBeenCalledWith('screen');
  });

  it('does not request screen wake lock when inactive', () => {
    renderHook(() => useTakeGuard(false));
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('releases lock when inactive and on unmount', async () => {
    const { rerender, unmount } = renderHook(
      ({ active }) => useTakeGuard(active),
      { initialProps: { active: true } }
    );
    // Allow promise tick
    await act(async () => {});
    expect(requestMock).toHaveBeenCalledTimes(1);

    rerender({ active: false });
    await act(async () => {});
    expect(releaseMock).toHaveBeenCalledTimes(1);

    // Re-active then unmount
    rerender({ active: true });
    await act(async () => {});
    expect(requestMock).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => {});
    expect(releaseMock).toHaveBeenCalledTimes(2);
  });

  it('requests lock again after hidden then visible while active', async () => {
    let hidden = false;
    Object.defineProperty(document, 'hidden', {
      get: () => hidden,
      configurable: true,
    });

    const firstSentinel = {
      release: releaseMock,
      released: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const secondSentinel = {
      release: releaseMock,
      released: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    requestMock
      .mockResolvedValueOnce(firstSentinel)
      .mockResolvedValueOnce(secondSentinel);

    renderHook(() => useTakeGuard(true));
    await act(async () => {});
    expect(requestMock).toHaveBeenCalledTimes(1);

    // Tab is hidden (browser drops the lock)
    await act(async () => {
      hidden = true;
      firstSentinel.released = true;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(requestMock).toHaveBeenCalledTimes(1);

    // Tab becomes visible again
    await act(async () => {
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock).toHaveBeenLastCalledWith('screen');
  });

  it('skips request while a sentinel is held and not yet released', async () => {
    renderHook(() => useTakeGuard(true));
    await act(async () => {});
    expect(requestMock).toHaveBeenCalledTimes(1);

    // visibilitychange fires while visible and sentinel is still held
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('does not throw when navigator.wakeLock is missing or request rejects', async () => {
    // Missing API
    Reflect.deleteProperty(navigator, 'wakeLock');
    expect(() => {
      renderHook(() => useTakeGuard(true));
    }).not.toThrow();


    // Rejection
    requestMock = vi.fn().mockRejectedValue(new Error('WakeLock request rejected'));
    Object.defineProperty(navigator, 'wakeLock', {
      value: { request: requestMock },
      configurable: true,
      writable: true,
    });

    expect(() => {
      renderHook(() => useTakeGuard(true));
    }).not.toThrow();
    await act(async () => {});
  });
});

describe('useTakeGuard background hidden time', () => {
  let hidden = false;

  beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
    Object.defineProperty(document, 'hidden', {
      get: () => hidden,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setTabHidden(val: boolean) {
    hidden = val;
    document.dispatchEvent(new Event('visibilitychange'));
  }

  it('shows no note when hidden for less than 5 seconds', () => {
    const { result } = renderHook(() => useTakeGuard(true));

    act(() => {
      setTabHidden(true);
      vi.advanceTimersByTime(4000);
      setTabHidden(false);
    });

    expect(result.current.backgroundNote).toBeNull();
  });

  it('shows note when hidden for 5 seconds or more', () => {
    const { result } = renderHook(() => useTakeGuard(true));

    act(() => {
      setTabHidden(true);
      vi.advanceTimersByTime(5000);
      setTabHidden(false);
    });

    expect(result.current.backgroundNote).toBe(
      'This tab was in the background for 5 s during the take. Keep it in front while recording.'
    );
  });

  it('accumulates repeated hides within the same take', () => {
    const { result } = renderHook(() => useTakeGuard(true));

    // First hide: 3s (not >= 5s)
    act(() => {
      setTabHidden(true);
      vi.advanceTimersByTime(3000);
      setTabHidden(false);
    });
    expect(result.current.backgroundNote).toBeNull();

    // Second hide: 3s (total 6s >= 5s)
    act(() => {
      setTabHidden(true);
      vi.advanceTimersByTime(3000);
      setTabHidden(false);
    });
    expect(result.current.backgroundNote).toBe(
      'This tab was in the background for 6 s during the take. Keep it in front while recording.'
    );

    // Third hide without dismiss adds to the note: 6s + 6s = 12s
    act(() => {
      setTabHidden(true);
      vi.advanceTimersByTime(6000);
      setTabHidden(false);
    });
    expect(result.current.backgroundNote).toBe(
      'This tab was in the background for 12 s during the take. Keep it in front while recording.'
    );
  });

  it('dismisses note and resets accumulation until dismissed', () => {
    const { result } = renderHook(() => useTakeGuard(true));

    act(() => {
      setTabHidden(true);
      vi.advanceTimersByTime(6000);
      setTabHidden(false);
    });
    expect(result.current.backgroundNote).not.toBeNull();

    act(() => {
      result.current.dismissBackgroundNote();
    });
    expect(result.current.backgroundNote).toBeNull();

    // After dismiss, accumulation starts fresh
    act(() => {
      setTabHidden(true);
      vi.advanceTimersByTime(2000);
      setTabHidden(false);
    });
    expect(result.current.backgroundNote).toBeNull();

    act(() => {
      setTabHidden(true);
      vi.advanceTimersByTime(3000);
      setTabHidden(false);
    });
    expect(result.current.backgroundNote).toBe(
      'This tab was in the background for 5 s during the take. Keep it in front while recording.'
    );
  });

  it('resets when a new take starts (active false to true)', () => {
    const { result, rerender } = renderHook(
      ({ active }) => useTakeGuard(active),
      { initialProps: { active: true } }
    );

    act(() => {
      setTabHidden(true);
      vi.advanceTimersByTime(7000);
      setTabHidden(false);
    });
    expect(result.current.backgroundNote).toBe(
      'This tab was in the background for 7 s during the take. Keep it in front while recording.'
    );

    // Take ends
    rerender({ active: false });
    // Note remains until new take starts
    expect(result.current.backgroundNote).toBe(
      'This tab was in the background for 7 s during the take. Keep it in front while recording.'
    );

    // New take starts
    rerender({ active: true });
    expect(result.current.backgroundNote).toBeNull();

    // Accumulation was also reset
    act(() => {
      setTabHidden(true);
      vi.advanceTimersByTime(3000);
      setTabHidden(false);
    });
    expect(result.current.backgroundNote).toBeNull();
  });
});

describe('useTakeGuard battery note', () => {
  class FakeBattery extends EventTarget {
    charging: boolean;
    level: number;
    constructor(charging: boolean, level: number) {
      super();
      this.charging = charging;
      this.level = level;
    }
  }

  let fakeBattery: FakeBattery;

  beforeEach(() => {
    fakeBattery = new FakeBattery(false, 0.08);
    Object.defineProperty(navigator, 'getBattery', {
      value: vi.fn().mockResolvedValue(fakeBattery),
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'getBattery');
  });


  it('appears and clears from levelchange and chargingchange events on fake battery', async () => {
    const { result } = renderHook(() => useTakeGuard(true));
    await act(async () => {});

    expect(result.current.batteryNote).toBe(
      'Battery at 8% and not charging. Plug in, or end the take soon.'
    );

    // Charging starts -> clears
    await act(async () => {
      fakeBattery.charging = true;
      fakeBattery.dispatchEvent(new Event('chargingchange'));
    });
    expect(result.current.batteryNote).toBeNull();

    // Charging stops -> reappears
    await act(async () => {
      fakeBattery.charging = false;
      fakeBattery.dispatchEvent(new Event('chargingchange'));
    });
    expect(result.current.batteryNote).toBe(
      'Battery at 8% and not charging. Plug in, or end the take soon.'
    );

    // Level rises above 10% -> clears
    await act(async () => {
      fakeBattery.level = 0.15;
      fakeBattery.dispatchEvent(new Event('levelchange'));
    });
    expect(result.current.batteryNote).toBeNull();

    // Level drops to 10% -> reappears
    await act(async () => {
      fakeBattery.level = 0.10;
      fakeBattery.dispatchEvent(new Event('levelchange'));
    });
    expect(result.current.batteryNote).toBe(
      'Battery at 10% and not charging. Plug in, or end the take soon.'
    );
  });

  it('removes listeners and clears note on cleanup or inactive', async () => {
    const removeSpy = vi.spyOn(fakeBattery, 'removeEventListener');
    const { result, rerender, unmount } = renderHook(
      ({ active }) => useTakeGuard(active),
      { initialProps: { active: true } }
    );
    await act(async () => {});
    expect(result.current.batteryNote).not.toBeNull();

    rerender({ active: false });
    await act(async () => {});
    expect(result.current.batteryNote).toBeNull();
    expect(removeSpy).toHaveBeenCalledWith('levelchange', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('chargingchange', expect.any(Function));

    rerender({ active: true });
    await act(async () => {});
    expect(result.current.batteryNote).not.toBeNull();

    unmount();
    await act(async () => {});
    expect(removeSpy).toHaveBeenCalledTimes(4); // 2 on inactive, 2 on unmount
  });

  it('does not throw when getBattery is missing or rejects', async () => {
    Reflect.deleteProperty(navigator, 'getBattery');
    expect(() => {
      renderHook(() => useTakeGuard(true));
    }).not.toThrow();


    Object.defineProperty(navigator, 'getBattery', {
      value: vi.fn().mockRejectedValue(new Error('Battery API not allowed')),
      configurable: true,
      writable: true,
    });
    expect(() => {
      renderHook(() => useTakeGuard(true));
    }).not.toThrow();
    await act(async () => {});
  });
});



