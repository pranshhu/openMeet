import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createMicVerdict,
  watchMic,
  MIC_DEAD_PEAK,
  MIC_SILENT_AFTER_MS,
  MIC_POLL_MS,
  MIC_CLIP_PEAK,
  MIC_CLIP_HITS,
  MIC_CLIP_CLEAR_MS,
  MIC_WARNING_TEXT,
  type LevelTap,
} from '@/lib/mic-watch';

describe('MIC_WARNING_TEXT', () => {
  it('defines UI copy for silent warning matching the exact template with 10 seconds', () => {
    expect(MIC_WARNING_TEXT.silent).toBe(
      'No sound from your microphone for 10 seconds. Check it’s plugged in and not muted, or select another microphone.'
    );
  });

  it('defines UI copy for clipping warning', () => {
    expect(MIC_WARNING_TEXT.clipping).toBe(
      'Your microphone is clipping. Lower the input gain or move back from it — the distortion goes into the recording.'
    );
  });
});

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

  it('uses the documented levels', () => {
    expect(MIC_CLIP_PEAK).toBe(0.98);
    expect(MIC_CLIP_HITS).toBe(3);
    expect(MIC_CLIP_CLEAR_MS).toBe(10_000);
  });

  it('does not report clipping for one loud moment or hits below threshold', () => {
    const verdict = createMicVerdict();
    // One clipped poll written out, then ordinary speech throughout
    expect(verdict(1, 0)).toBeNull();
    for (let t = MIC_POLL_MS; t <= MIC_CLIP_CLEAR_MS; t += MIC_POLL_MS) {
      expect(verdict(0.3, t)).toBeNull();
    }

    // Fresh verdict fed MIC_CLIP_HITS - 1 clipped polls and then speech
    const fresh = createMicVerdict();
    let t = 0;
    for (let i = 0; i < MIC_CLIP_HITS - 1; i++) {
      expect(fresh(1, t)).toBeNull();
      t += MIC_POLL_MS;
    }
    for (let speechT = t; speechT <= t + MIC_CLIP_CLEAR_MS; speechT += MIC_POLL_MS) {
      expect(fresh(0.3, speechT)).toBeNull();
    }
  });

  it('reports clipping on the threshold hit and clears after MIC_CLIP_CLEAR_MS', () => {
    const verdict = createMicVerdict();
    let t = 0;
    for (let i = 0; i < MIC_CLIP_HITS - 1; i++) {
      expect(verdict(1, t)).toBeNull();
      t += MIC_POLL_MS;
    }
    // The MIC_CLIP_HITS-th clipped poll returns 'clipping'
    expect(verdict(1, t)).toBe('clipping');
    const lastClippedMs = t;

    // Ordinary polls keep returning 'clipping' until MIC_CLIP_CLEAR_MS has passed
    for (let now = lastClippedMs + MIC_POLL_MS; now < lastClippedMs + MIC_CLIP_CLEAR_MS; now += MIC_POLL_MS) {
      expect(verdict(0.3, now)).toBe('clipping');
    }
    // Exactly at MIC_CLIP_CLEAR_MS and after, returns null
    expect(verdict(0.3, lastClippedMs + MIC_CLIP_CLEAR_MS)).toBeNull();
    expect(verdict(0.3, lastClippedMs + MIC_CLIP_CLEAR_MS + MIC_POLL_MS)).toBeNull();
  });

  it('does not accumulate clipped polls spaced MIC_CLIP_CLEAR_MS apart', () => {
    const verdict = createMicVerdict();
    let t = 0;
    for (let cycle = 0; cycle < 5; cycle++) {
      expect(verdict(1, t)).toBeNull();
      for (let step = 1; step * MIC_POLL_MS < MIC_CLIP_CLEAR_MS; step++) {
        expect(verdict(0.3, t + step * MIC_POLL_MS)).toBeNull();
      }
      t += MIC_CLIP_CLEAR_MS;
    }
    expect(verdict(1, t)).toBeNull();
  });

  it('matches the lobby threshold: MIC_CLIP_PEAK is clean while MIC_CLIP_PEAK + 0.001 clips', () => {
    const verdictExact = createMicVerdict();
    for (let i = 0; i < MIC_CLIP_HITS; i++) {
      expect(verdictExact(MIC_CLIP_PEAK, i * MIC_POLL_MS)).toBeNull();
    }

    const verdictAbove = createMicVerdict();
    for (let i = 0; i < MIC_CLIP_HITS - 1; i++) {
      expect(verdictAbove(MIC_CLIP_PEAK + 0.001, i * MIC_POLL_MS)).toBeNull();
    }
    expect(verdictAbove(MIC_CLIP_PEAK + 0.001, (MIC_CLIP_HITS - 1) * MIC_POLL_MS)).toBe('clipping');
  });

  it('resets the clipping hit count when mic is off in the app', () => {
    const verdict = createMicVerdict();
    let t = 0;
    for (let i = 0; i < MIC_CLIP_HITS - 1; i++) {
      expect(verdict(1, t)).toBeNull();
      t += MIC_POLL_MS;
    }
    expect(verdict(null, t)).toBeNull();
    t += MIC_POLL_MS;
    expect(verdict(1, t)).toBeNull();
  });

  it('extends the clear window on subsequent clipped polls', () => {
    const verdict = createMicVerdict();
    let t = 0;
    for (let i = 0; i < MIC_CLIP_HITS; i++) {
      verdict(1, t);
      t += MIC_POLL_MS;
    }
    t += MIC_CLIP_CLEAR_MS / 2;
    expect(verdict(1, t)).toBe('clipping');
    const extendedLastClip = t;

    expect(verdict(0.3, extendedLastClip + MIC_CLIP_CLEAR_MS - MIC_POLL_MS)).toBe('clipping');
    expect(verdict(0.3, extendedLastClip + MIC_CLIP_CLEAR_MS)).toBeNull();
  });

  it('keeps the clipping note through dead polls and still times silence from the first dead poll', () => {
    const verdict = createMicVerdict();
    let t = 0;
    for (let i = 0; i < MIC_CLIP_HITS; i++, t += MIC_POLL_MS) verdict(1, t);
    const lastClip = t - MIC_POLL_MS;
    const deadSince = t;
    for (; t < lastClip + MIC_CLIP_CLEAR_MS; t += MIC_POLL_MS) {
      expect(verdict(0, t)).toBe('clipping');
    }
    for (; t < deadSince + MIC_SILENT_AFTER_MS; t += MIC_POLL_MS) {
      expect(verdict(0, t)).toBeNull();
    }
    expect(verdict(0, t)).toBe('silent');
  });

  it('does not forget the count over silence between clipped polls', () => {
    const verdict = createMicVerdict();
    let t = 0;
    for (let i = 0; i < MIC_CLIP_HITS - 1; i++) {
      expect(verdict(1, t)).toBeNull();
      t += MIC_POLL_MS;
      expect(verdict(0, t)).toBeNull();
      t += MIC_POLL_MS;
    }
    expect(verdict(1, t)).toBe('clipping');
  });

  it('adds up clipped polls less than MIC_CLIP_CLEAR_MS apart, however old the first is', () => {
    const verdict = createMicVerdict();
    const gap = 0.6 * MIC_CLIP_CLEAR_MS;
    let t = 0;
    for (let i = 0; i < MIC_CLIP_HITS - 1; i++) {
      expect(verdict(1, t)).toBeNull();
      for (let s = t + MIC_POLL_MS; s < t + gap; s += MIC_POLL_MS) expect(verdict(0.3, s)).toBeNull();
      t += gap;
    }
    expect(verdict(1, t)).toBe('clipping');
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

  it('reports clipping through watchMic when only one channel is hot', () => {
    const tap0: LevelTap = {
      fftSize: 0,
      context: { state: 'running' },
      getFloatTimeDomainData: (b: Float32Array) => {
        b.fill(1);
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
    vi.advanceTimersByTime(MIC_CLIP_HITS * MIC_POLL_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('clipping');
    stop();
  });
});
