import { describe, it, expect, vi } from 'vitest';
import { phaseOnPeerLeft, phaseOnPeerJoined, type RoomPhase } from '@/hooks/useRoom';
import { FileWriter } from '@/lib/fs-writer';
import { ChunkSender } from '@/lib/chunk-sender';

/**
 * Regression cover for the ways an in-progress recording used to be destroyed.
 * Each of these was a silent, total loss of the user's file.
 */

describe('phaseOnPeerLeft', () => {
  it('holds the phase while recording — the peer disconnecting must not end it', () => {
    // The Durable Object broadcasts peer-left on ANY socket close: a wifi blip,
    // a sleeping laptop, a tab refresh. Moving to 'peer-left' unmounts
    // CallStage, which removes the only button that closes the file handle.
    expect(phaseOnPeerLeft('recording')).toBe('recording');
    expect(phaseOnPeerLeft('finalizing')).toBe('finalizing');
  });

  it('holds done phase so backup download remains accessible', () => {
    expect(phaseOnPeerLeft('done')).toBe('done');
  });

  it('still leaves the call when nothing is being recorded', () => {
    for (const p of ['in-call', 'connecting', 'waiting'] as RoomPhase[]) {
      expect(phaseOnPeerLeft(p)).toBe('peer-left');
    }
  });
});

describe('phaseOnPeerJoined', () => {
  it('recovers from peer-left when the peer comes back', () => {
    // Previously a permanent dead end: the host stayed on "you can close this
    // tab" even after the guest reconnected.
    expect(phaseOnPeerJoined('peer-left')).toBe('connecting');
  });

  it('leaves the waiting room', () => {
    expect(phaseOnPeerJoined('waiting')).toBe('connecting');
  });

  it('never downgrades an active call', () => {
    for (const p of ['in-call', 'recording', 'finalizing'] as RoomPhase[]) {
      expect(phaseOnPeerJoined(p)).toBe(p);
    }
  });
});

describe('FileWriter write-chain poisoning', () => {
  it('keeps accepting writes after one fails', async () => {
    // writeTail used to BE the rejected promise, so every later write inherited
    // the rejection: one transient error silently ended the recording while the
    // UI kept showing "Recording".
    let failNext = true;
    const written: number[] = [];
    const writable = {
      write: vi.fn().mockImplementation(({ position }: { position: number }) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('transient'));
        }
        written.push(position);
        return Promise.resolve();
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const handle = { createWritable: vi.fn().mockResolvedValue(writable), name: 'h.mp4' };
    const fw = new FileWriter({ picker: vi.fn().mockResolvedValue(handle) });
    await fw.openFile('h.mp4');

    // The caller still sees the real failure...
    await expect(fw.write(0, new ArrayBuffer(4))).rejects.toThrow('transient');
    // ...but the writer is not dead.
    await fw.write(100, new ArrayBuffer(4));
    await fw.write(200, new ArrayBuffer(4));
    expect(written).toEqual([100, 200]);
  });
});

describe('ChunkSender ack handling', () => {
  it('truncates on an ack even though the peers use different recordingIds', () => {
    // Host and guest each mint their own crypto.randomUUID() for the same
    // recording, so the old `msg.recordingId === this.recordingId` guard never
    // matched: every ack was discarded and the retransmit buffer never drained.
    const channel = {
      readyState: 'open',
      bufferedAmount: 0,
      send: vi.fn(),
    } as unknown as RTCDataChannel;

    const sender = new ChunkSender({ recordingId: 'guest-side-uuid', channel });
    for (let i = 0; i < 4; i++) {
      sender.sendChunk({
        header: { idx: i, offset: i * 10, size: 10, ts: 0 },
        payload: new ArrayBuffer(10),
      });
    }

    sender.handleControl({
      type: 'ack',
      recordingId: 'host-side-uuid', // deliberately different
      uptoIdx: 2,
      uptoOffset: 30,
    });

    expect(sender.lastAckedIdx).toBe(2);
  });
});
