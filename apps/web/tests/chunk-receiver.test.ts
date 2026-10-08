import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChunkReceiver, MAX_OFFSET_JUMP_BYTES, RESUME_ASK_INTERVAL_MS } from '@/lib/chunk-receiver';
import { CHUNK_TIMESLICE_MS, encodeChunkHeader } from '@openmeet/protocol';
import { StreamingSha256, type Sha256State } from '@/lib/sha256';
import type { JournalFile } from '@/lib/take-journal';

function fakeWriter() {
  return { write: vi.fn().mockResolvedValue(undefined), fileName: 'guest.mp4' };
}

type FakeJournalFile = Omit<JournalFile, 'dead' | 'commit'> & {
  dead: boolean;
  commit: (nextIdx: number, hashState?: Sha256State) => Promise<void>;
};

function fakeJournalFile(): FakeJournalFile {
  return {
    append: vi.fn(),
    commit: vi.fn().mockResolvedValue(undefined),
    position: vi.fn(),
    parts: vi.fn(),
    dead: false,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function acks(sent: string[]) {
  return sent.map((m) => JSON.parse(m)).filter((m) => m.type === 'ack');
}

describe('ChunkReceiver', () => {
  it('writes a binary payload at the offset from the preceding header', async () => {
    const writer = fakeWriter();
    const sent: string[] = [];
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: (m) => sent.push(m),
    });
    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 4, ts: 1 }));
    await r.handleMessage(new Uint8Array([1, 2, 3, 4]).buffer);
    expect(writer.write).toHaveBeenCalledWith(0, expect.any(ArrayBuffer));
    expect(r.bytesWritten).toBe(4);
  });

  it('acks every 5 chunks', async () => {
    const writer = fakeWriter();
    const acks: string[] = [];
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: (m) => acks.push(m),
    });
    for (let i = 0; i < 5; i++) {
      await r.handleMessage(encodeChunkHeader({ idx: i, offset: i * 4, size: 4, ts: 1 }));
      await r.handleMessage(new Uint8Array([1, 2, 3, 4]).buffer);
    }
    const parsed = acks.map((a) => JSON.parse(a));
    const ack = parsed.find((p) => p.type === 'ack');
    expect(ack).toMatchObject({ type: 'ack', recordingId: 'r1', uptoIdx: 4, uptoOffset: 20 });
  });

  it('ignores control strings (host->guest messages) without writing', async () => {
    const writer = fakeWriter();
    const r = new ChunkReceiver({ recordingId: 'r1', writer: writer as never, sendControl: vi.fn() });
    await r.handleMessage(JSON.stringify({ type: 'ack', recordingId: 'r1', uptoIdx: 1, uptoOffset: 1 }));
    expect(writer.write).not.toHaveBeenCalled();
  });

  it('drops a binary payload with no preceding header', async () => {
    const writer = fakeWriter();
    const r = new ChunkReceiver({ recordingId: 'r1', writer: writer as never, sendControl: vi.fn() });
    await r.handleMessage(new Uint8Array([9]).buffer);
    expect(writer.write).not.toHaveBeenCalled();
  });

  it('answers a clock_ping with a clock_pong echoing seq/t0 + a host receive time', async () => {
    const sent: string[] = [];
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: fakeWriter() as never,
      sendControl: (m) => sent.push(m),
    });
    await r.handleMessage(JSON.stringify({ type: 'clock_ping', recordingId: 'r1', seq: 3, t0: 1234 }));
    const pong = JSON.parse(sent[0]!);
    expect(pong.type).toBe('clock_pong');
    expect(pong.seq).toBe(3);
    expect(pong.t0).toBe(1234);
    expect(typeof pong.t1).toBe('number');
  });

  it('captures recording_meta as the guest start (host clock) + rtt', async () => {
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: fakeWriter() as never,
      sendControl: vi.fn(),
    });
    expect(r.guestStartHostMs).toBeNull();
    await r.handleMessage(
      JSON.stringify({ type: 'recording_meta', recordingId: 'r1', guestStartHostMs: 987654, rttMs: 42 })
    );
    expect(r.guestStartHostMs).toBe(987654);
    expect(r.syncRttMs).toBe(42);
  });

  it('ignores a guest start later than the host clock, and keeps one that is not', async () => {
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: fakeWriter() as never,
      sendControl: vi.fn(),
    });
    await r.handleMessage(
      JSON.stringify({
        type: 'recording_meta',
        recordingId: 'r1',
        guestStartHostMs: Date.now() + 60_000,
      })
    );
    expect(r.guestStartHostMs).toBeNull();

    const past = Date.now() - 500;
    await r.handleMessage(
      JSON.stringify({
        type: 'recording_meta',
        recordingId: 'r1',
        guestStartHostMs: past,
      })
    );
    expect(r.guestStartHostMs).toBe(past);
  });

  it('leaves numeric fields unset when recording_meta contains non-finite or non-numeric values', async () => {
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: fakeWriter() as never,
      sendControl: vi.fn(),
    });
    await r.handleMessage(
      JSON.stringify({
        type: 'recording_meta',
        recordingId: 'r1',
        guestStartHostMs: { toString: 0 },
        rttMs: 'not-a-number',
      })
    );
    expect(r.guestStartHostMs).toBeNull();
    expect(r.syncRttMs).toBeNull();

    await r.handleMessage(
      '{"type":"recording_meta","recordingId":"r1","guestStartHostMs":1e999,"rttMs":-1e999}'
    );
    expect(r.guestStartHostMs).toBeNull();
    expect(r.syncRttMs).toBeNull();
  });

  it('leaves senderSha256 unset when recording-finalized sha256 is not a string or exceeds 64 characters', async () => {
    const r1 = new ChunkReceiver({
      recordingId: 'r1',
      writer: fakeWriter() as never,
      sendControl: vi.fn(),
    });
    await r1.handleMessage(
      JSON.stringify({
        type: 'recording-finalized',
        recordingId: 'r1',
        sha256: { toString: 0 },
      })
    );
    expect(r1.senderSha256).toBeNull();

    const r2 = new ChunkReceiver({
      recordingId: 'r2',
      writer: fakeWriter() as never,
      sendControl: vi.fn(),
    });
    await r2.handleMessage(
      JSON.stringify({
        type: 'recording-finalized',
        recordingId: 'r2',
        sha256: 'a'.repeat(65),
      })
    );
    expect(r2.senderSha256).toBeNull();

    const r3 = new ChunkReceiver({
      recordingId: 'r3',
      writer: fakeWriter() as never,
      sendControl: vi.fn(),
    });
    await r3.handleMessage(
      JSON.stringify({
        type: 'recording-finalized',
        recordingId: 'r3',
        sha256: 'a'.repeat(64),
      })
    );
    expect(r3.senderSha256).toBe('a'.repeat(64));
  });

  it('keeps a sane rate a guest reports', async () => {
    const r1 = new ChunkReceiver({
      recordingId: 'r1',
      writer: fakeWriter() as never,
      sendControl: vi.fn(),
    });
    expect(r1.senderFrameRate).toBeNull();
    await r1.handleMessage(
      JSON.stringify({
        type: 'recording-finalized',
        recordingId: 'r1',
        frameRate: 25,
      })
    );
    expect(r1.senderFrameRate).toBe(25);

    const r2 = new ChunkReceiver({
      recordingId: 'r2',
      writer: fakeWriter() as never,
      sendControl: vi.fn(),
    });
    await r2.handleMessage(
      JSON.stringify({
        type: 'recording-finalized',
        recordingId: 'r2',
        frameRate: 29.970029830932617,
      })
    );
    expect(r2.senderFrameRate).toBe(29.97);
  });

  it('ignores a rate that is not a number from 1 to 120, and still finalizes', async () => {
    const invalidRates = ['30', { toString: 0 }, null, 0, -30, 0.5, 121];
    for (const frameRate of invalidRates) {
      const r = new ChunkReceiver({
        recordingId: 'r',
        writer: fakeWriter() as never,
        sendControl: vi.fn(),
      });
      await r.handleMessage(
        JSON.stringify({
          type: 'recording-finalized',
          recordingId: 'r',
          frameRate,
        })
      );
      expect(r.senderFrameRate).toBeNull();
      expect(r.receivedFinalized).toBe(true);
      await r.whenFinalized(50);
      expect(r.isTimedOut).toBe(false);
    }

    const rRaw = new ChunkReceiver({
      recordingId: 'r1',
      writer: fakeWriter() as never,
      sendControl: vi.fn(),
    });
    await rRaw.handleMessage('{"type":"recording-finalized","recordingId":"r1","frameRate":1e999}');
    expect(rRaw.senderFrameRate).toBeNull();
    expect(rRaw.receivedFinalized).toBe(true);
    await rRaw.whenFinalized(50);
    expect(rRaw.isTimedOut).toBe(false);

    const rOverwrite = new ChunkReceiver({
      recordingId: 'r1',
      writer: fakeWriter() as never,
      sendControl: vi.fn(),
    });
    await rOverwrite.handleMessage(
      JSON.stringify({
        type: 'recording-finalized',
        recordingId: 'r1',
        frameRate: 25,
      })
    );
    expect(rOverwrite.senderFrameRate).toBe(25);
    await rOverwrite.handleMessage(
      JSON.stringify({
        type: 'recording-finalized',
        recordingId: 'r1',
        frameRate: 5000,
      })
    );
    expect(rOverwrite.senderFrameRate).toBe(25);
  });

  it('answers resume_query with resume_offset of last written position', async () => {
    const writer = fakeWriter();
    const sent: string[] = [];
    const r = new ChunkReceiver({ recordingId: 'r1', writer: writer as never, sendControl: (m) => sent.push(m) });
    for (let i = 0; i < 4; i++) {
      await r.handleMessage(encodeChunkHeader({ idx: i, offset: i * 10, size: 10, ts: 1 }));
      await r.handleMessage(new Uint8Array(10).buffer);
    }
    sent.length = 0;
    await r.handleMessage(JSON.stringify({ type: 'resume_query', recordingId: 'r1' }));
    const ro = sent.map((s) => JSON.parse(s)).find((m) => m.type === 'resume_offset');
    expect(ro).toMatchObject({ type: 'resume_offset', recordingId: 'r1', lastIdx: 3, lastByte: 40 });
  });

  it('continues from a resume position: the part this tab missed is skipped, not rewritten', async () => {
    const writer = fakeWriter();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      resumeFrom: { nextIdx: 2, end: 200 },
    });

    expect(r.resumed).toBe(true);
    expect(r.lastOffsetValue).toBe(200);

    // Replayed from the start by a sender that ignored the announced position:
    // the two parts this tab already has must not be rewritten.
    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: 100, size: 100, ts: 1 }));
    await r.handleMessage(new Uint8Array(100).buffer);
    expect(writer.write).not.toHaveBeenCalled();

    await r.handleMessage(encodeChunkHeader({ idx: 2, offset: 200, size: 4, ts: 2 }));
    await r.handleMessage(new Uint8Array(4).buffer);
    expect(writer.write).toHaveBeenCalledWith(200, expect.any(ArrayBuffer));
    expect(r.lastOffsetValue).toBe(204);
  });

  it('ignores a resume position that is not two finite numbers with an index', async () => {
    const cases: ({ nextIdx: number; end: number } | undefined)[] = [
      undefined,
      { nextIdx: -1, end: 50 },
      { nextIdx: NaN, end: 0 },
      { nextIdx: 1, end: Infinity },
    ];
    for (const resumeFrom of cases) {
      const writer = fakeWriter();
      const r = new ChunkReceiver({
        recordingId: 'r1',
        writer: writer as never,
        sendControl: vi.fn(),
        ...(resumeFrom ? { resumeFrom } : {}),
      });

      expect(r.resumed).toBe(false);
      expect(r.lastOffsetValue).toBe(0);

      await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 4, ts: 1 }));
      await r.handleMessage(new Uint8Array(4).buffer);
      expect(writer.write).toHaveBeenCalledWith(0, expect.any(ArrayBuffer));
    }
  });

  it('clamps negative resume end to zero', () => {
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: fakeWriter() as never,
      sendControl: vi.fn(),
      resumeFrom: { nextIdx: 1, end: -50 },
    });
    expect(r.resumed).toBe(true);
    expect(r.lastOffsetValue).toBe(0);
  });

  /** Four distinct 4-byte fragments, and the state that has them all. */
  const FRAGMENTS = [1, 2, 3, 4].map((n) => new Uint8Array([n, n + 1, n + 2, n + 3]));
  function stateAfter(count: number, nextIdx: number) {
    const h = new StreamingSha256();
    for (let i = 0; i < count; i++) h.update(FRAGMENTS[i]!);
    return { nextIdx, ...h.toJSON() };
  }

  async function deliverFrom(r: ChunkReceiver, first: number) {
    for (let i = first; i < FRAGMENTS.length; i++) {
      await r.handleMessage(encodeChunkHeader({ idx: i, offset: i * 4, size: 4, ts: 1 }));
      await r.handleMessage(FRAGMENTS[i]!.buffer);
    }
  }

  it('digests the whole file when the resume carries the state of the bytes before it', async () => {
    const whole = new StreamingSha256();
    for (const fragment of FRAGMENTS) whole.update(fragment);

    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: fakeWriter() as never,
      sendControl: vi.fn(),
      resumeFrom: { nextIdx: 2, end: 8, sha256State: stateAfter(2, 2) },
    });

    expect(r.resumed).toBe(false);
    await deliverFrom(r, 2);
    expect(await r.digestHex()).toBe(await whole.digestHex());
  });

  it('reports a resume without a state as partial', () => {
    for (const sha256State of [undefined, null]) {
      const r = new ChunkReceiver({
        recordingId: 'r1',
        writer: fakeWriter() as never,
        sendControl: vi.fn(),
        resumeFrom: { nextIdx: 2, end: 8, ...(sha256State !== undefined ? { sha256State } : {}) },
      });

      expect(r.resumed).toBe(true);
    }
  });

  it('ignores a state committed at another position, keeping the digest partial', async () => {
    const rest = new StreamingSha256();
    rest.update(FRAGMENTS[2]!);
    rest.update(FRAGMENTS[3]!);

    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: fakeWriter() as never,
      sendControl: vi.fn(),
      resumeFrom: { nextIdx: 2, end: 8, sha256State: stateAfter(2, 1) },
    });

    expect(r.resumed).toBe(true);
    await deliverFrom(r, 2);
    expect(await r.digestHex()).toBe(await rest.digestHex());
  });

  it('reports a write failure via onError instead of throwing', async () => {
    const writer = {
      write: vi.fn().mockRejectedValue(Object.assign(new Error('full'), { name: 'DiskFullError' })),
      fileName: 'guest.mp4',
    };
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
    });
    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 4, ts: 1 }));
    await r.handleMessage(new Uint8Array([1, 2, 3, 4]).buffer);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).name).toBe('DiskFullError');
    expect(r.bytesWritten).toBe(0); // failed write does not count toward bytes
  });

  it('stops a bounded receiver at a write failure', async () => {
    const writer = {
      write: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('full'), { name: 'DiskFullError' }))
        .mockResolvedValue(undefined),
      fileName: 'guest.mp4',
    };
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
      maxBytes: 100,
    });
    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 10, ts: 1 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: 10, size: 10, ts: 2 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).name).toBe('DiskFullError');
    expect(r.bytesWritten).toBe(0);
  });

  it('keeps taking later chunks after a write failure when unbounded', async () => {
    const writer = {
      write: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('full'), { name: 'DiskFullError' }))
        .mockResolvedValue(undefined),
      fileName: 'guest.mp4',
    };
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
    });
    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 10, ts: 1 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: 10, size: 10, ts: 2 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    expect(writer.write).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(r.bytesWritten).toBe(10);
  });

  it('flushAck() emits an ack for the latest index even below the cadence', async () => {
    const writer = fakeWriter();
    const sent: string[] = [];
    const r = new ChunkReceiver({ recordingId: 'r1', writer: writer as never, sendControl: (m) => sent.push(m) });
    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 4, ts: 1 }));
    await r.handleMessage(new Uint8Array(4).buffer);
    sent.length = 0;
    r.flushAck();
    const ack = sent.map((s) => JSON.parse(s)).find((m) => m.type === 'ack');
    expect(ack).toMatchObject({ type: 'ack', uptoIdx: 0, uptoOffset: 4 });
  });

  it('writes a chunk that ends exactly at maxBytes and refuses one that ends past it, measuring payload even if header.size claims less', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
      maxBytes: 10,
    });

    // Chunk 1: ends exactly at bound
    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 10, ts: 1 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(writer.write).toHaveBeenCalledWith(0, expect.any(ArrayBuffer));
    expect(r.bytesWritten).toBe(10);
    expect(onError).not.toHaveBeenCalled();

    // Chunk 2: ends one byte past bound (offset 10 + 1 > 10), header claims size 0
    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: 10, size: 0, ts: 2 }));
    await r.handleMessage(new Uint8Array(1).buffer);
    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(r.bytesWritten).toBe(10);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Received more data than the sender declared.' })
    );
  });

  it('refuses a small chunk whose offset is past maxBytes', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
      maxBytes: 10,
    });
    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 1_000_000, size: 1, ts: 1 }));
    await r.handleMessage(new Uint8Array(1).buffer);
    expect(writer.write).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(r.bytesWritten).toBe(0);
  });

  it('enforces maxBytes of 0', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
      maxBytes: 0,
    });
    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 1, ts: 1 }));
    await r.handleMessage(new Uint8Array(1).buffer);
    expect(writer.write).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(r.bytesWritten).toBe(0);
  });

  it('refuses a chunk that leaves a gap', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
      maxBytes: 100,
    });
    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 5, size: 10, ts: 1 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    expect(writer.write).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Received data out of order.' })
    );
    expect(r.bytesWritten).toBe(0);
  });

  it('refuses a chunk that rewrites bytes already taken', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
      maxBytes: 100,
    });
    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 10, ts: 1 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(r.bytesWritten).toBe(10);
    expect(onError).not.toHaveBeenCalled();

    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: 0, size: 10, ts: 2 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Received data out of order.' })
    );
    expect(r.bytesWritten).toBe(10);
    expect(r.receivedFinalHeader).toBe(false);
  });

  it('refuses a chunk that starts inside bytes already taken and runs past them', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
      maxBytes: 100,
    });
    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 10, ts: 1 }));
    await r.handleMessage(new Uint8Array(10).buffer);

    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: 5, size: 10, ts: 2 }));
    await r.handleMessage(new Uint8Array(10).buffer);

    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Received data out of order.' })
    );
    expect(r.bytesWritten).toBe(10);
  });

  it('takes two honest chunks delivered back to back while write is pending', async () => {
    const resolves: Array<() => void> = [];
    const writer = {
      write: vi.fn().mockImplementation(() => new Promise<void>((resolve) => resolves.push(resolve))),
      fileName: 'guest.mp4',
    };
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
      maxBytes: 100,
    });

    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 10, ts: 1 }));
    const p1 = r.handleMessage(new Uint8Array(10).buffer);

    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: 10, size: 10, ts: 2 }));
    const p2 = r.handleMessage(new Uint8Array(10).buffer);

    expect(resolves).toHaveLength(2);
    resolves.forEach((res) => res());
    await Promise.all([p1, p2]);

    expect(writer.write).toHaveBeenCalledTimes(2);
    expect(writer.write).toHaveBeenNthCalledWith(1, 0, expect.any(ArrayBuffer));
    expect(writer.write).toHaveBeenNthCalledWith(2, 10, expect.any(ArrayBuffer));
    expect(onError).not.toHaveBeenCalled();
    expect(r.bytesWritten).toBe(20);
  });

  it('counts nothing from a chunk whose write was queued when the first write failed', async () => {
    const rejects: Array<(err: unknown) => void> = [];
    const resolves: Array<() => void> = [];
    const writer = {
      write: vi
        .fn()
        .mockImplementationOnce(() => new Promise<void>((_, reject) => rejects.push(reject)))
        .mockImplementationOnce(() => new Promise<void>((resolve) => resolves.push(resolve))),
      fileName: 'guest.mp4',
    };
    const onError = vi.fn();
    const sent: string[] = [];
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: (m) => sent.push(m),
      onError,
      maxBytes: 100,
    });
    const rBaseline = new ChunkReceiver({
      recordingId: 'base',
      writer: fakeWriter() as never,
      sendControl: vi.fn(),
      maxBytes: 100,
    });

    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 10, ts: 1 }));
    const p1 = r.handleMessage(new Uint8Array(10).buffer);

    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: 10, size: 10, ts: 2 }));
    const p2 = r.handleMessage(new Uint8Array(10).buffer);

    // Both writes are queued before either settles; the first one fails.
    expect(writer.write).toHaveBeenCalledTimes(2);
    rejects[0]!(new Error('disk full'));
    resolves[0]!();
    await Promise.all([p1, p2]);

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe('disk full');
    expect(r.bytesWritten).toBe(0);
    expect(await r.digestHex()).toBe(await rBaseline.digestHex());

    // Nothing was taken for the second chunk, so there is no position to ack.
    r.flushAck();
    expect(sent).toEqual([]);
  });

  it('takes no more data chunks and reports the error once after a refusal, while still handling control messages', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const sent: string[] = [];
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: (m) => sent.push(m),
      onError,
      maxBytes: 100,
    });

    const rBaseline = new ChunkReceiver({
      recordingId: 'base',
      writer: fakeWriter() as never,
      sendControl: vi.fn(),
      maxBytes: 100,
    });
    await rBaseline.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 10, ts: 1 }));
    await rBaseline.handleMessage(new Uint8Array(10).buffer);

    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 10, ts: 1 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    expect(writer.write).toHaveBeenCalledTimes(1);

    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: 20, size: 10, ts: 2 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);

    // Send five more chunks, including one that would have been valid
    await r.handleMessage(encodeChunkHeader({ idx: 2, offset: 10, size: 10, ts: 3 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    await r.handleMessage(encodeChunkHeader({ idx: 3, offset: 20, size: 10, ts: 4 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    await r.handleMessage(encodeChunkHeader({ idx: 4, offset: 30, size: 10, ts: 5 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    await r.handleMessage(encodeChunkHeader({ idx: 5, offset: 40, size: 10, ts: 6 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    await r.handleMessage(encodeChunkHeader({ idx: 6, offset: 50, size: 10, ts: 7 }));
    await r.handleMessage(new Uint8Array(10).buffer);

    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);

    // Refused chunks must not be hashed into digest
    expect(await r.digestHex()).toBe(await rBaseline.digestHex());

    // Control messages are still handled
    sent.length = 0;
    await r.handleMessage(JSON.stringify({ type: 'clock_ping', recordingId: 'r1', seq: 1, t0: 100 }));
    expect(sent.map((s) => JSON.parse(s))).toContainEqual(expect.objectContaining({ type: 'clock_pong', seq: 1 }));

    sent.length = 0;
    await r.handleMessage(JSON.stringify({ type: 'resume_query', recordingId: 'r1' }));
    expect(sent.map((s) => JSON.parse(s))).toContainEqual(
      expect.objectContaining({ type: 'resume_offset', lastIdx: 0, lastByte: 10 })
    );

    await r.handleMessage(JSON.stringify({ type: 'stream-abandoned', recordingId: 'r1' }));
    expect(r.isAbandoned).toBe(true);

    await r.handleMessage(JSON.stringify({ type: 'recording-finalized', recordingId: 'r1' }));
    expect(r.receivedFinalized).toBe(true);

    // Duplicate chunks and control frames do not clear the refused state
    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 10, ts: 1 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    await r.handleMessage(encodeChunkHeader({ idx: 7, offset: 10, size: 10, ts: 8 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('takes nothing more after a size refusal and reports the size error once', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
      maxBytes: 10,
    });

    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 11, ts: 1 }));
    await r.handleMessage(new Uint8Array(11).buffer);
    expect(writer.write).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);

    // One chunk that would have been valid, then one past the bound again.
    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: 0, size: 10, ts: 2 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    await r.handleMessage(encodeChunkHeader({ idx: 2, offset: 5, size: 10, ts: 3 }));
    await r.handleMessage(new Uint8Array(10).buffer);

    expect(writer.write).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Received more data than the sender declared.' })
    );
  });

  it('refuses a bounded chunk whose declared size is not its payload length', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
      maxBytes: 100,
    });

    // Chunk 0: declared size is 5, but actual payload is 10 bytes
    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 5, ts: 1 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    expect(writer.write).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Received data that does not match its header.' })
    );
    expect(r.bytesWritten).toBe(0);

    // The refusal latches: a later honest chunk is not taken either.
    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: 10, size: 10, ts: 2 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    expect(writer.write).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(r.bytesWritten).toBe(0);
  });

  it('refuses a bounded chunk whose declared size exceeds its payload length', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
      maxBytes: 100,
    });

    // Chunk 0: declared size is 20, but actual payload is 10 bytes
    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 20, ts: 1 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    expect(writer.write).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Received data that does not match its header.' })
    );
    expect(r.bytesWritten).toBe(0);

    // The refusal latches: a later honest chunk is not taken either.
    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: 10, size: 10, ts: 2 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    expect(writer.write).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(r.bytesWritten).toBe(0);
  });

  it('reports the size-bound error for a chunk that is both past the bound and wrongly sized', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
      maxBytes: 5,
    });

    // Declared size is 1, the payload is 10 bytes, and the bound is 5.
    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 1, ts: 1 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    expect(writer.write).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Received more data than the sender declared.' })
    );
    expect(r.bytesWritten).toBe(0);
  });

  it('reports the header-mismatch error for a chunk that is both wrongly sized and out of order', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
      maxBytes: 100,
    });

    // Offset 5 leaves a gap, and the declared size is not the payload's length.
    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 5, size: 5, ts: 1 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    expect(writer.write).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Received data that does not match its header.' })
    );
    expect(r.bytesWritten).toBe(0);
  });

  it('accepts three contiguous chunks in sequence', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
      maxBytes: 100,
    });

    for (let i = 0; i < 3; i++) {
      await r.handleMessage(encodeChunkHeader({ idx: i, offset: i * 10, size: 10, ts: i + 1 }));
      await r.handleMessage(new Uint8Array(10).buffer);
    }
    expect(writer.write).toHaveBeenCalledTimes(3);
    expect(r.bytesWritten).toBe(30);
    expect(onError).not.toHaveBeenCalled();
  });

  it('keeps its place across a recording-finalized message', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
      maxBytes: 100,
    });
    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 10, ts: 1 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    await r.handleMessage(JSON.stringify({ type: 'recording-finalized', recordingId: 'r1' }));
    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: 10, size: 10, ts: 2 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    expect(writer.write).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it('refuses everything when maxBytes is NaN', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
      maxBytes: NaN,
    });
    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 1, ts: 1 }));
    await r.handleMessage(new Uint8Array(1).buffer);
    expect(writer.write).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Received more data than the sender declared.' })
    );
    expect(r.bytesWritten).toBe(0);
  });

  it('refuses everything when maxBytes is Infinity', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
      maxBytes: Infinity,
    });
    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 1, ts: 1 }));
    await r.handleMessage(new Uint8Array(1).buffer);
    expect(writer.write).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Received more data than the sender declared.' })
    );
    expect(r.bytesWritten).toBe(0);
  });

  it('drops an empty payload on a bounded receiver instead of counting it as progress', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const sent: string[] = [];
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: (m) => sent.push(m),
      onError,
      maxBytes: 100,
    });

    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 0, ts: 1 }));
    await r.handleMessage(new ArrayBuffer(0));
    expect(writer.write).not.toHaveBeenCalled();
    expect(sent).toEqual([]);

    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: 0, size: 10, ts: 2 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(writer.write).toHaveBeenCalledWith(0, expect.any(ArrayBuffer));
    expect(onError).not.toHaveBeenCalled();
    expect(r.bytesWritten).toBe(10);
  });

  it('drops an empty payload on an unbounded receiver too, leaving its offset unwritten', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const sent: string[] = [];
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: (m) => sent.push(m),
      onError,
    });

    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 1_000, size: 0, ts: 1 }));
    await r.handleMessage(new ArrayBuffer(0));
    expect(writer.write).not.toHaveBeenCalled();
    expect(r.bytesWritten).toBe(0);
    expect(r.lastOffsetValue).toBe(0);
    expect(sent).toEqual([]);
    expect(onError).not.toHaveBeenCalled();

    // The dropped frame was not counted as progress, so the sender's next
    // chunk is still taken.
    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: 1_000, size: 10, ts: 2 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    expect(writer.write).toHaveBeenCalledWith(1_000, expect.any(ArrayBuffer));
    expect(r.bytesWritten).toBe(10);
  });

  // The far-offset rule runs before a frame is dropped for carrying nothing:
  // a frame that arrived must not move a file's size off zero.
  it('refuses an empty payload at a far offset instead of dropping it', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
    });

    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 1_000_000_000, size: 0, ts: 1 }));
    await r.handleMessage(new ArrayBuffer(0));

    expect(writer.write).not.toHaveBeenCalled();
    expect(r.bytesWritten).toBe(0);
    expect(r.lastOffsetValue).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe(
      'A fragment arrived far past the end of the file.'
    );
  });

  it('reports size error when a chunk is both past the bound and out of order', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
      maxBytes: 10,
    });
    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 1_000_000, size: 1, ts: 1 }));
    await r.handleMessage(new Uint8Array(1).buffer);
    expect(writer.write).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Received more data than the sender declared.' })
    );
    expect(r.bytesWritten).toBe(0);
  });

  it('does not treat a replayed chunk as an out-of-order violation', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
      maxBytes: 100,
    });

    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 10, ts: 1 }));
    await r.handleMessage(new Uint8Array(10).buffer);

    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 10, ts: 1 }));
    await r.handleMessage(new Uint8Array(10).buffer);

    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: 10, size: 10, ts: 2 }));
    await r.handleMessage(new Uint8Array(10).buffer);

    expect(writer.write).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
    expect(r.bytesWritten).toBe(20);
  });

  it('allows out-of-order chunks when maxBytes is undefined', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
    });

    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 100, size: 10, ts: 1 }));
    await r.handleMessage(new Uint8Array(10).buffer);

    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: 0, size: 10, ts: 2 }));
    await r.handleMessage(new Uint8Array(10).buffer);

    expect(writer.write).toHaveBeenCalledTimes(2);
    expect(writer.write).toHaveBeenNthCalledWith(1, 100, expect.any(ArrayBuffer));
    expect(writer.write).toHaveBeenNthCalledWith(2, 0, expect.any(ArrayBuffer));
    expect(onError).not.toHaveBeenCalled();
  });

  it('writes a chunk whose declared size differs from its payload when maxBytes is undefined', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
    });

    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 5, ts: 1 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(writer.write).toHaveBeenCalledWith(0, expect.any(ArrayBuffer));
    expect(onError).not.toHaveBeenCalled();
    expect(r.bytesWritten).toBe(10);

    // The declared size is not an extent: the ten bytes that arrived are.
    expect(r.lastOffsetValue).toBe(10);
  });

  it('counts a queued second chunk after a write failure when unbounded', async () => {
    const rejects: Array<(err: unknown) => void> = [];
    const resolves: Array<() => void> = [];
    const writer = {
      write: vi
        .fn()
        .mockImplementationOnce(() => new Promise<void>((_, reject) => rejects.push(reject)))
        .mockImplementationOnce(() => new Promise<void>((resolve) => resolves.push(resolve))),
      fileName: 'guest.mp4',
    };
    const onError = vi.fn();
    const sent: string[] = [];
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: (m) => sent.push(m),
      onError,
    });

    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 10, ts: 1 }));
    const p1 = r.handleMessage(new Uint8Array(10).buffer);

    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: 10, size: 10, ts: 2 }));
    const p2 = r.handleMessage(new Uint8Array(10).buffer);

    expect(writer.write).toHaveBeenCalledTimes(2);
    rejects[0]!(new Error('disk full'));
    resolves[0]!();
    await Promise.all([p1, p2]);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(r.bytesWritten).toBe(10);
    r.flushAck();
    const ack = sent.map((m) => JSON.parse(m)).find((m) => m.type === 'ack');
    expect(ack).toMatchObject({ uptoIdx: 1, uptoOffset: 20 });
  });
});

