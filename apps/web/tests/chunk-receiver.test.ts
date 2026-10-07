import { describe, it, expect, vi } from 'vitest';
import { ChunkReceiver } from '@/lib/chunk-receiver';
import { encodeChunkHeader } from '@openmeet/protocol';

function fakeWriter() {
  return { write: vi.fn().mockResolvedValue(undefined), fileName: 'guest.mp4' };
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
    await r.handleMessage(encodeChunkHeader({ idx: 3, offset: 30, size: 10, ts: 1 }));
    await r.handleMessage(new Uint8Array(10).buffer);
    sent.length = 0;
    await r.handleMessage(JSON.stringify({ type: 'resume_query', recordingId: 'r1' }));
    const ro = sent.map((s) => JSON.parse(s)).find((m) => m.type === 'resume_offset');
    expect(ro).toMatchObject({ type: 'resume_offset', recordingId: 'r1', lastIdx: 3, lastByte: 40 });
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

    // Without a bound, the resume answer still reports the declared size.
    expect(r.lastOffsetValue).toBe(5);
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
