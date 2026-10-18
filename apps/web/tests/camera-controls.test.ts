import { describe, it, expect, vi } from 'vitest';
import { applyCameraSetting, cameraControls } from '@/lib/camera-controls';

function fakeTrack(
  capabilities: Record<string, unknown>,
  settings: Record<string, unknown> = {},
  constraints: Record<string, unknown> = {}
) {
  return {
    getCapabilities: () => capabilities,
    getSettings: () => settings,
    getConstraints: () => constraints,
    applyConstraints: vi.fn().mockResolvedValue(undefined),
  } as unknown as MediaStreamTrack & { applyConstraints: ReturnType<typeof vi.fn> };
}

describe('cameraControls', () => {
  it('lists what the camera offers, in a fixed order, with step and a value held inside the range', () => {
    const track = fakeTrack(
      {
        tilt: { min: -10, max: 10, step: 2 },
        pan: { min: 0, max: 4, step: 1 },
        zoom: { min: 1, max: 5 },
        colorTemperature: { min: 2000, max: 8000, step: 100 },
        whiteBalanceMode: ['manual', 'continuous'],
        exposureTime: { min: 10, max: 1000, step: 0 },
        exposureCompensation: { min: -2, max: 2, step: 0.5 },
        exposureMode: ['continuous', 'manual'],
      },
      {
        exposureMode: 'continuous',
        exposureCompensation: 9,
        zoom: 2,
        colorTemperature: 5000,
        whiteBalanceMode: 'manual',
      }
    );

    expect(cameraControls(track)).toEqual([
      { key: 'exposureMode', label: 'Auto exposure', kind: 'switch', on: true },
      { key: 'exposureCompensation', label: 'Exposure', kind: 'range', min: -2, max: 2, step: 0.5, value: 2 },
      { key: 'exposureTime', label: 'Exposure time', kind: 'range', min: 10, max: 1000, step: 9.9, value: 10 },
      { key: 'whiteBalanceMode', label: 'Auto white balance', kind: 'switch', on: false },
      { key: 'colorTemperature', label: 'Colour temperature', kind: 'range', min: 2000, max: 8000, step: 100, value: 5000 },
      { key: 'zoom', label: 'Zoom', kind: 'range', min: 1, max: 5, step: 0.04, value: 2 },
      { key: 'pan', label: 'Pan', kind: 'range', min: 0, max: 4, step: 1, value: 0 },
      { key: 'tilt', label: 'Tilt', kind: 'range', min: -10, max: 10, step: 2, value: -10 },
    ]);
  });

  it('draws nothing for an empty, non-finite or inverted range, or a mode list without manual', () => {
    const track = fakeTrack({
      exposureMode: ['continuous'],
      whiteBalanceMode: ['manual'],
      exposureCompensation: { min: 1, max: 1 },
      exposureTime: { min: 0, max: Infinity },
      colorTemperature: { min: 5, max: 1 },
      zoom: { min: Number.NaN, max: 3 },
      pan: { min: -Infinity, max: 3 },
      tilt: 'wide',
    });
    expect(cameraControls(track)).toEqual([]);
  });

  it('gives an empty list for a track that cannot say, or throws when asked', () => {
    expect(cameraControls({} as MediaStreamTrack)).toEqual([]);
    expect(cameraControls({ getCapabilities: () => undefined } as unknown as MediaStreamTrack)).toEqual([]);
    const throwing = {
      getCapabilities: () => {
        throw new Error('no');
      },
    } as unknown as MediaStreamTrack;
    expect(cameraControls(throwing)).toEqual([]);
  });

  it('still lists the controls when the settings cannot be read', () => {
    const track = {
      getCapabilities: () => ({ zoom: { min: 1, max: 3, step: 1 } }),
      getSettings: () => {
        throw new Error('no');
      },
    } as unknown as MediaStreamTrack;
    const none = { getCapabilities: () => ({ zoom: { min: 1, max: 3, step: 1 } }), getSettings: () => undefined };
    for (const t of [track, none as unknown as MediaStreamTrack]) {
      expect(cameraControls(t)).toEqual([
        { key: 'zoom', label: 'Zoom', kind: 'range', min: 1, max: 3, step: 1, value: 1 },
      ]);
    }
  });
});

