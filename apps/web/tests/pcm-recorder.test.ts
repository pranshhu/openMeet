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

  it('counts the audio it had to pad with silence', async () => {
    // 20 ms frames: the second is 5 ms late (jitter, nothing padded), the
    // third leaves a 37 ms hole, which is two whole frames of silence.
    const f1 = frame(new Array(960).fill(0.5), 48000, 1, 0);
    const f2 = frame(new Array(960).fill(0.5), 48000, 1, 25_000);
    const f3 = frame(new Array(960).fill(0.5), 48000, 1, 82_000);

    const { rec } = mkRecorder([f1, f2, f3]);
    rec.start();
    await rec.whenDrained();
    await rec.stopAndFlush();

    expect(rec.droppedMs).toBe(40);
  });

  describe('padding only while behind the track timestamps', () => {
    const FRAME_US = 10_000;

    // Frames of 480 samples (10 ms at 48 kHz) stamped as given, read lazily so a
    // long take does not hold every frame in memory at once.
    async function pad(timestamps: (number | undefined)[], samples = 480) {
      let next = 0;
      let bytes = 0;
      const rec = new PcmRecorder({
        stream: { getAudioTracks: () => [{} as MediaStreamTrack] } as unknown as MediaStream,
        onChunk: (c) => {
          if (c.header.offset >= WAV_HEADER_BYTES) bytes += c.header.size;
        },
        frameSource: () =>
          new ReadableStream<PcmFrame>({
            pull(c) {
              if (next >= timestamps.length) return c.close();
              c.enqueue(frame(new Array(samples).fill(0.5), 48000, 1, timestamps[next++]));
            },
          }),
      });
      rec.start();
      await rec.whenDrained();
      await rec.stopAndFlush();
      return { silentFrames: bytes / (samples * 3) - timestamps.length, droppedMs: rec.droppedMs };
    }

    // Stamps where each frame starts `gap` after the end of the one before it; the first starts at 0.
    function fromGaps(gaps: number[], frameUs = FRAME_US): number[] {
      const stamps = [0];
      for (const gap of gaps) stamps.push(stamps[stamps.length - 1]! + frameUs + gap);
      return stamps;
    }

    it('adds no silence for frames on the grid', async () => {
      expect(await pad([0, 10_000, 20_000, 30_000, 40_000])).toEqual({ silentFrames: 0, droppedMs: 0 });
    });

    // The stamps Chrome gives the recorded track: they step in render quanta, 0 for four frames,
    // then 2.667 ms late for four, 5.333 for four, 8 for four, then back to 0. `extra(i)` adds
    // what a case needs on top of the pattern.
    const quanta = (count: number, extra: (i: number) => number = () => 0) =>
      Array.from({ length: count }, (_, i) => i * FRAME_US + Math.floor((i % 16) / 4) * 2667 + extra(i));

    it('adds no silence for the stepping pattern alone', async () => {
      expect(await pad(quanta(10_000))).toEqual({ silentFrames: 0, droppedMs: 0 });
    });

    it('adds at most 1 frame of silence when a frame is 5.3 ms late and the next 2.6 ms early, every 200 frames', async () => {
      const late = (i: number) => (i % 16 === 14 && i % 200 < 16 ? 5_300 : 0);
      const early = (i: number) => (i > 0 && late(i - 1) ? -2_600 : 0);
      const out = await pad(quanta(20_000, (i) => late(i) + early(i)));
      expect(out.silentFrames).toBeLessThanOrEqual(1);
    });

    it('fills each loss of 5 frames with 4 or 5 frames of silence', async () => {
      const losses = 30;
      const lost = (i: number) => Math.floor((i + 100) / 200) * 5 * FRAME_US;
      const out = await pad(quanta(6_000, lost));
      expect(out.silentFrames).toBeGreaterThanOrEqual(losses * 4);
      expect(out.silentFrames).toBeLessThanOrEqual(losses * 5);
    });

    it('fills at least 90 in 100 real losses of one frame, one every 97 frames', async () => {
      const losses = Math.floor(20_000 / 97);
      // A few tenths of a millisecond of noise on top, as in the logs.
      let seed = 7;
      const noise = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
      const out = await pad(quanta(20_000, (i) => Math.floor(i / 97) * FRAME_US + Math.round(noise() * 600 - 300)));
      expect(out.silentFrames).toBeGreaterThanOrEqual(Math.ceil(losses * 0.9));
      expect(out.silentFrames).toBeLessThanOrEqual(losses);
    });

    it('adds silence at most once when frames alternate 6 ms late and 6 ms early', async () => {
      const stamps: number[] = [0];
      let t = 0;
      for (let i = 0; i < 100; i++) {
        // Late by 6 ms: gap of +6 ms. Early by 6 ms: gap of -6 ms.
        stamps.push(t + FRAME_US + 6_000);
        stamps.push(t + 2 * FRAME_US);
        t += 2 * FRAME_US;
      }
      expect(await pad(stamps)).toEqual({ silentFrames: 1, droppedMs: 10 });
    });

    it.each([1, 3])('fills a real gap of %i whole frames', async (k) => {
      const out = await pad([0, FRAME_US + k * FRAME_US]);
      expect(out).toEqual({ silentFrames: k, droppedMs: k * 10 });
    });

    it('uses up the surplus from one false frame before filling a real gap, then fills the next', async () => {
      const out = await pad([
        0, // ends at 10 ms
        16_000, // 6 ms late: one frame of silence
        20_000, // 6 ms early: takes nothing back
        40_000, // a real gap of one frame, already covered by the surplus
        60_000, // a second real gap of one frame
      ]);
      expect(out).toEqual({ silentFrames: 2, droppedMs: 20 });
    });

    it.each([2, -2])('adds no silence when every frame drifts %i us against the sample count', async (drift) => {
      const stamps = Array.from({ length: 100_000 }, (_, i) => i * (FRAME_US + drift));
      expect(await pad(stamps)).toEqual({ silentFrames: 0, droppedMs: 0 });
    });

    it('lets a surplus built by timestamps that run early absorb a real gap, up to the second that is remembered', async () => {
      const stamps = Array.from({ length: 20_000 }, (_, i) => i * (FRAME_US - 2));
      stamps.push(stamps[stamps.length - 1]! + 4 * FRAME_US - 2);
      expect(await pad(stamps)).toEqual({ silentFrames: 0, droppedMs: 0 });
    });

    it.each([
      ['3 late by 6 ms then 3 early by 6 ms', [6_000, 6_000, 6_000, -6_000, -6_000, -6_000]],
      ['2 late by 9 ms then 2 early by 9 ms', [9_000, 9_000, -9_000, -9_000]],
      ['1 late by 18 ms then 3 early by 6 ms', [18_000, -6_000, -6_000, -6_000]],
    ])('adds at most 2 frames of silence in a take of %s, 500 times', async (_name, cycle) => {
      const gaps = Array.from({ length: 500 }, () => cycle).flat();
      expect((await pad(fromGaps(gaps))).silentFrames).toBeLessThanOrEqual(2);
    });

    it('adds at most 2 frames of silence when timestamps wander 8 ms either side of the grid', async () => {
      let seed = 12345;
      const next = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
      const stamps = Array.from({ length: 5_000 }, (_, i) => i * FRAME_US + Math.round((next() * 2 - 1) * 8_000));
      expect((await pad(stamps)).silentFrames).toBeLessThanOrEqual(2);
    });

    it('adds no silence for 2 us of drift either way, and the surplus left by the early half absorbs a real gap', async () => {
      const stamps = fromGaps([...Array(100_000).fill(2), ...Array(100_000).fill(-2)]);
      expect((await pad(stamps)).silentFrames).toBe(0);
      stamps.push(stamps[stamps.length - 1]! + 2 * FRAME_US);
      expect(await pad(stamps)).toEqual({ silentFrames: 0, droppedMs: 0 });
    });

    it('takes back a late frame and its early partner once each, around a real gap', async () => {
      const out = await pad([0, 40_000, 56_000, 60_000, 76_000, 80_000]);
      expect(out).toEqual({ silentFrames: 4, droppedMs: 40 });
    });

    it('fills real gaps again within 100 of them after one timestamp ten seconds in the past', async () => {
      // The clock steps back and the later frames follow it, one frame missing every 20 frames.
      const gaps = [-10_000_000];
      for (let g = 0; g < 150; g++) gaps.push(...Array(19).fill(0), FRAME_US);
      const out = await pad(fromGaps(gaps));
      expect(out.silentFrames).toBe(50);
    });

    it.each([128, 960])('keeps surplus to 1 frame for frames of %i samples, and fills a real gap', async (samples) => {
      const frameUs = (samples * 1_000_000) / 48000;
      const late = Math.round(frameUs * 0.6);
      const gaps = Array.from({ length: 1_000 }, () => [late, -late]).flat();
      expect((await pad(fromGaps(gaps, frameUs), samples)).silentFrames).toBeLessThanOrEqual(1);
      const out = await pad(fromGaps([2 * frameUs], frameUs), samples);
      expect(out.silentFrames).toBe(2);
    });

    it('does not pad for two frames that are each less than half a frame late', async () => {
      expect(await pad(fromGaps([4_000, 4_000]))).toEqual({ silentFrames: 0, droppedMs: 0 });
    });

    it('remembers lateness only up to one frame', async () => {
      // 100 frames 4 ms late stand for 40 ms of lateness, of which one frame is kept; an
      // early frame then a real gap of one frame finds the file already caught up.
      const gaps = [...Array(100).fill(4_000), -20_000, FRAME_US];
      expect(await pad(fromGaps(gaps))).toEqual({ silentFrames: 0, droppedMs: 0 });
    });

    it('does not let a long late drift invent a gap from later jitter', async () => {
      const stamps = Array.from({ length: 10_000 }, (_, i) => i * (FRAME_US + 2));
      let t = stamps[stamps.length - 1]! + FRAME_US + 2;
      // Two frames 6 ms early, then one 6 ms late.
      for (const jitter of [-6_000, -6_000, 6_000]) {
        stamps.push(t + jitter);
        t = stamps[stamps.length - 1]! + FRAME_US;
      }
      expect(await pad(stamps)).toEqual({ silentFrames: 0, droppedMs: 0 });
    });

    it('keeps its standing across a frame that has no timestamp', async () => {
      const out = await pad([
        0,
        2_000, // 8 ms early: the file is ahead by 8 ms
        undefined,
        50_000,
        68_000, // 8 ms late, which only repays the 8 ms
      ]);
      expect(out).toEqual({ silentFrames: 0, droppedMs: 0 });
    });
  });
});
