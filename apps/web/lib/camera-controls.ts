type Mode = 'backgroundBlur' | 'exposureMode' | 'whiteBalanceMode';
type Range = 'exposureCompensation' | 'exposureTime' | 'colorTemperature' | 'zoom' | 'pan' | 'tilt';

export type CameraControl =
  | { key: Mode; label: string; kind: 'switch'; on: boolean }
  | { key: Range; label: string; kind: 'range'; min: number; max: number; step: number; value: number };

type Control =
  | { key: Mode; label: string; kind: 'switch'; on: string | boolean; off: string | boolean }
  | { key: Range; label: string; kind: 'range' };

const AUTO = { on: 'continuous', off: 'manual' } as const;

// The order the panel draws them in. A switch lists the two values its capability
// holds and sends the one that matches its state.
const CONTROLS: readonly Control[] = [
  { key: 'backgroundBlur', label: 'Background blur', kind: 'switch', on: true, off: false },
  { key: 'exposureMode', label: 'Auto exposure', kind: 'switch', ...AUTO },
  { key: 'exposureCompensation', label: 'Exposure', kind: 'range' },
  { key: 'exposureTime', label: 'Exposure time', kind: 'range' },
  { key: 'whiteBalanceMode', label: 'Auto white balance', kind: 'switch', ...AUTO },
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
 * The blur, exposure and colour settings this camera offers the browser, each only
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
  for (const control of CONTROLS) {
    const { key, label } = control;
    const capability = capabilities[key];
    if (control.kind === 'switch') {
      if (Array.isArray(capability) && capability.includes(control.on) && capability.includes(control.off)) {
        controls.push({ key: control.key, label, kind: 'switch', on: settings[key] === control.on });
      }
      continue;
    }
    const range = rangeOf(capability);
    if (!range) continue;
    const { min, max } = range;
    const step = typeof range.step === 'number' && range.step > 0 ? range.step : (max - min) / 100;
    const at = settings[key];
    const value = typeof at === 'number' && Number.isFinite(at) ? clamp(at, min, max) : min;
    controls.push({ key: control.key, label, kind: 'range', min, max, step, value });
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
  let setting: number | string | boolean;
  if (control.kind === 'switch') {
    setting = value ? control.on : control.off;
  } else {
    if (typeof value !== 'number' || !Number.isFinite(value)) return Promise.resolve();
    const range = rangeOf(capabilitiesOf(track)[key]);
    setting = range ? clamp(value, range.min, range.max) : value;
  }
  const asked = track.getConstraints?.() ?? {};
  const others = (Array.isArray(asked.advanced) ? asked.advanced : []).filter((set) => !(key in set));
  return track.applyConstraints({ ...asked, advanced: [...others, { [key]: setting }] });
}
