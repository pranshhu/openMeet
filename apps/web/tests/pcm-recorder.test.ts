import { describe, it, expect } from 'vitest';
import { PcmRecorder, type PcmFrame } from '@/lib/pcm-recorder';
import { WAV_HEADER_BYTES } from '@/lib/wav';
import type { RecordedChunk } from '@/lib/recorder';

/** Stand-in for a WebCodecs AudioData frame of interleaved f32. */
function frame(samples: number[], sampleRate = 48000, channels = 1, timestamp?: number): PcmFrame {
  const data = Float32Array.from(samples);
  return {
    sampleRate,
    numberOfChannels: channels,
    numberOfFrames: samples.length / channels,
    allocationSize: () => data.byteLength,
    copyTo: (dest) => {
      new Float32Array((dest as ArrayBufferView).buffer ?? (dest as ArrayBuffer)).set(data);
    },
    close: () => {},
    ...(timestamp !== undefined ? { timestamp } : {}),
  };
}

function sourceOf(frames: PcmFrame[]) {
  return () =>
    new ReadableStream<PcmFrame>({
      start(c) {
        frames.forEach((f) => c.enqueue(f));
        c.close();
      },
    });
}

function mkRecorder(frames: PcmFrame[]) {
  const chunks: RecordedChunk[] = [];
  const rec = new PcmRecorder({
    stream: { getAudioTracks: () => [{} as MediaStreamTrack] } as unknown as MediaStream,
    onChunk: (c) => chunks.push(c),
    frameSource: sourceOf(frames),
  });
  return { rec, chunks };
}

// One second of audio at 48k mono is 48000 samples -> 144000 bytes, well over
// the 2s batching threshold only when repeated; a single big frame is simpler.
const bigFrame = () => frame(new Array(48000 * 3).fill(0.25));

