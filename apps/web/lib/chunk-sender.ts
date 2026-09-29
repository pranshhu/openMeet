import {
  DC_BUFFERED_HIGH_WATERMARK,
  DC_MAX_MESSAGE_BYTES,
  DC_BUFFERED_LOW_WATERMARK,
  DRAIN_NO_PROGRESS_TIMEOUT_MS,
  STREAM_BACKLOG_CAP_BYTES,
  encodeChunkHeader,
  type ChunkAck,
  type StreamAbandoned,
} from '@openmeet/protocol';
import type { RecordedChunk } from './recorder';
import { RetransmitBuffer } from './retransmit-buffer';
import { StreamingSha256 } from './sha256';

type Chunk = RecordedChunk;

export class StreamAbandonedError extends Error {
  constructor(
    message = 'Upload backlog exceeded — streaming stopped. Your full copy is saved locally (backup).'
  ) {
    super(message);
    this.name = 'StreamAbandonedError';
  }
}

export interface ChunkSenderOpts {
  recordingId: string;
  channel: RTCDataChannel;
  backlogCapBytes?: number;
  onBackpressure?: (paused: boolean) => void;
  onAbandon?: () => void;
  onError?: (err: unknown) => void;
}

export class ChunkSender {
  private readonly recordingId: string;
  private channel: RTCDataChannel;
  private readonly backlogCapBytes: number;
  private readonly onBackpressure: ((paused: boolean) => void) | undefined;
  private readonly onAbandon: (() => void) | undefined;
  private readonly onError: ((err: unknown) => void) | undefined;
  private queue: Chunk[] = [];
  private _lastAckedIdx = -1;
  private _lastSentIdx = -1;
  private _abandoned = false;
  private needSendAbandoned = false;
  private readonly buffer = new RetransmitBuffer();
  private readonly hash = new StreamingSha256();
  private paused = false;
  // Wire-level index. Independent of the recorder's, because one recorded chunk
  // becomes several frames on the wire.
  private outIdx = 0;

  constructor(opts: ChunkSenderOpts) {
    this.recordingId = opts.recordingId;
    this.channel = opts.channel;
    this.backlogCapBytes = opts.backlogCapBytes ?? STREAM_BACKLOG_CAP_BYTES;
    this.onBackpressure = opts.onBackpressure;
    this.onAbandon = opts.onAbandon;
    this.onError = opts.onError;
  }

  rebind(channel: RTCDataChannel): void {
    this.channel = channel;
    if (this._abandoned && this.needSendAbandoned) {
      this.sendAbandonedMessage();
    }
  }

  get lastAckedIdx(): number {
    return this._lastAckedIdx;
  }

  get lastSentIdx(): number {
    return this._lastSentIdx;
  }

  get isAbandoned(): boolean {
    return this._abandoned;
  }

  get hasQueuedChunks(): boolean {
    return this.queue.length > 0;
  }

  digestHex(): Promise<string> {
    return this.hash.digestHex();
  }

  /**
   * Queue one recorded chunk, split to fit the DataChannel's message limit.
   *
   * SCTP caps message size well below what a 2-second chunk contains — 1080p is
   * ~1.2 MiB against Chrome's 256 KiB — so sending a chunk whole throws
   * "Trying to send message larger than max-message-size" and the recording
   * dies. Every chunk openMeet produces is over the cap, video and audio alike.
   *
   * Fragmenting costs almost nothing because the transport is POSITIONAL: each
   * fragment carries its own absolute offset and the receiver writes it straight
   * to disk at that offset. Nothing is reassembled in memory, on either side.
   *
   * The digest is taken over the whole payload before splitting, and the host
   * hashes each fragment as it arrives — same byte sequence either way, so
   * integrity verification is unaffected.
   */
  sendChunk(chunk: Chunk): void {
    if (this._abandoned) return;
    const total = chunk.payload.byteLength;
    if (total === 0) return;

    if (this.buffer.bytes + total > this.backlogCapBytes) {
      this.abandonStream();
      return;
    }

    this.hash.update(chunk.payload);

    for (let at = 0; at < total; at += DC_MAX_MESSAGE_BYTES) {
      const end = Math.min(at + DC_MAX_MESSAGE_BYTES, total);
      const slice = chunk.payload.slice(at, end);
      const frag: Chunk = {
        header: {
          idx: this.outIdx++,
          offset: chunk.header.offset + at,
          size: slice.byteLength,
          ts: chunk.header.ts,
        },
        payload: slice,
      };
      this.buffer.add(frag);
      this.enqueueOrSend(frag);
    }
  }

