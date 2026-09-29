import { describe, it, expect } from 'vitest';
import { RetransmitBuffer } from '@/lib/retransmit-buffer';
import type { ChunkHeader } from '@openmeet/protocol';

function chunk(idx: number, size: number) {
  return { header: { idx, offset: idx * size, size, ts: 1 } as ChunkHeader, payload: new ArrayBuffer(size) };
}

describe('RetransmitBuffer', () => {
  it('retains chunks and replays those after a given idx', () => {
    const b = new RetransmitBuffer();
    b.add(chunk(0, 10));
    b.add(chunk(1, 10));
    b.add(chunk(2, 10));
    expect(b.since(0).map((c) => c.header.idx)).toEqual([1, 2]);
    expect(b.since(-1).map((c) => c.header.idx)).toEqual([0, 1, 2]);
  });

  it('truncate drops chunks up to and including uptoIdx', () => {
    const b = new RetransmitBuffer();
    b.add(chunk(0, 10));
    b.add(chunk(1, 10));
    b.add(chunk(2, 10));
    b.truncate(1);
    expect(b.since(-1).map((c) => c.header.idx)).toEqual([2]);
    expect(b.bytes).toBe(10);
  });

  it('never evicts unacked data regardless of buffer size', () => {
    const b = new RetransmitBuffer();
    const oneMb = 1024 * 1024;
    for (let i = 0; i < 40; i++) b.add(chunk(i, oneMb));
    expect(b.bytes).toBe(40 * oneMb);
    const idxs = b.since(-1).map((c) => c.header.idx);
    expect(idxs[idxs.length - 1]).toBe(39);
    expect(idxs[0]).toBe(0);
  });
});
