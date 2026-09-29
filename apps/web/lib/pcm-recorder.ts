import { CHUNK_TIMESLICE_MS, WAV_BIT_DEPTH } from '@openmeet/protocol';

// Backstop for a source that has stopped producing frames; one frame is ~10ms.
const PCM_DRAIN_TIMEOUT_MS = 500;
import type { RecordedChunk } from './recorder';
import { f32ToS24LE, wavHeader, WAV_HEADER_BYTES, type WavFormat } from './wav';

/**
 * Records the mic as uncompressed WAV, alongside (not instead of) the MP4.
 *
 * MediaRecorder cannot emit WAV, so this is a second capture path off the same
 * track rather than a codec swap. It uses MediaStreamTrackProcessor (WebCodecs)
 * to read raw AudioData frames — an AudioWorklet would also work but needs a
 * separately-loaded module script, which static export makes awkward. openMeet
 * is Chromium-only already (File System Access), so WebCodecs costs no reach.
 *
 * Emits the same RecordedChunk shape as ChunkRecorder, so ChunkSender,
 * ChunkReceiver and FileWriter carry it with no changes at all: the transport is
 * byte-oriented and never inspects the payload.
 */

// The subset of WebCodecs AudioData this needs. Declared structurally so tests
// can feed plain objects instead of standing up real WebCodecs.
export interface PcmFrame {
  sampleRate: number;
  numberOfChannels: number;
  numberOfFrames: number;
  allocationSize(opts: { planeIndex: number; format: string }): number;
  copyTo(dest: ArrayBuffer | ArrayBufferView, opts: { planeIndex: number; format: string }): void;
  close(): void;
  timestamp?: number;
}

export type FrameSource = (track: MediaStreamTrack) => ReadableStream<PcmFrame>;

export interface PcmRecorderOpts {
  stream: MediaStream;
  onChunk: (chunk: RecordedChunk) => void;
  onError?: (err: unknown) => void;
  /** Test seam; defaults to MediaStreamTrackProcessor. */
  frameSource?: FrameSource;
}

/** Whether raw PCM capture is possible here. Recording still works without it. */
export function isPcmCaptureSupported(): boolean {
  return typeof globalThis !== 'undefined' && 'MediaStreamTrackProcessor' in globalThis;
}

function defaultFrameSource(track: MediaStreamTrack): ReadableStream<PcmFrame> {
  const Ctor = (globalThis as unknown as {
    MediaStreamTrackProcessor: new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<PcmFrame> };
  }).MediaStreamTrackProcessor;
  return new Ctor({ track }).readable;
}

export class PcmRecorder {
  private readonly opts: PcmRecorderOpts;
  private idx = 0;
  private _offset = WAV_HEADER_BYTES; // samples start after the header
  private fmt: WavFormat | null = null;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private lastFrameEndUs: number | null = null;
  private reader: ReadableStreamDefaultReader<PcmFrame> | null = null;
  private done: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(opts: PcmRecorderOpts) {
    this.opts = opts;
  }

  /** Total WAV file size so far, header included. */
  get totalBytes(): number {
    return this._offset;
  }

  get format(): WavFormat | null {
    return this.fmt;
  }

  /** Resolves when the capture source ends (track stopped, device unplugged). */
  whenDrained(): Promise<void> {
    return this.done;
  }

  start(): void {
    const track = this.opts.stream.getAudioTracks()[0];
    if (!track) throw new Error('PcmRecorder: stream has no audio track');
    const source = this.opts.frameSource ?? defaultFrameSource;
    this.reader = source(track).getReader();
    this.done = this.pump().catch((e: unknown) => this.opts.onError?.(e));
  }

