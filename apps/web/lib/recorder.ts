import {
  CHUNK_TIMESLICE_MS,
  RECORDING_MIME,
  RECORDING_MIME_CANDIDATES,
  RECORDING_VIDEO_BPS,
  RECORDING_AUDIO_BPS,
  type ChunkHeader,
} from '@openmeet/protocol';

export interface RecordedChunk {
  header: ChunkHeader;
  payload: ArrayBuffer;
}

type MrFactory = (stream: MediaStream, opts: MediaRecorderOptions) => MediaRecorder;

export interface ChunkRecorderOpts {
  stream: MediaStream;
  onChunk: (chunk: RecordedChunk) => void;
  onStop?: () => void;
  /**
   * A MediaRecorder that fails mid-session (encoder error, track ended, device
   * unplugged) stops producing chunks silently while the UI keeps showing
   * "Recording". Without this the user finds out at finalize, or never.
   */
  onError?: (err: unknown) => void;
  mrFactory?: MrFactory;
  mimeType?: string;
  videoBitsPerSecond?: number;
  audioBitsPerSecond?: number;
}

/** Thrown when no candidate codec is encodable here, so recording cannot start. */
export class UnsupportedCodecError extends Error {
  constructor() {
    super(
      'This browser cannot record MP4 video. Recording needs a Chromium browser with ' +
        'an H.264 encoder — official Google Chrome is the tested one.'
    );
    this.name = 'UnsupportedCodecError';
  }
}

/**
 * First codec in RECORDING_MIME_CANDIDATES that this browser can actually encode,
 * or null if none of them work (Firefox, Safari, and any build without an H.264
 * encoder). Codec availability varies by OS even within Chrome — Linux Chrome has
 * no AAC encoder — so this must be probed at runtime, never assumed.
 */
export function pickRecordingMime(): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return null;
  }
  return RECORDING_MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

/**
 * Audio-only containers for the host's copy of a guest's call audio, best editor
 * import first: AAC in MP4 where the platform has an AAC encoder, Opus in MP4 on
 * Linux, and WebM/Opus as the one every Chromium has.
 */
const CALL_AUDIO_MIME_CANDIDATES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4;codecs=opus',
  'audio/webm;codecs=opus',
] as const;

/** First of them this browser can encode, or null. Probed, like pickRecordingMime. */
export function pickCallAudioMime(): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return null;
  }
  return CALL_AUDIO_MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

/**
 * Whether this browser can record at all. With no argument it asks the real
 * question — "is ANY supported codec available?" — rather than testing one
 * hardcoded string that happens to fail on Linux.
 */
export function isRecordingSupported(mimeType?: string): boolean {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return false;
  }
  if (mimeType !== undefined) return MediaRecorder.isTypeSupported(mimeType);
  return pickRecordingMime() !== null;
}

/**
 * How long to wait for MediaRecorder's `onstop` before giving up and flushing.
 * Generous: a real stop resolves in milliseconds, so anything near this is a
 * recorder that is never coming back.
 */
export const RECORDER_STOP_TIMEOUT_MS = 5_000;

export class ChunkRecorder {
  private readonly opts: ChunkRecorderOpts;
  private mr: MediaRecorder | null = null;
  private idx = 0;
  private _offset = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(opts: ChunkRecorderOpts) {
    this.opts = opts;
  }

  get totalBytes(): number {
    return this._offset;
  }

  start(): void {
    const factory = this.opts.mrFactory ?? ((s, o) => new MediaRecorder(s, o));
    const mr = factory(this.opts.stream, {
      // Callers should pass an explicitly probed mime; fall back to probing here so
      // a caller that forgets still gets something this browser can encode rather
      // than a hardcoded string that throws NotSupportedError on Linux.
      mimeType: this.opts.mimeType ?? pickRecordingMime() ?? RECORDING_MIME,
      videoBitsPerSecond: this.opts.videoBitsPerSecond ?? RECORDING_VIDEO_BPS,
      audioBitsPerSecond: this.opts.audioBitsPerSecond ?? RECORDING_AUDIO_BPS,
    });
    this.mr = mr;

    mr.ondataavailable = (ev: BlobEvent) => {
      if (!ev.data || ev.data.size === 0) return;
      const blob = ev.data;
      const myIdx = this.idx++;
      const myOffset = this._offset;
      this._offset += blob.size;
      const ts = Date.now();
      const work = this.tail.then(async () => {
        const payload = await blob.arrayBuffer();
        this.opts.onChunk({
          header: { idx: myIdx, offset: myOffset, size: blob.size, ts },
          payload,
        });
      });
      // The sequencing chain must NEVER hold a rejection. Previously `tail`
      // itself was the rejected promise, so one failing chunk skipped every
      // later .then() — silently dropping the rest of the recording — and
      // stopAndFlush() then awaited that rejection forever, so finalize hung
      // and the file was never closed. A single oversized send destroyed the
      // whole session. Report and carry on; offsets were already assigned
      // synchronously, so a failure leaves a recoverable hole rather than
      // shifting everything after it.
      this.tail = work.catch((e: unknown) => {
        this.opts.onError?.(e);
      });
    };

    mr.onstop = () => {
      void this.tail.then(() => this.opts.onStop?.());
    };

    mr.onerror = (ev: Event) => {
      const err = (ev as unknown as { error?: unknown }).error ?? new Error('MediaRecorder failed');
      this.opts.onError?.(err);
    };

    mr.start(CHUNK_TIMESLICE_MS);
  }

  stop(): void {
    this.mr?.stop();
  }

  /**
   * Stops and resolves only once the FINAL chunk has been handed to onChunk.
   *
   * MediaRecorder.stop() is synchronous but the last `ondataavailable` fires
   * afterwards, and the blob->ArrayBuffer conversion is queued on `tail`. So
   * `stop(); await writer.close()` closes the file before the last ~2s of video
   * has been written. Finalize must await this instead.
   */
  stopAndFlush(): Promise<void> {
    const mr = this.mr;
    if (!mr || mr.state === 'inactive') return this.tail;
    return new Promise<void>((resolve) => {
      const prev = this.opts.onStop;
      // Backstop. `onstop` never arrives from a MediaRecorder whose encoder has
      // already errored or whose capture track was pulled (device unplugged,
      // screen share revoked). Finalize awaits this BEFORE any writer.close(),
      // so without a timer a broken recorder means no file is ever closed and
      // the whole take is lost. PcmRecorder has had this since it shipped, with
      // a comment saying exactly that; this one never got it.
      const timer = setTimeout(() => {
        this.opts.onError?.(new Error('MediaRecorder did not stop; flushing what we have'));
        resolve();
      }, RECORDER_STOP_TIMEOUT_MS);
      this.opts.onStop = () => {
        clearTimeout(timer);
        prev?.();
        resolve();
      };
      mr.stop();
    });
  }

  pause(): void {
    if (this.mr && this.mr.state === 'recording') this.mr.pause();
  }

  resume(): void {
    if (this.mr && this.mr.state === 'paused') this.mr.resume();
  }
}
