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
  /** Pause before the next round of pings while no round has been answered. */
  retryMs?: number;
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
 * demuxes control messages). The host answers only while it is recording and
 * has this channel bound, which can be later than one round lasts, so a round
 * nobody answers is followed by another after `retryMs`, until one is answered
 * or stop() is called.
 */
export class ClockSync {
  private readonly recordingId: string;
  private readonly guestStartMs: number;
  private send: (json: string) => void;
  private readonly now: () => number;
  private readonly perPingTimeoutMs: number;
  private readonly retryMs: number;

  private seq = 0;
  private samples = 0;
  private timeoutMs = 0;
  private remaining = 0;
  private deadline = 0;
  private inRound = false;
  private stopped = false;
  private pending: { seq: number; t0: number } | null = null;
  private best: ClockSyncResult | null = null;
  /** An answer showed this clock set back while the round held no sample: nothing is asked after it. */
  private clockSetBack = false;
  private resolveRun: ((r: ClockSyncResult | null) => void) | null = null;
  private overallTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: ClockSyncOpts) {
    this.recordingId = opts.recordingId;
    this.guestStartMs = opts.guestStartMs;
    this.send = opts.send;
    this.now = opts.now ?? (() => Date.now());
    this.perPingTimeoutMs = opts.perPingTimeoutMs ?? 1500;
    this.retryMs = opts.retryMs ?? 5000;
  }

  /** Resolves when the first round ends, with its estimate or null. A later round reports by itself. */
  run(samples = 5, timeoutMs = 8000): Promise<ClockSyncResult | null> {
    return new Promise((resolve) => {
      this.resolveRun = resolve;
      this.samples = samples;
      this.timeoutMs = timeoutMs;
      this.startRound();
    });
  }

  /** Send through another channel: a reconnect replaces the one the recording began on. */
  sendOn(send: (json: string) => void): void {
    this.send = send;
  }

  /** The recording is over: no further round. One in flight ends here and reports what it has. */
  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.finish();
  }

  /**
   * One more round as the recording stops, reported like the first. The host
   * keeps it beside the first report, and the two say how far the clocks moved
   * in between. Resolves when the round is over, answered or not; never rejects.
   */
  again(samples = 3, timeoutMs = 3000): Promise<void> {
    this.stop();
    // An estimate taken after the clock was set back does not place the start.
    if (this.clockSetBack) return Promise.resolve();
    return new Promise((resolve) => {
      // A fresh estimate: the smallest round trip of this round, not of the take.
      this.best = null;
      this.resolveRun = () => resolve();
      this.samples = samples;
      this.timeoutMs = timeoutMs;
      this.startRound();
    });
  }

  handlePong(msg: ClockPong): void {
    if (msg.recordingId !== this.recordingId) return;
    if (!this.pending || msg.seq !== this.pending.seq) return;
    // The host's own number. One that is not a time gives no estimate, and
    // taking it would end the retries on a start nobody measured.
    if (typeof msg.t1 !== 'number' || !Number.isFinite(msg.t1)) return;
    const t2 = this.now();
    const t0 = this.pending.t0;
    const rtt = t2 - t0;
    if (rtt < 0) {
      // An answer cannot come before its question: this computer's clock was
      // set back in between. guestStartMs was read before that, so an estimate
      // measured from here on does not place it. The round ends on the sample
      // it has; with none, this recording asks no more.
      if (!this.best) this.clockSetBack = true;
      this.finish();
      return;
    }
    const offset = msg.t1 - (t0 + t2) / 2;
    if (!this.best || rtt < this.best.rttMs) this.best = { offsetMs: offset, rttMs: rtt };
    this.clearPingTimer();
    this.pending = null;
    this.afterSample();
  }

  private startRound(): void {
    this.retryTimer = null;
    this.inRound = true;
    this.remaining = this.samples;
    this.deadline = this.now() + this.timeoutMs;
    this.overallTimer = setTimeout(() => this.finish(), this.timeoutMs);
    this.sendNextPing();
  }

  private sendNextPing(): void {
    const seq = this.seq++;
    const t0 = this.now();
    this.pending = { seq, t0 };
    const ping: ClockPing = { type: 'clock_ping', recordingId: this.recordingId, seq, t0 };
    this.post(ping);
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
    if (!this.inRound) return;
    this.inRound = false;
    this.clearTimers();
    // A pong that comes between rounds belongs to none of them.
    this.pending = null;
    if (this.best) {
      const meta: RecordingMeta = {
        type: 'recording_meta',
        recordingId: this.recordingId,
        guestStartHostMs: Math.round(this.guestStartMs + this.best.offsetMs),
        rttMs: Math.round(this.best.rttMs),
      };
      this.post(meta);
    } else if (!this.stopped && !this.clockSetBack) {
      this.retryTimer = setTimeout(() => this.startRound(), this.retryMs);
    }
    const resolve = this.resolveRun;
    this.resolveRun = null;
    resolve?.(this.best);
  }

  /** A channel can close between the caller's check and the send; that must not end a round with an exception. */
  private post(msg: ClockPing | RecordingMeta): void {
    try {
      this.send(JSON.stringify(msg));
    } catch {
      // Unsent. A ping then times out like any other.
    }
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
