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
  createDataChannel(_label: string) {
    const ch = new FakeChannel();
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

  it('finishes the old screen segment and starts a new one on the rebuilt connection when sharing screen', async () => {
    installMediaRecorder();
    const { peer, pc } = setup();
    const oldChannel = new FakeChannel();
    const sender = new ChunkSender({
      recordingId: 'rec-screen-rebind',
      channel: oldChannel as unknown as RTCDataChannel,
    });
    const fakeScreenStream = {
      getVideoTracks: () => [{ readyState: 'live', getSettings: () => ({ width: 1920, height: 1080 }) }],
      getAudioTracks: () => [],
      getTracks: () => [{ readyState: 'live', getSettings: () => ({ width: 1920, height: 1080 }) }],
    } as unknown as MediaStream;

    const oldScreenRec = {
      stopAndFlush: vi.fn().mockResolvedValue(undefined),
    };
    const h: RecordingHandles = {
      recordingId: 'rec-screen-rebind',
      sender,
      screenSegment: 1,
      screenRecorder: oldScreenRec as any,
    };
    const recordingRef = { current: h };

    const rebindPromise = rebindGuestRecordingWhenConnected(peer, recordingRef, fakeScreenStream);

    // Old screen segment should be stopped
    expect(oldScreenRec.stopAndFlush).toHaveBeenCalled();
    expect(h.screenRecorder).toBeUndefined();

    // Allow stopScreenRecording microtasks to flush so rebindGuestRecordingWhenConnected reaches whenConnected
    await Promise.resolve();
    await Promise.resolve();

    // Now connection reaches connected
    pc.connectionState = 'connected';
    pc.onconnectionstatechange?.();

    await new Promise((r) => setTimeout(r, 10));
    const screenChannel = pc.created.find((ch: any) => ch !== h.channel);
    expect(screenChannel).toBeDefined();

    for (const l of (screenChannel as any).listeners['open'] ?? []) l();
    await rebindPromise;

    expect(h.screenSegment).toBe(2);
    expect(h.screenRecorder).toBeDefined();
  });
});