describe('ChunkReceiver — live take order', () => {
  // A live file is written front to back. A fragment above the expected index
  // means one was lost, and writing the later one anyway would leave a
  // zero-filled hole nothing ever reports.
  it('asks the guest to resend from the last fragment written when one is missing', async () => {
    const writer = fakeWriter();
    const sent: string[] = [];
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: (m) => sent.push(m),
    });

    for (const idx of [0, 1, 5]) {
      await r.handleMessage(encodeChunkHeader({ idx, offset: idx * 4, size: 4, ts: 1 }));
      await r.handleMessage(new Uint8Array([1, 2, 3, 4]).buffer);
    }

    expect(writer.write).toHaveBeenCalledTimes(2);
    const asks = sent.map((m) => JSON.parse(m)).filter((m) => m.type === 'resume_offset');
    expect(asks).toEqual([{ type: 'resume_offset', recordingId: 'r1', lastByte: 8, lastIdx: 1 }]);
  });

  it('drops a fragment below the expected index without answering', async () => {
    const writer = fakeWriter();
    const sent: string[] = [];
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: (m) => sent.push(m),
    });

    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 4, ts: 1 }));
    await r.handleMessage(new Uint8Array([1, 2, 3, 4]).buffer);
    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 4, ts: 1 }));
    await r.handleMessage(new Uint8Array([1, 2, 3, 4]).buffer);

    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
  });

  it('writes a fragment that arrives while the previous write is still pending', async () => {
    const resolves: Array<() => void> = [];
    const writer = {
      write: vi.fn().mockImplementation(() => new Promise<void>((res) => resolves.push(res))),
      fileName: 'guest.mp4',
    };
    const sent: string[] = [];
    const r = new ChunkReceiver({ recordingId: 'r1', writer: writer as never, sendControl: (m) => sent.push(m) });

    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 4, ts: 1 }));
    const first = r.handleMessage(new Uint8Array([1, 2, 3, 4]).buffer);
    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: 4, size: 4, ts: 2 }));
    const second = r.handleMessage(new Uint8Array([5, 6, 7, 8]).buffer);

    expect(resolves).toHaveLength(2);
    for (const resolve of resolves) resolve();
    await Promise.all([first, second]);

    expect(writer.write).toHaveBeenCalledTimes(2);
    expect(writer.write).toHaveBeenNthCalledWith(1, 0, expect.any(ArrayBuffer));
    expect(writer.write).toHaveBeenNthCalledWith(2, 4, expect.any(ArrayBuffer));
    expect(sent.filter((m) => JSON.parse(m).type === 'resume_offset')).toEqual([]);
  });

  it('drops a replay that arrives while its write is still pending', async () => {
    const resolves: Array<() => void> = [];
    const writer = {
      write: vi.fn().mockImplementation(() => new Promise<void>((res) => resolves.push(res))),
      fileName: 'guest.mp4',
    };
    const sent: string[] = [];
    const r = new ChunkReceiver({ recordingId: 'r1', writer: writer as never, sendControl: (m) => sent.push(m) });

    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 4, ts: 1 }));
    const first = r.handleMessage(new Uint8Array([1, 2, 3, 4]).buffer);
    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 4, ts: 1 }));
    const replay = r.handleMessage(new Uint8Array([1, 2, 3, 4]).buffer);

    expect(resolves).toHaveLength(1);
    resolves[0]!();
    await Promise.all([first, replay]);

    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(sent.filter((m) => JSON.parse(m).type === 'resume_offset')).toEqual([]);
  });

  it('asks for a gap at most once per RESUME_ASK_INTERVAL_MS', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const sent: string[] = [];
      const r = new ChunkReceiver({
        recordingId: 'r1',
        writer: fakeWriter() as never,
        sendControl: (m) => sent.push(m),
      });
      const asks = () => sent.map((m) => JSON.parse(m)).filter((m) => m.type === 'resume_offset');

      for (const idx of [5, 6, 7]) {
        await r.handleMessage(encodeChunkHeader({ idx, offset: 0, size: 4, ts: 1 }));
        await r.handleMessage(new Uint8Array([1, 2, 3, 4]).buffer);
      }
      expect(asks()).toHaveLength(1);

      vi.advanceTimersByTime(1999);
      await r.handleMessage(encodeChunkHeader({ idx: 8, offset: 0, size: 4, ts: 1 }));
      await r.handleMessage(new Uint8Array([1, 2, 3, 4]).buffer);
      expect(asks()).toHaveLength(1);

      vi.advanceTimersByTime(1);
      await r.handleMessage(encodeChunkHeader({ idx: 9, offset: 0, size: 4, ts: 1 }));
      await r.handleMessage(new Uint8Array([1, 2, 3, 4]).buffer);
      expect(asks()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the ask interval per receiver, not per module', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const firstSent: string[] = [];
      const secondSent: string[] = [];
      const first = new ChunkReceiver({
        recordingId: 'r1',
        writer: fakeWriter() as never,
        sendControl: (m) => firstSent.push(m),
      });
      const second = new ChunkReceiver({
        recordingId: 'r2',
        writer: fakeWriter() as never,
        sendControl: (m) => secondSent.push(m),
      });

      await first.handleMessage(encodeChunkHeader({ idx: 1, offset: 0, size: 4, ts: 1 }));
      await first.handleMessage(new Uint8Array([1, 2, 3, 4]).buffer);
      await second.handleMessage(encodeChunkHeader({ idx: 1, offset: 0, size: 4, ts: 1 }));
      await second.handleMessage(new Uint8Array([1, 2, 3, 4]).buffer);

      const asks = secondSent.map((m) => JSON.parse(m)).filter((m) => m.type === 'resume_offset');
      expect(asks).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // A returned file is read front to back against a declared size, so a gap
  // there is a refusal, not a retransmit: the sender's buffer is long gone.
  it('leaves a bounded receiver dropping replays and refusing a gap', async () => {
    const writer = fakeWriter();
    const sent: string[] = [];
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: (m) => sent.push(m),
      onError,
      maxBytes: 100,
    });

    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 4, ts: 1 }));
    await r.handleMessage(new Uint8Array([1, 2, 3, 4]).buffer);
    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 4, ts: 1 }));
    await r.handleMessage(new Uint8Array([1, 2, 3, 4]).buffer);
    expect(onError).not.toHaveBeenCalled();

    await r.handleMessage(encodeChunkHeader({ idx: 2, offset: 8, size: 4, ts: 2 }));
    await r.handleMessage(new Uint8Array([1, 2, 3, 4]).buffer);

    expect(writer.write).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe('Received data out of order.');
    expect(sent.map((m) => JSON.parse(m)).filter((m) => m.type === 'resume_offset')).toEqual([]);
  });

  // The header's `size` is the guest's claim about its own frame. Only the
  // bytes in the frame arrived, so only they can say where the file ends.
  it('measures the end of a live file by the payload that arrived, not the declared size', async () => {
    const writer = fakeWriter();
    const sent: string[] = [];
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: (m) => sent.push(m),
    });

    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 10, size: 999_999, ts: 1 }));
    await r.handleMessage(new Uint8Array(4).buffer);

    expect(r.lastOffsetValue).toBe(14);

    sent.length = 0;
    r.flushAck();
    expect(sent.map((m) => JSON.parse(m))).toEqual([
      { type: 'ack', recordingId: 'r1', uptoIdx: 0, uptoOffset: 14 },
    ]);
  });

  // A live file is written front to back, so an offset far past its end would
  // only make the folder writer create a sparse file.
  it('refuses a fragment far past the end of a live file and reports it', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
    });

    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 10, size: 999_999, ts: 1 }));
    await r.handleMessage(new Uint8Array(4).buffer);

    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: MAX_OFFSET_JUMP_BYTES + 100, size: 4, ts: 2 }));
    await r.handleMessage(new Uint8Array(4).buffer);
    await r.handleMessage(encodeChunkHeader({ idx: 2, offset: MAX_OFFSET_JUMP_BYTES + 200, size: 4, ts: 3 }));
    await r.handleMessage(new Uint8Array(4).buffer);

    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(r.bytesWritten).toBe(4);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe('A fragment arrived far past the end of the file.');
  });

  // One report per receiver: a guest that keeps naming absurd offsets must not
  // become an error per frame in the host's UI.
  it('reports the far-past-the-end fragment once, however many arrive', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
    });

    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 4, ts: 1 }));
    await r.handleMessage(new Uint8Array(4).buffer);

    // Both jumps carry the index the receiver expects, so both reach the
    // offset rule rather than the gap rule.
    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: MAX_OFFSET_JUMP_BYTES + 100, size: 4, ts: 2 }));
    await r.handleMessage(new Uint8Array(4).buffer);
    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: MAX_OFFSET_JUMP_BYTES + 200, size: 4, ts: 3 }));
    await r.handleMessage(new Uint8Array(4).buffer);

    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(r.bytesWritten).toBe(4);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  // The refused fragment must not be claimed: if it advanced the expected
  // index, the honest fragment that follows would be dropped as a replay.
  it('takes the honest fragment after a refused jump instead of calling it a gap', async () => {
    const writer = fakeWriter();
    const sent: string[] = [];
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: (m) => sent.push(m),
      onError: vi.fn(),
    });

    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 10, size: 999_999, ts: 1 }));
    await r.handleMessage(new Uint8Array(4).buffer);
    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: MAX_OFFSET_JUMP_BYTES + 100, size: 4, ts: 2 }));
    await r.handleMessage(new Uint8Array(4).buffer);
    sent.length = 0;

    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: 14, size: 4, ts: 3 }));
    await r.handleMessage(new Uint8Array(4).buffer);

    expect(writer.write).toHaveBeenCalledTimes(2);
    expect(writer.write).toHaveBeenNthCalledWith(2, 14, expect.any(ArrayBuffer));
    expect(sent.filter((m) => JSON.parse(m).type === 'resume_offset')).toEqual([]);
  });

  // The bound is on how far past the end a fragment may start, not on whether
  // it moves forward: a replay after a lost ack and a WAV header rewritten at
  // offset 0 both start before the end and must still be written.
  it('still takes a live fragment that starts before the end of the file', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
    });

    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 4, ts: 1 }));
    await r.handleMessage(new Uint8Array(4).buffer);
    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: MAX_OFFSET_JUMP_BYTES, size: 4, ts: 2 }));
    await r.handleMessage(new Uint8Array(4).buffer);
    await r.handleMessage(encodeChunkHeader({ idx: 2, offset: 0, size: 4, ts: 3 }));
    await r.handleMessage(new Uint8Array(4).buffer);

    expect(writer.write).toHaveBeenCalledTimes(3);
    expect(writer.write).toHaveBeenNthCalledWith(2, MAX_OFFSET_JUMP_BYTES, expect.any(ArrayBuffer));
    expect(writer.write).toHaveBeenNthCalledWith(3, 0, expect.any(ArrayBuffer));
    expect(onError).not.toHaveBeenCalled();
  });

  // A file that has already received more than 64 MiB of data can still receive
  // fragments starting before the end (such as a WAV header rewritten at offset 0).
  // A symmetric bound (|offset - bytesWritten| > MAX_OFFSET_JUMP_BYTES) would reject
  // the offset-0 rewrite once bytesWritten exceeds 64 MiB.
  it('allows rewriting at offset 0 after more than 64 MiB has arrived', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
    });

    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: MAX_OFFSET_JUMP_BYTES + 1, ts: 1 }));
    await r.handleMessage(new Uint8Array(MAX_OFFSET_JUMP_BYTES + 1).buffer);
    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(r.bytesWritten).toBe(MAX_OFFSET_JUMP_BYTES + 1);

    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: 0, size: 44, ts: 2 }));
    await r.handleMessage(new Uint8Array(44).buffer);

    expect(writer.write).toHaveBeenCalledTimes(2);
    expect(writer.write).toHaveBeenNthCalledWith(2, 0, expect.any(ArrayBuffer));
    expect(onError).not.toHaveBeenCalled();
  });

  // A fragment starting at exactly bytesWritten + MAX_OFFSET_JUMP_BYTES is
  // within the bound and must be written, and a file past 64 MiB continues
  // taking chunks.
  it('allows a fragment starting at the exact maximum jump boundary beyond current extents', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
    });

    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 4, ts: 1 }));
    await r.handleMessage(new Uint8Array(4).buffer);
    await r.handleMessage(
      encodeChunkHeader({ idx: 1, offset: 4 + MAX_OFFSET_JUMP_BYTES, size: 4, ts: 2 })
    );
    await r.handleMessage(new Uint8Array(4).buffer);

    expect(writer.write).toHaveBeenCalledTimes(2);
    expect(writer.write).toHaveBeenNthCalledWith(2, 4 + MAX_OFFSET_JUMP_BYTES, expect.any(ArrayBuffer));
    expect(r.bytesWritten).toBe(8);
    expect(onError).not.toHaveBeenCalled();

    await r.handleMessage(
      encodeChunkHeader({ idx: 2, offset: 8 + MAX_OFFSET_JUMP_BYTES, size: 4, ts: 3 })
    );
    await r.handleMessage(new Uint8Array(4).buffer);

    expect(writer.write).toHaveBeenCalledTimes(3);
    expect(writer.write).toHaveBeenNthCalledWith(3, 8 + MAX_OFFSET_JUMP_BYTES, expect.any(ArrayBuffer));
    expect(r.bytesWritten).toBe(12);
    expect(onError).not.toHaveBeenCalled();
  });

  // Each fragment starts 64 MiB past the last while carrying one byte.
  // Measured from the file's end, every step is allowed and one byte buys
  // another 64 MiB of file; measured from the bytes that arrived, the file
  // cannot run more than the bound past what the guest really sent.
  it('measures the jump allowance from the bytes that arrived, not the file end', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
    });

    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: MAX_OFFSET_JUMP_BYTES, size: 1, ts: 1 }));
    await r.handleMessage(new Uint8Array(1).buffer);
    // The same index each time, so every jump reaches the offset rule rather
    // than the gap rule.
    for (let i = 2; i <= 5; i++) {
      await r.handleMessage(
        encodeChunkHeader({ idx: 1, offset: i * MAX_OFFSET_JUMP_BYTES + i - 1, size: 1, ts: i })
      );
      await r.handleMessage(new Uint8Array(1).buffer);
    }

    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(writer.write).toHaveBeenCalledWith(MAX_OFFSET_JUMP_BYTES, expect.any(ArrayBuffer));
    expect(r.bytesWritten).toBe(1);
    expect(r.lastOffsetValue).toBe(MAX_OFFSET_JUMP_BYTES + 1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe(
      'A fragment arrived far past the end of the file.'
    );
  });

  // A returned file is read front to back against the size its sender declared,
  // so a jump there is the size rule's refusal, and that refusal latches.
  it('leaves a bounded receiver refusing a jump by its own size rule', async () => {
    const writer = fakeWriter();
    const onError = vi.fn();
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: writer as never,
      sendControl: vi.fn(),
      onError,
      maxBytes: 100,
    });

    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: MAX_OFFSET_JUMP_BYTES + 100, size: 1, ts: 1 }));
    await r.handleMessage(new Uint8Array(1).buffer);
    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: 0, size: 1, ts: 2 }));
    await r.handleMessage(new Uint8Array(1).buffer);

    expect(writer.write).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe('Received more data than the sender declared.');
  });

  // A guest asks on its channel's open, the host binds when its own file is
  // ready. Answering a query must count as the answer, or the gap that follows
  // the query sends a second one at the same instant.
  it('answers a resume_query and the gap after it with one resume_offset', async () => {
    const sent: string[] = [];
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: fakeWriter() as never,
      sendControl: (m) => sent.push(m),
    });

    await r.handleMessage(JSON.stringify({ type: 'resume_query', recordingId: 'r1' }));
    await r.handleMessage(encodeChunkHeader({ idx: 3, offset: 0, size: 4, ts: 1 }));
    await r.handleMessage(new Uint8Array(4).buffer);

    const asks = sent.map((m) => JSON.parse(m)).filter((m) => m.type === 'resume_offset');
    expect(asks).toEqual([{ type: 'resume_offset', recordingId: 'r1', lastByte: 0, lastIdx: -1 }]);
  });

  // A receiver that is new while the sender is not would ask forever, and every
  // ask makes the guest replay its whole backlog. Five fruitless asks is enough
  // to tell the host this file cannot be continued here.
  it('stops asking for a gap after five fruitless asks and reports it once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const writer = fakeWriter();
      const sent: string[] = [];
      const onError = vi.fn();
      const r = new ChunkReceiver({
        recordingId: 'r1',
        writer: writer as never,
        sendControl: (m) => sent.push(m),
        onError,
      });
      const asks = () => sent.map((m) => JSON.parse(m)).filter((m) => m.type === 'resume_offset');
      const gap = async (idx: number) => {
        await r.handleMessage(encodeChunkHeader({ idx, offset: 0, size: 4, ts: 1 }));
        await r.handleMessage(new Uint8Array(4).buffer);
      };

      for (let i = 0; i < 5; i++) {
        await gap(i + 1);
        vi.advanceTimersByTime(RESUME_ASK_INTERVAL_MS);
      }
      expect(asks()).toHaveLength(5);
      expect(onError).toHaveBeenCalledTimes(1);
      expect((onError.mock.calls[0]![0] as Error).message).toBe(
        "A guest's recording could not be continued here. Their own backup has it."
      );

      await gap(9);
      await gap(10);
      expect(asks()).toHaveLength(5);
      expect(onError).toHaveBeenCalledTimes(1);

      // The fragment the asks were for is still taken when it finally arrives.
      await gap(0);
      expect(writer.write).toHaveBeenCalledTimes(1);
      expect(writer.write).toHaveBeenCalledWith(0, expect.any(ArrayBuffer));
    } finally {
      vi.useRealTimers();
    }
  });

  // The count belongs to a gap, not to the receiver: an ask that gets its
  // fragment answers the question, and the next gap starts over.
  it('asks for a later gap again once a fragment fills the one before it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const writer = fakeWriter();
      const sent: string[] = [];
      const onError = vi.fn();
      const r = new ChunkReceiver({
        recordingId: 'r1',
        writer: writer as never,
        sendControl: (m) => sent.push(m),
        onError,
      });
      const asks = () => sent.map((m) => JSON.parse(m)).filter((m) => m.type === 'resume_offset');

      for (let i = 0; i < 4; i++) {
        await r.handleMessage(encodeChunkHeader({ idx: 1, offset: 0, size: 4, ts: 1 }));
        await r.handleMessage(new Uint8Array(4).buffer);
        vi.advanceTimersByTime(RESUME_ASK_INTERVAL_MS);
      }
      expect(asks()).toHaveLength(4);
      expect(onError).not.toHaveBeenCalled();

      await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 4, ts: 1 }));
      await r.handleMessage(new Uint8Array(4).buffer);
      expect(writer.write).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(RESUME_ASK_INTERVAL_MS);
      await r.handleMessage(encodeChunkHeader({ idx: 2, offset: 4, size: 4, ts: 1 }));
      await r.handleMessage(new Uint8Array(4).buffer);

      expect(asks()).toHaveLength(5);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // One report per receiver: a guest that gives up on a later gap must not
  // keep replacing whatever the host is being told.
  it('reports the gap once however many times the asking gives up', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const writer = fakeWriter();
      const sent: string[] = [];
      const onError = vi.fn();
      const r = new ChunkReceiver({
        recordingId: 'r1',
        writer: writer as never,
        sendControl: (m) => sent.push(m),
        onError,
      });
      const asks = () => sent.map((m) => JSON.parse(m)).filter((m) => m.type === 'resume_offset');
      const gap = async (idx: number) => {
        await r.handleMessage(encodeChunkHeader({ idx, offset: 0, size: 4, ts: 1 }));
        await r.handleMessage(new Uint8Array(4).buffer);
      };

      for (let i = 0; i < 5; i++) {
        await gap(1);
        vi.advanceTimersByTime(RESUME_ASK_INTERVAL_MS);
      }
      expect(asks()).toHaveLength(5);
      expect(onError).toHaveBeenCalledTimes(1);

      // The fragment the asks were for arrives, so a later gap is asked for
      // again from scratch.
      await gap(0);
      expect(writer.write).toHaveBeenCalledTimes(1);

      for (let i = 0; i < 5; i++) {
        await gap(2);
        vi.advanceTimersByTime(RESUME_ASK_INTERVAL_MS);
      }
      expect(asks()).toHaveLength(10);
      expect(onError).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ChunkReceiver — host-driven stop', () => {
  // The host signals stop over the WS, so the guest's tail is still a round
  // trip plus an encoder flush away. Closing the writer on the host's own
  // schedule truncated the last seconds of every guest take.
  it('whenFinalized resolves once the sender reports recording-finalized', async () => {
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: fakeWriter() as never,
      sendControl: () => {},
    });
    let settled = false;
    const waiting = r.whenFinalized(5000).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await r.handleMessage(
      JSON.stringify({ type: 'recording-finalized', recordingId: 'r1', totalBytes: 8, sha256: 'abc' })
    );
    await waiting;
    expect(settled).toBe(true);
    expect(r.senderSha256).toBe('abc');
  });

  // A guest that crashed mid-take must not strand the host holding an open
  // file handle — an unclosed FileSystemWritableFileStream is a 0-byte MP4.
  it('whenFinalized gives up after the timeout rather than hanging', async () => {
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: fakeWriter() as never,
      sendControl: () => {},
    });
    await expect(r.whenFinalized(10)).resolves.toBeUndefined();
  });
});

