import { describe, it, expect, vi } from 'vitest';
import { rebindGuestRecordingWhenConnected, type RecordingHandles } from '@/hooks/recording-controller';
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
