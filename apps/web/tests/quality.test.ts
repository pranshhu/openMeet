import { describe, it, expect } from 'vitest';
import {
  QUALITY_PRESETS, presetById, presetForTrack, supportedPresets,
  bytesPerHour, formatPerHour, describeTrack, DEFAULT_QUALITY_ID,
} from '@/lib/quality';

const track = (caps?: Partial<MediaTrackCapabilities>, settings?: Partial<MediaTrackSettings>) =>
  ({
    getCapabilities: caps ? () => caps as MediaTrackCapabilities : undefined,
    getSettings: () => (settings ?? {}) as MediaTrackSettings,
  }) as unknown as MediaStreamTrack;

describe('quality presets', () => {
  it('falls back to the default for an unknown id', () => {
    expect(presetById('nope').id).toBe(DEFAULT_QUALITY_ID);
  });

  it('scales bitrate with pixel count', () => {
    const bps = QUALITY_PRESETS.map((p) => p.videoBps);
    expect(bps).toEqual([...bps].sort((a, b) => a - b));
  });

  it('counts the uncompressed WAV in the per-hour estimate', () => {
    // Video alone would understate it by ~518 MB/hr, which is the whole reason
    // the estimate exists.
    const p = presetById('1080p');
    const videoOnly = (p.videoBps / 8) * 3600;
    expect(bytesPerHour(p)).toBeGreaterThan(videoOnly + 500e6);
    expect(formatPerHour(p)).toMatch(/GB\/hr/);
  });
});

describe('supportedPresets', () => {
  it('hides presets the camera cannot deliver', () => {
    const ids = supportedPresets(track({ width: { max: 1920 }, height: { max: 1080 } })).map((p) => p.id);
    expect(ids).toEqual(['720p', '1080p']);
  });

  // Constraints are `ideal`, so offering 4K on a 720p webcam promises a
  // resolution the recording will never contain.
  it('never returns an empty list, even below 720p', () => {
    expect(supportedPresets(track({ width: { max: 640 }, height: { max: 480 } }))).toHaveLength(1);
  });

  it('offers everything when capabilities are unavailable rather than guessing', () => {
    expect(supportedPresets(track())).toHaveLength(QUALITY_PRESETS.length);
    expect(supportedPresets(undefined)).toHaveLength(QUALITY_PRESETS.length);
  });
});

describe('presetForTrack', () => {
  // The self-correcting bit: if the camera silently degraded, encode at the
  // bitrate the REAL frame deserves, not the one that was asked for.
  it('picks the preset matching the actual resolution, not the requested one', () => {
    expect(presetForTrack(track(undefined, { height: 720 })).id).toBe('720p');
    expect(presetForTrack(track(undefined, { height: 2160 })).id).toBe('4k');
  });

  it('snaps an odd resolution to the nearest preset', () => {
    expect(presetForTrack(track(undefined, { height: 1200 })).id).toBe('1080p');
  });

  it('defaults when the track reports nothing', () => {
    expect(presetForTrack(undefined).id).toBe(DEFAULT_QUALITY_ID);
  });
});

describe('describeTrack', () => {
  it('reports what was actually negotiated', () => {
    expect(describeTrack(track(undefined, { width: 1920, height: 1080, frameRate: 30 }))).toBe('1920x1080 @ 30fps');
  });
  it('returns null when there is nothing to report', () => {
    expect(describeTrack(track(undefined, {}))).toBeNull();
  });
});