  private async pump(): Promise<void> {
    const reader = this.reader;
    if (!reader) return;
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) return;
      try {
        this.consume(value);
      } finally {
        value.close();
      }
      if (this.stopped) return;
    }
  }

  private consume(frame: PcmFrame): void {
    // Format is whatever the mic actually delivers — read it, never assume it.
    // Requesting 48kHz in constraints is a hint, not a guarantee.
    if (!this.fmt) {
      this.fmt = {
        sampleRate: frame.sampleRate,
        channels: frame.numberOfChannels,
        bitDepth: WAV_BIT_DEPTH,
      };
      // Placeholder header at offset 0; rewritten with real sizes at finalize.
      this.emit(0, wavHeader(this.fmt, 0));
    }

    const durationUs = (frame.numberOfFrames * 1_000_000) / frame.sampleRate;
    if (this.lastFrameEndUs !== null && frame.timestamp !== undefined) {
      const gapUs = frame.timestamp - this.lastFrameEndUs;
      // Pad only whole missing frames. Sub-frame gaps are timestamp jitter from
      // Web Audio render quantum alignment (±1 quantum), not dropped frames;
      // real drops when the reader falls behind are whole frames.
      const missing = Math.round(gapUs / durationUs);
      if (missing >= 1) {
        const bytesPerSample = WAV_BIT_DEPTH / 8;
        const silenceBytes = missing * frame.numberOfFrames * frame.numberOfChannels * bytesPerSample;
        const silence = new Uint8Array(silenceBytes);
        this.pending.push(silence);
        this.pendingBytes += silenceBytes;
        if (this.pendingBytes >= this.chunkTarget()) this.flushPending();
      }
    }
    this.lastFrameEndUs = frame.timestamp !== undefined ? frame.timestamp + durationUs : null;

    // 'f32' is interleaved across channels, which is exactly WAV's layout.
    const bytes = frame.allocationSize({ planeIndex: 0, format: 'f32' });
    const f32 = new Float32Array(bytes / 4);
    frame.copyTo(f32, { planeIndex: 0, format: 'f32' });
    const pcm = new Uint8Array(f32ToS24LE(f32));

    this.pending.push(pcm);
    this.pendingBytes += pcm.byteLength;
    if (this.pendingBytes >= this.chunkTarget()) this.flushPending();
  }

  /** Batch to the same cadence as the video recorder rather than per ~10ms frame. */
  private chunkTarget(): number {
    const f = this.fmt;
    if (!f) return 0;
    const bytesPerSecond = f.sampleRate * f.channels * (f.bitDepth / 8);
    return Math.max(1, Math.floor((bytesPerSecond * CHUNK_TIMESLICE_MS) / 1000));
  }

  private flushPending(): void {
    if (this.pendingBytes === 0) return;
    const merged = new Uint8Array(this.pendingBytes);
    let at = 0;
    for (const part of this.pending) {
      merged.set(part, at);
      at += part.byteLength;
    }
    this.pending = [];
    this.pendingBytes = 0;
    this.emit(this._offset, merged.buffer);
    this._offset += merged.byteLength;
  }

  private emit(offset: number, payload: ArrayBuffer): void {
    try {
      this.opts.onChunk({
        header: { idx: this.idx++, offset, size: payload.byteLength, ts: Date.now() },
        payload,
      });
    } catch (e) {
      // emit() runs inside the read loop, so an unguarded throw would end PCM
      // capture for the whole session over one failed send. Offsets are already
      // committed, so carrying on leaves a recoverable hole.
      this.opts.onError?.(e);
    }
  }

  /**
   * Stops, flushes buffered samples, then rewrites the header at offset 0 with
   * the real sizes. The rewrite is just another chunk — dedupe is on `idx`, not
   * offset, so revisiting position 0 with a fresh idx is a legitimate use of the
   * positional transport and needs no receiver changes.
   */
  async stopAndFlush(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    // Let the pump exit on its own: it consumes the frame it is currently
    // awaiting, then sees `stopped`. Cancelling first would discard whatever the
    // stream still had queued, which is real audio loss at the tail of every
    // recording. The race is a backstop only — a track that has stopped
    // producing frames entirely would otherwise hang finalize, and a hung
    // finalize means the file never gets closed.
    await Promise.race([
      this.done,
      new Promise<void>((r) => setTimeout(r, PCM_DRAIN_TIMEOUT_MS)),
    ]);
    await this.reader?.cancel().catch(() => {});
    this.flushPending();
    if (this.fmt) {
      this.emit(0, wavHeader(this.fmt, this._offset - WAV_HEADER_BYTES));
    }
  }
}
