import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChunkSender } from '@/lib/chunk-sender';
import { encodeChunkHeader, decodeChunkHeader, type ChunkHeader } from '@openmeet/protocol';

class FakeChannel {
  readyState = 'open';
  bufferedAmount = 0;
  sent: (string | ArrayBuffer)[] = [];
  send(d: string | ArrayBuffer) { this.sent.push(d); }
}

function chunk(idx: number, offset: number, size: number) {
  return { header: { idx, offset, size, ts: 1 } as ChunkHeader, payload: new ArrayBuffer(size) };
}

describe('ChunkSender', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends header string then binary payload per chunk', () => {
    const ch = new FakeChannel();
    const s = new ChunkSender({ recordingId: 'r1', channel: ch as unknown as RTCDataChannel });
    s.sendChunk(chunk(0, 0, 8));
    expect(ch.sent.length).toBe(2);
    expect(ch.sent[0]).toBe(encodeChunkHeader({ idx: 0, offset: 0, size: 8, ts: 1 }));
    expect(ch.sent[1]).toBeInstanceOf(ArrayBuffer);
    expect((ch.sent[1] as ArrayBuffer).byteLength).toBe(8);
  });

  it('queues when bufferedAmount exceeds the high watermark, flushes on drainQueue', () => {
    const ch = new FakeChannel();
    ch.bufferedAmount = 17 * 1024 * 1024;
    const s = new ChunkSender({ recordingId: 'r1', channel: ch as unknown as RTCDataChannel });
    s.sendChunk(chunk(0, 0, 8));
    expect(ch.sent.length).toBe(0);
    ch.bufferedAmount = 0;
    s.drainQueue();
    expect(ch.sent.length).toBe(2);
  });

  it('tracks lastAckedIdx from ack control messages', () => {
    const ch = new FakeChannel();
    const s = new ChunkSender({ recordingId: 'r1', channel: ch as unknown as RTCDataChannel });
    s.handleControl({ type: 'ack', recordingId: 'r1', uptoIdx: 5, uptoOffset: 4000 });
    expect(s.lastAckedIdx).toBe(5);
  });

  it('drain() resolves true when buffer empties before the cap', async () => {
    const ch = new FakeChannel();
    ch.bufferedAmount = 1000;
    const s = new ChunkSender({ recordingId: 'r1', channel: ch as unknown as RTCDataChannel });
    const p = s.drain();
    ch.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(200);
    await expect(p).resolves.toBe(true);
  });

  it('drain() resolves false when the hard cap elapses with buffer remaining', async () => {
    const ch = new FakeChannel();
    ch.bufferedAmount = 1000;
    const s = new ChunkSender({ recordingId: 'r1', channel: ch as unknown as RTCDataChannel });
    const p = s.drain();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(p).resolves.toBe(false);
  });

  it('truncates the retransmit buffer on ack and replays since lastIdx on resume', () => {
    const ch = new FakeChannel();
    const s = new ChunkSender({ recordingId: 'r1', channel: ch as unknown as RTCDataChannel });
    s.sendChunk(chunk(0, 0, 8));
    s.sendChunk(chunk(1, 8, 8));
    s.sendChunk(chunk(2, 16, 8));
    ch.sent.length = 0;
    s.handleControl({ type: 'ack', recordingId: 'r1', uptoIdx: 0, uptoOffset: 8 });
    s.resume(0);
    expect(ch.sent.length).toBe(4);
  });

  it('fires onBackpressure(true) above high watermark and (false) below low watermark', () => {
    const ch = new FakeChannel();
    const events: boolean[] = [];
    const s = new ChunkSender({
      recordingId: 'r1',
      channel: ch as unknown as RTCDataChannel,
      onBackpressure: (p) => events.push(p),
    });
    ch.bufferedAmount = 17 * 1024 * 1024;
    s.sendChunk(chunk(0, 0, 8));
    ch.bufferedAmount = 4 * 1024 * 1024;
    s.drainQueue();
    expect(events).toEqual([true, false]);
  });

  it('computes a digest over sent payloads', async () => {
    const ch = new FakeChannel();
    const s = new ChunkSender({ recordingId: 'r1', channel: ch as unknown as RTCDataChannel });
    s.sendChunk(chunk(0, 0, 4));
    const hex = await s.digestHex();
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rebinds to a new channel, replaying unacked chunks and un-pausing when bufferedAmount is low', () => {
    const chA = new FakeChannel();
    const chB = new FakeChannel();
    const backpressure: boolean[] = [];
    const s = new ChunkSender({
      recordingId: 'r1',
      channel: chA as unknown as RTCDataChannel,
      onBackpressure: (p) => backpressure.push(p),
    });

    for (let i = 0; i < 5; i++) {
      s.sendChunk(chunk(i, i * 8, 8));
    }
    expect(chA.sent).toHaveLength(10); // 5 chunks * (header + payload)

    s.handleControl({ type: 'ack', recordingId: 'r1', uptoIdx: 2, uptoOffset: 24 });
    expect(s.lastAckedIdx).toBe(2);

    chA.readyState = 'closed';

    s.rebind(chB as unknown as RTCDataChannel);

    // Channel B starts with high bufferedAmount so resume queues chunks and pauses
    chB.bufferedAmount = 17 * 1024 * 1024;
    s.resume(2);

    expect(backpressure).toEqual([true]);
    expect(chB.sent).toHaveLength(0);

    // New chunk sent after resume must be queued behind chunks 3 and 4
    s.sendChunk(chunk(5, 40, 8));
    expect(chB.sent).toHaveLength(0);

    // Once B's bufferedAmount drops, drainQueue flushes chunks 3, 4, 5 in strict order and unpauses
    chB.bufferedAmount = 0;
    s.drainQueue();

    expect(backpressure).toEqual([true, false]);
    expect(chB.sent).toHaveLength(6);
    expect(chB.sent[0]).toBe(encodeChunkHeader({ idx: 3, offset: 24, size: 8, ts: 1 }));
    expect(chB.sent[2]).toBe(encodeChunkHeader({ idx: 4, offset: 32, size: 8, ts: 1 }));
    expect(chB.sent[4]).toBe(encodeChunkHeader({ idx: 5, offset: 40, size: 8, ts: 1 }));
  });

  // A chunk sent while the channel is dead (queued) must not overtake
  // the resume replay that arrives behind it. sendChunk always buffers before
  // queuing, so by the time resume(2) runs, chunk 5 is BOTH already queued
  // (from the dead-channel send) AND present in buffer.since(2) — the old
  // resume() appended the replay after the existing queue, producing wire
  // order 5,3,4,5 and letting the receiver's idx<=lastIdx dedupe discard the
  // real 3 and 4 forever.
  it('resume() merges the pending queue with the replay so wire order stays strictly increasing', () => {
    const chA = new FakeChannel();
    const chB = new FakeChannel();
    const s = new ChunkSender({ recordingId: 'r1', channel: chA as unknown as RTCDataChannel });

    for (let i = 0; i < 5; i++) s.sendChunk(chunk(i, i * 8, 8)); // idx 0..4, sent on A
    s.handleControl({ type: 'ack', recordingId: 'r1', uptoIdx: 2, uptoOffset: 24 });

    chA.readyState = 'closed';
    s.sendChunk(chunk(5, 40, 8)); // idx 5, channel dead -> queued, not sent

    s.rebind(chB as unknown as RTCDataChannel);
    s.resume(2);

    const headers = chB.sent
      .filter((f): f is string => typeof f === 'string')
      .map((f) => decodeChunkHeader(f)!.idx);
    expect(headers).toEqual([3, 4, 5]);
  });

  // Reproduces: a chunk queues (and pauses the recorder) while the channel is
  // dead; rebind to a fresh open channel; resume() replays the queue but never
  // un-pauses, because onbufferedamountlow only fires on a threshold CROSSING
  // and a small replay never crosses it. The recorder stays paused forever.
  it('resume() un-pauses once the replay lands under the low watermark', () => {
    const chA = new FakeChannel();
    chA.readyState = 'closed';
    const backpressure: boolean[] = [];
    const s = new ChunkSender({
      recordingId: 'r1',
      channel: chA as unknown as RTCDataChannel,
      onBackpressure: (p) => backpressure.push(p),
    });

    s.sendChunk(chunk(0, 0, 8)); // channel dead -> queued, pauses
    expect(backpressure).toEqual([true]);

    const chB = new FakeChannel();
    s.rebind(chB as unknown as RTCDataChannel);
    s.resume(-1);

    expect(backpressure).toEqual([true, false]);
    expect(chB.sent).toHaveLength(2);
    expect(chB.sent[0]).toBe(encodeChunkHeader({ idx: 0, offset: 0, size: 8, ts: 1 }));
  });

  it('resume() with nothing queued just replays buffer.since(lastIdx) in order', () => {
    const ch = new FakeChannel();
    const s = new ChunkSender({ recordingId: 'r1', channel: ch as unknown as RTCDataChannel });

    for (let i = 0; i < 3; i++) s.sendChunk(chunk(i, i * 8, 8)); // idx 0..2, all sent, queue stays empty
    ch.sent.length = 0;

    s.resume(0);

    const headers = ch.sent
      .filter((f): f is string => typeof f === 'string')
      .map((f) => decodeChunkHeader(f)!.idx);
    expect(headers).toEqual([1, 2]);
  });

  it('abandons stream when a chunk would exceed backlog cap, notifies host and guest', () => {
    const ch = new FakeChannel();
    let errorReported: unknown = null;
    const s = new ChunkSender({
      recordingId: 'r1',
      channel: ch as unknown as RTCDataChannel,
      backlogCapBytes: 100,
      onError: (err) => { errorReported = err; },
    });
    s.sendChunk(chunk(0, 0, 80));
    expect((s as any).isAbandoned).toBe(false);
    ch.sent.length = 0;

    s.sendChunk(chunk(1, 80, 30));
    expect((s as any).isAbandoned).toBe(true);

    const controlMsg = ch.sent.find((msg) => typeof msg === 'string' && msg.includes('stream-abandoned'));
    expect(controlMsg).toBeDefined();
    const parsed = JSON.parse(controlMsg as string);
    expect(parsed.type).toBe('stream-abandoned');
    expect(parsed.recordingId).toBe('r1');

    expect(errorReported).toBeDefined();
    expect((errorReported as Error).message).toMatch(/backup/i);
  });

  it('drain() continues past 30s while progress is being made', async () => {
    const ch = new FakeChannel();
    ch.bufferedAmount = 1000;
    const s = new ChunkSender({ recordingId: 'r1', channel: ch as unknown as RTCDataChannel });
    const p = s.drain();

    // At 15s: progress happens (bufferedAmount decreases)
    await vi.advanceTimersByTimeAsync(15_000);
    ch.bufferedAmount = 500;

    // At 25s: progress happens again (ack received)
    await vi.advanceTimersByTimeAsync(10_000);
    s.handleControl({ type: 'ack', recordingId: 'r1', uptoIdx: 0, uptoOffset: 10 });

    // At 35s (>30s from start): drain must still be alive!
    await vi.advanceTimersByTimeAsync(10_000);
    ch.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(200);

    await expect(p).resolves.toBe(true);
  });
});

