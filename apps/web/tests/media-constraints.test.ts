import { describe, it, expect } from 'vitest';
import { NO_CAMERA, RECORDING_CONSTRAINTS, cameraConstraints, deviceConstraints, recordedChannels } from '@/lib/media';

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

describe('the portrait shape', () => {
  const asked = (c: MediaTrackConstraints | false) => {
    const v = c as MediaTrackConstraints;
    return [v.width, v.height];
  };

  it('asks for 9:16 at the preset height, the width rounded to an even number', () => {
    expect(asked(cameraConstraints('', '720p', 30, true))).toEqual([{ ideal: 406 }, { ideal: 720 }]);
    expect(asked(cameraConstraints('', '1080p', 30, true))).toEqual([{ ideal: 608 }, { ideal: 1080 }]);
    expect(asked(cameraConstraints('', '1440p', 30, true))).toEqual([{ ideal: 810 }, { ideal: 1440 }]);
    expect(asked(cameraConstraints('', '4k', 30, true))).toEqual([{ ideal: 1216 }, { ideal: 2160 }]);
  });

  it('is landscape when the argument is left out or false', () => {
    expect(asked(cameraConstraints('', '1080p'))).toEqual([{ ideal: 1920 }, { ideal: 1080 }]);
    expect(asked(cameraConstraints('', '1080p', 30, false))).toEqual([{ ideal: 1920 }, { ideal: 1080 }]);
  });

  it('leaves the device, the facing mode and the frame rate as they are', () => {
    const plain = cameraConstraints('cam-1', '1080p', 25) as MediaTrackConstraints;
    const tall = cameraConstraints('cam-1', '1080p', 25, true) as MediaTrackConstraints;
    expect(tall.deviceId).toEqual({ exact: 'cam-1' });
    expect(tall.frameRate).toEqual({ ideal: 25 });
    expect({ ...tall, width: plain.width }).toEqual(plain);
    expect((cameraConstraints('user', '1080p', 30, true) as MediaTrackConstraints).facingMode).toEqual({
      exact: 'user',
    });
  });

  it('is passed on by deviceConstraints', () => {
    const v = deviceConstraints('mic-1', 'cam-1', '1080p', 30, false, true).video as MediaTrackConstraints;
    expect(v.width).toEqual({ ideal: 608 });
    expect(v.height).toEqual({ ideal: 1080 });
    const w = deviceConstraints('mic-1', 'cam-1', '1080p').video as MediaTrackConstraints;
    expect(w.width).toEqual({ ideal: 1920 });
  });

  it('still opens no camera for the microphone-only choice', () => {
    expect(cameraConstraints(NO_CAMERA, '1080p', 30, true)).toBe(false);
    expect(deviceConstraints('mic-1', NO_CAMERA, '1080p', 30, false, true).video).toBe(false);
  });
});
