import { describe, it, expect, vi } from 'vitest';
import {
  bindGuestChannel,
  rebindGuestRecording,
  type RecordingHandles,
} from '@/hooks/recording-controller';
import { ChunkSender } from '@/lib/chunk-sender';
import type { PeerConnection } from '@/lib/peer';

class FakeChannel {
  readyState = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;
  sent: (string | ArrayBuffer)[] = [];
  listeners: Record<string, (() => void)[]> = {};

  addEventListener(event: string, handler: () => void) {
    (this.listeners[event] ??= []).push(handler);
  }

  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }

  open() {
    this.readyState = 'open';
    for (const h of this.listeners['open'] ?? []) {
      h();
    }
  }
}

class FakePeer {
  cameraChannel: FakeChannel | null = null;
  audioChannel: FakeChannel | null = null;
  cameraChannelsCreated: FakeChannel[] = [];
  audioChannelsCreated: FakeChannel[] = [];

  createRecordingChannel(): RTCDataChannel {
    const ch = new FakeChannel();
    this.cameraChannelsCreated.push(ch);
    this.cameraChannel = ch;
    return ch as unknown as RTCDataChannel;
  }

  createRecordingAudioChannel(): RTCDataChannel {
    const ch = new FakeChannel();
    this.audioChannelsCreated.push(ch);
    this.audioChannel = ch;
    return ch as unknown as RTCDataChannel;
  }
}