describe('PcmRecorder', () => {
  it('emits a placeholder WAV header first, at offset 0', async () => {
    const { rec, chunks } = mkRecorder([frame([0, 0.5, -0.5])]);
    rec.start();
    await rec.whenDrained();
    await rec.stopAndFlush();

    expect(chunks[0]!.header.offset).toBe(0);
    expect(chunks[0]!.header.size).toBe(WAV_HEADER_BYTES);
    const v = new DataView(chunks[0]!.payload);
    expect(v.getUint32(40, true)).toBe(0); // placeholder: no data yet
  });

  it('writes samples immediately after the header and rewrites it at finalize', async () => {
    const { rec, chunks } = mkRecorder([frame([0, 0.5, -0.5])]);
    rec.start();
    await rec.whenDrained();
    await rec.stopAndFlush();

    const pcm = chunks[1]!;
    expect(pcm.header.offset).toBe(WAV_HEADER_BYTES);
    expect(pcm.header.size).toBe(3 * 3); // 3 samples x 24-bit

    // Final chunk rewrites position 0 with the true data size. Dedupe is on idx,
    // not offset, so revisiting position 0 is legal — this is the whole reason
    // the WAV header problem costs one extra write instead of a rewrite pass.
    const last = chunks.at(-1)!;
    expect(last.header.offset).toBe(0);
    expect(last.header.idx).toBeGreaterThan(chunks[0]!.header.idx);
    expect(new DataView(last.payload).getUint32(40, true)).toBe(9);
  });

  it('reads the real capture format instead of assuming 48k mono', async () => {
    const { rec, chunks } = mkRecorder([frame([0, 0, 0, 0], 44100, 2)]);
    rec.start();
    await rec.whenDrained();
    await rec.stopAndFlush();

    const v = new DataView(chunks[0]!.payload);
    expect(v.getUint32(24, true)).toBe(44100);
    expect(v.getUint16(22, true)).toBe(2);
    expect(rec.format).toEqual({ sampleRate: 44100, channels: 2, bitDepth: 24 });
  });

  it('batches small frames rather than emitting one chunk per ~10ms frame', async () => {
    // 20 tiny frames must not become 20 DataChannel sends.
    const { rec, chunks } = mkRecorder(Array.from({ length: 20 }, () => frame([0.1, 0.2])));
    rec.start();
    await rec.whenDrained();
    await rec.stopAndFlush();

    const pcmChunks = chunks.filter((c) => c.header.offset >= WAV_HEADER_BYTES);
    expect(pcmChunks).toHaveLength(1);
    expect(pcmChunks[0]!.header.size).toBe(20 * 2 * 3);
  });

  it('flushes a full batch once the timeslice threshold is crossed', async () => {
    const { rec, chunks } = mkRecorder([bigFrame(), bigFrame()]);
    rec.start();
    await rec.whenDrained();
    await rec.stopAndFlush();

    const pcmChunks = chunks.filter((c) => c.header.offset >= WAV_HEADER_BYTES);
    expect(pcmChunks.length).toBeGreaterThan(1);
  });

  it('keeps offsets contiguous so the file has no gaps', async () => {
    const { rec, chunks } = mkRecorder([bigFrame(), bigFrame(), bigFrame()]);
    rec.start();
    await rec.whenDrained();
    await rec.stopAndFlush();

    const pcmChunks = chunks.filter((c) => c.header.offset >= WAV_HEADER_BYTES);
    let expected = WAV_HEADER_BYTES;
    for (const c of pcmChunks) {
      expect(c.header.offset).toBe(expected);
      expected += c.header.size;
    }
    expect(rec.totalBytes).toBe(expected);
  });

  it('is a no-op on a second stopAndFlush', async () => {
    const { rec, chunks } = mkRecorder([frame([0.1])]);
    rec.start();
    await rec.whenDrained();
    await rec.stopAndFlush();
    const count = chunks.length;
    await rec.stopAndFlush();
    expect(chunks).toHaveLength(count);
  });

  it('reports a missing audio track instead of silently recording nothing', () => {
    const rec = new PcmRecorder({
      stream: { getAudioTracks: () => [] } as unknown as MediaStream,
      onChunk: () => {},
      frameSource: sourceOf([]),
    });
    expect(() => rec.start()).toThrow(/no audio track/);
  });

  it('detects dropped frames from timestamps and writes silence for the gap', async () => {
    // 480 samples @ 48kHz = 10,000 us duration.
    // Frame 1: at timestamp 0 (ends at 10,000 us).
    // Frame 2: at timestamp 30,000 us (gap of 20,000 us = 960 frames dropped).
    const f1 = frame(new Array(480).fill(0.5), 48000, 1, 0);
    const f2 = frame(new Array(480).fill(0.5), 48000, 1, 30_000);

    const { rec, chunks } = mkRecorder([f1, f2]);
    rec.start();
    await rec.whenDrained();
    await rec.stopAndFlush();

    const pcmChunks = chunks.filter((c) => c.header.offset >= WAV_HEADER_BYTES);
    const totalPcmBytes = pcmChunks.reduce((acc, c) => acc + c.header.size, 0);

    // Total expected frames: 480 + 960 (silence) + 480 = 1920 frames.
    // 1920 * 1 channel * 3 bytes (24-bit) = 5760 bytes.
    expect(totalPcmBytes).toBe(1920 * 3);

    // Verify silence bytes in the payload:
    // First 480 samples (1440 bytes) are 0.5.
    // Middle 960 samples (2880 bytes) must be 0 (silence).
    // Last 480 samples (1440 bytes) are 0.5.
    const allPcm = new Uint8Array(totalPcmBytes);
    let offset = 0;
    for (const c of pcmChunks) {
      allPcm.set(new Uint8Array(c.payload), offset);
      offset += c.header.size;
    }
    const middleSlice = allPcm.slice(1440, 1440 + 2880);
    expect(middleSlice.every((b) => b === 0)).toBe(true);
  });

  it('produces exactly delivered samples without silence when timestamps jitter around a steady 10ms cadence', async () => {
    // 480 samples @ 48kHz = 10,000 us duration per frame.
    // Jitter by ±2.67 ms (128 samples / 1 Web Audio render quantum ≈ 2667 us).
    // Gaps fluctuate between +2.67 ms and -2.67 ms around steady cadence.
    const timestamps = [0, 12_667, 20_000, 32_667, 40_000, 52_667, 60_000];
    const frames = timestamps.map((ts) => frame(new Array(480).fill(0.5), 48000, 1, ts));

    const { rec, chunks } = mkRecorder(frames);
    rec.start();
    await rec.whenDrained();
    await rec.stopAndFlush();

    const pcmChunks = chunks.filter((c) => c.header.offset >= WAV_HEADER_BYTES);
    const totalPcmBytes = pcmChunks.reduce((acc, c) => acc + c.header.size, 0);

    // Exactly 7 frames of 480 samples * 1 channel * 3 bytes (24-bit), no padded silence.
    expect(totalPcmBytes).toBe(7 * 480 * 3);
  });

  it('pads exactly one frame of silence when a frame arrives one whole frame late with jitter', async () => {
    // Frame 1: ends at 10,000 us.
    // Frame 2: arrives one whole 10ms frame late with +2.67 ms jitter (at 22,667 us).
    const f1 = frame(new Array(480).fill(0.5), 48000, 1, 0);
    const f2 = frame(new Array(480).fill(0.5), 48000, 1, 22_667);

    const { rec, chunks } = mkRecorder([f1, f2]);
    rec.start();
    await rec.whenDrained();
    await rec.stopAndFlush();

    const pcmChunks = chunks.filter((c) => c.header.offset >= WAV_HEADER_BYTES);
    const totalPcmBytes = pcmChunks.reduce((acc, c) => acc + c.header.size, 0);

    // Expected: 480 (f1) + 480 (1 frame silence) + 480 (f2) = 1440 samples * 3 bytes.
    expect(totalPcmBytes).toBe(1440 * 3);

    const allPcm = new Uint8Array(totalPcmBytes);
    let offset = 0;
    for (const c of pcmChunks) {
      allPcm.set(new Uint8Array(c.payload), offset);
      offset += c.header.size;
    }
    // Exactly the middle 480 samples (1440 bytes) are silence.
    const middleSlice = allPcm.slice(1440, 1440 + 1440);
    expect(middleSlice.every((b) => b === 0)).toBe(true);
    expect(allPcm.slice(0, 1440).some((b) => b !== 0)).toBe(true);
    expect(allPcm.slice(2880).some((b) => b !== 0)).toBe(true);
  });

  it('pads exactly two frames of silence when two frames are dropped with jitter', async () => {
    // Frame 1: ends at 10,000 us.
    // Frame 2: arrives two whole 10ms frames late with +2.67 ms jitter (at 32,667 us).
    const f1 = frame(new Array(480).fill(0.5), 48000, 1, 0);
    const f2 = frame(new Array(480).fill(0.5), 48000, 1, 32_667);

    const { rec, chunks } = mkRecorder([f1, f2]);
    rec.start();
    await rec.whenDrained();
    await rec.stopAndFlush();

    const pcmChunks = chunks.filter((c) => c.header.offset >= WAV_HEADER_BYTES);
    const totalPcmBytes = pcmChunks.reduce((acc, c) => acc + c.header.size, 0);

    // Expected: 480 (f1) + 960 (2 frames silence) + 480 (f2) = 1920 samples * 3 bytes.
    expect(totalPcmBytes).toBe(1920 * 3);

    const allPcm = new Uint8Array(totalPcmBytes);
    let offset = 0;
    for (const c of pcmChunks) {
      allPcm.set(new Uint8Array(c.payload), offset);
      offset += c.header.size;
    }
    // Exactly the middle 960 samples (2880 bytes) are silence.
    const middleSlice = allPcm.slice(1440, 1440 + 2880);
    expect(middleSlice.every((b) => b === 0)).toBe(true);
    expect(allPcm.slice(0, 1440).some((b) => b !== 0)).toBe(true);
    expect(allPcm.slice(1440 + 2880).some((b) => b !== 0)).toBe(true);
  });
});
