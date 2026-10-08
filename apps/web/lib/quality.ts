import {
  MAX_RECORDED_PEERS,
  RECORDING_AUDIO_BPS,
  RECORDING_FRAME_RATE,
  RECORDING_VIDEO_BPS,
  RECORDING_VIDEO_HEIGHT,
  RECORDING_VIDEO_WIDTH,
  WAV_BIT_DEPTH,
  WAV_SAMPLE_RATE,
} from '@openmeet/protocol';

/**
 * Capture quality presets.
 *
 * Bitrates scale roughly with pixel count, which is what H.264 actually costs;
 * a flat multiplier per step would starve 4K and waste bits at 720p.
 */
export interface QualityPreset {
  id: string;
  label: string;
  width: number;
  height: number;
  videoBps: number;
}

export const QUALITY_PRESETS: QualityPreset[] = [
  { id: '720p', label: '720p', width: 1280, height: 720, videoBps: 2_500_000 },
  { id: '1080p', label: '1080p', width: RECORDING_VIDEO_WIDTH, height: RECORDING_VIDEO_HEIGHT, videoBps: RECORDING_VIDEO_BPS },
  { id: '1440p', label: '1440p', width: 2560, height: 1440, videoBps: 10_000_000 },
  { id: '4k', label: '4K', width: 3840, height: 2160, videoBps: 25_000_000 },
];

export const DEFAULT_QUALITY_ID = '1080p';

export function presetById(id: string): QualityPreset {
  return QUALITY_PRESETS.find((p) => p.id === id) ?? (QUALITY_PRESETS[1] as QualityPreset);
}

/** Frame rates a person can ask their camera for. */
export const FRAME_RATES: readonly number[] = [24, 25, 29.97, 30];

/** A stored frame rate, or the default when it is not one on offer. */
export function frameRateFrom(raw: string | null): number {
  const n = Number(raw);
  return FRAME_RATES.includes(n) ? n : RECORDING_FRAME_RATE;
}

/**
 * Bytes per hour for a preset: encoded video (including audio) plus the uncompressed WAV master,
 * which is a fixed ~518 MB/hr per channel and easy to forget.
 */
export function bytesPerHour(p: QualityPreset, channels = 1): number {
  const video = ((p.videoBps + RECORDING_AUDIO_BPS) / 8) * 3600;
  const wav = WAV_SAMPLE_RATE * (WAV_BIT_DEPTH / 8) * channels * 3600;
  return video + wav;
}

/**
 * Recording-folder space needed per hour for a room at the chosen quality:
 * camera MP4 (video and audio) plus stereo WAV per participant.
 */
export function recordingFolderBytesPerHour(p: QualityPreset, peers = MAX_RECORDED_PEERS): number {
  return bytesPerHour(p, 2) * peers;
}

export function formatPerHour(p: QualityPreset, channels = 1): string {
  const gb = bytesPerHour(p, channels) / 1e9;
  return gb >= 1 ? `~${gb.toFixed(1)} GB/hr` : `~${Math.round(gb * 1000)} MB/hr`;
}

/**
 * Presets this camera can actually deliver.
 *
 * Constraints are `ideal`, so asking a 720p webcam for 4K silently returns 720p
 * and the UI would promise a resolution the file never has. When capabilities
 * are unavailable (older browsers, no permission yet) every preset is offered
 * rather than hiding options on a guess.
 */
export function supportedPresets(track: MediaStreamTrack | undefined): QualityPreset[] {
  const caps = track?.getCapabilities?.();
  const maxW = caps?.width?.max;
  const maxH = caps?.height?.max;
  if (!maxW || !maxH) return QUALITY_PRESETS;
  const usable = QUALITY_PRESETS.filter((p) => p.width <= maxW && p.height <= maxH);
  // Never return nothing: a camera below 720p still has to be recordable.
  return usable.length > 0 ? usable : [QUALITY_PRESETS[0] as QualityPreset];
}

/**
 * The preset matching a live track's ACTUAL resolution.
 *
 * Recording reads the encode bitrate from here rather than from the user's
 * choice, so a camera that silently degraded (constraints are `ideal`) gets the
 * bitrate its real resolution deserves instead of one sized for a frame it never
 * produced. Nothing has to be threaded from the Lobby to the recorder.
 */
export function presetForTrack(track: MediaStreamTrack | undefined): QualityPreset {
  const h = track?.getSettings?.().height;
  if (!h) return presetById(DEFAULT_QUALITY_ID);
  let best = QUALITY_PRESETS[0] as QualityPreset;
  for (const p of QUALITY_PRESETS) {
    if (Math.abs(p.height - h) < Math.abs(best.height - h)) best = p;
  }
  return best;
}

/** Human-readable actual capture format, for the lobby and the summary screen. */
export function describeTrack(track: MediaStreamTrack | undefined): string | null {
  const s = track?.getSettings?.();
  if (!s?.width || !s.height) return null;
  const fps = cleanFps(s.frameRate);
  return `${s.width}x${s.height}${fps === null ? '' : ` @ ${fps}fps`}`;
}

/**
 * A frame rate fit for a report or an ffmpeg command: a number from 1 to 120,
 * to three decimals. Anything else is null, so "not reported" and "nonsense"
 * read the same downstream.
 */
export function cleanFps(v: unknown): number | null {
  return typeof v === 'number' && v >= 1 && v <= 120 ? Math.round(v * 1000) / 1000 : null;
}
