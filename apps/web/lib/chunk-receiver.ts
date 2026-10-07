import {
  ACK_EVERY_N_CHUNKS,
  ACK_EVERY_N_MS,
  decodeChunkHeader,
  type ChunkAck,
  type ChunkHeader,
  type ChunkResumeOffset,
  type ClockPing,
  type ClockPong,
  type ChunkRecordingFinalized,
  type RecordingMeta,
} from '@openmeet/protocol';
import type { FileWriter } from './fs-writer';
import { StreamingSha256 } from './sha256';
import { cleanFps } from './quality';

export interface ChunkReceiverOpts {
  recordingId: string;
  writer: FileWriter;
  sendControl: (json: string) => void;
  // Reports a fatal write failure (e.g. DiskFullError). Without this the
  // rejection would be swallowed by the `void receiver.handleMessage(...)`
  // call site and never reach the UI.
  onError?: (err: unknown) => void;
  /** Largest end offset this file may reach, for a sender that declared its size up front. */
  maxBytes?: number;
}

export class ChunkReceiver {
  private readonly recordingId: string;
  private readonly writer: FileWriter;
  private readonly sendControl: (json: string) => void;
  private readonly onError: ((err: unknown) => void) | undefined;
  private readonly maxBytes: number | undefined;
  /** Bounded mode: where the next chunk must start. Claimed before the write, since the next chunk can arrive while it is pending. */
  private nextOffset = 0;
  /** Bounded mode: a chunk was refused, so no more data is taken. */
  private refused = false;
  private pendingHeader: ChunkHeader | null = null;
  private lastIdx = -1;
  private lastOffset = 0;
  private chunksSinceAck = 0;
  private lastAckAt = Date.now();
  private _bytesWritten = 0;
  private _guestStartHostMs: number | null = null;
  private _syncRttMs: number | null = null;
  private _senderSha256: string | null = null;
  private _senderFrameRate: number | null = null;
  private _abandoned = false;
  private _timedOut = false;
  private _receivedFinalHeader = false;
  private _receivedFinalized = false;
  private lastDataReceivedAt = Date.now();
  private readonly hash = new StreamingSha256();
  // Resolved when the sender says it has flushed everything. The host waits on
  // this before closing the file: a host-driven stop reaches the guest a round
  // trip late, so closing immediately would truncate whatever is still in
  // flight — the last few seconds of every recording.
  private finalizeResolve: (() => void) | null = null;
  private readonly finalized = new Promise<void>((res) => {
    this.finalizeResolve = res;
  });

  constructor(opts: ChunkReceiverOpts) {
    this.recordingId = opts.recordingId;
    this.writer = opts.writer;
    this.sendControl = opts.sendControl;
    this.onError = opts.onError;
    this.maxBytes = opts.maxBytes;
  }

  get bytesWritten(): number {
    return this._bytesWritten;
  }

  get isAbandoned(): boolean {
    return this._abandoned;
  }

  get isTimedOut(): boolean {
    return this._timedOut;
  }

  get receivedFinalHeader(): boolean {
    return this._receivedFinalHeader;
  }

  get receivedFinalized(): boolean {
    return this._receivedFinalized;
  }

  get lastOffsetValue(): number {
    return this.lastOffset;
  }

  // Guest recorder start, expressed on the host clock (from clock-sync), or null
  // if the guest never reported it (host started >timeout after the guest).
  get guestStartHostMs(): number | null {
    return this._guestStartHostMs;
  }

  get syncRttMs(): number | null {
    return this._syncRttMs;
  }

  /** Digest the sender reported for what it sent, once it finalizes. */
  get senderSha256(): string | null {
    return this._senderSha256;
  }

  /** Frame rate the sender's camera reported, once it finalizes; null if it never said or said nonsense. */
  get senderFrameRate(): number | null {
    return this._senderFrameRate;
  }