describe('ChunkReceiver — host-driven stop hard cap', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function deliver(r: ChunkReceiver, idx: number) {
    await r.handleMessage(encodeChunkHeader({ idx, offset: idx * 4, size: 4, ts: 1 }));
    await r.handleMessage(new Uint8Array(4).buffer);
  }

  function receiver() {
    return new ChunkReceiver({
      recordingId: 'r1',
      writer: fakeWriter() as never,
      sendControl: () => {},
    });
  }

  // A sender that keeps delivering never trips the no-progress rule, so without
  // the cap it decides when the host may close the file — for as long as it likes.
  it('gives up at the hard cap while fragments keep arriving', async () => {
    const r = receiver();
    let settled = false;
    const waiting = r.whenFinalized(50, 200).then(() => {
      settled = true;
    });
    // A fragment every 20 ms, so 50 ms of no progress never passes.
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(20);
      await deliver(r, i);
    }
    expect(settled, 'resolved before the cap with the sender still delivering').toBe(false);

    await vi.advanceTimersByTimeAsync(20);
    await deliver(r, 9);
    expect(settled).toBe(true);
    expect(r.isTimedOut).toBe(true);
    await waiting;
  });

  // The cap bounds the wait; it does not replace the progress rule. A slow but
  // honest sender is still given its no-progress window after the last fragment.
  it('lets progress extend the wait up to the cap', async () => {
    const r = receiver();
    let settled = false;
    let resolvedAt = 0;
    const startedAt = Date.now();
    const waiting = r.whenFinalized(50, 10_000).then(() => {
      settled = true;
      resolvedAt = Date.now();
    });
    // Fragments for 140 ms — nearly three times the 50 ms no-progress window.
    for (let i = 0; i < 7; i++) {
      await vi.advanceTimersByTimeAsync(20);
      await deliver(r, i);
      if (i === 4) {
        expect(settled, 'gave up while the sender was still delivering').toBe(false);
      }
    }

    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(true);
    expect(r.isTimedOut).toBe(true);
    expect(resolvedAt - startedAt).toBeGreaterThanOrEqual(150);
    expect(resolvedAt - startedAt).toBeLessThan(1000);
    await waiting;
  });

  // No cap given means no cap: only the sender, or 20 s of silence, ends the
  // wait. A default that quietly gave up would cut off a sender still sending.
  it('has no cap when none is given', async () => {
    const r = receiver();
    let settled = false;
    const waiting = r.whenFinalized(20_000).then(() => {
      settled = true;
    });
    for (let i = 0; i < 13; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      await deliver(r, i);
      expect(settled, 'gave up without a cap while fragments were still arriving').toBe(false);
    }

    await r.handleMessage(
      JSON.stringify({ type: 'recording-finalized', recordingId: 'r1', sha256: 'abc' })
    );
    await waiting;
    expect(r.isTimedOut).toBe(false);
  });
});

