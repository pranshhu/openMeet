import {
  ACK_EVERY_N_CHUNKS,
  ACK_EVERY_N_MS,
  CHUNK_TIMESLICE_MS,
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
import type { JournalFile } from './take-journal';

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
  /** The take's crash copy for this file. Without it acks behave exactly as before. */
  journalFile?: JournalFile;
  /** One message when the journal dies and the receiver falls back to acking the folder write. */
  onWarn?: (msg: string) => void;
  /** Where the journal's parts already put this file, for a take reopened after a crash. */
  resumeFrom?: { nextIdx: number; end: number };
}

export const RESUME_ASK_INTERVAL_MS = 2000;

/** How far past the end of what arrived a fragment may start. */
export const MAX_OFFSET_JUMP_BYTES = 64 * 1024 * 1024;

/** Gap answers in a row that left the expected index where it was. */
const GAP_ASKS_BEFORE_GIVING_UP = 5;

export class ChunkReceiver {
  private readonly recordingId: string;
  private readonly writer: FileWriter;
  private readonly sendControl: (json: string) => void;
  private readonly onError: ((err: unknown) => void) | undefined;
  private readonly maxBytes: number | undefined;
  private readonly journalFile: JournalFile | undefined;
  private readonly onWarn: ((msg: string) => void) | undefined;
  /** The wire index the next accepted fragment must carry. Claimed before the write, since the next frame can arrive while it is pending. */
  private nextIdx = 0;
  /** When a gap was last answered with resume_offset, so one lost fragment cannot become a message per frame. */
  private lastResumeAskAt = 0;
  /** Gap answers in a row with the expected index still missing; a sender that cannot fill it is asked no further. */
  private gapAsks = 0;
  /** A fragment far past the end was reported; one report per receiver is enough. */
  private jumpReported = false;
  /** A gap was reported as uncontinuable; one report per receiver is enough. */
  private gapReported = false;
  /** Bounded mode: where the next chunk must start. Claimed before the write, since the next chunk can arrive while it is pending. */
  private nextOffset = 0;
  /** Bounded mode: a chunk was refused, so no more data is taken. */
  private refused = false;
  private pendingHeader: ChunkHeader | null = null;
  private lastIdx = -1;
  private lastOffset = 0;
  private chunksSinceAck = 0;
  private lastAckAt = Date.now();
  private journalDead = false;
  /** Zero until the first fragment arrives; stamped when a commit is queued, so a file commits at most once per timeslice. */
  private lastCommitAt = 0;
  /**
   * Commits run one after another: the journal returns the commit already in
   * flight to a second caller, and acking on that promise would cover bytes
   * no part closed.
   */
  private commitChain: Promise<void> = Promise.resolve();
  private _bytesWritten = 0;
  private _guestStartHostMs: number | null = null;
  private _syncRttMs: number | null = null;
  private _senderSha256: string | null = null;
  private _senderFrameRate: number | null = null;
  private _abandoned = false;
  private _timedOut = false;
  private _receivedFinalHeader = false;
  private _receivedFinalized = false;
  private _resumed = false;
  /** Where the file stood when this receiver took over: the far-offset rule moves with it. */
  private resumeBase = 0;
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
    this.journalFile = opts.journalFile;
    this.onWarn = opts.onWarn;
    const from = opts.resumeFrom;
    // A position the journal could not have produced is no position: the take
    // then starts this file where it would have without one.
    if (from && Number.isFinite(from.nextIdx) && Number.isFinite(from.end) && from.nextIdx >= 0) {
      this.nextIdx = from.nextIdx;
      this.lastIdx = from.nextIdx - 1;
      this.lastOffset = Math.max(0, from.end);
      this.resumeBase = this.lastOffset;
      this._resumed = true;
    }
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

