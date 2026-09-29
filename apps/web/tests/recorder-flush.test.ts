import { describe, it, expect } from 'vitest';
import { ChunkRecorder } from '@/lib/recorder';
import type { ChunkHeader } from '@openmeet/protocol';

/**
 * The real MediaRecorder fires its FINAL `ondataavailable` *after* stop() has
 * returned, and only then `onstop`. The fake in recorder.test.ts fires onstop
 * immediately with no trailing chunk, which is why "the last chunk is dropped"
 * survived a green suite: finalize called stop() and closed the file before the
 * last ~2s had been handed over.
 *
 * This fake models the real ordering, so it fails against a plain stop().
 */
class RealisticMR {
  static last: RealisticMR | null = null;
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  state = 'inactive';
  constructor(public stream: unknown, public opts: unknown) {
    RealisticMR.last = this;
  }
  start() {
    this.state = 'recording';
  }
  emit(bytes: number) {
    this.ondataavailable?.({
      data: { size: bytes, arrayBuffer: async () => new ArrayBuffer(bytes) } as unknown as Blob,
    });
  }
  stop() {
    this.state = 'inactive';
    // Trailing chunk lands asynchronously, then onstop — as the real API does.
    setTimeout(() => {
      this.emit(777);
      this.onstop?.();
    }, 0);
  }
  fail(message: string) {
    this.onerror?.({ error: new Error(message) } as unknown as Event);
  }
}

const mk = (onChunk: (c: { header: ChunkHeader; payload: ArrayBuffer }) => void, onError?: (e: unknown) => void) =>
  new ChunkRecorder({
    stream: {} as MediaStream,
    mimeType: 'video/mp4',
    mrFactory: (s, o) => new RealisticMR(s, o) as unknown as MediaRecorder,
    onChunk,
    ...(onError ? { onError } : {}),
  });

describe('ChunkRecorder.stopAndFlush', () => {
  it('resolves only after the final trailing chunk has been delivered', async () => {
    const chunks: number[] = [];
    const rec = mk((c) => chunks.push(c.header.size));
    rec.start();
    RealisticMR.last!.emit(100);
    RealisticMR.last!.emit(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(chunks).toEqual([100, 200]);

    await rec.stopAndFlush();

    // The 777-byte trailing chunk must be present BEFORE the await returns.
    // A plain stop() would let the caller close the file with this missing.
    expect(chunks).toEqual([100, 200, 777]);
  });

  it('accounts the trailing chunk in totalBytes before resolving', async () => {
    const rec = mk(() => {});
    rec.start();
    RealisticMR.last!.emit(1000);
    await new Promise((r) => setTimeout(r, 0));
    await rec.stopAndFlush();
    expect(rec.totalBytes).toBe(1777);
  });

  it('is safe to call when the recorder never started', async () => {
    const rec = mk(() => {});
    await expect(rec.stopAndFlush()).resolves.toBeUndefined();
  });

  it('surfaces a mid-session MediaRecorder failure instead of going quiet', () => {
    const errors: unknown[] = [];
    const rec = mk(
      () => {},
      (e) => errors.push(e)
    );
    rec.start();
    RealisticMR.last!.fail('encoder died');
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('encoder died');
  });
});
