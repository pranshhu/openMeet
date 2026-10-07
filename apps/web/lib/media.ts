import {
  RECORDING_VIDEO_WIDTH,
  RECORDING_VIDEO_HEIGHT,
  RECORDING_FRAME_RATE,
  WAV_SAMPLE_RATE,
} from '@openmeet/protocol';
import { DEFAULT_QUALITY_ID, presetById } from './quality';

// Default capture constraints for studio-quality recording. `ideal` (not `exact`)
// so a webcam that can't hit 1080p degrades instead of throwing OverconstrainedError.
// One stream feeds both the live call and the local recording: WebRTC adapts the
// *send* down under bandwidth pressure, but the local MediaRecorder keeps full res.
//
// Audio DSP is explicitly OFF. This same stream feeds MediaRecorder and the WAV
// master, so leaving the browser defaults on (they default to true) means the
// recorded master is AGC-pumped, noise-suppressed, echo-cancelled webcam audio —
// exactly what a studio recorder exists to avoid.
//
// It also breaks alignment. When clock-sync fails, sync.json tells the user to
// "align the two files by their audio waveform (clap/slate)" — which needs each
// file to contain some bleed of the other person. Echo cancellation removes the
// far-end signal by design, so the fallback was structurally impossible.
//
// The cost is that guests on speakers will hear echo: headphones are required,
// and documented as such in the README. That is the same trade every serious
// remote-recording tool makes. Deliberately NOT a toggle — an option here just
// moves the wrong default one click away.
export const RECORDING_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    width: { ideal: RECORDING_VIDEO_WIDTH },
    height: { ideal: RECORDING_VIDEO_HEIGHT },
    frameRate: { ideal: RECORDING_FRAME_RATE },
  },
  audio: {
    channelCount: { ideal: 2 },
    sampleRate: { ideal: WAV_SAMPLE_RATE },
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
};

export function deviceConstraints(
  micId?: string,
  camId?: string,
  qualityId: string = DEFAULT_QUALITY_ID,
  frameRate: number = RECORDING_FRAME_RATE
): MediaStreamConstraints {
  return { audio: micConstraints(micId), video: cameraConstraints(camId, qualityId, frameRate) };
}

export function micConstraints(micId?: string): MediaTrackConstraints {
  const a = RECORDING_CONSTRAINTS.audio as MediaTrackConstraints;
  return micId ? { ...a, deviceId: { exact: micId } } : { ...a };
}

/**
 * One channel unless stereo was asked for and the microphone can deliver it.
 * A voice is one source, so the second channel of a stereo mic array only
 * doubles the uncompressed master; the Web Audio destination mixes it down.
 */
export function recordedChannels(mic: MediaStreamTrack | null | undefined, stereo: boolean): 1 | 2 {
  return stereo && (mic?.getSettings?.().channelCount ?? 0) >= 2 ? 2 : 1;
}

export function cameraConstraints(
  camIdOrFacing?: string,
  qualityId: string = DEFAULT_QUALITY_ID,
  frameRate: number = RECORDING_FRAME_RATE
): MediaTrackConstraints {
  const v = RECORDING_CONSTRAINTS.video as MediaTrackConstraints;
  const q = presetById(qualityId);
  return {
    ...v,
    width: { ideal: q.width },
    height: { ideal: q.height },
    frameRate: { ideal: frameRate },
    ...(camIdOrFacing === 'user' || camIdOrFacing === 'environment'
      ? { facingMode: { exact: camIdOrFacing } }
      : camIdOrFacing
        ? { deviceId: { exact: camIdOrFacing } }
        : {}),
  };
}

export class MediaPermissionError extends Error {
  constructor(message = 'Camera/microphone permission denied') {
    super(message);
    this.name = 'MediaPermissionError';
  }
}

export class MediaDeviceMissingError extends Error {
  constructor(message = 'No camera or microphone found') {
    super(message);
    this.name = 'MediaDeviceMissingError';
  }
}

/**
 * Browsers expose navigator.mediaDevices only in a secure context: HTTPS, or
 * localhost. Serving over plain http from any other host — a LAN IP while
 * testing on two machines, or a self-hosted deploy without TLS — leaves it
 * `undefined`, and the call site then throws a bare
 * "Cannot read properties of undefined (reading 'getUserMedia')" at the user.
 */
export class InsecureContextError extends Error {
  constructor() {
    super(
      'Camera and microphone need a secure page. Serve openMeet over HTTPS, or open it ' +
        'via localhost. (Testing over a LAN IP? Start Chrome with ' +
        '--unsafely-treat-insecure-origin-as-secure=<origin> and its own --user-data-dir.)'
    );
    this.name = 'InsecureContextError';
  }
}

/** True when getUserMedia is actually callable here. */
export function isMediaCaptureSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  );
}

export interface DeviceInfo {
  deviceId: string;
  label: string;
}

export interface DeviceList {
  audioInputs: DeviceInfo[];
  videoInputs: DeviceInfo[];
}

export class MediaManager {
  private stream: MediaStream | null = null;

  async acquire(constraints?: MediaStreamConstraints): Promise<MediaStream> {
    // Check first: on an insecure origin navigator.mediaDevices is undefined,
    // and dereferencing it throws a TypeError the user cannot act on.
    if (!isMediaCaptureSupported()) throw new InsecureContextError();
    const want = constraints ?? { audio: true, video: true };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia(want);
      return this.stream;
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new MediaPermissionError();
      }
      if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        throw new MediaDeviceMissingError();
      }
      throw e;
    }
  }

  /** Adopt an already-acquired stream (e.g. one obtained in the lobby). */
  adopt(stream: MediaStream): void {
    this.stream = stream;
  }

  getStream(): MediaStream | null {
    return this.stream;
  }

  async listDevices(): Promise<DeviceList> {
    // Same insecure-context hazard as acquire(): mediaDevices may not exist.
    // Device pickers are a nicety, so degrade to empty rather than throwing.
    if (!isMediaCaptureSupported()) return { audioInputs: [], videoInputs: [] };
    const all = await navigator.mediaDevices.enumerateDevices();
    const audioInputs: DeviceInfo[] = [];
    const videoInputs: DeviceInfo[] = [];
    for (const d of all) {
      if (d.kind === 'audioinput') audioInputs.push({ deviceId: d.deviceId, label: d.label });
      else if (d.kind === 'videoinput') videoInputs.push({ deviceId: d.deviceId, label: d.label });
    }
    return { audioInputs, videoInputs };
  }

  setAudioEnabled(on: boolean): void {
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = on));
  }

  setVideoEnabled(on: boolean): void {
    this.stream?.getVideoTracks().forEach((t) => (t.enabled = on));
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
