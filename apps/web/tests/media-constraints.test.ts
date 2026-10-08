import { describe, it, expect } from 'vitest';
import { RECORDING_CONSTRAINTS, recordedChannels } from '@/lib/media';

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

  // The graph mixes down; asking the device for one channel would leave
  // nothing for a stereo take to record.
  it('asks the device for two channels', () => {
    expect(audio.channelCount).toEqual({ ideal: 2 });
  });
});

describe('recordedChannels', () => {
  const mic = (settings: MediaTrackSettings) =>
    ({ getSettings: () => settings }) as unknown as MediaStreamTrack;

  it('records one channel when stereo was not asked for, even from a two-channel mic', () => {
    expect(recordedChannels(mic({ channelCount: 2 }), false)).toBe(1);
  });

  it('records two channels when stereo was asked for and the mic reports two', () => {
    expect(recordedChannels(mic({ channelCount: 2 }), true)).toBe(2);
  });

  it('records one channel when stereo was asked for but the mic reports one', () => {
    expect(recordedChannels(mic({ channelCount: 1 }), true)).toBe(1);
  });

  it('records one channel when the mic reports no channel count', () => {
    expect(recordedChannels(mic({}), true)).toBe(1);
  });

  it('records one channel when there is no mic at all', () => {
    expect(recordedChannels(null, true)).toBe(1);
    expect(recordedChannels(null, false)).toBe(1);
  });

  it('records two channels from a mic that reports more than two', () => {
    expect(recordedChannels(mic({ channelCount: 4 }), true)).toBe(2);
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

  it('asks the camera for the chosen frame rate, and for 30 without one', async () => {
    const { deviceConstraints } = await import('@/lib/media');
    const chosen = deviceConstraints('mic-123', 'cam-456', '720p', 25).video as MediaTrackConstraints;
    expect(chosen.frameRate).toEqual({ ideal: 25 });
    const fallback = deviceConstraints('mic-123', 'cam-456', '720p').video as MediaTrackConstraints;
    expect(fallback.frameRate).toEqual({ ideal: 30 });
  });
});