describe('ChunkSender — a failing send must not escape', () => {
  function chunk(idx: number, size = 8) {
    return { header: { idx, offset: idx * size, size, ts: 0 }, payload: new Uint8Array(size).buffer };
  }

  // send() can throw even after readyState says 'open' — the channel can close
  // in between. The throw used to escape through onbufferedamountlow, and from
  // drain()'s setTimeout loop it left that promise permanently unsettled, so
  // finalizing hung forever instead of failing.
  it('requeues instead of throwing when send() fails', () => {
    let fail = true;
    const sent: unknown[] = [];
    const channel = {
      readyState: 'open',
      bufferedAmount: 0,
      send: (d: unknown) => {
        if (fail) throw new DOMException('closed', 'InvalidStateError');
        sent.push(d);
      },
    } as unknown as RTCDataChannel;

    const s = new ChunkSender({ recordingId: 'r', channel });
    expect(() => s.sendChunk(chunk(0))).not.toThrow();
    expect(sent).toHaveLength(0);

    // Recovered channel: the chunk is still queued and goes out in order.
    fail = false;
    expect(() => s.drainQueue()).not.toThrow();
    expect(sent).toHaveLength(2); // header + payload
  });

  it('drain() settles rather than hanging when the channel is broken', async () => {
    vi.useFakeTimers();
    try {
      const channel = {
        readyState: 'open',
        bufferedAmount: 1,
        send: () => { throw new Error('gone'); },
      } as unknown as RTCDataChannel;
      const s = new ChunkSender({ recordingId: 'r', channel });
      s.sendChunk(chunk(0));
      const settled = s.drain();
      await vi.advanceTimersByTimeAsync(31_000);
      await expect(settled).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
