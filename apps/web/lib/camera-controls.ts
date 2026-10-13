type Mode = 'exposureMode' | 'whiteBalanceMode';
type Range = 'exposureCompensation' | 'exposureTime' | 'colorTemperature' | 'zoom' | 'pan' | 'tilt';

export type CameraControl =
  | { key: Mode; label: string; kind: 'switch'; on: boolean }
  | { key: Range; label: string; kind: 'range'; min: number; max: number; step: number; value: number };

// The order the panel draws them in.
const CONTROLS: readonly { key: Mode | Range; label: string; kind: 'switch' | 'range' }[] = [
  { key: 'exposureMode', label: 'Auto exposure', kind: 'switch' },
  { key: 'exposureCompensation', label: 'Exposure', kind: 'range' },
  { key: 'exposureTime', label: 'Exposure time', kind: 'range' },
  { key: 'whiteBalanceMode', label: 'Auto white balance', kind: 'switch' },
  { key: 'colorTemperature', label: 'Colour temperature', kind: 'range' },
  { key: 'zoom', label: 'Zoom', kind: 'range' },
  { key: 'pan', label: 'Pan', kind: 'range' },
  { key: 'tilt', label: 'Tilt', kind: 'range' },
];

type Capability = { min: number; max: number; step?: unknown };

/** A browser's capability numbers are not trusted: only a finite, non-empty range counts. */
function rangeOf(capability: unknown): Capability | null {
  const c = capability as Capability | null | undefined;
  return typeof c?.min === 'number' &&
    typeof c.max === 'number' &&
    Number.isFinite(c.min) &&
    Number.isFinite(c.max) &&
    c.min < c.max
    ? c
    : null;
}

function capabilitiesOf(track: MediaStreamTrack): Record<string, unknown> {
  try {
    return (track.getCapabilities() ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/**
 * The exposure and colour settings this camera offers the browser, each only
 * where its capabilities list it. A track that cannot say gives none.
 */
export function cameraControls(track: MediaStreamTrack): CameraControl[] {
  const capabilities = capabilitiesOf(track);
  let settings: Record<string, unknown> = {};
  try {
    settings = (track.getSettings() ?? {}) as Record<string, unknown>;
  } catch {
    // The picture can be adjusted without knowing where each slider stands.
  }
  const controls: CameraControl[] = [];
  for (const { key, label, kind } of CONTROLS) {
    const capability = capabilities[key];
    if (kind === 'switch') {
      if (Array.isArray(capability) && capability.includes('continuous') && capability.includes('manual')) {
        controls.push({ key: key as Mode, label, kind, on: settings[key] === 'continuous' });
      }
      continue;
    }
    const range = rangeOf(capability);
    if (!range) continue;
    const { min, max } = range;
    const step = typeof range.step === 'number' && range.step > 0 ? range.step : (max - min) / 100;
    const at = settings[key];
    const value = typeof at === 'number' && Number.isFinite(at) ? clamp(at, min, max) : min;
    controls.push({ key: key as Range, label, kind, min, max, step, value });
  }
  return controls;
}

/**
 * Changes one setting on the camera with one request. A request replaces
 * everything the track was asked for before, so it carries the track's own
 * constraints (size, frame rate, device, earlier settings) and swaps only the
 * set that names `key`. Resolves with nothing for a key that is not offered.
 */
export function applyCameraSetting(track: MediaStreamTrack, key: string, value: number | boolean): Promise<void> {
  const control = CONTROLS.find((c) => c.key === key);
  if (!control) return Promise.resolve();
  let setting: number | string;
  if (control.kind === 'switch') {
    setting = value ? 'continuous' : 'manual';
  } else {
    if (typeof value !== 'number' || !Number.isFinite(value)) return Promise.resolve();
    const range = rangeOf(capabilitiesOf(track)[key]);
    setting = range ? clamp(value, range.min, range.max) : value;
  }
  const asked = track.getConstraints?.() ?? {};
  const others = (Array.isArray(asked.advanced) ? asked.advanced : []).filter((set) => !(key in set));
  return track.applyConstraints({ ...asked, advanced: [...others, { [key]: setting }] });
}