describe('rebindGuestRecording', () => {
  it('creates a new camera channel, rebinds existing sender, and sends resume_query on open (no WAV)', () => {
    const peer = new FakePeer();
    const oldCamChannel = new FakeChannel();
    oldCamChannel.readyState = 'open';

    const sender = new ChunkSender({
      recordingId: 'rec-camera-only',
      channel: oldCamChannel as unknown as RTCDataChannel,
    });
    const rebindSpy = vi.spyOn(sender, 'rebind');

    const h: RecordingHandles = {
      recordingId: 'rec-camera-only',
      sender,
      channel: oldCamChannel as unknown as RTCDataChannel,
    };

    rebindGuestRecording(h, peer as unknown as PeerConnection);

    // Creates new camera channel, does not create WAV channel
    expect(peer.cameraChannelsCreated).toHaveLength(1);
    expect(peer.audioChannelsCreated).toHaveLength(0);

    const newCam = peer.cameraChannel!;
    expect(h.channel).toBe(newCam);

    // Existing sender retained (same object identity) and rebound
    expect(h.sender).toBe(sender);
    expect(rebindSpy).toHaveBeenCalledWith(newCam);

    // Before open, no resume_query is sent
    expect(newCam.sent).toHaveLength(0);

    // On open, sends resume_query
    newCam.open();
    expect(newCam.sent).toEqual([
      JSON.stringify({ type: 'resume_query', recordingId: 'rec-camera-only' }),
    ]);

    // Guest channel bindings wired
    expect(newCam.onmessage).toBeTypeOf('function');
    expect(newCam.bufferedAmountLowThreshold).toBe(8 * 1024 * 1024);
  });

  it('creates new camera and WAV channels, rebinds existing senders, and sends resume_query on each when opened', () => {
    const peer = new FakePeer();
    const oldCam = new FakeChannel();
    const oldWav = new FakeChannel();

    const sender = new ChunkSender({
      recordingId: 'rec-dual',
      channel: oldCam as unknown as RTCDataChannel,
    });
    const wavSender = new ChunkSender({
      recordingId: 'rec-dual',
      channel: oldWav as unknown as RTCDataChannel,
    });
    const senderRebindSpy = vi.spyOn(sender, 'rebind');
    const wavSenderRebindSpy = vi.spyOn(wavSender, 'rebind');

    const h: RecordingHandles = {
      recordingId: 'rec-dual',
      sender,
      channel: oldCam as unknown as RTCDataChannel,
      wavSender,
      wavChannel: oldWav as unknown as RTCDataChannel,
    };

    rebindGuestRecording(h, peer as unknown as PeerConnection);

    expect(peer.cameraChannelsCreated).toHaveLength(1);
    expect(peer.audioChannelsCreated).toHaveLength(1);

    const newCam = peer.cameraChannel!;
    const newWav = peer.audioChannel!;
    expect(h.channel).toBe(newCam);
    expect(h.wavChannel).toBe(newWav);

    // Same object identities preserved
    expect(h.sender).toBe(sender);
    expect(h.wavSender).toBe(wavSender);
    expect(senderRebindSpy).toHaveBeenCalledWith(newCam);
    expect(wavSenderRebindSpy).toHaveBeenCalledWith(newWav);

    // Fire open on camera channel
    newCam.open();
    expect(newCam.sent).toEqual([
      JSON.stringify({ type: 'resume_query', recordingId: 'rec-dual' }),
    ]);
    expect(newWav.sent).toHaveLength(0);

    // Fire open on WAV channel
    newWav.open();
    expect(newWav.sent).toEqual([
      JSON.stringify({ type: 'resume_query', recordingId: 'rec-dual' }),
    ]);

    // Both channels bound
    expect(newCam.onmessage).toBeTypeOf('function');
    expect(newWav.onmessage).toBeTypeOf('function');
  });

  // The host's lastIdx is its own number, so it can be nonsense or out of
  // range. `resume` rebuilds the whole queue from it, and a value that is not
  // an index would empty the queue and lose every chunk still waiting.
  it('resumes the sender only for a resume_offset it can use', () => {
    const peer = new FakePeer();
    const oldCam = new FakeChannel();
    oldCam.readyState = 'open';

    const sender = new ChunkSender({
      recordingId: 'rec-bad-resume',
      channel: oldCam as unknown as RTCDataChannel,
    });
    // One chunk the host never acked, so the sender can still replay it.
    sender.sendChunk({ header: { idx: 0, offset: 0, size: 4, ts: 0 }, payload: new Uint8Array([1, 2, 3, 4]).buffer });
    const resumeSpy = vi.spyOn(sender, 'resume');

    const h: RecordingHandles = {
      recordingId: 'rec-bad-resume',
      sender,
      channel: oldCam as unknown as RTCDataChannel,
    };
    rebindGuestRecording(h, peer as unknown as PeerConnection);
    const ch = peer.cameraChannel!;

    ch.onmessage!({
      data: JSON.stringify({ type: 'resume_offset', recordingId: 'r', lastByte: 0, lastIdx: -1 }),
    } as MessageEvent);
    expect(resumeSpy).toHaveBeenCalledWith(-1);

    for (const lastIdx of ['1', 1.5, -2, 1000, Number.MAX_SAFE_INTEGER]) {
      ch.onmessage!({
        data: JSON.stringify({ type: 'resume_offset', recordingId: 'r', lastByte: 0, lastIdx }),
      } as MessageEvent);
    }
    ch.onmessage!({
      data: JSON.stringify({ type: 'resume_offset', recordingId: 'r', lastByte: 0 }),
    } as MessageEvent);

    expect(resumeSpy).toHaveBeenCalledTimes(1);
    // A rejected value must not rebuild the queue: the unacked chunk is still
    // here for the next resume or the drain that follows the rebind.
    expect(sender.hasQueuedChunks).toBe(true);
  });

  it('resumes the sender for a positive lastIdx from a host that has written fragments', () => {
    const peer = new FakePeer();
    const oldCam = new FakeChannel();
    oldCam.readyState = 'open';

    const sender = new ChunkSender({
      recordingId: 'rec-pos-resume',
      channel: oldCam as unknown as RTCDataChannel,
    });
    for (let i = 0; i < 7; i++) {
      sender.sendChunk({ header: { idx: 0, offset: i * 4, size: 4, ts: 0 }, payload: new Uint8Array([1, 2, 3, 4]).buffer });
    }
    const resumeSpy = vi.spyOn(sender, 'resume');

    const h: RecordingHandles = {
      recordingId: 'rec-pos-resume',
      sender,
      channel: oldCam as unknown as RTCDataChannel,
    };
    rebindGuestRecording(h, peer as unknown as PeerConnection);
    const ch = peer.cameraChannel!;

    ch.onmessage!({
      data: JSON.stringify({ type: 'resume_offset', recordingId: 'r', lastByte: 20, lastIdx: 5 }),
    } as MessageEvent);
    expect(resumeSpy).toHaveBeenCalledWith(5);
    expect(sender.hasQueuedChunks).toBe(true);

    // A lastIdx equal to sender.lastSentIdx is accepted when the host has written
    // every fragment the sender put on the wire.
    ch.onmessage!({
      data: JSON.stringify({ type: 'resume_offset', recordingId: 'r', lastByte: 28, lastIdx: 6 }),
    } as MessageEvent);
    expect(resumeSpy).toHaveBeenCalledWith(6);
  });

  // Every ack carries the host's take id. Reading it is what lets a repeat of
  // that take be told apart from a new one.
  it('follows the ack recording id and ignores anything that is not a short string', () => {
    const sender = new ChunkSender({
      recordingId: 'rec-take-id',
      channel: new FakeChannel() as unknown as RTCDataChannel,
    });
    const ch = new FakeChannel();
    const seen: string[] = [];
    bindGuestChannel(ch as unknown as RTCDataChannel, sender, undefined, (id) => seen.push(id));

    ch.onmessage!({
      data: JSON.stringify({ type: 'ack', recordingId: 'host-take-1', uptoIdx: 0, uptoOffset: 0 }),
    } as MessageEvent);
    const id64 = 'x'.repeat(64);
    ch.onmessage!({
      data: JSON.stringify({ type: 'ack', recordingId: id64, uptoIdx: 0, uptoOffset: 0 }),
    } as MessageEvent);
    expect(seen).toEqual(['host-take-1', id64]);

    for (const recordingId of [true, ['bad'], null, undefined, 1e308, NaN, -999, {}, 7, 'x'.repeat(65)]) {
      ch.onmessage!({
        data: JSON.stringify({ type: 'ack', recordingId, uptoIdx: 0, uptoOffset: 0 }),
      } as MessageEvent);
    }
    ch.onmessage!({ data: JSON.stringify({ type: 'ack', uptoIdx: 0, uptoOffset: 0 }) } as MessageEvent);
    expect(seen).toEqual(['host-take-1', id64]);

    // An ack the sender itself rejects (an index it never sent) still carries
    // the host's take: observing the id is not part of the sender's handling.
    ch.onmessage!({
      data: JSON.stringify({ type: 'ack', recordingId: 'stale-take', uptoIdx: 9999, uptoOffset: 0 }),
    } as MessageEvent);
    expect(seen).toEqual(['host-take-1', id64, 'stale-take']);
  });

  it('keeps following the ack id on both channels after a rebind', () => {
    const peer = new FakePeer();
    const oldCam = new FakeChannel();
    const oldWav = new FakeChannel();
    const sender = new ChunkSender({
      recordingId: 'rec-rebind-id',
      channel: oldCam as unknown as RTCDataChannel,
    });
    const wavSender = new ChunkSender({
      recordingId: 'rec-rebind-id',
      channel: oldWav as unknown as RTCDataChannel,
    });
    const seen: string[] = [];
    const h: RecordingHandles = {
      recordingId: 'rec-rebind-id',
      sender,
      channel: oldCam as unknown as RTCDataChannel,
      wavSender,
      wavChannel: oldWav as unknown as RTCDataChannel,
      onHostTakeId: (id) => seen.push(id),
    };

    rebindGuestRecording(h, peer as unknown as PeerConnection);

    peer.cameraChannel!.onmessage!({
      data: JSON.stringify({ type: 'ack', recordingId: 'cam-take', uptoIdx: 0, uptoOffset: 0 }),
    } as MessageEvent);
    peer.audioChannel!.onmessage!({
      data: JSON.stringify({ type: 'ack', recordingId: 'wav-take', uptoIdx: 0, uptoOffset: 0 }),
    } as MessageEvent);
    expect(seen).toEqual(['cam-take', 'wav-take']);
  });
});