  private abandonStream(): void {
    if (this._abandoned) return;
    this._abandoned = true;
    this.needSendAbandoned = true;
    this.queue = [];
    this.sendAbandonedMessage();
    this.onAbandon?.();
    this.onError?.(new StreamAbandonedError());
  }

  private sendAbandonedMessage(): void {
    if (this.channel.readyState === 'open') {
      try {
        const msg: StreamAbandoned = {
          type: 'stream-abandoned',
          recordingId: this.recordingId,
          lastIdx: this._lastSentIdx,
        };
        this.channel.send(JSON.stringify(msg));
        this.needSendAbandoned = false;
      } catch {
        // channel send failed; keep needSendAbandoned true
      }
    }
  }

  private enqueueOrSend(chunk: Chunk): void {
    const open = this.channel.readyState === 'open';
    const overHigh = open && this.channel.bufferedAmount > DC_BUFFERED_HIGH_WATERMARK;

    // HEAD OF LINE: once anything is queued, everything queues.
    //
    // This branch used to be entered only when the channel was closed or over
    // the high watermark, so between the high and low watermarks a new chunk
    // went straight out and OVERTOOK the backlog. When the drain then replayed
    // the queue at lower indices, the receiver's `idx <= lastIdx` dedupe threw
    // all of it away — and because writes are positional the file was left with
    // a zero-filled hole, with nothing thrown on either side. The WAV path made
    // this routine: its onBackpressure is a no-op, so the pump kept feeding the
    // sender while the queue sat there.
    if (!open || overHigh || this.queue.length > 0) {
      this.queue.push(chunk);
      // Pause on a closed channel too. Without it the queue grows unbounded at
      // ~5 Mbps video + ~1.15 Mbps WAV — roughly 3.4 GB/hr — until the tab dies,
      // while the host's file silently stops growing.
      if (overHigh || !open) this.setPaused(true);
      // onbufferedamountlow only fires on CROSSING the threshold, so a queue
      // that formed while already below it would sit unsent until finalize.
      else this.drainQueue();
      return;
    }
    if (!this.rawSend(chunk)) this.setPaused(true);
  }

  drainQueue(): void {
    if (this._abandoned) {
      if (this.needSendAbandoned) this.sendAbandonedMessage();
      return;
    }
    while (
      this.queue.length > 0 &&
      this.channel.readyState === 'open' &&
      this.channel.bufferedAmount <= DC_BUFFERED_HIGH_WATERMARK
    ) {
      // rawSend puts the chunk back on failure, so stop rather than spin.
      if (!this.rawSend(this.queue.shift()!)) break;
    }
    if (this.paused && this.channel.bufferedAmount <= DC_BUFFERED_LOW_WATERMARK) {
      this.setPaused(false);
    }
  }

  handleControl(msg: ChunkAck): void {
    // No recordingId comparison. The host and the guest each mint their own
    // crypto.randomUUID() for the same recording, so matching them never
    // succeeded: every ack was dropped, truncate() never ran, and the 32 MiB
    // retransmit buffer stayed permanently full — evicting exactly the chunks a
    // resume would need. One DataChannel carries one recording, so the channel
    // itself is the identity; the id bought nothing.
    if (msg.type !== 'ack') return;
    if (msg.uptoIdx > this._lastAckedIdx) {
      this._lastAckedIdx = msg.uptoIdx;
      this.buffer.truncate(msg.uptoIdx);
    }
  }

