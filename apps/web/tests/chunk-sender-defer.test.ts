import { describe, it, expect, vi } from 'vitest';
import { ChunkSender } from '@/lib/chunk-sender';
import type { ChunkHeader } from '@openmeet/protocol';

class FakeChannel {
  readyState = 'open';
  bufferedAmount = 0;
  sent: (string | ArrayBuffer)[] = [];
  send(d: string | ArrayBuffer) {
    this.sent.push(d);
  }
}

function chunk(idx: number, offset: number, size: number) {
  return { header: { idx, offset, size, ts: 1 } as ChunkHeader, payload: new ArrayBuffer(size) };
}

function sender(
  channel: FakeChannel,
  opts: { backlogCapBytes?: number; onError?: () => void; onAbandon?: () => void } = {}
) {
  return new ChunkSender({ recordingId: 'r1', channel: channel as unknown as RTCDataChannel, ...opts });
}

/** The control messages a channel was sent: a chunk header never carries a `type`. */
const control = (ch: FakeChannel) =>
  ch.sent.filter((m): m is string => typeof m === 'string' && m.includes('"type"')).map((m) => JSON.parse(m));

const stopped = (lastIdx: number) => ({ type: 'stream-abandoned', recordingId: 'r1', lastIdx });

describe('ChunkSender.defer()', () => {
  it('tells the far end, sends and queues nothing more, and reports no error', async () => {
    const ch = new FakeChannel();
    const onError = vi.fn();
    const onAbandon = vi.fn();
    const s = sender(ch, { onError, onAbandon });
    s.sendChunk(chunk(0, 0, 8));
    ch.sent.length = 0;

    s.defer();
    expect(control(ch)).toEqual([stopped(0)]);
    expect(s.isAbandoned).toBe(true);

    s.sendChunk(chunk(1, 8, 8));
    expect(ch.sent).toHaveLength(1);
    expect(s.hasQueuedChunks).toBe(false);
    await expect(s.drain()).resolves.toBe(false);
    expect(onError).not.toHaveBeenCalled();
    expect(onAbandon).not.toHaveBeenCalled();
  });

  it('lets go of everything the host had not acknowledged', () => {
    const ch = new FakeChannel();
    const s = sender(ch);
    for (let i = 0; i < 4; i++) s.sendChunk(chunk(i, i * 8, 8));
    const kept = (s as unknown as { buffer: { bytes: number } }).buffer;
    expect(kept.bytes).toBe(32);

    s.defer();
    expect(kept.bytes).toBe(0);
  });

  it('empties a queue that waited for a dead channel, and tells the channel that replaces it', () => {
    const dead = new FakeChannel();
    dead.readyState = 'closed';
    const s = sender(dead);
    s.sendChunk(chunk(0, 0, 8));
    expect(s.hasQueuedChunks).toBe(true);

    s.defer();
    expect(s.hasQueuedChunks).toBe(false);
    expect(dead.sent).toEqual([]);

    const next = new FakeChannel();
    s.rebind(next as unknown as RTCDataChannel);
    expect(next.sent).toHaveLength(1);
    expect(control(next)).toEqual([stopped(-1)]);
  });

  it('answers the far end with the same news every time it says where its file stands', () => {
    const first = new FakeChannel();
    const s = sender(first);
    s.sendChunk(chunk(0, 0, 8));
    s.defer();
    expect(control(first)).toEqual([stopped(0)]);

    // The host page reloaded: the receiver behind the next channel is a new
    // one, and it says where its file stands as soon as it is bound.
    const next = new FakeChannel();
    s.rebind(next as unknown as RTCDataChannel);
    expect(next.sent).toEqual([]);
    s.resume(0);
    expect(control(next)).toEqual([stopped(0)]);
    s.resume(0);
    expect(control(next)).toEqual([stopped(0), stopped(0)]);
    // Nothing of the file itself is replayed.
    expect(next.sent).toHaveLength(2);
  });

  it('does nothing to a stream that already stopped', () => {
    const ch = new FakeChannel();
    const s = sender(ch);
    s.giveUp();
    s.defer();
    s.resume(-1);
    expect(ch.sent).toEqual([]);
  });
});

describe('ChunkSender: a stopped stream that is asked where it stands', () => {
  it('one that stopped at the backlog cap says so again', () => {
    const first = new FakeChannel();
    const s = sender(first, { backlogCapBytes: 10, onError: () => {} });
    s.sendChunk(chunk(0, 0, 16));
    expect(s.isAbandoned).toBe(true);
    expect(control(first)).toEqual([stopped(-1)]);

    const next = new FakeChannel();
    s.rebind(next as unknown as RTCDataChannel);
    s.resume(-1);
    expect(control(next)).toEqual([stopped(-1)]);
  });

  it('one that gave up still says nothing, there or anywhere', () => {
    const first = new FakeChannel();
    const s = sender(first);
    s.sendChunk(chunk(0, 0, 8));
    first.sent.length = 0;
    s.giveUp();

    const next = new FakeChannel();
    s.rebind(next as unknown as RTCDataChannel);
    s.resume(0);
    expect(first.sent).toEqual([]);
    expect(next.sent).toEqual([]);
  });
});