  /** This file began mid-stream; its digest covers only the part this tab received. */
  get resumed(): boolean {
    return this._resumed;
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

  /** The file this receiver writes into. */
  get fileName(): string {
    return this.writer.fileName;
  }

  /**
   * Wait for the sender's `recording-finalized`, or give up after `timeoutMs` of no progress.
   *
   * `hardCapMs` bounds the whole wait whatever the progress: a sender that
   * keeps delivering can otherwise hold the file open for as long as it likes.
   * Both give-ups set the same timed-out flag, so the file reads the same.
   *
   * Never rejects: a guest that crashed mid-recording must not stop the host
   * from closing and keeping the bytes it already has on disk.
   */
  whenFinalized(timeoutMs: number, hardCapMs = Infinity): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      this.finalized.then(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      const startedAt = Date.now();
      let lastProgress = this.lastDataReceivedAt;
      const check = () => {
        if (settled) return;
        if (this.lastDataReceivedAt > lastProgress) {
          lastProgress = this.lastDataReceivedAt;
        }
        const now = Date.now();
        if (now - lastProgress >= timeoutMs || now - startedAt >= hardCapMs) {
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
    if (this.maxBytes !== undefined) {
      if (header.idx <= this.lastIdx) return;
    } else {
      // A live file is written front to back. A fragment below the expected
      // index is a replay; one above it means a fragment was lost, and the
      // sender still holds everything unacknowledged, so ask for it again
      // rather than writing around the hole. `nextIdx` is claimed BEFORE the
      // write is awaited: a second fragment can arrive while it is pending,
      // and it must not be read as a duplicate.
      if (header.idx < this.nextIdx) return;
      if (header.idx > this.nextIdx) {
        // A sender that cannot fill the gap would be asked for it forever, and
        // every ask makes it replay its whole backlog. Five answers that left
        // the expected index where it was mean this file cannot be continued
        // here, and the sender's own backup is the only copy of the hole.
        if (this.gapAsks >= GAP_ASKS_BEFORE_GIVING_UP) return;
        const now = Date.now();
        if (now - this.lastResumeAskAt >= RESUME_ASK_INTERVAL_MS) {
          this.answerResume();
          this.gapAsks += 1;
          if (this.gapAsks >= GAP_ASKS_BEFORE_GIVING_UP && !this.gapReported) {
            this.gapReported = true;
            this.onError?.(
              new Error("A guest's recording could not be continued here. Their own backup has it.")
            );
          }
        }
        return;
      }
      // A guest names its own offsets. One far past the bytes that arrived
      // would make the folder writer create a sparse file, so it is refused.
      // Measured from where this receiver took the file over plus the bytes
      // that arrived since, not the file's end: one byte cannot buy another
      // 64 MiB of file, and a resumed file's own end is not a jump. The bound
      // is loose on purpose: a reconnect or a WAV header rewritten at offset 0
      // both move by more than a fragment.
      if (header.offset > this.resumeBase + this._bytesWritten + MAX_OFFSET_JUMP_BYTES) {
        if (!this.jumpReported) {
          this.jumpReported = true;
          this.onError?.(new Error('A fragment arrived far past the end of the file.'));
        }
        return;
      }
      this.gapAsks = 0;
      this.nextIdx = header.idx + 1;
    }
    // The recorder never sends an empty blob, and an empty frame would count
    // for acks and the finalize wait without moving the transfer forward.
    // Dropped for every receiver once its index is accounted for: a sender's
    // empty frame must not move a file's size off zero, or the sync report
    // reads it as written.
    if (data.byteLength === 0) return;
    if (this.maxBytes !== undefined) {
      if (this.refused) return;
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
    this.lastOffset = header.offset + data.byteLength;
    if (this.journalFile && !this.journalDead) {
      // The folder write is a temporary file until close(); the guest must keep
      // every byte the journal has not committed, so the ack waits for the commit.
      this.journalFile.append(header.offset, data);
      const now = Date.now();
      if (this.lastCommitAt === 0) this.lastCommitAt = now;
      if (now < this.lastCommitAt || now - this.lastCommitAt >= CHUNK_TIMESLICE_MS) {
        this.lastCommitAt = now;
        this.queueCommit(header.idx + 1, header.offset + data.byteLength);
      }
      return;
    }
    this.chunksSinceAck += 1;
    this.maybeAck();
  }

  flushAck(): void {
    if (this.lastIdx < 0) return;
    if (this.journalFile && !this.journalDead) {
      this.queueCommit(this.lastIdx + 1, this.lastOffset);
      return;
    }
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

  /** Tell the other side where this file ends, so it can replay exactly what is missing. */
  answerResume(): void {
    this.lastResumeAskAt = Date.now();
    const ro: ChunkResumeOffset = {
      type: 'resume_offset',
      recordingId: this.recordingId,
      lastByte: this.lastOffset,
      lastIdx: this.lastIdx,
    };
    this.sendControl(JSON.stringify(ro));
  }

  /** Queue one commit behind any earlier one, so its ack covers exactly its own bytes. */
  private queueCommit(nextIdx: number, uptoOffset: number): void {
    // commit() never rejects. A control send that does must not stop the next
    // commit, and must not surface from the finalize path's flushAck either.
    this.commitChain = this.commitChain
      .then(() => this.commitAndAck(nextIdx, uptoOffset))
      .catch(() => {});
  }

  /**
   * Close the bytes gathered so far and acknowledge exactly them, not the
   * bytes that arrived while the commit was in flight.
   */
  private async commitAndAck(nextIdx: number, uptoOffset: number): Promise<void> {
    if (this.journalDead) return;
    await this.journalFile!.commit(nextIdx);
    if (this.journalFile!.dead) {
      // The latch comes first: a warning callback that throws must not leave
      // the guest without the folder-write ack or the next commit unlatched.
      this.journalDead = true;
      try {
        this.onWarn?.('Crash protection stopped for this take — browser storage would not take it.');
      } finally {
        if (this.lastIdx >= 0) this.emitAckAt(this.lastIdx, this.lastOffset);
      }
      return;
    }
    if (this.lastIdx >= 0) this.emitAckAt(nextIdx - 1, uptoOffset);
  }

  private maybeAck(): void {
    const due =
      this.chunksSinceAck >= ACK_EVERY_N_CHUNKS || Date.now() - this.lastAckAt >= ACK_EVERY_N_MS;
    if (!due) return;
    this.emitAck();
  }

  private emitAck(): void {
    this.emitAckAt(this.lastIdx, this.lastOffset);
  }

  private emitAckAt(uptoIdx: number, uptoOffset: number): void {
    const ack: ChunkAck = {
      type: 'ack',
      recordingId: this.recordingId,
      uptoIdx,
      uptoOffset,
    };
    this.sendControl(JSON.stringify(ack));
    this.chunksSinceAck = 0;
    this.lastAckAt = Date.now();
  }
}
