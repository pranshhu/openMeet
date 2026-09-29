import { describe, it, expect, vi } from 'vitest';
import { ClockSync } from '@/lib/clock-sync';
import type { ClockPong, RecordingMeta } from '@openmeet/protocol';

describe('ClockSync', () => {
  it('estimates offset/rtt from a pong and reports guest start on host clock', async () => {
    const sent: unknown[] = [];
    // now() call order: [run:deadline, sendPing:t0, handlePong:t2].
    const times = [0, 1000, 1040]; // t0=1000, t2=1040 -> rtt 40
    let i = 0;
    const sync = new ClockSync({
      recordingId: 'r1',
      guestStartMs: 5000, // guest clock
      send: (j) => sent.push(JSON.parse(j)),
      now: () => times[Math.min(i++, times.length - 1)]!,
    });

    const run = sync.run(1, 8000);
    // Host received at host-clock t1 = 1_000_000 (huge skew on purpose).
    const ping = sent[0] as { type: string; seq: number; t0: number };
    expect(ping.type).toBe('clock_ping');
    const pong: ClockPong = { type: 'clock_pong', recordingId: 'r1', seq: ping.seq, t0: ping.t0, t1: 1_000_000 };
    sync.handlePong(pong);

    const result = await run;
    // offset = t1 - (t0+t2)/2 = 1_000_000 - (1000+1040)/2 = 1_000_000 - 1020 = 998_980
    expect(result).not.toBeNull();
    expect(result!.rttMs).toBe(40);
    expect(result!.offsetMs).toBe(998_980);

    const meta = sent.find((m) => (m as { type: string }).type === 'recording_meta') as RecordingMeta;
    expect(meta).toBeTruthy();
    // guestStartHostMs = 5000 + 998_980 = 1_003_980
    expect(meta.guestStartHostMs).toBe(1_003_980);
    expect(meta.rttMs).toBe(40);
  });

  it('keeps the minimum-RTT sample across multiple pings', async () => {
    const sent: Array<{ type: string; seq?: number; t0?: number }> = [];
    // now() order: [run:deadline, ping0:t0, pong0:t2, afterSample:check, ping1:t0, pong1:t2]
    // pong0 rtt=100; pong1 rtt=20 (wins).
    const times = [0, 0, 100, 100, 200, 220];
    let i = 0;
    const sync = new ClockSync({
      recordingId: 'r2',
      guestStartMs: 0,
      send: (j) => sent.push(JSON.parse(j)),
      now: () => times[Math.min(i++, times.length - 1)]!,
    });
    const run = sync.run(2, 8000);
    const p0 = sent[0]!;
    sync.handlePong({ type: 'clock_pong', recordingId: 'r2', seq: p0.seq!, t0: p0.t0!, t1: 1000 });
    const p1 = sent[1]!;
    sync.handlePong({ type: 'clock_pong', recordingId: 'r2', seq: p1.seq!, t0: p1.t0!, t1: 1000 });
    const result = await run;
    expect(result!.rttMs).toBe(20); // the smaller-RTT sample
  });

  it('resolves null and sends no meta when the host never answers', async () => {
    vi.useFakeTimers();
    try {
      const sent: Array<{ type: string }> = [];
      const sync = new ClockSync({
        recordingId: 'r3',
        guestStartMs: 0,
        send: (j) => sent.push(JSON.parse(j)),
        now: () => Date.now(),
        perPingTimeoutMs: 100,
      });
      const run = sync.run(2, 500);
      await vi.advanceTimersByTimeAsync(600);
      const result = await run;
      expect(result).toBeNull();
      expect(sent.every((m) => m.type === 'clock_ping')).toBe(true);
      expect(sent.some((m) => m.type === 'recording_meta')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores pongs for a different recordingId or stale seq', async () => {
    const sent: Array<{ type: string; seq?: number; t0?: number }> = [];
    // now() order: [run:deadline, ping:t0, correctPong:t2]. Wrong/stale pongs
    // return before reading now(), so they don't consume the sequence.
    const times = [0, 0, 10];
    let i = 0;
    const sync = new ClockSync({
      recordingId: 'r4',
      guestStartMs: 0,
      send: (j) => sent.push(JSON.parse(j)),
      now: () => times[Math.min(i++, times.length - 1)]!,
    });
    const run = sync.run(1, 8000);
    const p0 = sent[0]!;
    sync.handlePong({ type: 'clock_pong', recordingId: 'WRONG', seq: p0.seq!, t0: p0.t0!, t1: 5 });
    sync.handlePong({ type: 'clock_pong', recordingId: 'r4', seq: p0.seq! + 99, t0: p0.t0!, t1: 5 });
    // Now the correct one:
    sync.handlePong({ type: 'clock_pong', recordingId: 'r4', seq: p0.seq!, t0: p0.t0!, t1: 5 });
    const result = await run;
    expect(result).not.toBeNull();
    expect(result!.rttMs).toBe(10);
  });
});