  /**
   * Replay everything after `lastIdx`, in strictly increasing idx order.
   *
   * A chunk can already be sitting in `queue` (sent while the channel was
   * dead) AND in `buffer.since(lastIdx)` (every chunk is buffered before it's
   * queued). Appending the replay behind the existing queue put that chunk on
   * the wire twice, ahead of chunks between it and lastIdx — the receiver's
   * idx<=lastIdx dedupe then discarded the real, never-yet-sent chunks as
   * "stale" duplicates. Merging both sources, deduping by idx, and rebuilding
   * the queue from scratch keeps the wire order gap-free.
   */
  resume(lastIdx: number): void {
    if (this._abandoned) {
      if (this.needSendAbandoned) this.sendAbandonedMessage();
      return;
    }
    const byIdx = new Map<number, Chunk>();
    for (const c of [...this.queue, ...this.buffer.since(lastIdx)]) {
      if (c.header.idx > lastIdx) byIdx.set(c.header.idx, c);
    }
    const replay = [...byIdx.values()].sort((a, b) => a.header.idx - b.header.idx);
    this.queue = [];
    for (const c of replay) this.enqueueOrSend(c);
    // enqueueOrSend only un-pauses via onbufferedamountlow, which fires on a
    // threshold CROSSING — a replay that never pushes bufferedAmount above the
    // low watermark never crosses it, so the recorder would stay paused for
    // the rest of the take. Drain explicitly so a replay that lands under the
    // watermark un-pauses immediately; one still above it is left for the new
    // channel's own onbufferedamountlow.
    this.drainQueue();
  }

  async drain(): Promise<boolean> {
    if (this._abandoned) return false;
    let lastProgressAt = Date.now();
    let lastAcked = this._lastAckedIdx;
    let lastQueueLen = this.queue.length;
    let lastBuffered = this.channel.bufferedAmount;

    return new Promise<boolean>((resolve) => {
      const tick = () => {
        if (this._abandoned) {
          resolve(false);
          return;
        }
        this.drainQueue();
        if (this.queue.length === 0 && this.channel.bufferedAmount === 0) {
          resolve(true);
          return;
        }
        const now = Date.now();
        if (
          this._lastAckedIdx > lastAcked ||
          this.queue.length < lastQueueLen ||
          this.channel.bufferedAmount < lastBuffered
        ) {
          lastProgressAt = now;
          lastAcked = this._lastAckedIdx;
          lastQueueLen = this.queue.length;
          lastBuffered = this.channel.bufferedAmount;
        }
        if (now - lastProgressAt >= DRAIN_NO_PROGRESS_TIMEOUT_MS) {
          resolve(false);
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  private setPaused(p: boolean): void {
    if (this.paused === p) return;
    this.paused = p;
    this.onBackpressure?.(p);
  }

  /**
   * Put one chunk on the wire as its two frames. Returns false if the send
   * failed, having pushed the chunk back to the head of the queue.
   *
   * Never throws. `send()` can reject a frame even after readyState says open —
   * the channel can close in between, and SCTP can refuse — and the throw used
   * to escape through `onbufferedamountlow`, an event handler nothing awaits.
   * Worse, from drain()'s setTimeout loop it left that promise permanently
   * unsettled, so finalizing hung forever instead of failing.
   *
   * Re-sending a header whose payload failed is safe: the receiver keeps only
   * the most recent header, so header, header, payload writes at the right
   * offset either way.
   */
  private rawSend(chunk: Chunk): boolean {
    try {
      this.channel.send(encodeChunkHeader(chunk.header));
      this.channel.send(chunk.payload);
      this._lastSentIdx = Math.max(this._lastSentIdx, chunk.header.idx);
      return true;
    } catch {
      this.queue.unshift(chunk);
      return false;
    }
  }
}
