export interface ChunkHeader {
  idx: number;
  offset: number;
  size: number;
  ts: number;
}

export function encodeChunkHeader(h: ChunkHeader): string {
  return JSON.stringify(h);
}

/**
 * A non-negative safe integer.
 *
 * `typeof` alone was not enough: `typeof NaN` and `typeof Infinity` are both
 * 'number', and EVERY comparison against NaN is false, so both sailed straight
 * through the old `< 0` range check. A single header carrying Infinity set the
 * receiver's `lastIdx` to Infinity, and its `idx <= lastIdx` dedupe then
 * silently discarded every later chunk for that file — the entire rest of the
 * recording, with nothing thrown on either side.
 */
function isCount(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 0;
}

export function decodeChunkHeader(s: string): ChunkHeader | null {
  try {
    const v = JSON.parse(s) as unknown;
    if (typeof v !== 'object' || v === null) return null;
    const o = v as Record<string, unknown>;
    if (!isCount(o.idx) || !isCount(o.offset) || !isCount(o.size)) return null;
    if (typeof o.ts !== 'number' || !Number.isFinite(o.ts) || o.ts < 0) return null;
    return { idx: o.idx, offset: o.offset, size: o.size, ts: o.ts };
  } catch {
    return null;
  }
}

export interface ChunkAck {
  type: 'ack';
  recordingId: string;
  uptoIdx: number;
  uptoOffset: number;
}

export interface ChunkResumeQuery {
  type: 'resume_query';
  recordingId: string;
}

export interface ChunkResumeOffset {
  type: 'resume_offset';
  recordingId: string;
  lastByte: number;
  lastIdx: number;
}

export interface ChunkRecordingFinalized {
  type: 'recording-finalized';
  recordingId: string;
  totalBytes: number;
  /**
   * sha256 of everything the sender SENT. The host holds its own digest of
   * everything it WROTE; comparing the two is the actual integrity check.
   * Without this the host only ever had one side of it.
   */
  sha256?: string;
  /**
   * What the sender's camera track reported as its frame rate when the recorder
   * started. Camera files only. A figure from the sender's browser: the
   * receiver bounds it before using it.
   */
  frameRate?: number;
}

// Clock-sync (guest <-> host) over the recording DataChannel. The two peers each
// start their own MediaRecorder at independent wall-clock moments (two human
// clicks, plus clock skew between machines). To align the two output files on an
// editor timeline we estimate the host<->guest clock offset with a round trip,
// then the guest reports its recorder start expressed on the HOST clock.
export interface ClockPing {
  type: 'clock_ping';
  recordingId: string;
  seq: number;
  t0: number; // guest send time (guest clock)
}

export interface ClockPong {
  type: 'clock_pong';
  recordingId: string;
  seq: number;
  t0: number; // echoed guest send time
  t1: number; // host receive time (host clock)
}

export interface RecordingMeta {
  type: 'recording_meta';
  recordingId: string;
  guestStartHostMs: number; // guest recorder start, converted to host clock
  rttMs: number; // measured round-trip time (sync quality indicator)
}

export interface StreamAbandoned {
  type: 'stream-abandoned';
  recordingId: string;
  lastIdx: number;
}

// First message on a `backup#<name>` channel: how big the file is. The host
// answers `resume_offset` once it has a file open, and the bytes follow as
// ordinary chunks.
export interface BackupOffer {
  type: 'backup_offer';
  size: number;
}

export type DataChannelControlMessage =
  | ChunkAck
  | ChunkResumeQuery
  | ChunkResumeOffset
  | ChunkRecordingFinalized
  | ClockPing
  | ClockPong
  | RecordingMeta
  | StreamAbandoned
  | BackupOffer;
