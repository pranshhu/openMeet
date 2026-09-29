import { describe, it, expect } from 'vitest';
import { RECORDING_CONSTRAINTS } from '@/lib/media';

/**
 * The recorded master is whatever getUserMedia hands us, so browser-default
 * audio DSP (all three default to ON) would bake AGC pumping, noise gating and
 * echo cancellation irreversibly into the file.
 *
 * Echo cancellation additionally removes the far-end signal by design, which
 * makes the documented waveform-alignment fallback in sync.json structurally
 * impossible: neither file would contain any common signal to align on.
 */
describe('RECORDING_CONSTRAINTS audio', () => {
  const audio = RECORDING_CONSTRAINTS.audio as MediaTrackConstraints;

  it('disables all three DSP stages rather than inheriting browser defaults', () => {
    expect(audio.echoCancellation).toBe(false);
    expect(audio.noiseSuppression).toBe(false);
    expect(audio.autoGainControl).toBe(false);
  });

  it('requests 48kHz so the WAV master matches the studio standard', () => {
    expect(audio.sampleRate).toEqual({ ideal: 48_000 });
  });
});

describe('deviceConstraints', () => {
  it('builds shared constraints with DSP off and preset dimensions', async () => {
    const { deviceConstraints } = await import('@/lib/media');
    const c = deviceConstraints('mic-123', 'cam-456', '720p');
    const a = c.audio as MediaTrackConstraints;
    const v = c.video as MediaTrackConstraints;

    expect(a.echoCancellation).toBe(false);
    expect(a.noiseSuppression).toBe(false);
    expect(a.autoGainControl).toBe(false);
    expect(a.deviceId).toEqual({ exact: 'mic-123' });

    expect(v.width).toEqual({ ideal: 1280 });
    expect(v.height).toEqual({ ideal: 720 });
    expect(v.deviceId).toEqual({ exact: 'cam-456' });
  });

  it('handles facingMode for mobile cameras', async () => {
    const { deviceConstraints } = await import('@/lib/media');
    const c = deviceConstraints('', 'user');
    const v = c.video as MediaTrackConstraints;
    expect(v.facingMode).toEqual({ exact: 'user' });
    expect(v.deviceId).toBeUndefined();
  });
});
