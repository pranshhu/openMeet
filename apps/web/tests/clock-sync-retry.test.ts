import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClockSync } from '@/lib/clock-sync';
import { ChunkSender } from '@/lib/chunk-sender';
import {
  endGuestRecording,
  rebindGuestRecording,
  type RecordingHandles,
} from '@/hooks/recording-controller';
import type { PeerConnection } from '@/lib/peer';

type Sent = { type: string; seq?: number; t0?: number; guestStartHostMs?: number; rttMs?: number };

const pings = (sent: Sent[]) => sent.filter((m) => m.type === 'clock_ping');
const metas = (sent: Sent[]) => sent.filter((m) => m.type === 'recording_meta');

describe('ClockSync: a round nobody answers is tried again', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (sent: Sent[], guestStartMs = Date.now()) =>
    new ClockSync({
      recordingId: 'r',
      guestStartMs,
      send: (j) => sent.push(JSON.parse(j) as Sent),
      perPingTimeoutMs: 100,
      retryMs: 1000,
    });

  it('starts another round after the pause, and reports as soon as one is answered', async () => {
    const sent: Sent[] = [];
    const start = Date.now();
    const sync = make(sent, start);
    const first = sync.run(2, 500);
    await vi.advanceTimersByTimeAsync(200);
    // The first round is over, unanswered: the caller hears null.
    await expect(first).resolves.toBeNull();
    expect(pings(sent)).toHaveLength(2);
    expect(metas(sent)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(999);
    expect(pings(sent)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(pings(sent)).toHaveLength(3);

    const ping = pings(sent)[2]!;
    sync.handlePong({ type: 'clock_pong', recordingId: 'r', seq: ping.seq!, t0: ping.t0!, t1: Date.now() + 5000 });
    // The round's second ping goes unanswered; the round still reports its one sample.
    await vi.advanceTimersByTimeAsync(100);
    expect(metas(sent)).toEqual([
      { type: 'recording_meta', recordingId: 'r', guestStartHostMs: start + 5000, rttMs: 0 },
    ]);

    // An answered round is the last one.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pings(sent)).toHaveLength(4);
    expect(metas(sent)).toHaveLength(1);
  });

  it('stops asking when told to', async () => {
    const sent: Sent[] = [];
    const sync = make(sent);
    void sync.run(2, 500);
    await vi.advanceTimersByTimeAsync(200);
    sync.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pings(sent)).toHaveLength(2);
  });

  it('reports what a round has when stop cuts it short', async () => {
    const sent: Sent[] = [];
    const start = Date.now();
    const sync = make(sent, start);
    const first = sync.run(5, 8000);
    const ping = pings(sent)[0]!;
    sync.handlePong({ type: 'clock_pong', recordingId: 'r', seq: ping.seq!, t0: ping.t0!, t1: start + 250 });
    sync.stop();
    expect(metas(sent)).toEqual([
      { type: 'recording_meta', recordingId: 'r', guestStartHostMs: start + 250, rttMs: 0 },
    ]);
    await expect(first).resolves.toEqual({ offsetMs: 250, rttMs: 0 });

    // The answer to the ping that was in flight arrives after the stop: nothing more is asked.
    const late = pings(sent)[1]!;
    sync.handlePong({ type: 'clock_pong', recordingId: 'r', seq: late.seq!, t0: late.t0!, t1: start + 250 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pings(sent)).toHaveLength(2);
    expect(metas(sent)).toHaveLength(1);
  });

  it('takes no estimate from a pong whose host time is not a number, and asks again', async () => {
    const sent: Sent[] = [];
    const sync = make(sent);
    void sync.run(1, 500);
    const ping = pings(sent)[0]!;
    for (const t1 of [null, 'soon', {}, undefined, Infinity]) {
      sync.handlePong({ type: 'clock_pong', recordingId: 'r', seq: ping.seq!, t0: ping.t0!, t1 } as never);
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(metas(sent)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pings(sent)).toHaveLength(2);
  });

  it('goes on when a send throws', async () => {
    const sent: Sent[] = [];
    let closed = true;
    const sync = new ClockSync({
      recordingId: 'r',
      guestStartMs: Date.now(),
      send: (j) => {
        if (closed) throw new Error('channel closed');
        sent.push(JSON.parse(j) as Sent);
      },
      perPingTimeoutMs: 100,
      retryMs: 1000,
    });
    const first = sync.run(1, 500);
    await vi.advanceTimersByTimeAsync(100);
    await expect(first).resolves.toBeNull();
    closed = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(pings(sent)).toHaveLength(1);
  });

  it('ends the round on the estimate it has when an answer finds this clock set back', async () => {
    const sent: Sent[] = [];
    const start = Date.now();
    const sync = make(sent, start);
    let got: unknown = 'not over';
    void sync.run(3, 500).then((r) => {
      got = r;
    });
    const p0 = pings(sent)[0]!;
    sync.handlePong({ type: 'clock_pong', recordingId: 'r', seq: p0.seq!, t0: p0.t0!, t1: start + 250 });
    const p1 = pings(sent)[1]!;
    // This computer's clock is set back five seconds between the second ping and its answer.
    vi.setSystemTime(start - 5000);
    sync.handlePong({ type: 'clock_pong', recordingId: 'r', seq: p1.seq!, t0: p1.t0!, t1: start + 250 });
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual({ offsetMs: 250, rttMs: 0 });
    expect(metas(sent)).toEqual([
      { type: 'recording_meta', recordingId: 'r', guestStartHostMs: start + 250, rttMs: 0 },
    ]);

    // The round was over at that answer: its third ping is never sent.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pings(sent)).toHaveLength(2);
    expect(metas(sent)).toHaveLength(1);
  });

  it('reports nothing and asks no more when its first answer finds this clock set back', async () => {
    const sent: Sent[] = [];
    const start = Date.now();
    const sync = make(sent, start);
    let got: unknown = 'not over';
    void sync.run(2, 500).then((r) => {
      got = r;
    });
    const ping = pings(sent)[0]!;
    vi.setSystemTime(start - 5000);
    sync.handlePong({ type: 'clock_pong', recordingId: 'r', seq: ping.seq!, t0: ping.t0!, t1: start + 20 });
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toBeNull();

    // No later round: its estimate would be measured after the clock was set.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pings(sent)).toHaveLength(1);

    // Nor at the stop, which is over at once.
    let over = false;
    void sync.again().then(() => {
      over = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(over).toBe(true);
    expect(pings(sent)).toHaveLength(1);
    expect(metas(sent)).toHaveLength(0);
  });
});

class FakeChannel {
  readyState = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;
  sent: (string | ArrayBuffer)[] = [];
  listeners: Record<string, (() => void)[]> = {};

  addEventListener(event: string, handler: () => void) {
    (this.listeners[event] ??= []).push(handler);
  }

  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }

  open() {
    this.readyState = 'open';
    for (const h of this.listeners['open'] ?? []) h();
  }

  of(type: string): Sent[] {
    return this.sent
      .filter((m): m is string => typeof m === 'string')
      .map((m) => JSON.parse(m) as Sent)
      .filter((m) => m.type === type);
  }
}

class FakePeer {
  camera: FakeChannel | null = null;

  createRecordingChannel(): RTCDataChannel {
    this.camera = new FakeChannel();
    return this.camera as unknown as RTCDataChannel;
  }

  createRecordingAudioChannel(): RTCDataChannel {
    return new FakeChannel() as unknown as RTCDataChannel;
  }
}

describe('guest recording: the clock sync follows the take', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('asks on the channel a reconnect made, and reports there', async () => {
    const oldCam = new FakeChannel();
    oldCam.readyState = 'open';
    const start = Date.now();
    const clockSync = new ClockSync({
      recordingId: 'rec',
      guestStartMs: start,
      send: (json) => {
        if (oldCam.readyState === 'open') oldCam.send(json);
      },
      perPingTimeoutMs: 100,
      retryMs: 1000,
    });
    const h: RecordingHandles = {
      recordingId: 'rec',
      sender: new ChunkSender({ recordingId: 'rec', channel: oldCam as unknown as RTCDataChannel }),
      channel: oldCam as unknown as RTCDataChannel,
      clockSync,
    };
    void clockSync.run(1, 500);
    expect(oldCam.of('clock_ping')).toHaveLength(1);

    // The connection drops and is rebuilt before any answer came.
    oldCam.readyState = 'closed';
    const peer = new FakePeer();
    rebindGuestRecording(h, peer as unknown as PeerConnection);
    const newCam = peer.camera!;
    newCam.open();

    // The unanswered round ends after 100 ms, and the next starts a second later.
    await vi.advanceTimersByTimeAsync(100 + 1000);
    expect(oldCam.of('clock_ping')).toHaveLength(1);
    const [ping] = newCam.of('clock_ping');
    expect(ping).toBeDefined();

    newCam.onmessage!({
      data: JSON.stringify({
        type: 'clock_pong',
        recordingId: 'rec',
        seq: ping!.seq,
        t0: ping!.t0,
        t1: Date.now() + 40,
      }),
    } as MessageEvent);
    expect(newCam.of('recording_meta')).toEqual([
      { type: 'recording_meta', recordingId: 'rec', guestStartHostMs: start + 40, rttMs: 0 },
    ]);
  });

  it('stops asking when the guest recording ends', async () => {
    const sent: string[] = [];
    const clockSync = new ClockSync({
      recordingId: 'rec',
      guestStartMs: Date.now(),
      send: (json) => sent.push(json),
      perPingTimeoutMs: 100,
      retryMs: 1000,
    });
    void clockSync.run(1, 500);
    await endGuestRecording({ recordingId: 'rec', clockSync });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(1);
  });
});