describe('applyCameraSetting', () => {
  const caps = {
    zoom: { min: 1, max: 5, step: 1 },
    exposureTime: { min: 10, max: 100 },
    exposureMode: ['continuous', 'manual'],
  };

  it('keeps what the track was already asked for, so a new request does not undo it', async () => {
    const track = fakeTrack(caps, {}, {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
      deviceId: { exact: 'cam-1' },
    });
    await applyCameraSetting(track, 'zoom', 3);
    expect(track.applyConstraints).toHaveBeenCalledTimes(1);
    expect(track.applyConstraints).toHaveBeenCalledWith({
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
      deviceId: { exact: 'cam-1' },
      advanced: [{ zoom: 3 }],
    });
  });

  it('keeps a set for another key and replaces the set for the same key', async () => {
    const track = fakeTrack(caps, {}, { advanced: [{ exposureTime: 50 }, { zoom: 2 }, { sharpness: 4 }] });
    await applyCameraSetting(track, 'zoom', 4);
    expect(track.applyConstraints).toHaveBeenCalledWith({
      advanced: [{ exposureTime: 50 }, { sharpness: 4 }, { zoom: 4 }],
    });
  });

  it('holds a number inside the range the camera lists', async () => {
    const track = fakeTrack(caps);
    await applyCameraSetting(track, 'zoom', 99);
    await applyCameraSetting(track, 'exposureTime', -5);
    expect(track.applyConstraints).toHaveBeenNthCalledWith(1, { advanced: [{ zoom: 5 }] });
    expect(track.applyConstraints).toHaveBeenNthCalledWith(2, { advanced: [{ exposureTime: 10 }] });
  });

  it('sends continuous or manual for a switch', async () => {
    const track = fakeTrack(caps);
    await applyCameraSetting(track, 'exposureMode', true);
    await applyCameraSetting(track, 'exposureMode', false);
    expect(track.applyConstraints).toHaveBeenNthCalledWith(1, { advanced: [{ exposureMode: 'continuous' }] });
    expect(track.applyConstraints).toHaveBeenNthCalledWith(2, { advanced: [{ exposureMode: 'manual' }] });
  });

  it('makes no call for a key that is not one the panel lists', async () => {
    const track = fakeTrack(caps);
    await applyCameraSetting(track, 'focusDistance', 3);
    await applyCameraSetting(track, 'zoom', Number.NaN);
    expect(track.applyConstraints).not.toHaveBeenCalled();
  });

  it('returns the promise of the one call, so a refusal reaches the caller', async () => {
    const track = fakeTrack(caps);
    track.applyConstraints.mockRejectedValue(new Error('refused'));
    await expect(applyCameraSetting(track, 'zoom', 2)).rejects.toThrow('refused');
  });
});

describe('background blur', () => {
  const zoom = { min: 1, max: 3, step: 1 };

  it('lists a switch row first, on or off by the setting', () => {
    const caps = { backgroundBlur: [false, true], zoom, exposureMode: ['continuous', 'manual'] };
    expect(cameraControls(fakeTrack(caps, { backgroundBlur: true })).map((c) => c.key)).toEqual([
      'backgroundBlur',
      'exposureMode',
      'zoom',
    ]);
    expect(cameraControls(fakeTrack(caps, { backgroundBlur: true }))[0]).toEqual({
      key: 'backgroundBlur',
      label: 'Background blur',
      kind: 'switch',
      on: true,
    });
    expect(cameraControls(fakeTrack(caps, {}))[0]).toEqual({
      key: 'backgroundBlur',
      label: 'Background blur',
      kind: 'switch',
      on: false,
    });
  });

  it('draws no row unless the capability lists both true and false', () => {
    const lists = [[true], [false], 'true', [], ['true', 'false'], undefined];
    for (const backgroundBlur of lists) {
      expect(cameraControls(fakeTrack({ backgroundBlur, zoom })).map((c) => c.key)).toEqual(['zoom']);
    }
    expect(cameraControls(fakeTrack({ backgroundBlur: [true, false], zoom })).map((c) => c.key)).toEqual([
      'backgroundBlur',
      'zoom',
    ]);
  });

  it('sends the boolean itself and keeps what the track was already asked for', async () => {
    const track = fakeTrack({ backgroundBlur: [false, true] }, {}, { width: { ideal: 1280 }, deviceId: { exact: 'cam-1' } });
    await applyCameraSetting(track, 'backgroundBlur', true);
    await applyCameraSetting(track, 'backgroundBlur', false);
    expect(track.applyConstraints).toHaveBeenNthCalledWith(1, {
      width: { ideal: 1280 },
      deviceId: { exact: 'cam-1' },
      advanced: [{ backgroundBlur: true }],
    });
    expect(track.applyConstraints).toHaveBeenNthCalledWith(2, {
      width: { ideal: 1280 },
      deviceId: { exact: 'cam-1' },
      advanced: [{ backgroundBlur: false }],
    });
  });
});
