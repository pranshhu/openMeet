import { describe, it, expect, afterEach } from 'vitest';
import { RECORDING_AUDIO_BPS, STREAM_BACKLOG_CAP_BYTES } from '@openmeet/protocol';
import {
  QUALITY_PRESETS, presetById, presetForTrack, supportedPresets, supportedFrameRates,
  bytesPerHour, formatPerHour, describeTrack, DEFAULT_QUALITY_ID,
  cleanFps, frameRateFrom,
  DEFAULT_BITRATE_ID, atBitrate, bitrateLevels, cameraVideoBps, chooseBitrate,
  BITRATE_LEVELS, MAX_VIDEO_BPS, isHighFrameRate, presetAt,
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

describe('supportedFrameRates', () => {
  it('hides rates the camera cannot reach', () => {
    expect(supportedFrameRates(track({ frameRate: { max: 30 } }))).toEqual([24, 25, 29.97, 30]);
    expect(supportedFrameRates(track({ frameRate: { max: 25 } }))).toEqual([24, 25]);
    expect(supportedFrameRates(track({ frameRate: { max: 10 } }))).toEqual([24]);
  });

  // Half a frame of slack: a 59.94 camera does 60, a 29.97 one does 30.
  it('rounds a near-miss rate up to the option it can hold', () => {
    expect(supportedFrameRates(track({ frameRate: { max: 29.97 } }))).toEqual([24, 25, 29.97, 30]);
    expect(supportedFrameRates(track({ frameRate: { max: 59.94 } }))).toEqual([24, 25, 29.97, 30, 50, 60]);
  });

  it('lists 50 and 60 only where the camera reaches them', () => {
    expect(supportedFrameRates(track({ frameRate: { max: 60 } }))).toEqual([24, 25, 29.97, 30, 50, 60]);
    expect(supportedFrameRates(track({ frameRate: { max: 50 } }))).toEqual([24, 25, 29.97, 30, 50]);
  });

  it('offers everything when capabilities are unavailable rather than guessing', () => {
    expect(supportedFrameRates(track())).toEqual([24, 25, 29.97, 30, 50, 60]);
    expect(supportedFrameRates(track({ width: { max: 640 } }))).toEqual([24, 25, 29.97, 30, 50, 60]);
    expect(supportedFrameRates(undefined)).toEqual([24, 25, 29.97, 30, 50, 60]);
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

describe('bitrate levels', () => {
  afterEach(() => chooseBitrate(DEFAULT_BITRATE_ID));

  // First in the block, so it reads the level the module starts with.
  it('gives a camera track its preset at the level joined with', () => {
    expect(cameraVideoBps(track(undefined, { height: 720 }))).toBe(2_500_000);
    chooseBitrate('high');
    expect(cameraVideoBps(track(undefined, { height: 720 }))).toBe(3_750_000);
  });

  it('multiplies the preset bitrate by the level', () => {
    const p = presetById('1080p');
    expect(atBitrate(p, 'standard').videoBps).toBe(5_000_000);
    expect(atBitrate(p, 'high').videoBps).toBe(7_500_000);
    expect(atBitrate(p, 'max').videoBps).toBe(10_000_000);
  });

  it('leaves an unknown level at Standard', () => {
    const p = presetById('1080p');
    expect(atBitrate(p, 'nope')).toEqual(p);
  });

  it('offers no level past the ceiling', () => {
    expect(bitrateLevels(presetById('4k')).map((l) => l.id)).toEqual(['standard']);
    expect(atBitrate(presetById('4k'), 'max').videoBps).toBe(25_000_000);
    for (const p of QUALITY_PRESETS) expect(bitrateLevels(p)[0]?.id).toBe('standard');
  });

  // A guest's stream is abandoned once the backlog cap is waiting for an ack.
  // The 4K preset rides out 85 s of a stalled link; no level may do worse.
  it('keeps every offered bitrate inside what the recording channel is sized for', () => {
    for (const p of QUALITY_PRESETS) {
      for (const l of bitrateLevels(p)) {
        const bytesPerSec = (atBitrate(p, l.id).videoBps + RECORDING_AUDIO_BPS) / 8;
        expect(STREAM_BACKLOG_CAP_BYTES / bytesPerSec).toBeGreaterThanOrEqual(80);
      }
    }
  });

  // The picker and the recorder both read this list, so ids, labels and steps
  // are a contract: a later slice shows the labels and joins by the id.
  it('offers Standard, High and Maximum as the three steps', () => {
    expect(BITRATE_LEVELS.map((l) => [l.id, l.label, l.factor])).toEqual([
      ['standard', 'Standard', 1],
      ['high', 'High', 1.5],
      ['max', 'Maximum', 2],
    ]);
  });
});

describe('frame rate and bitrate', () => {
  afterEach(() => chooseBitrate(DEFAULT_BITRATE_ID));

  it('means 50 and 60 fps, and nothing a 30 fps camera reports', () => {
    for (const fps of [50, 59.94005994, 60]) expect(isHighFrameRate(fps)).toBe(true);
    for (const fps of [24, 29.97, 30.000030517578125, undefined, null, NaN]) {
      expect(isHighFrameRate(fps)).toBe(false);
    }
  });

  it('costs 1.5 times the bits and leaves the frame alone', () => {
    const p = presetById('1080p');
    expect(presetAt(p, 30)).toBe(p);
    expect(presetAt(p, undefined)).toBe(p);
    expect(presetAt(p, null)).toBe(p);
    expect(presetAt(p, 60)).toEqual({ ...p, videoBps: p.videoBps * 1.5 });
  });

  it('never passes the ceiling, at any preset and level', () => {
    expect(presetAt(presetById('4k'), 60).videoBps).toBe(MAX_VIDEO_BPS);
    for (const p of QUALITY_PRESETS) {
      for (const l of bitrateLevels(p)) {
        expect(presetAt(atBitrate(p, l.id), 60).videoBps).toBeLessThanOrEqual(MAX_VIDEO_BPS);
      }
    }
  });

  it('sizes a camera track from the rate it delivers', () => {
    const p = presetById('1080p').videoBps;
    expect(cameraVideoBps(track(undefined, { height: 1080, frameRate: 60 }))).toBe(p * 1.5);
    expect(cameraVideoBps(track(undefined, { height: 1080, frameRate: 30 }))).toBe(p);
    expect(cameraVideoBps(track(undefined, { height: 1080 }))).toBe(p);
    expect(cameraVideoBps(undefined)).toBe(presetById(DEFAULT_QUALITY_ID).videoBps);
  });

  // Frame rate first would drop the level instead of capping the product:
  // 1440p at Maximum and 60 fps would read 15 Mbps, not the 25 Mbps ceiling.
  it('applies the level first and the frame rate second, under one ceiling', () => {
    chooseBitrate('max');
    expect(cameraVideoBps(track(undefined, { height: 720, frameRate: 60 }))).toBe(
      presetById('720p').videoBps * 2 * 1.5
    );
    expect(cameraVideoBps(track(undefined, { height: 1440, frameRate: 60 }))).toBe(MAX_VIDEO_BPS);
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
    expect(frameRateFrom('50')).toBe(50);
    expect(frameRateFrom('60')).toBe(60);
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
