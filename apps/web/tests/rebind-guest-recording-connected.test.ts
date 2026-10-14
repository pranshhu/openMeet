import { describe, it, expect, vi } from 'vitest';
import {
  bindGuestChannel,
  rebindGuestRecordingWhenConnected,
  stopScreenRecording,
  type RecordingHandles,
} from '@/hooks/recording-controller';
import { PeerConnection } from '@/lib/peer';
import { ChunkSender } from '@/lib/chunk-sender';

/**
 * Regression cover for the deadlock seen in production (Chrome 154): a WS
 * reconnect rebuilds the guest<->host PeerConnection, and rebindGuestRecording
 * used to recreate the recording DataChannels immediately — often during that
 * new connection's own glare. A DataChannel created before an implicit
 * rollback is never negotiated by Chrome, so the channel sat in 'connecting'
 * forever and the guest silently stopped streaming. The fix waits for the
 * rebuilt connection's first 'connected' before recreating the channels.
 */

class FakeChannel {
  label = '';
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
}

// The real PeerConnection, so whenConnected() is the genuine implementation —
// not a test double standing in for it.
class FakePC {
  connectionState: RTCPeerConnectionState = 'new';
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: unknown = null;
  ontrack: unknown = null;
  onicecandidate: unknown = null;
  onnegotiationneeded: unknown = null;
  signalingState = 'stable';
  localDescription = { sdp: '' };
  created: FakeChannel[] = [];
  createDataChannel(label: string) {
    const ch = new FakeChannel();
    ch.label = label;
    this.created.push(ch);
    return ch as unknown as RTCDataChannel;
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  close() {}
}

function installMediaRecorder() {
  class FakeMR {
    state = 'inactive';
    ondataavailable: ((e: unknown) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
    pause() {}
    resume() {}
  }
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMR;
  (globalThis as { MediaRecorder: { isTypeSupported: (m: string) => boolean } }).MediaRecorder.isTypeSupported =
    () => true;
}

function setup() {
  const pc = new FakePC();
  const peer = new PeerConnection({
    polite: true,
    iceServers: [],
    sendSignal: vi.fn(),
    onRemoteStream: vi.fn(),
    pcFactory: () => pc as unknown as RTCPeerConnection,
  });
  peer.start();
  return { peer, pc };
}

describe('rebindGuestRecordingWhenConnected', () => {
  it('does not recreate the recording channel before the connection is connected', async () => {
    const { peer, pc } = setup();
    const oldChannel = new FakeChannel();
    const sender = new ChunkSender({
      recordingId: 'rec-1',
      channel: oldChannel as unknown as RTCDataChannel,
    });
    const rebindSpy = vi.spyOn(sender, 'rebind');
    const recordingRef = { current: { recordingId: 'rec-1', sender } as RecordingHandles };

    void rebindGuestRecordingWhenConnected(peer, recordingRef);

    // Still 'new': the fix must not have created anything yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(pc.created).toHaveLength(0);
    expect(rebindSpy).not.toHaveBeenCalled();

    // Now the rebuilt connection finishes its first negotiation.
    pc.connectionState = 'connected';
    pc.onconnectionstatechange?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(pc.created).toHaveLength(1);
    expect(rebindSpy).toHaveBeenCalledWith(pc.created[0]);
  });

  it('recreates the channel right away when the connection is already connected', async () => {
    const { peer, pc } = setup();
    pc.connectionState = 'connected';
    pc.onconnectionstatechange?.();

    const oldChannel = new FakeChannel();
    const sender = new ChunkSender({
      recordingId: 'rec-2',
      channel: oldChannel as unknown as RTCDataChannel,
    });
    const recordingRef = { current: { recordingId: 'rec-2', sender } as RecordingHandles };

    await rebindGuestRecordingWhenConnected(peer, recordingRef);

    expect(pc.created).toHaveLength(1);
  });

  it('does not rebind if the recording ended while waiting for the connection', async () => {
    const { peer, pc } = setup();
    const oldChannel = new FakeChannel();
    const sender = new ChunkSender({
      recordingId: 'rec-3',
      channel: oldChannel as unknown as RTCDataChannel,
    });
    const recordingRef = { current: { recordingId: 'rec-3', sender } as RecordingHandles | null };

    const done = rebindGuestRecordingWhenConnected(peer, recordingRef);

    // End & save (or the equivalent) clears the ref before the wait resolves.
    recordingRef.current = null;
    pc.connectionState = 'connected';
    pc.onconnectionstatechange?.();
    await done;

    expect(pc.created).toHaveLength(0);
  });
});

describe('rebindGuestRecordingWhenConnected with a screen share', () => {
  const screenStream = () => {
    const track = { readyState: 'live', getSettings: () => ({ width: 1920, height: 1080 }) };
    return Object.assign(new EventTarget(), {
      getVideoTracks: () => [track],
      getAudioTracks: () => [],
      getTracks: () => [track],
    }) as unknown as MediaStream;
  };

  const chunk = (n: number) => ({
    header: { idx: n, offset: n * 4, size: 4, ts: 100 },
    payload: new Uint8Array(4).fill(n + 1).buffer,
  });

  // A running stretch: a sender on its channel, a recorder, a key and a number.
  function stretch(recordingId: string) {
    const oldChannel = new FakeChannel();
    oldChannel.readyState = 'open';
    const screenSender = new ChunkSender({
      recordingId,
      channel: oldChannel as unknown as RTCDataChannel,
    });
    const recorder = { stopAndFlush: vi.fn().mockResolvedValue(undefined) };
    const h: RecordingHandles = {
      recordingId,
      screenSender,
      screenRecorder: recorder as any,
      screenKey: 'share-key',
      screenSegment: 1,
      screenChannel: oldChannel as unknown as RTCDataChannel,
    };
    return { h, oldChannel, screenSender, recorder };
  }

  const connect = (pc: FakePC) => {
    pc.connectionState = 'connected';
    pc.onconnectionstatechange?.();
  };

  const openChannel = (ch: FakeChannel) => {
    ch.readyState = 'open';
    for (const l of ch.listeners['open'] ?? []) l();
  };

  const sentHeaders = (ch: FakeChannel) =>
    ch.sent.filter((m): m is string => typeof m === 'string').map((m) => JSON.parse(m) as { idx?: number; type?: string });

  it('continues the running stretch on a channel under its own key', async () => {
    // Removal that must fail this test: stopping the stretch before the wait.
    installMediaRecorder();
    const { peer, pc } = setup();
    const { h, screenSender, recorder } = stretch('rec-continue');
    const recordingRef = { current: h };

    const done = rebindGuestRecordingWhenConnected(peer, recordingRef, screenStream());
    connect(pc);
    await done;

    expect(recorder.stopAndFlush).not.toHaveBeenCalled();
    expect(h.screenRecorder).toBe(recorder);
    expect(h.screenSender).toBe(screenSender);
    expect(h.screenSegment).toBe(1);
    expect(pc.created).toHaveLength(1);
    expect(pc.created[0]!.label).toBe('recording-screen-1#share-key');
    expect(h.screenChannel).toBe(pc.created[0]);

    openChannel(pc.created[0]!);
    expect(sentHeaders(pc.created[0]!)).toEqual([{ type: 'resume_query', recordingId: 'rec-continue' }]);
  });

  it('replays from the host answer and sends nothing before it', async () => {
    // Removal that must fail this test: the hold() after the rebind.
    installMediaRecorder();
    const { peer, pc } = setup();
    const { h, oldChannel, screenSender } = stretch('rec-replay');
    screenSender.sendChunk(chunk(0));
    screenSender.sendChunk(chunk(1));
    oldChannel.readyState = 'closed';
    screenSender.sendChunk(chunk(2));
    screenSender.sendChunk(chunk(3));
    const recordingRef = { current: h };

    const done = rebindGuestRecordingWhenConnected(peer, recordingRef, screenStream());
    connect(pc);
    await done;
    const next = pc.created[0]!;
    openChannel(next);
    next.onbufferedamountlow?.();

    expect(sentHeaders(next).filter((m) => m.idx !== undefined)).toEqual([]);

    next.onmessage?.({
      data: JSON.stringify({ type: 'resume_offset', recordingId: 'rec-replay', lastIdx: 1 }),
    } as MessageEvent);

    expect(sentHeaders(next).filter((m) => m.idx !== undefined).map((m) => m.idx)).toEqual([2, 3]);
  });

  it('ends the stretch and starts a new one when its sender has given up', async () => {
    // Removal that must fail this test: the abandoned check before continuing.
    installMediaRecorder();
    const { peer, pc } = setup();
    const { h, screenSender, recorder } = stretch('rec-abandoned');
    screenSender.giveUp();
    const recordingRef = { current: h };

    const done = rebindGuestRecordingWhenConnected(peer, recordingRef, screenStream());
    connect(pc);
    await vi.waitFor(() => expect(pc.created).toHaveLength(1));
    openChannel(pc.created[0]!);
    await done;

    expect(recorder.stopAndFlush).toHaveBeenCalled();
    expect(h.screenSegment).toBe(2);
    expect(h.screenSender).not.toBe(screenSender);
    expect(pc.created[0]!.label).not.toBe('recording-screen-1#share-key');
  });

  it('ends the stretch and starts a new one when another sender holds the handles after the wait', async () => {
    // Removal that must fail this test: comparing the sender with the one at the call.
    installMediaRecorder();
    const { peer, pc } = setup();
    const { h, screenSender, recorder } = stretch('rec-swapped');
    const recordingRef = { current: h };

    const done = rebindGuestRecordingWhenConnected(peer, recordingRef, screenStream());
    h.screenSender = new ChunkSender({
      recordingId: 'rec-swapped',
      channel: new FakeChannel() as unknown as RTCDataChannel,
    });
    connect(pc);
    await vi.waitFor(() => expect(pc.created).toHaveLength(1));
    openChannel(pc.created[0]!);
    await done;

    expect(recorder.stopAndFlush).toHaveBeenCalled();
    expect(h.screenSegment).toBe(2);
    expect(h.screenSender).not.toBe(screenSender);
  });

  it.each([
    ['its recorder is gone', (h: RecordingHandles) => { delete h.screenRecorder; }],
    ['it has no key', (h: RecordingHandles) => { delete h.screenKey; }],
    ['no sender was running at the call', (h: RecordingHandles) => { delete h.screenSender; }],
  ])('ends the stretch and starts a new one when %s', async (_why, spoil) => {
    // Removals that must fail this test: the recorder, the key and the running-sender conditions.
    installMediaRecorder();
    const { peer, pc } = setup();
    const { h } = stretch('rec-spoiled');
    spoil(h);
    const recordingRef = { current: h };

    const done = rebindGuestRecordingWhenConnected(peer, recordingRef, screenStream());
    connect(pc);
    await vi.waitFor(() => expect(pc.created).toHaveLength(1));
    openChannel(pc.created[0]!);
    await done;

    expect(h.screenSegment).toBe(2);
    expect(h.screenRecorder).toBeDefined();
    expect(pc.created[0]!.label).toBe(`recording-screen-1#${h.screenKey}`);
    expect(h.screenKey).not.toBe('share-key');
  });

  it('starts a stretch when none was running at the call', async () => {
    installMediaRecorder();
    const { peer, pc } = setup();
    const h: RecordingHandles = { recordingId: 'rec-idle' };
    const recordingRef = { current: h };

    const done = rebindGuestRecordingWhenConnected(peer, recordingRef, screenStream());
    connect(pc);
    await vi.waitFor(() => expect(pc.created).toHaveLength(1));
    openChannel(pc.created[0]!);
    await done;

    expect(h.screenSegment).toBe(1);
    expect(h.screenRecorder).toBeDefined();
    expect(h.screenKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(pc.created[0]!.label).toBe(`recording-screen-1#${h.screenKey}`);
  });
});

describe('a screen share the host holds less of than it acknowledged', () => {
  const lowAnswer = (lastIdx: unknown) =>
    ({ data: JSON.stringify({ type: 'resume_offset', recordingId: 'rec', lastIdx }) }) as MessageEvent;

  const connect = (pc: FakePC) => {
    pc.connectionState = 'connected';
    pc.onconnectionstatechange?.();
  };

  const openChannel = (ch: FakeChannel) => {
    ch.readyState = 'open';
    for (const l of ch.listeners['open'] ?? []) l();
  };

  const chunkIdxs = (ch: FakeChannel) =>
    ch.sent
      .filter((m): m is string => typeof m === 'string')
      .map((m) => (JSON.parse(m) as { idx?: number }).idx)
      .filter((i): i is number => i !== undefined);

  // Six fragments, the first four on the old channel. `acked` of them are
  // acknowledged by the host before the channel dies; the rest queue.
  async function reconnected(acked: number | null) {
    installMediaRecorder();
    const { peer, pc } = setup();
    const track = { readyState: 'live', getSettings: () => ({ width: 1920, height: 1080 }) };
    const stream = Object.assign(new EventTarget(), {
      getVideoTracks: () => [track],
      getAudioTracks: () => [],
      getTracks: () => [track],
    }) as unknown as MediaStream;
    const oldChannel = new FakeChannel();
    oldChannel.readyState = 'open';
    const screenSender = new ChunkSender({ recordingId: 'rec', channel: oldChannel as unknown as RTCDataChannel });
    const recorder = { stopAndFlush: vi.fn().mockResolvedValue(undefined) };
    const backup = { stop: vi.fn().mockResolvedValue(undefined) };
    const h: RecordingHandles = {
      recordingId: 'rec',
      screenSender,
      screenRecorder: recorder as any,
      screenBackup: backup as any,
      screenKey: 'share-key',
      screenSegment: 1,
      screenChannel: oldChannel as unknown as RTCDataChannel,
    };
    const send = (n: number) =>
      screenSender.sendChunk({
        header: { idx: n, offset: n * 4, size: 4, ts: 100 },
        payload: new Uint8Array(4).fill(n + 1).buffer,
      });
    for (let n = 0; n < 4; n++) send(n);
    if (acked !== null) screenSender.handleControl({ type: 'ack', recordingId: 'rec', uptoIdx: acked, uptoOffset: (acked + 1) * 4 });
    oldChannel.readyState = 'closed';
    send(4);
    send(5);

    const done = rebindGuestRecordingWhenConnected(peer, { current: h }, stream);
    connect(pc);
    await done;
    const next = pc.created[0]!;
    openChannel(next);
    next.onbufferedamountlow?.();
    return { h, pc, next, track, recorder, backup, screenSender };
  }

  it('ends the stretch and starts a new one before anything is replayed', async () => {
    // Removal that must fail this test: the whole low-answer check, which lets fragments 4 and 5 go out at their old offsets.
    const { h, pc, next, recorder, backup } = await reconnected(3);

    next.onmessage?.(lowAnswer(-1));
    await vi.waitFor(() => expect(pc.created).toHaveLength(2));
    openChannel(pc.created[1]!);
    await vi.waitFor(() => expect(h.screenSegment).toBe(2));

    expect(chunkIdxs(next)).toEqual([]);
    expect(recorder.stopAndFlush).toHaveBeenCalledTimes(1);
    expect(pc.created[1]!.label).not.toBe(next.label);
    expect(h.screenBackups).toEqual([backup]);
    expect(h.screenKey).not.toBe('share-key');
  });

  it('asks the stretch to give up before it stops, so no finish message follows', async () => {
    // Removal that must fail this test: the giveUp call on the old sender.
    const { h, pc, next, screenSender } = await reconnected(3);

    next.onmessage?.(lowAnswer(-1));
    await vi.waitFor(() => expect(pc.created).toHaveLength(2));
    openChannel(pc.created[1]!);
    await vi.waitFor(() => expect(h.screenSegment).toBe(2));

    expect(screenSender.isAbandoned).toBe(true);
    expect(screenSender.hasQueuedChunks).toBe(false);
    expect(next.sent.some((m) => typeof m === 'string' && m.includes('recording-finalized'))).toBe(false);
  });

  it('starts one new stretch when the host answers low twice', async () => {
    // Removal that must fail this test: the abandoned check at the head of the low-answer handling.
    const { h, pc, next, recorder } = await reconnected(3);

    next.onmessage?.(lowAnswer(-1));
    next.onmessage?.(lowAnswer(-1));
    await vi.waitFor(() => expect(pc.created).toHaveLength(2));
    openChannel(pc.created[1]!);
    await vi.waitFor(() => expect(h.screenSegment).toBe(2));
    await new Promise((r) => setTimeout(r, 10));

    expect(recorder.stopAndFlush).toHaveBeenCalledTimes(1);
    expect(pc.created).toHaveLength(2);
    expect(h.screenSegment).toBe(2);
  });

  it('replays the whole stretch into the host’s new file when nothing was acknowledged', async () => {
    // Removal that must fail this test: comparing with lastAckedIdx, so that -1 counts as low whatever was acknowledged.
    const { h, pc, next, recorder } = await reconnected(null);

    next.onmessage?.(lowAnswer(-1));

    expect(chunkIdxs(next)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(recorder.stopAndFlush).not.toHaveBeenCalled();
    expect(pc.created).toHaveLength(1);
    expect(h.screenSegment).toBe(1);
  });

  it('continues the file when the host holds exactly what it acknowledged', async () => {
    // Removal that must fail this test: the strict comparison, replaced by one that also fires on equal values.
    const { h, pc, next, recorder } = await reconnected(3);

    next.onmessage?.(lowAnswer(3));

    expect(chunkIdxs(next)).toEqual([4, 5]);
    expect(recorder.stopAndFlush).not.toHaveBeenCalled();
    expect(pc.created).toHaveLength(1);
    expect(h.screenSegment).toBe(1);
  });

  it('ends the stretch when only fragment 0 was acknowledged and the host holds nothing', async () => {
    // Removal that must fail this test: the comparison with lastAckedIdx, loosened to one below it.
    const { h, pc, next, recorder } = await reconnected(0);

    next.onmessage?.(lowAnswer(-1));
    await vi.waitFor(() => expect(pc.created).toHaveLength(2));
    openChannel(pc.created[1]!);
    await vi.waitFor(() => expect(h.screenSegment).toBe(2));

    expect(chunkIdxs(next)).toEqual([]);
    expect(recorder.stopAndFlush).toHaveBeenCalledTimes(1);
    expect(h.screenKey).not.toBe('share-key');
  });

  it('continues the file when the host holds exactly fragment 0 and that was all it acknowledged', async () => {
    // Removal that must fail this test: the strict comparison, replaced by one that also fires on equal values.
    const { h, pc, next, recorder } = await reconnected(0);

    next.onmessage?.(lowAnswer(0));

    expect(chunkIdxs(next)).toEqual([1, 2, 3, 4, 5]);
    expect(recorder.stopAndFlush).not.toHaveBeenCalled();
    expect(pc.created).toHaveLength(1);
    expect(h.screenSegment).toBe(1);
  });

  it.each([['"0"', '0'], ['a fraction', 1.5], ['null', null]])(
    'ignores an answer that is not a whole number: %s',
    async (_why, lastIdx) => {
      // Removal that must fail this test: the safe-integer check of the low-answer handling.
      const { h, pc, next, recorder } = await reconnected(3);

      next.onmessage?.(lowAnswer(lastIdx));
      await new Promise((r) => setTimeout(r, 10));

      expect(chunkIdxs(next)).toEqual([]);
      expect(recorder.stopAndFlush).not.toHaveBeenCalled();
      expect(pc.created).toHaveLength(1);
      expect(h.screenSegment).toBe(1);
    }
  );

  it('does nothing when the stretch has ended by the time the answer arrives', async () => {
    // Removal that must fail this test: the check that the stretch is still the one this channel was made for.
    const { h, pc, next, recorder } = await reconnected(3);
    await stopScreenRecording(h);

    next.onmessage?.(lowAnswer(-1));
    await new Promise((r) => setTimeout(r, 10));

    expect(recorder.stopAndFlush).toHaveBeenCalledTimes(1);
    expect(pc.created).toHaveLength(1);
    expect(h.screenSegment).toBe(1);
    expect(h.screenRecorder).toBeUndefined();
  });

  it('stops the stretch and starts none when the screen is no longer shared', async () => {
    // Removal that must fail this test: the live-track condition before the new stretch starts.
    const { h, pc, next, track, recorder } = await reconnected(3);
    track.readyState = 'ended';

    next.onmessage?.(lowAnswer(-1));
    await vi.waitFor(() => expect(recorder.stopAndFlush).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));

    expect(pc.created).toHaveLength(1);
    expect(h.screenRecorder).toBeUndefined();
    expect(h.screenSender).toBeUndefined();
    expect(h.screenSegment).toBe(1);
  });

  it('leaves a channel that was bound without the check as it is', async () => {
    // Removal that must fail this test: making the check apply to every bound channel.
    const channel = new FakeChannel();
    channel.readyState = 'open';
    const sender = new ChunkSender({ recordingId: 'rec', channel: channel as unknown as RTCDataChannel });
    for (let n = 0; n < 4; n++) {
      sender.sendChunk({
        header: { idx: n, offset: n * 4, size: 4, ts: 100 },
        payload: new Uint8Array(4).fill(n + 1).buffer,
      });
    }
    sender.handleControl({ type: 'ack', recordingId: 'rec', uptoIdx: 3, uptoOffset: 16 });
    const next = new FakeChannel();
    next.readyState = 'open';
    sender.rebind(next as unknown as RTCDataChannel);
    sender.hold();
    sender.sendChunk({
      header: { idx: 4, offset: 16, size: 4, ts: 100 },
      payload: new Uint8Array(4).buffer,
    });
    bindGuestChannel(next as unknown as RTCDataChannel, sender);

    next.onmessage?.(lowAnswer(-1));

    expect(chunkIdxs(next)).toEqual([4]);
  });
});
