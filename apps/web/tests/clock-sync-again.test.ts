import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClockSync } from '@/lib/clock-sync';
import { endGuestRecording, type RecordingHandles } from '@/hooks/recording-controller';
import { handleGuestRecordingStarted } from '@/hooks/useRoom';

type Sent = { type: string; seq?: number; t0?: number; guestStartHostMs?: number };

const pings = (sent: Sent[]) => sent.filter((m) => m.type === 'clock_ping');
const metas = (sent: Sent[]) => sent.filter((m) => m.type === 'recording_meta');

describe('ClockSync.again: one more estimate as the recording stops', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (sent: Sent[], guestStartMs: number) =>
    new ClockSync({
      recordingId: 'r',
      guestStartMs,
      send: (j) => sent.push(JSON.parse(j) as Sent),
      perPingTimeoutMs: 100,
      retryMs: 1000,
    });

  it('reports a second estimate from a fresh round', async () => {
    const sent: Sent[] = [];
    const start = Date.now();
    const sync = make(sent, start);
    // The host's clock is `offset` ms ahead of this one, and the answer is instant.
    const answer = (offset: number) => {
      const ping = pings(sent).at(-1)!;
      sync.handlePong({ type: 'clock_pong', recordingId: 'r', seq: ping.seq!, t0: ping.t0!, t1: Date.now() + offset });
    };

    const first = sync.run(1, 500);
    answer(1000);
    await first;
    expect(metas(sent).map((m) => m.guestStartHostMs)).toEqual([start + 1000]);

    // An hour on, the host's clock has gained 7 ms on this one.
    await vi.advanceTimersByTimeAsync(3_600_000);
    const done = sync.again(1, 500);
    answer(1007);
    await done;
    expect(metas(sent).map((m) => m.guestStartHostMs)).toEqual([start + 1000, start + 1007]);
  });

  it('ends unanswered after its time, reports nothing, and is not followed by another round', async () => {
    const sent: Sent[] = [];
    const sync = make(sent, Date.now());
    let over = false;
    void sync.again(2, 300).then(() => {
      over = true;
    });
    await vi.advanceTimersByTimeAsync(199);
    expect(over).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(over).toBe(true);
    expect(pings(sent)).toHaveLength(2);
    expect(metas(sent)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(pings(sent)).toHaveLength(2);
  });

  it('ends at its three seconds when every answer comes late', async () => {
    const sent: Sent[] = [];
    const sync = new ClockSync({
      recordingId: 'r',
      guestStartMs: Date.now(),
      send: (j) => sent.push(JSON.parse(j) as Sent),
    });
    const start = Date.now();
    let took = -1;
    void sync.again().then(() => {
      took = Date.now() - start;
    });
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(1400);
      const ping = pings(sent).at(-1)!;
      sync.handlePong({ type: 'clock_pong', recordingId: 'r', seq: ping.seq!, t0: ping.t0!, t1: Date.now() });
    }
    await vi.advanceTimersByTimeAsync(5000);
    expect(took).toBe(3000);
    expect(metas(sent)).toHaveLength(1);
  });
});

describe('endGuestRecording: one more clock estimate before the file is called final', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = (over: { drained?: boolean; readyState?: string } = {}) => {
    const sent: Sent[] = [];
    const channel = {
      readyState: over.readyState ?? 'open',
      send: (j: string) => sent.push(JSON.parse(j) as Sent),
    };
    // Sends whatever the channel's state, so a ping that should not have been
    // asked for shows up in `sent`.
    const clockSync = new ClockSync({
      recordingId: 'r',
      guestStartMs: Date.now(),
      send: (j) => sent.push(JSON.parse(j) as Sent),
    });
    const sender = {
      drain: async () => over.drained ?? true,
      digestHex: async () => 'abc',
      isAbandoned: false,
      hasQueuedChunks: false,
      lastAckedIdx: 0,
    };
    return {
      sent,
      clockSync,
      types: () => sent.map((m) => m.type),
      ended: endGuestRecording({ recordingId: 'r', channel, sender, clockSync } as never),
    };
  };

  it('measures again after the drain and reports before the file is called final', async () => {
    const { sent, clockSync, types, ended } = setup();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(0);
      const ping = pings(sent).at(-1)!;
      clockSync.handlePong({ type: 'clock_pong', recordingId: 'r', seq: ping.seq!, t0: ping.t0!, t1: Date.now() + 9 });
    }
    await ended;
    expect(types()).toEqual(['clock_ping', 'clock_ping', 'clock_ping', 'recording_meta', 'recording-finalized']);
  });

  it('costs three seconds when the host never answers, and the file is still called final', async () => {
    const { types, ended } = setup();
    await vi.advanceTimersByTimeAsync(2999);
    expect(types()).not.toContain('recording-finalized');
    await vi.advanceTimersByTimeAsync(1);
    await ended;
    expect(types()).toEqual(['clock_ping', 'clock_ping', 'recording-finalized']);
  });

  it('asks nothing when the stream did not drain, or the channel is closed', async () => {
    const undrained = setup({ drained: false });
    await vi.advanceTimersByTimeAsync(5000);
    await undrained.ended;
    expect(undrained.types()).toEqual(['recording-finalized']);

    const closed = setup({ readyState: 'closed' });
    await vi.advanceTimersByTimeAsync(5000);
    await closed.ended;
    expect(closed.types()).toEqual([]);
  });
});

describe('a new take that finds this guest still recording an older one', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ends the older take without the closing estimate, so the new capture does not wait for it', async () => {
    const sent: Sent[] = [];
    // Open and drained: the state in which endGuestRecording would measure again.
    const channel = { readyState: 'open', send: (j: string) => sent.push(JSON.parse(j) as Sent) };
    const clockSync = new ClockSync({
      recordingId: 'r',
      guestStartMs: Date.now(),
      send: (j) => sent.push(JSON.parse(j) as Sent),
      perPingTimeoutMs: 100,
      retryMs: 1000,
    });
    // No answer ever came for the older take: its clock sync waits for its next round.
    void clockSync.run(1, 500);
    await vi.advanceTimersByTimeAsync(100);
    sent.length = 0;
    const sender = {
      drain: async () => true,
      digestHex: async () => 'abc',
      isAbandoned: false,
      hasQueuedChunks: false,
      lastAckedIdx: 0,
    };
    const recordingRef = {
      current: { recordingId: 'r', channel, sender, clockSync } as unknown as RecordingHandles | null,
    };
    const beginGuestRecording = vi.fn().mockResolvedValue(undefined);

    const handled = handleGuestRecordingStarted({
      recordingRef,
      endRecording: async () => {
        await endGuestRecording(recordingRef.current!);
        recordingRef.current = null;
      },
      beginGuestRecording,
    });
    // No time passes: everything below has to have happened without a timer.
    await vi.advanceTimersByTimeAsync(0);

    expect(sent.map((m) => m.type)).toEqual(['recording-finalized']);
    expect(beginGuestRecording).toHaveBeenCalledTimes(1);
    await handled;

    // The older take's clock sync is over: the round it was waiting for never starts.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent.map((m) => m.type)).toEqual(['recording-finalized']);
  });
});
