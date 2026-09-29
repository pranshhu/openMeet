import { describe, it, expect, vi } from 'vitest';
import { ChunkRecorder } from '@/lib/recorder';

/**
 * A throw inside onChunk used to poison the recorder's promise chain:
 *
 *   this.tail = this.tail.then(async () => { ... onChunk(...) });
 *
 * Once `tail` held a rejection, every subsequent .then() was skipped — so ONE
 * failed send silently dropped the entire rest of the recording, and
 * stopAndFlush() awaited a rejected promise so finalize never completed either.
 *
 * That is what turned the max-message-size error into a lost session rather
 * than a lost chunk. Same class of bug as the FileWriter writeTail poisoning.
 */
class FakeMR {
  state = 'inactive';
  ondataavailable: ((e: { data: { size: number; arrayBuffer: () => Promise<ArrayBuffer> } }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.onstop?.(); }
  pause() {}
  resume() {}
  emit(size: number) {
    this.ondataavailable?.({ data: { size, arrayBuffer: async () => new ArrayBuffer(size) } });
  }
}

function mk(onChunk: (c: unknown) => void, onError?: (e: unknown) => void) {
  const mr = new FakeMR();
  const rec = new ChunkRecorder({
    stream: {} as MediaStream,
    mimeType: 'video/mp4',
    onChunk: onChunk as never,
    ...(onError ? { onError } : {}),
    mrFactory: () => mr as unknown as MediaRecorder,
  });
  rec.start();
  return { rec, mr };
}

describe('ChunkRecorder resilience', () => {
  it('keeps delivering chunks after one throws', async () => {
    const seen: number[] = [];
    const { rec, mr } = mk((c) => {
      const idx = (c as { header: { idx: number } }).header.idx;
      if (idx === 0) throw new TypeError('Trying to send message larger than max-message-size');
      seen.push(idx);
    });
    mr.emit(10);
    mr.emit(10);
    mr.emit(10);
    await rec.stopAndFlush();
    // Chunks 1 and 2 must still arrive. Previously both were silently dropped.
    expect(seen).toEqual([1, 2]);
  });

  it('reports the failure instead of swallowing it', async () => {
    const onError = vi.fn();
    const { rec, mr } = mk(() => { throw new Error('boom'); }, onError);
    mr.emit(10);
    await rec.stopAndFlush();
    expect(onError).toHaveBeenCalled();
  });

  it('stopAndFlush still resolves after a failed chunk', async () => {
    const { rec, mr } = mk(() => { throw new Error('boom'); }, () => {});
    mr.emit(10);
    // A rejected tail left finalize hanging, so the file was never closed.
    await expect(rec.stopAndFlush()).resolves.toBeUndefined();
  });

  it('keeps offsets contiguous across a failed chunk', async () => {
    const offsets: number[] = [];
    const { rec, mr } = mk((c) => {
      const h = (c as { header: { idx: number; offset: number } }).header;
      if (h.idx === 1) throw new Error('boom');
      offsets.push(h.offset);
    }, () => {});
    mr.emit(100);
    mr.emit(100);
    mr.emit(100);
    await rec.stopAndFlush();
    // Offsets are assigned synchronously, so a failed send leaves a HOLE rather
    // than shifting later data — which is what makes retransmit recoverable.
    expect(offsets).toEqual([0, 200]);
  });
});
