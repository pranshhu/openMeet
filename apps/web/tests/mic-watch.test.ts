import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createMicVerdict,
  watchMic,
  MIC_DEAD_PEAK,
  MIC_SILENT_AFTER_MS,
  MIC_POLL_MS,
  type LevelTap,
} from '@/lib/mic-watch';

describe('createMicVerdict', () => {
  it('reports silence only once dead input has lasted MIC_SILENT_AFTER_MS', () => {
    const verdict = createMicVerdict();
    for (let t = 0; t < MIC_SILENT_AFTER_MS; t += MIC_POLL_MS) {
      expect(verdict(0, t)).toBeNull();
    }
    expect(verdict(0, MIC_SILENT_AFTER_MS)).toBe('silent');
  });

  it('treats a muted converter idle noise under MIC_DEAD_PEAK as dead input', () => {
    const verdict = createMicVerdict();
    const idleNoise = MIC_DEAD_PEAK / 2;
    for (let t = 0; t < MIC_SILENT_AFTER_MS; t += MIC_POLL_MS) {
      expect(verdict(idleNoise, t)).toBeNull();
    }
    expect(verdict(idleNoise, MIC_SILENT_AFTER_MS)).toBe('silent');
  });

  it('does not treat a quiet room as silence', () => {
    const verdict = createMicVerdict();
    const quietRoomPeak = 0.001;
    const durationMs = 6 * MIC_SILENT_AFTER_MS;
    for (let t = 0; t <= durationMs; t += MIC_POLL_MS) {
      expect(verdict(quietRoomPeak, t)).toBeNull();
    }
  });

  it('clears silence on sound and restarts the countdown', () => {
    const verdict = createMicVerdict();
    expect(verdict(0, 0)).toBeNull();
    expect(verdict(0, MIC_SILENT_AFTER_MS)).toBe('silent');

    const soundTime = MIC_SILENT_AFTER_MS + MIC_POLL_MS;
    expect(verdict(0.2, soundTime)).toBeNull();

    const resumeTime = soundTime + MIC_POLL_MS;
    for (let t = resumeTime; t < resumeTime + MIC_SILENT_AFTER_MS; t += MIC_POLL_MS) {
      expect(verdict(0, t)).toBeNull();
    }
    expect(verdict(0, resumeTime + MIC_SILENT_AFTER_MS)).toBe('silent');
  });

  it('never reports silence when mic is off in app and resets the dead input count', () => {
    const verdict = createMicVerdict();
    const nineSecondsMs = MIC_SILENT_AFTER_MS - (MIC_SILENT_AFTER_MS / 10);
    let t = 0;
    for (; t < nineSecondsMs; t += MIC_POLL_MS) {
      expect(verdict(0, t)).toBeNull();
    }
    expect(verdict(null, t)).toBeNull();
    t += MIC_POLL_MS;
    const restartTime = t;
    for (; t < restartTime + nineSecondsMs; t += MIC_POLL_MS) {
      expect(verdict(0, t)).toBeNull();
    }
  });
});

