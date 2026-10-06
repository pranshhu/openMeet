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
