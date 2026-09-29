import { describe, it, expect } from 'vitest';
import { ChunkSender } from '@/lib/chunk-sender';
import { ChunkReceiver } from '@/lib/chunk-receiver';
import { DC_MAX_MESSAGE_BYTES, decodeChunkHeader, type ChunkHeader } from '@openmeet/protocol';
import type { FileWriter } from '@/lib/fs-writer';

/**
 * Every real chunk exceeds the SCTP max-message-size, so this path never worked
 * for actual recordings:
 *
 *   1080p video, 2s timeslice -> ~1,221 KiB
 *   4K video,    2s timeslice -> ~6,104 KiB
 *   24-bit/48k stereo WAV     -> ~562 KiB
 *   Chrome's negotiated limit -> 256 KiB
 *
 * Live it surfaced as:
 *   TypeError: Failed to execute 'send' on 'RTCDataChannel':
 *   Trying to send message larger than max-message-size
 */

/** Rejects oversized sends exactly the way a real RTCDataChannel does. */
class StrictChannel {
  readyState = 'open';
  bufferedAmount = 0;
  sent: (string | ArrayBuffer)[] = [];
  constructor(private max = DC_MAX_MESSAGE_BYTES) {}
  send(d: string | ArrayBuffer) {
    const size = typeof d === 'string' ? d.length : d.byteLength;
    if (size > this.max) {
      throw new TypeError(
        "Failed to execute 'send' on 'RTCDataChannel': Trying to send message larger than max-message-size"
      );
    }
    this.sent.push(d);
  }
}

function payload(size: number, seed = 1): ArrayBuffer {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = (i * seed + 7) & 0xff;
  return b.buffer;
}

const chunkOf = (idx: number, offset: number, buf: ArrayBuffer) => ({
  header: { idx, offset, size: buf.byteLength, ts: 1 } as ChunkHeader,
  payload: buf,
});

describe('oversized chunk transport', () => {
  it('does not throw on a 1080p-sized chunk', () => {
    const ch = new StrictChannel();
    const s = new ChunkSender({ recordingId: 'r', channel: ch as unknown as RTCDataChannel });
    expect(() => s.sendChunk(chunkOf(0, 0, payload(1_250_000)))).not.toThrow();
  });

  it('keeps every individual send within the limit', () => {
    const ch = new StrictChannel();
    const s = new ChunkSender({ recordingId: 'r', channel: ch as unknown as RTCDataChannel });
    s.sendChunk(chunkOf(0, 0, payload(1_250_000)));
    for (const m of ch.sent) {
      const size = typeof m === 'string' ? m.length : m.byteLength;
      expect(size).toBeLessThanOrEqual(DC_MAX_MESSAGE_BYTES);
    }
  });

  it('still pairs each header with exactly one payload', () => {
    const ch = new StrictChannel();
    const s = new ChunkSender({ recordingId: 'r', channel: ch as unknown as RTCDataChannel });
    s.sendChunk(chunkOf(0, 0, payload(200_000)));
    expect(ch.sent.length % 2).toBe(0);
    for (let i = 0; i < ch.sent.length; i += 2) {
      expect(typeof ch.sent[i]).toBe('string');
      expect(ch.sent[i + 1]).toBeInstanceOf(ArrayBuffer);
    }
  });

  it('emits strictly increasing idx and contiguous offsets', () => {
    const ch = new StrictChannel();
    const s = new ChunkSender({ recordingId: 'r', channel: ch as unknown as RTCDataChannel });
    s.sendChunk(chunkOf(0, 0, payload(300_000)));
    s.sendChunk(chunkOf(1, 300_000, payload(300_000)));

    let lastIdx = -1;
    let expectedOffset = 0;
    for (let i = 0; i < ch.sent.length; i += 2) {
      const h = decodeChunkHeader(ch.sent[i] as string)!;
      expect(h.idx).toBeGreaterThan(lastIdx);
      lastIdx = h.idx;
      expect(h.offset).toBe(expectedOffset);
      expect(h.size).toBe((ch.sent[i + 1] as ArrayBuffer).byteLength);
      expectedOffset += h.size;
    }
    expect(expectedOffset).toBe(600_000);
  });

  // The property that actually matters: the file on the host's disk is
  // byte-identical to what the guest recorded.
  it('reassembles byte-exactly through a real ChunkReceiver', async () => {
    const ch = new StrictChannel();
    const s = new ChunkSender({ recordingId: 'r', channel: ch as unknown as RTCDataChannel });

    const disk = new Uint8Array(1_000_000);
    let highWater = 0;
    const writer = {
      write: async (position: number, data: ArrayBuffer) => {
        disk.set(new Uint8Array(data), position);
        highWater = Math.max(highWater, position + data.byteLength);
      },
    } as unknown as FileWriter;
    const r = new ChunkReceiver({ recordingId: 'r', writer, sendControl: () => {} });

    const original = payload(900_000, 3);
    s.sendChunk(chunkOf(0, 0, original));

    for (const m of ch.sent) await r.handleMessage(m);

    expect(highWater).toBe(900_000);
    expect(Array.from(disk.slice(0, 900_000))).toEqual(Array.from(new Uint8Array(original)));
    // Both digests cover the same byte sequence, so integrity still verifies.
    expect(await r.digestHex()).toBe(await s.digestHex());
  });

  it('handles a payload that is an exact multiple of the limit', async () => {
    const ch = new StrictChannel();
    const s = new ChunkSender({ recordingId: 'r', channel: ch as unknown as RTCDataChannel });
    s.sendChunk(chunkOf(0, 0, payload(DC_MAX_MESSAGE_BYTES * 3)));
    expect(ch.sent.length).toBe(6); // 3 fragments, no empty trailing one
  });

  it('leaves a small chunk as a single frame pair', () => {
    const ch = new StrictChannel();
    const s = new ChunkSender({ recordingId: 'r', channel: ch as unknown as RTCDataChannel });
    s.sendChunk(chunkOf(0, 0, payload(1024)));
    expect(ch.sent.length).toBe(2);
  });
});
