import { describe, it, expect } from 'vitest';
import {
  QUALITY_PRESETS, presetById, presetForTrack, supportedPresets,
  bytesPerHour, formatPerHour, describeTrack, DEFAULT_QUALITY_ID,
  cleanFps, frameRateFrom,
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
  // The line exists to show what the camera really delivers, so a 29.97 mode
  // must not read as a rounded 30.
  it('prints the reported rate without rounding it away', () => {
    expect(describeTrack(track(undefined, { width: 1920, height: 1080, frameRate: 29.970029830932617 }))).toBe(
      '1920x1080 @ 29.97fps'
    );
    expect(describeTrack(track(undefined, { width: 1920, height: 1080, frameRate: 30.000030517578125 }))).toBe(
      '1920x1080 @ 30fps'
    );
  });

  it('prints no rate when the track reports one that is not usable', () => {
    expect(describeTrack(track(undefined, { width: 1920, height: 1080, frameRate: 0 }))).toBe('1920x1080');
  });

  it('returns null when there is nothing to report', () => {
    expect(describeTrack(track(undefined, {}))).toBeNull();
  });
});

describe('frameRateFrom', () => {
  it('takes a stored rate that is on offer', () => {
    expect(frameRateFrom('25')).toBe(25);
    expect(frameRateFrom('29.97')).toBe(29.97);
  });

  // A stale or hand-edited value must not become `frameRate: { ideal: NaN }`:
  // getUserMedia throws on it and the lobby is left with no preview at all.
  it('falls back to the default for anything else', () => {
    for (const raw of [null, '', 'abc', '1e9', '-25', 'NaN']) {
      expect(frameRateFrom(raw)).toBe(30);
    }
  });
});

describe('cleanFps', () => {
  it('keeps a sane rate and rounds it to three decimals', () => {
    expect(cleanFps(30)).toBe(30);
    expect(cleanFps(29.970029830932617)).toBe(29.97);
    expect(cleanFps(30.000030517578125)).toBe(30);
    expect(cleanFps(1)).toBe(1);
    expect(cleanFps(120)).toBe(120);
  });

  it('turns everything else into null', () => {
    expect(cleanFps(undefined)).toBeNull();
    expect(cleanFps(null)).toBeNull();
    expect(cleanFps('30')).toBeNull();
    expect(cleanFps({ toString: 0 })).toBeNull();
    expect(cleanFps(NaN)).toBeNull();
    expect(cleanFps(Infinity)).toBeNull();
    expect(cleanFps(0)).toBeNull();
    expect(cleanFps(0.5)).toBeNull();
    expect(cleanFps(-30)).toBeNull();
    expect(cleanFps(120.5)).toBeNull();
    expect(cleanFps(100000)).toBeNull();
  });
});
