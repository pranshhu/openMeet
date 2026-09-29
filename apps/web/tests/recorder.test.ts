import { describe, it, expect, vi } from 'vitest';
import { ChunkRecorder } from '@/lib/recorder';
import {
  RECORDING_MIME,
  RECORDING_VIDEO_BPS,
  RECORDING_AUDIO_BPS,
  type ChunkHeader,
} from '@openmeet/protocol';

class FakeMR {
  static last: FakeMR | null = null;
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  state = 'inactive';
  constructor(public stream: unknown, public opts: unknown) { FakeMR.last = this; }
  start(_timeslice?: number) { this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.onstop?.(); }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  emit(bytes: number) {
    const data = { size: bytes, arrayBuffer: async () => new ArrayBuffer(bytes) } as unknown as Blob;
    this.ondataavailable?.({ data });
  }
}

describe('ChunkRecorder', () => {
  it('emits chunks with monotonic idx and running offset', async () => {
    const chunks: { header: ChunkHeader; payload: ArrayBuffer }[] = [];
    const rec = new ChunkRecorder({
      stream: {} as MediaStream,
      mrFactory: (s, o) => new FakeMR(s, o) as unknown as MediaRecorder,
      onChunk: (c) => chunks.push(c),
    });
    rec.start();
    FakeMR.last!.emit(1000);
    FakeMR.last!.emit(500);
    await new Promise((r) => setTimeout(r, 0));
    expect(chunks.map((c) => c.header.idx)).toEqual([0, 1]);
    expect(chunks.map((c) => c.header.offset)).toEqual([0, 1000]);
    expect(chunks.map((c) => c.header.size)).toEqual([1000, 500]);
    expect(chunks[1]!.payload.byteLength).toBe(500);
  });

  it('reports totalBytes after chunks', async () => {
    const rec = new ChunkRecorder({
      stream: {} as MediaStream,
      mrFactory: (s, o) => new FakeMR(s, o) as unknown as MediaRecorder,
      onChunk: () => {},
    });
    rec.start();
    FakeMR.last!.emit(100);
    FakeMR.last!.emit(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(rec.totalBytes).toBe(300);
  });

  it('stop() invokes the onStop callback after final flush', async () => {
    const onStop = vi.fn();
    const rec = new ChunkRecorder({
      stream: {} as MediaStream,
      mrFactory: (s, o) => new FakeMR(s, o) as unknown as MediaRecorder,
      onChunk: () => {},
      onStop,
    });
    rec.start();
    rec.stop();
    await new Promise((r) => setTimeout(r, 0));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('constructs MediaRecorder with mime + default quality bitrates', () => {
    const rec = new ChunkRecorder({
      stream: {} as MediaStream,
      mrFactory: (s, o) => new FakeMR(s, o) as unknown as MediaRecorder,
      onChunk: () => {},
    });
    rec.start();
    const opts = FakeMR.last!.opts as MediaRecorderOptions;
    expect(opts.mimeType).toBe(RECORDING_MIME);
    expect(opts.videoBitsPerSecond).toBe(RECORDING_VIDEO_BPS);
    expect(opts.audioBitsPerSecond).toBe(RECORDING_AUDIO_BPS);
  });

  it('honors explicit bitrate overrides', () => {
    const rec = new ChunkRecorder({
      stream: {} as MediaStream,
      mrFactory: (s, o) => new FakeMR(s, o) as unknown as MediaRecorder,
      onChunk: () => {},
      videoBitsPerSecond: 1_234_000,
      audioBitsPerSecond: 96_000,
    });
    rec.start();
    const opts = FakeMR.last!.opts as MediaRecorderOptions;
    expect(opts.videoBitsPerSecond).toBe(1_234_000);
    expect(opts.audioBitsPerSecond).toBe(96_000);
  });

  it('pause()/resume() toggle the underlying recorder state', () => {
    const rec = new ChunkRecorder({
      stream: {} as MediaStream,
      mrFactory: (s, o) => new FakeMR(s, o) as unknown as MediaRecorder,
      onChunk: () => {},
    });
    rec.start();
    rec.pause();
    expect(FakeMR.last!.state).toBe('paused');
    rec.resume();
    expect(FakeMR.last!.state).toBe('recording');
  });
});