describe('ChunkReceiver — journal-backed acks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // A clock at 0 collides with the sentinel that says no commit was queued yet.
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  async function deliver(r: ChunkReceiver, idx: number, offset: number, bytes = 4) {
    await r.handleMessage(encodeChunkHeader({ idx, offset, size: bytes, ts: 1 }));
    await r.handleMessage(new Uint8Array(bytes).buffer);
  }

  /** Let the commit chain's microtasks run to quiescence. */
  async function settle() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }

  function receiver(journal: FakeJournalFile, sent: string[], onWarn?: (msg: string) => void) {
    return new ChunkReceiver({
      recordingId: 'r1',
      writer: fakeWriter() as never,
      sendControl: (m) => sent.push(m),
      journalFile: journal,
      ...(onWarn ? { onWarn } : {}),
    });
  }

  it('holds the ack until the commit covering the fragment resolves', async () => {
    const journal = fakeJournalFile();
    const gate = deferred();
    journal.commit = vi.fn(() => gate.promise);
    const sent: string[] = [];
    const r = receiver(journal, sent);

    await deliver(r, 0, 0);
    vi.advanceTimersByTime(CHUNK_TIMESLICE_MS);
    for (let i = 1; i < 5; i++) await deliver(r, i, i * 4);

    expect(journal.commit).toHaveBeenCalledTimes(1);
    expect(acks(sent)).toEqual([]);

    gate.resolve();
    await settle();
    expect(acks(sent)).toEqual([
      { type: 'ack', recordingId: 'r1', uptoIdx: 1, uptoOffset: 8 },
    ]);
    expect(journal.append).toHaveBeenCalledTimes(5);
    for (let i = 0; i < 5; i++) {
      expect(journal.append).toHaveBeenNthCalledWith(i + 1, i * 4, expect.any(ArrayBuffer));
    }
  });

  it('commits on the timeslice, not on the fragment count', async () => {
    const journal = fakeJournalFile();
    const sent: string[] = [];
    const r = receiver(journal, sent);

    await deliver(r, 0, 0);
    vi.advanceTimersByTime(1000);
    await deliver(r, 1, 4);
    await settle();
    expect(journal.commit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    await deliver(r, 2, 8);
    await settle();
    expect(journal.commit).toHaveBeenCalledTimes(1);
    expect(journal.commit).toHaveBeenCalledWith(3, expect.any(Object));
    await settle();
    expect(acks(sent)).toEqual([
      { type: 'ack', recordingId: 'r1', uptoIdx: 2, uptoOffset: 12 },
    ]);

    vi.advanceTimersByTime(2000);
    await deliver(r, 3, 12);
    await settle();
    expect(journal.commit).toHaveBeenCalledTimes(2);
    expect(journal.commit).toHaveBeenLastCalledWith(4, expect.any(Object));
  });

  it('hands the journal the hash state of exactly the bytes it commits', async () => {
    const journal = fakeJournalFile();
    const states: unknown[] = [];
    journal.commit = vi.fn(async (_nextIdx: number, state?: unknown) => {
      states.push(state);
    });
    const r = receiver(journal, []);

    await deliver(r, 0, 0);
    vi.advanceTimersByTime(CHUNK_TIMESLICE_MS);
    await deliver(r, 1, 4);
    await settle();

    const expected = new StreamingSha256();
    expected.update(new Uint8Array(8));
    expect(states).toEqual([expected.toJSON()]);
  });

  it('acks the bytes the commit closed, not the ones that arrived while it ran', async () => {
    const journal = fakeJournalFile();
    const gate = deferred();
    journal.commit = vi.fn(() => gate.promise);
    const sent: string[] = [];
    const r = receiver(journal, sent);

    await deliver(r, 0, 0);
    vi.advanceTimersByTime(CHUNK_TIMESLICE_MS);
    for (let i = 1; i < 4; i++) await deliver(r, i, i * 4);
    expect(journal.commit).toHaveBeenCalledTimes(1);

    gate.resolve();
    await settle();
    expect(acks(sent)).toEqual([
      { type: 'ack', recordingId: 'r1', uptoIdx: 1, uptoOffset: 8 },
    ]);
  });

  it('does not start a second commit while one is in flight', async () => {
    const journal = fakeJournalFile();
    const first = deferred();
    const second = deferred();
    const gates = [first, second];
    let inFlight: Promise<void> | null = null;
    journal.commit = vi.fn(() => {
      if (!inFlight) {
        const started = gates.shift()!.promise;
        inFlight = started;
        void started.then(() => {
          inFlight = null;
        });
      }
      return inFlight;
    });
    const sent: string[] = [];
    const r = receiver(journal, sent);

    await deliver(r, 0, 0);
    vi.advanceTimersByTime(CHUNK_TIMESLICE_MS);
    await deliver(r, 1, 4);
    expect(journal.commit).toHaveBeenCalledTimes(1);

    // A commit is due again while the first is still in flight.
    vi.advanceTimersByTime(CHUNK_TIMESLICE_MS);
    await deliver(r, 2, 8);
    await settle();
    expect(journal.commit).toHaveBeenCalledTimes(1);

    first.resolve();
    await settle();
    expect(acks(sent)).toEqual([
      { type: 'ack', recordingId: 'r1', uptoIdx: 1, uptoOffset: 8 },
    ]);
    expect(journal.commit).toHaveBeenCalledTimes(2);
    expect(journal.commit).toHaveBeenLastCalledWith(3, expect.any(Object));
  });

  it('stamps the timeslice when the commit is queued, not when it resolves', async () => {
    const journal = fakeJournalFile();
    const gate = deferred();
    let calls = 0;
    journal.commit = vi.fn(() => {
      calls += 1;
      return calls === 1 ? gate.promise : Promise.resolve();
    });
    const sent: string[] = [];
    const r = receiver(journal, sent);

    await deliver(r, 0, 0);
    vi.advanceTimersByTime(CHUNK_TIMESLICE_MS);
    await deliver(r, 1, 4);
    expect(journal.commit).toHaveBeenCalledTimes(1);

    // The commit takes much longer than a timeslice.
    vi.advanceTimersByTime(8000);
    gate.resolve();
    await settle();
    expect(journal.commit).toHaveBeenCalledTimes(1);

    await deliver(r, 2, 8);
    await settle();
    expect(journal.commit).toHaveBeenCalledTimes(2);
  });

  it('falls back to the folder-write ack at once, with one warning, when the journal dies', async () => {
    const journal = fakeJournalFile();
    const gate = deferred();
    journal.commit = vi.fn(() => {
      journal.dead = true;
      return gate.promise;
    });
    const sent: string[] = [];
    const onWarn = vi.fn();
    const r = receiver(journal, sent, onWarn);

    await deliver(r, 0, 0);
    vi.advanceTimersByTime(CHUNK_TIMESLICE_MS);
    for (let i = 1; i < 5; i++) await deliver(r, i, i * 4);
    expect(journal.append).toHaveBeenCalledTimes(5);
    expect(journal.commit).toHaveBeenCalledTimes(1);
    expect(acks(sent)).toEqual([]);

    gate.resolve();
    await settle();
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn).toHaveBeenCalledWith(
      'Crash protection stopped for this take — browser storage would not take it.'
    );
    expect(acks(sent)).toEqual([
      { type: 'ack', recordingId: 'r1', uptoIdx: 4, uptoOffset: 20 },
    ]);

    for (let i = 5; i < 10; i++) await deliver(r, i, i * 4);
    expect(journal.append).toHaveBeenCalledTimes(5);
    expect(journal.commit).toHaveBeenCalledTimes(1);
    expect(acks(sent)).toHaveLength(2);
    expect(acks(sent)[1]).toMatchObject({ uptoIdx: 9, uptoOffset: 40 });

    // The tail ack goes out at once for a journal that is gone.
    r.flushAck();
    expect(journal.commit).toHaveBeenCalledTimes(1);
    expect(acks(sent)).toHaveLength(3);
  });

  it('a commit already queued when the journal dies neither warns nor acks again', async () => {
    const journal = fakeJournalFile();
    const gate = deferred();
    journal.commit = vi.fn(() => gate.promise);
    const sent: string[] = [];
    const onWarn = vi.fn();
    const r = receiver(journal, sent, onWarn);

    await deliver(r, 0, 0);
    vi.advanceTimersByTime(CHUNK_TIMESLICE_MS);
    await deliver(r, 1, 4);
    vi.advanceTimersByTime(CHUNK_TIMESLICE_MS);
    await deliver(r, 2, 8);
    expect(journal.commit).toHaveBeenCalledTimes(1);

    journal.dead = true;
    gate.resolve();
    await settle();
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(acks(sent)).toEqual([
      { type: 'ack', recordingId: 'r1', uptoIdx: 2, uptoOffset: 12 },
    ]);
  });

  it('flushAck queues the tail commit and still returns nothing', async () => {
    const journal = fakeJournalFile();
    const sent: string[] = [];
    const r = receiver(journal, sent);
    expect(r.flushAck()).toBeUndefined();
    expect(journal.commit).not.toHaveBeenCalled();
    expect(acks(sent)).toEqual([]);

    await deliver(r, 0, 0);
    expect(journal.commit).not.toHaveBeenCalled();
    expect(r.flushAck()).toBeUndefined();
    await settle();
    expect(journal.commit).toHaveBeenCalledWith(1, expect.any(Object));
    expect(acks(sent)).toEqual([
      { type: 'ack', recordingId: 'r1', uptoIdx: 0, uptoOffset: 4 },
    ]);
  });

  it('gives the ordinary ack and no warning for a journal finished with the take', async () => {
    const journal = fakeJournalFile();
    const sent: string[] = [];
    const onWarn = vi.fn();
    const r = receiver(journal, sent, onWarn);

    await deliver(r, 0, 0);
    expect(r.flushAck()).toBeUndefined();
    await settle();

    expect(journal.commit).toHaveBeenCalledWith(1, expect.any(Object));
    expect(journal.dead).toBe(false);
    expect(acks(sent)).toEqual([
      { type: 'ack', recordingId: 'r1', uptoIdx: 0, uptoOffset: 4 },
    ]);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('keeps committing when a control send throws', async () => {
    const journal = fakeJournalFile();
    const sent: string[] = [];
    let attempts = 0;
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: fakeWriter() as never,
      sendControl: (m) => {
        attempts += 1;
        if (attempts === 1) throw new Error('channel closed');
        sent.push(m);
      },
      journalFile: journal,
    });

    await deliver(r, 0, 0);
    vi.advanceTimersByTime(CHUNK_TIMESLICE_MS);
    await deliver(r, 1, 4);
    await settle();
    expect(sent).toEqual([]);

    vi.advanceTimersByTime(CHUNK_TIMESLICE_MS);
    await deliver(r, 2, 8);
    await settle();
    expect(journal.commit).toHaveBeenCalledTimes(2);
    expect(acks(sent)).toEqual([
      { type: 'ack', recordingId: 'r1', uptoIdx: 2, uptoOffset: 12 },
    ]);
  });

  it('acks the payload length when header.size claims a different size', async () => {
    const journal = fakeJournalFile();
    const sent: string[] = [];
    const r = receiver(journal, sent);

    await r.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 100, ts: 1 }));
    await r.handleMessage(new Uint8Array(4).buffer);

    vi.advanceTimersByTime(CHUNK_TIMESLICE_MS);

    await r.handleMessage(encodeChunkHeader({ idx: 1, offset: 4, size: 200, ts: 2 }));
    await r.handleMessage(new Uint8Array(6).buffer);

    await settle();
    expect(journal.commit).toHaveBeenCalledWith(2, expect.any(Object));
    expect(acks(sent)).toEqual([
      { type: 'ack', recordingId: 'r1', uptoIdx: 1, uptoOffset: 10 },
    ]);
  });

  it('journals and acks only what the receiver took and the folder wrote', async () => {
    const journal = fakeJournalFile();
    const write = vi
      .fn()
      .mockResolvedValueOnce(undefined) // idx 0
      .mockRejectedValueOnce(new Error('disk full')) // idx 1
      .mockResolvedValue(undefined);
    const sent: string[] = [];
    const r = new ChunkReceiver({
      recordingId: 'r1',
      writer: { write, fileName: 'guest.mp4' } as never,
      sendControl: (m) => sent.push(m),
      journalFile: journal,
      onError: () => {},
    });

    await deliver(r, 0, 0); // taken
    await deliver(r, 0, 0); // a replay
    await deliver(r, 9, 1_000_000); // past a gap
    await deliver(r, 1, 4); // the folder refuses it
    await deliver(r, 2, 8, 0); // an empty frame

    expect(journal.append).toHaveBeenCalledTimes(1);
    expect(journal.append).toHaveBeenCalledWith(0, expect.any(ArrayBuffer));

    vi.advanceTimersByTime(CHUNK_TIMESLICE_MS);
    r.flushAck();
    await settle();
    expect(acks(sent)).toEqual([
      { type: 'ack', recordingId: 'r1', uptoIdx: 0, uptoOffset: 4 },
    ]);
  });

  it('commits when the host clock steps backwards', async () => {
    const journal = fakeJournalFile();
    const sent: string[] = [];
    const r = receiver(journal, sent);

    await deliver(r, 0, 0);
    vi.advanceTimersByTime(CHUNK_TIMESLICE_MS);
    await deliver(r, 1, 4);
    await settle();
    expect(journal.commit).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() - 60 * 60 * 1000);
    await deliver(r, 2, 8);
    await settle();
    expect(journal.commit).toHaveBeenCalledTimes(2);
    expect(acks(sent)).toEqual([
      { type: 'ack', recordingId: 'r1', uptoIdx: 1, uptoOffset: 8 },
      { type: 'ack', recordingId: 'r1', uptoIdx: 2, uptoOffset: 12 },
    ]);
  });

  it('latches a dead journal and sends the fallback ack when the warning throws', async () => {
    const journal = fakeJournalFile();
    journal.commit = vi.fn(() => {
      journal.dead = true;
      return Promise.resolve();
    });
    const sent: string[] = [];
    const onWarn = vi.fn(() => {
      throw new Error('the notice could not be shown');
    });
    const r = receiver(journal, sent, onWarn);

    await deliver(r, 0, 0);
    vi.advanceTimersByTime(CHUNK_TIMESLICE_MS);
    await deliver(r, 1, 4);
    await settle();
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(acks(sent)).toEqual([
      { type: 'ack', recordingId: 'r1', uptoIdx: 1, uptoOffset: 8 },
    ]);

    vi.advanceTimersByTime(CHUNK_TIMESLICE_MS);
    await deliver(r, 2, 8);
    await settle();
    expect(journal.commit).toHaveBeenCalledTimes(1);
    expect(onWarn).toHaveBeenCalledTimes(1);
  });
});