describe('watchMic', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports each change once, not each poll, and sets fftSize to 16384', () => {
    let tap0Level = 0;
    let tap1Level = 0;
    const buffersSeen: Float32Array[] = [];

    const tap0: LevelTap = {
      fftSize: 0,
      context: { state: 'running' },
      getFloatTimeDomainData: (b: Float32Array) => {
        buffersSeen.push(b);
        b.fill(tap0Level);
      },
    };
    const tap1: LevelTap = {
      fftSize: 0,
      context: { state: 'running' },
      getFloatTimeDomainData: (b: Float32Array) => {
        buffersSeen.push(b);
        b.fill(tap1Level);
      },
    };

    const onChange = vi.fn();
    const stop = watchMic([tap0, tap1], () => true, onChange);

    expect(tap0.fftSize).toBe(16384);
    expect(tap1.fftSize).toBe(16384);

    vi.advanceTimersByTime(MIC_SILENT_AFTER_MS + 2 * MIC_POLL_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('silent');

    const fiveSecondsMs = MIC_SILENT_AFTER_MS / 2;
    vi.advanceTimersByTime(fiveSecondsMs);
    expect(onChange).toHaveBeenCalledTimes(1);

    tap0Level = 0.2;
    vi.advanceTimersByTime(MIC_POLL_MS);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(null);

    // Verify buffer reuse across taps and polls
    expect(buffersSeen.length).toBeGreaterThan(0);
    const firstBuffer = buffersSeen[0];
    expect(firstBuffer).toHaveLength(tap0.fftSize);
    for (const b of buffersSeen) {
      expect(b).toBe(firstBuffer);
    }

    stop();
  });

  it('does not allocate a Float32Array per poll, reusing the same instance', () => {
    const buffersSeen: Float32Array[] = [];
    const tap0: LevelTap = {
      fftSize: 0,
      context: { state: 'running' },
      getFloatTimeDomainData: (b: Float32Array) => {
        buffersSeen.push(b);
      },
    };
    const tap1: LevelTap = {
      fftSize: 0,
      context: { state: 'running' },
      getFloatTimeDomainData: (b: Float32Array) => {
        buffersSeen.push(b);
      },
    };

    const stop = watchMic([tap0, tap1], () => true, () => {});
    vi.advanceTimersByTime(5 * MIC_POLL_MS);
    expect(buffersSeen).toHaveLength(5 * 2); // five polls, two taps
    const firstBuffer = buffersSeen[0];
    for (const b of buffersSeen) {
      expect(b).toBe(firstBuffer);
    }
    stop();
  });

  it('decides by the loudest channel when live tap is first', () => {
    const tap0: LevelTap = {
      fftSize: 0,
      context: { state: 'running' },
      getFloatTimeDomainData: (b: Float32Array) => {
        b.fill(0.05);
      },
    };
    const tap1: LevelTap = {
      fftSize: 0,
      context: { state: 'running' },
      getFloatTimeDomainData: (b: Float32Array) => {
        b.fill(0);
      },
    };

    const onChange = vi.fn();
    const stop = watchMic([tap0, tap1], () => true, onChange);
    vi.advanceTimersByTime(3 * MIC_SILENT_AFTER_MS);
    expect(onChange).not.toHaveBeenCalled();
    stop();
  });

  it('decides by the loudest channel when live tap is second', () => {
    const tap0: LevelTap = {
      fftSize: 0,
      context: { state: 'running' },
      getFloatTimeDomainData: (b: Float32Array) => {
        b.fill(0);
      },
    };
    const tap1: LevelTap = {
      fftSize: 0,
      context: { state: 'running' },
      getFloatTimeDomainData: (b: Float32Array) => {
        b.fill(-0.05);
      },
    };

    const onChange = vi.fn();
    const stop = watchMic([tap0, tap1], () => true, onChange);
    vi.advanceTimersByTime(3 * MIC_SILENT_AFTER_MS);
    expect(onChange).not.toHaveBeenCalled();
    stop();
  });

  it('reads a tap whose context is not running as dead', () => {
    const tap: LevelTap = {
      fftSize: 0,
      context: { state: 'suspended' },
      getFloatTimeDomainData: (b: Float32Array) => {
        b.fill(0.5);
      },
    };

    const onChange = vi.fn();
    const stop = watchMic([tap], () => true, onChange);
    vi.advanceTimersByTime(MIC_SILENT_AFTER_MS + 2 * MIC_POLL_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('silent');
    stop();
  });

  it('ends polling when stopped', () => {
    const tap: LevelTap = {
      fftSize: 0,
      context: { state: 'running' },
      getFloatTimeDomainData: (b: Float32Array) => {
        b.fill(0);
      },
    };

    const stop = watchMic([tap], () => true, () => {});
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times silence by the clock, not by counting polls', () => {
    const tap: LevelTap = {
      fftSize: 0,
      context: { state: 'running' },
      getFloatTimeDomainData: (b: Float32Array) => {
        b.fill(0);
      },
    };
    const onChange = vi.fn();
    const stop = watchMic([tap], () => true, onChange);
    vi.advanceTimersByTime(MIC_POLL_MS);
    vi.setSystemTime(Date.now() + MIC_SILENT_AFTER_MS);
    vi.advanceTimersByTime(MIC_POLL_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('silent');
    stop();
  });
});