  /**
   * Wait for the sender's `recording-finalized`, or give up after `timeoutMs` of no progress.
   *
   * Never rejects: a guest that crashed mid-recording must not stop the host
   * from closing and keeping the bytes it already has on disk.
   */
  whenFinalized(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      this.finalized.then(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      let lastProgress = this.lastDataReceivedAt;
      const check = () => {
        if (settled) return;
        if (this.lastDataReceivedAt > lastProgress) {
          lastProgress = this.lastDataReceivedAt;
        }
        if (Date.now() - lastProgress >= timeoutMs) {
          settled = true;
          this._timedOut = true;
          resolve();
          return;
        }
        setTimeout(check, 100);
      };
      setTimeout(check, 100);
    });
  }

  /**
   * Stop waiting for sender finalization early, e.g. when the channel closes or peer leaves.
   */
  resolveEarly(): void {
    this.finalizeResolve?.();
  }

  digestHex(): Promise<string> {
    return this.hash.digestHex();
  }

  async handleMessage(data: string | ArrayBuffer): Promise<void> {
    if (typeof data === 'string') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      if (parsed && typeof parsed === 'object' && 'type' in parsed) {
        const t = (parsed as { type: string }).type;
        if (t === 'resume_query') this.answerResume();
        else if (t === 'clock_ping') this.answerClockPing(parsed as ClockPing);
        else if (t === 'recording_meta') this.captureMeta(parsed as RecordingMeta);
        else if (t === 'recording-finalized') {
          this._receivedFinalized = true;
          const sha = (parsed as ChunkRecordingFinalized).sha256;
          if (typeof sha === 'string' && sha.length <= 64) {
            this._senderSha256 = sha;
          }
          const fps = cleanFps((parsed as ChunkRecordingFinalized).frameRate);
          if (fps !== null) this._senderFrameRate = fps;
          this.finalizeResolve?.();
        } else if (t === 'stream-abandoned') {
          this._abandoned = true;
          this.finalizeResolve?.();
        }
        return;
      }
      this.pendingHeader = decodeChunkHeader(data);
      return;
    }
    const header = this.pendingHeader;
    this.pendingHeader = null;
    if (!header) return;
    if (header.idx <= this.lastIdx) return;
    if (this.maxBytes !== undefined) {
      // The recorder never sends an empty blob, and an empty frame would count
      // for acks and the finalize wait without moving the transfer forward.
      if (this.refused || data.byteLength === 0) return;
      // A returned file is read front to back. Holding the sender to that
      // keeps the digest of what arrived equal to the digest of the file,
      // and what is taken within the size it declared. A size that is not a
      // finite number refuses instead of allowing.
      const end = header.offset + data.byteLength;
      const why = !(Number.isFinite(this.maxBytes) && end <= this.maxBytes)
        ? 'Received more data than the sender declared.'
        : header.size !== data.byteLength
          ? 'Received data that does not match its header.'
          : header.offset !== this.nextOffset
            ? 'Received data out of order.'
            : null;
      if (why) {
        this.refused = true;
        this.onError?.(new Error(why));
        return;
      }
      this.nextOffset = end;
    }
    try {
      await this.writer.write(header.offset, data);
    } catch (err) {
      // Disk full or other write failure — report once and stop processing
      // this chunk. Caller transitions the room to an error state. A bounded
      // receiver stops at this first error like a refusal.
      if (this.maxBytes !== undefined) this.refused = true;
      this.onError?.(err);
      return;
    }
    // A write that was already queued when the receiver stopped must not be
    // hashed, counted or acked once it resolves.
    if (this.maxBytes !== undefined && this.refused) return;
    this.lastDataReceivedAt = Date.now();
    if (header.offset === 0 && this.lastIdx >= 0) {
      this._receivedFinalHeader = true;
    }
    this.hash.update(data);
    this._bytesWritten += data.byteLength;
    this.lastIdx = header.idx;
    this.lastOffset = header.offset + header.size;
    this.chunksSinceAck += 1;
    this.maybeAck();
  }

  flushAck(): void {
    if (this.lastIdx < 0) return;
    this.emitAck();
  }

  // Echo the guest's clock ping with the host receive time so the guest can
  // estimate the host<->guest clock offset (see ClockSync).
  private answerClockPing(ping: ClockPing): void {
    const pong: ClockPong = {
      type: 'clock_pong',
      recordingId: ping.recordingId,
      seq: ping.seq,
      t0: ping.t0,
      t1: Date.now(),
    };
    this.sendControl(JSON.stringify(pong));
  }

  private captureMeta(m: RecordingMeta): void {
    // The guest reports its start on this clock, and started before it could
    // report: a later time is not a start. Left unset, the report says to align
    // by waveform rather than pad a file by an amount the sender made up.
    if (Number.isFinite(m.guestStartHostMs) && m.guestStartHostMs <= Date.now()) {
      this._guestStartHostMs = m.guestStartHostMs;
    }
    if (Number.isFinite(m.rttMs)) {
      this._syncRttMs = m.rttMs;
    }
  }

  private answerResume(): void {
    const ro: ChunkResumeOffset = {
      type: 'resume_offset',
      recordingId: this.recordingId,
      lastByte: this.lastOffset,
      lastIdx: this.lastIdx,
    };
    this.sendControl(JSON.stringify(ro));
  }

  private maybeAck(): void {
    const due =
      this.chunksSinceAck >= ACK_EVERY_N_CHUNKS || Date.now() - this.lastAckAt >= ACK_EVERY_N_MS;
    if (!due) return;
    this.emitAck();
  }

  private emitAck(): void {
    const ack: ChunkAck = {
      type: 'ack',
      recordingId: this.recordingId,
      uptoIdx: this.lastIdx,
      uptoOffset: this.lastOffset,
    };
    this.sendControl(JSON.stringify(ack));
    this.chunksSinceAck = 0;
    this.lastAckAt = Date.now();
  }
}
