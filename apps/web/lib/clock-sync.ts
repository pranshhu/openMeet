import type { ClockPing, ClockPong, RecordingMeta } from '@openmeet/protocol';

export interface ClockSyncResult {
  offsetMs: number; // hostClock - guestClock; add to a guest timestamp to get host time
  rttMs: number;
}

export interface ClockSyncOpts {
  recordingId: string;
  guestStartMs: number; // guest recorder start, in guest clock
  send: (json: string) => void;
  now?: () => number;
  perPingTimeoutMs?: number;
}

/**
 * Guest side of the recording clock-sync. Sends a short sequence of pings over
 * the recording DataChannel; for each pong it computes a (offset, rtt) sample
 * (NTP-style, assuming symmetric delay) and keeps the one with the smallest RTT
 * (least delay noise). When done it reports the guest's recorder start expressed
 * on the HOST clock via a `recording_meta` control message, so the host can write
 * the alignment offset between the two files.
 *
 * Pongs must be routed in via handlePong() (the channel's onmessage already
 * demuxes control messages). Degrades to null (no meta sent) if the host never
 * answers within the run timeout — e.g. it hasn't started recording yet.
 */
export class ClockSync {
  private readonly recordingId: string;
  private readonly guestStartMs: number;
  private readonly send: (json: string) => void;
  private readonly now: () => number;
  private readonly perPingTimeoutMs: number;

  private seq = 0;
  private remaining = 0;
  private deadline = 0;
  private pending: { seq: number; t0: number } | null = null;
  private best: ClockSyncResult | null = null;
  private resolveRun: ((r: ClockSyncResult | null) => void) | null = null;
  private overallTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: ClockSyncOpts) {
    this.recordingId = opts.recordingId;
    this.guestStartMs = opts.guestStartMs;
    this.send = opts.send;
    this.now = opts.now ?? (() => Date.now());
    this.perPingTimeoutMs = opts.perPingTimeoutMs ?? 1500;
  }

  run(samples = 5, timeoutMs = 8000): Promise<ClockSyncResult | null> {
    return new Promise((resolve) => {
      this.resolveRun = resolve;
      this.remaining = samples;
      this.deadline = this.now() + timeoutMs;
      this.overallTimer = setTimeout(() => this.finish(), timeoutMs);
      this.sendNextPing();
    });
  }

  handlePong(msg: ClockPong): void {
    if (msg.recordingId !== this.recordingId) return;
    if (!this.pending || msg.seq !== this.pending.seq) return;
    const t2 = this.now();
    const t0 = this.pending.t0;
    const rtt = t2 - t0;
    const offset = msg.t1 - (t0 + t2) / 2;
    if (!this.best || rtt < this.best.rttMs) this.best = { offsetMs: offset, rttMs: rtt };
    this.clearPingTimer();
    this.pending = null;
    this.afterSample();
  }

  private sendNextPing(): void {
    const seq = this.seq++;
    const t0 = this.now();
    this.pending = { seq, t0 };
    const ping: ClockPing = { type: 'clock_ping', recordingId: this.recordingId, seq, t0 };
    this.send(JSON.stringify(ping));
    this.pingTimer = setTimeout(() => this.onPingTimeout(seq), this.perPingTimeoutMs);
  }

  private onPingTimeout(seq: number): void {
    if (this.pending && this.pending.seq === seq) {
      this.pending = null;
      this.afterSample();
    }
  }

  private afterSample(): void {
    this.remaining -= 1;
    if (this.remaining > 0 && this.now() < this.deadline) this.sendNextPing();
    else this.finish();
  }

  private finish(): void {
    if (!this.resolveRun) return;
    this.clearTimers();
    const resolve = this.resolveRun;
    this.resolveRun = null;
    if (this.best) {
      const meta: RecordingMeta = {
        type: 'recording_meta',
        recordingId: this.recordingId,
        guestStartHostMs: Math.round(this.guestStartMs + this.best.offsetMs),
        rttMs: Math.round(this.best.rttMs),
      };
      this.send(JSON.stringify(meta));
    }
    resolve(this.best);
  }

  private clearPingTimer(): void {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = null;
  }

  private clearTimers(): void {
    this.clearPingTimer();
    if (this.overallTimer) clearTimeout(this.overallTimer);
    this.overallTimer = null;
  }
}
