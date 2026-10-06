import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PeerConnection, ConnectionTimeoutError } from '@/lib/peer';
import {
  setupJoinerNegotiation,
  startConnectWatchdog,
  phaseOnConnectionStateChange,
  phaseOnRemoteStream,
  recordingErrorMessage,
  applyRemotePeerPresence,
  removeRemotePeer,
  type RemotePeer,
} from '@/hooks/useRoom';
import { startGuestRecording } from '@/hooks/recording-controller';
import { BackupRecorder } from '@/lib/backup-recorder';

class FakePC {
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  signalingState = 'stable';
  senders: {
    track: unknown;
    getParameters: () => RTCRtpSendParameters;
    setParameters: (p: RTCRtpSendParameters) => Promise<void>;
    params: RTCRtpSendParameters;
  }[] = [];
  transceivers: { trackOrKind: unknown; init?: RTCRtpTransceiverInit }[] = [];
  ontrack: ((ev: { streams: MediaStream[] }) => void) | null = null;
  onicecandidate: ((ev: { candidate: RTCIceCandidate | null }) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState: RTCPeerConnectionState = 'new';
  restartedIceCount = 0;
  channels: { label: string; opts?: unknown }[] = [];
  operations: string[] = [];

  createDataChannel(label: string, opts?: unknown) {
    this.operations.push(`createDataChannel:${label}`);
    const ch = { label, opts };
    this.channels.push(ch);
    return ch as unknown as RTCDataChannel;
  }

  addTrack(track: unknown) {
    this.operations.push('addTrack');
    const sender = {
      track,
      params: { encodings: [] } as unknown as RTCRtpSendParameters,
      getParameters() { return this.params; },
      async setParameters(p: RTCRtpSendParameters) { this.params = p; },
    };
    this.senders.push(sender);
  }

  addTransceiver(trackOrKind: unknown, init?: RTCRtpTransceiverInit) {
    this.operations.push('addTransceiver');
    const t = init !== undefined ? { trackOrKind, init } : { trackOrKind };
    this.transceivers.push(t);
    return t as unknown as RTCRtpTransceiver;
  }

  getSenders() { return this.senders; }
  removeTrack(sender: unknown) { this.senders = this.senders.filter((s) => s !== sender); }

  async setLocalDescription(desc?: { type: string; sdp: string }) {
    this.localDescription = desc ?? { type: 'offer', sdp: 'local-offer' };
    this.signalingState = this.localDescription.type === 'offer' ? 'have-local-offer' : 'stable';
  }

  async setRemoteDescription(desc: { type: string; sdp: string }) {
    this.remoteDescription = desc;
    this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
  }

  restartIce() {
    this.restartedIceCount++;
  }

  async addIceCandidate(_c: unknown) {}
  close() {
    this.connectionState = 'closed';
  }
}

function fakeStream(id = 'stream-1'): MediaStream {
  const audioTrack = { id: 'a1', kind: 'audio' } as unknown as MediaStreamTrack;
  const videoTrack = { id: 'v1', kind: 'video', contentHint: '' } as unknown as MediaStreamTrack;
  return {
    id,
    getTracks: () => [audioTrack, videoTrack],
    getVideoTracks: () => [videoTrack],
    getAudioTracks: () => [audioTrack],
  } as unknown as MediaStream;
}

function setupPeer(polite = false) {
  const sent: unknown[] = [];
  const pc = new FakePC();
  const peer = new PeerConnection({
    polite,
    iceServers: [],
    sendSignal: (m) => sent.push(m),
    onRemoteStream: vi.fn(),
    pcFactory: () => pc as unknown as RTCPeerConnection,
  });
  return { peer, pc, sent };
}

describe('Mesh connection negotiation: one offerer per pair', () => {
  it("does not add an existing peer's tracks before answering the first offer, and adds them right after", async () => {
    const { peer, pc, sent } = setupPeer(true);
    peer.start();

    const stream = fakeStream();
    peer.setLocalStreamAfterFirstOffer(stream);

    // Before receiving an offer, no tracks are added yet
    expect(pc.getSenders().length).toBe(0);

    // The remote joiner sends an offer
    await peer.handleSignal({
      type: 'webrtc-offer',
      sdp: 'remote-offer-sdp',
      from: 'guest',
      fromPeerId: 'p-guest',
    });

    // The existing peer answered the offer
    expect(sent.some((m) => (m as { type: string }).type === 'webrtc-answer')).toBe(true);

    // Right after sending the answer, local tracks were added to pc
    expect(pc.getSenders().length).toBe(2);
  });

  it('a producer joiner creates recvonly transceivers on each peer connection', () => {
    const { peer, pc } = setupPeer(false);
    peer.start();

    const stream = fakeStream();
    setupJoinerNegotiation([peer], true, stream);

    expect(pc.transceivers).toHaveLength(2);
    expect(pc.transceivers[0]).toEqual({ trackOrKind: 'audio', init: { direction: 'recvonly' } });
    expect(pc.transceivers[1]).toEqual({ trackOrKind: 'video', init: { direction: 'recvonly' } });
    expect(pc.getSenders()).toHaveLength(0);
  });

  it('a non-producer joiner adds local tracks directly', () => {
    const { peer, pc } = setupPeer(false);
    peer.start();

    const stream = fakeStream();
    setupJoinerNegotiation([peer], false, stream);

    expect(pc.transceivers).toHaveLength(0);
    expect(pc.getSenders()).toHaveLength(2);
  });

  it('a non-producer joiner sharing screen adds both camera and screen tracks', () => {
    const { peer, pc } = setupPeer(false);
    peer.start();

    const stream = fakeStream();
    const screenStream = fakeStream('screen');
    setupJoinerNegotiation([peer], false, stream, screenStream);

    expect(pc.transceivers).toHaveLength(0);
    expect(pc.getSenders()).toHaveLength(4);
  });

  it('a rejoining peer receives screen tracks after answering the first offer', async () => {
    const { peer, pc } = setupPeer(false);
    peer.start();

    const stream = fakeStream();
    const screenStream = fakeStream('screen');
    peer.setLocalStreamAfterFirstOffer(stream, screenStream);

    expect(pc.getSenders()).toHaveLength(0);

    await peer.handleSignal({
      type: 'webrtc-offer',
      sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n',
      from: 'guest',
      fromPeerId: 'p-guest',
    });

    expect(pc.getSenders()).toHaveLength(4);
  });

  it('setupJoinerNegotiation creates a control data channel before adding tracks, once per peer even if called twice', () => {
    const { peer, pc } = setupPeer(false);
    peer.start();

    const stream = fakeStream();
    setupJoinerNegotiation([peer], false, stream);

    expect(pc.channels).toHaveLength(1);
    expect(pc.channels[0]!.label).toBe('control');
    expect(pc.operations[0]).toBe('createDataChannel:control');
    expect(pc.operations.slice(1)).toEqual(['addTrack', 'addTrack']);

    // Calling it again on the same peer does not create another channel
    setupJoinerNegotiation([peer], false, stream);
    expect(pc.channels).toHaveLength(1);
  });

  it('setupJoinerNegotiation creates a control data channel before adding transceivers for a producer, once per peer even if called twice', () => {
    const { peer, pc } = setupPeer(false);
    peer.start();

    const stream = fakeStream();
    setupJoinerNegotiation([peer], true, stream);

    expect(pc.channels).toHaveLength(1);
    expect(pc.channels[0]!.label).toBe('control');
    expect(pc.operations[0]).toBe('createDataChannel:control');
    expect(pc.operations.slice(1)).toEqual(['addTransceiver', 'addTransceiver']);

    // Calling it again on the same peer does not create another channel
    setupJoinerNegotiation([peer], true, stream);
    expect(pc.channels).toHaveLength(1);
  });

  it('setupJoinerNegotiation creates a control data channel on each peer connection before tracks', () => {
    const { peer: peer1, pc: pc1 } = setupPeer(false);
    const { peer: peer2, pc: pc2 } = setupPeer(false);
    peer1.start();
    peer2.start();

    const stream = fakeStream();
    setupJoinerNegotiation([peer1, peer2], false, stream);

    expect(pc1.channels).toHaveLength(1);
    expect(pc1.channels[0]!.label).toBe('control');
    expect(pc1.operations[0]).toBe('createDataChannel:control');

    expect(pc2.channels).toHaveLength(1);
    expect(pc2.channels[0]!.label).toBe('control');
    expect(pc2.operations[0]).toBe('createDataChannel:control');
  });

  it('answering a first offer after setLocalStreamAfterFirstOffer creates no data channel', async () => {
    const { peer, pc } = setupPeer(true);
    peer.start();

    const stream = fakeStream();
    peer.setLocalStreamAfterFirstOffer(stream);

    await peer.handleSignal({
      type: 'webrtc-offer',
      sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n',
      from: 'guest',
      fromPeerId: 'p-guest',
    });

    expect(pc.getSenders().length).toBe(2);
    expect(pc.channels).toHaveLength(0);
  });
});

describe('Connect watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls restartIce after 10 s when not connected and sets warning', () => {
    const { peer, pc } = setupPeer(false);
    peer.start();
    let iceRestarted = false;
    let warning: string | null = null;

    startConnectWatchdog(peer, {
      iceRestarted: () => iceRestarted,
      setIceRestarted: (val) => { iceRestarted = val; },
      onWarn: (msg) => { warning = msg; },
    });

    expect(pc.restartedIceCount).toBe(0);
    expect(warning).toBeNull();

    vi.advanceTimersByTime(9_999);
    expect(pc.restartedIceCount).toBe(0);

    vi.advanceTimersByTime(1);
    expect(pc.restartedIceCount).toBe(1);
    expect(iceRestarted).toBe(true);
    expect(warning).toBe('Connection lost — retrying…');

    // Does not repeat on subsequent intervals
    vi.advanceTimersByTime(10_000);
    expect(pc.restartedIceCount).toBe(1);
  });

  it('does not call restartIce when already connected within 10 s', () => {
    const { peer, pc } = setupPeer(false);
    peer.start();
    let iceRestarted = false;
    let warning: string | null = null;

    pc.connectionState = 'connected';

    startConnectWatchdog(peer, {
      iceRestarted: () => iceRestarted,
      setIceRestarted: (val) => { iceRestarted = val; },
      onWarn: (msg) => { warning = msg; },
    });

    vi.advanceTimersByTime(10_000);
    expect(pc.restartedIceCount).toBe(0);
    expect(warning).toBeNull();
    expect(iceRestarted).toBe(false);
  });

  it('does not call restartIce if ice was already restarted', () => {
    const { peer, pc } = setupPeer(false);
    peer.start();
    let iceRestarted = true;
    let warning: string | null = null;

    startConnectWatchdog(peer, {
      iceRestarted: () => iceRestarted,
      setIceRestarted: (val) => { iceRestarted = val; },
      onWarn: (msg) => { warning = msg; },
    });

    vi.advanceTimersByTime(10_000);
    expect(pc.restartedIceCount).toBe(0);
    expect(warning).toBeNull();
  });
});

describe('PeerConnection.whenConnected with timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with ConnectionTimeoutError after its timeout expires', async () => {
    const { peer } = setupPeer(false);
    peer.start();

    const promise = peer.whenConnected(5_000);
    vi.advanceTimersByTime(5_000);

    await expect(promise).rejects.toThrow(ConnectionTimeoutError);
  });

  it('resolves when connected before timeout', async () => {
    const { peer, pc } = setupPeer(false);
    peer.start();

    const promise = peer.whenConnected(15_000);
    pc.connectionState = 'connected';
    pc.onconnectionstatechange?.();

    await expect(promise).resolves.toBeUndefined();
  });
});

describe('Phase follows connection state', () => {
  it('remote stream arrival does not transition connecting to in-call', () => {
    const nextPhase = phaseOnRemoteStream('connecting');
    expect(nextPhase).toBe('connecting');
  });

  it('connectionState connected transitions connecting to in-call', () => {
    const nextPhase = phaseOnConnectionStateChange('connecting', 'connected');
    expect(nextPhase).toBe('in-call');
  });

  it('terminal phase is preserved on connection connected', () => {
    expect(phaseOnConnectionStateChange('recording', 'connected')).toBe('recording');
    expect(phaseOnConnectionStateChange('finalizing', 'connected')).toBe('finalizing');
    expect(phaseOnConnectionStateChange('done', 'connected')).toBe('done');
  });
});

describe('Guest recording timeout and backup resilience', () => {
  it('maps ConnectionTimeoutError to the exact user-facing notice', () => {
    const err = new ConnectionTimeoutError();
    const msg = recordingErrorMessage(err);
    expect(msg).toBe(
      "Couldn't connect to the host, so your camera isn't reaching their recording. Your in-browser backup is still recording."
    );
  });

  it('startGuestRecording reuses a pre-started backup recorder without restarting it', () => {
    class FakeMediaRecorder {
      static instances: FakeMediaRecorder[] = [];
      static isTypeSupported = () => true;
      ondataavailable: (() => void) | null = null;
      onstop: (() => void) | null = null;
      state = 'inactive';
      startCount = 0;
      constructor(public stream: unknown, public opts: unknown) {
        FakeMediaRecorder.instances.push(this);
      }
      start() {
        this.startCount++;
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
      }
    }
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;

    try {
      const stream = fakeStream();
      const backup = new BackupRecorder({
        mimeType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        stream,
      });
      backup.start();

      const fakeChannel = {
        readyState: 'open',
        addEventListener: vi.fn(),
        send: vi.fn(),
      } as unknown as RTCDataChannel;

      const handles = startGuestRecording({
        recordingId: 'rec-test-1',
        localStream: stream,
        channel: fakeChannel,
        backup,
      });

      expect(handles.backup).toBe(backup);
    } finally {
      delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    }
  });

  it('startGuestRecording keeps the rate the camera reported when it started', () => {
    class FakeMediaRecorder {
      static isTypeSupported = () => true;
      ondataavailable: (() => void) | null = null;
      onstop: (() => void) | null = null;
      state = 'inactive';
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
      }
    }
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;

    try {
      const channel = {
        readyState: 'open',
        addEventListener: vi.fn(),
        send: vi.fn(),
      } as unknown as RTCDataChannel;

      const videoTrack = {
        id: 'v-fps',
        kind: 'video',
        getSettings: () => ({ frameRate: 24 }),
      } as unknown as MediaStreamTrack;
      const streamWithFps = {
        getTracks: () => [videoTrack],
        getVideoTracks: () => [videoTrack],
        getAudioTracks: () => [],
      } as unknown as MediaStream;

      const handlesWithFps = startGuestRecording({
        recordingId: 'rec-fps',
        localStream: streamWithFps,
        channel,
      });
      expect(handlesWithFps.videoFps).toBe(24);

      const handlesNoFps = startGuestRecording({
        recordingId: 'rec-no-fps',
        localStream: fakeStream(),
        channel,
      });
      expect(handlesNoFps.videoFps).toBeUndefined();

      const streamNoVideo = {
        getTracks: () => [],
        getVideoTracks: () => [],
        getAudioTracks: () => [],
      } as unknown as MediaStream;

      const handlesNoVideo = startGuestRecording({
        recordingId: 'rec-no-video',
        localStream: streamNoVideo,
        channel,
      });
      expect(handlesNoVideo.videoFps).toBeUndefined();
    } finally {
      delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    }
  });

  it('sender never pauses the recorder on backpressure or closed channel', () => {
    class FakeMediaRecorder {
      static instances: FakeMediaRecorder[] = [];
      static isTypeSupported = () => true;
      ondataavailable: (() => void) | null = null;
      onstop: (() => void) | null = null;
      state = 'recording';
      paused = false;
      constructor(public stream: unknown, public opts: unknown) {
        FakeMediaRecorder.instances.push(this);
      }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; }
      pause() { this.paused = true; this.state = 'paused'; }
      resume() { this.paused = false; this.state = 'recording'; }
    }
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;

    try {
      const stream = fakeStream();
      const fakeChannel = {
        readyState: 'open',
        bufferedAmount: 17 * 1024 * 1024,
        addEventListener: vi.fn(),
        send: vi.fn(),
      } as unknown as RTCDataChannel;

      const handles = startGuestRecording({
        recordingId: 'rec-test-bp',
        localStream: stream,
        channel: fakeChannel,
      });

      const pauseSpy = vi.spyOn(handles.guestRecorder!, 'pause');

      handles.sender!.sendChunk({
        header: { idx: 0, offset: 0, size: 8, ts: 1 },
        payload: new ArrayBuffer(8),
      });

      expect(pauseSpy).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    }
  });
});

describe('Per-peer presence in mesh calls', () => {
  it('updates only the matching peer presence and leaves other peers untouched', () => {
    const initial: RemotePeer[] = [
      { peerId: 'p-bob', name: 'Bob', stream: null, presence: { micOn: true, camOn: true, screenSharing: false } },
      { peerId: 'p-carol', name: 'Carol', stream: null, presence: { micOn: true, camOn: true, screenSharing: false } },
    ];

    const updated = applyRemotePeerPresence(initial, {
      fromPeerId: 'p-carol',
      micOn: false,
      camOn: false,
      screenSharing: true,
    });

    // Bob is unchanged
    expect(updated.find((p) => p.peerId === 'p-bob')?.presence).toEqual({
      micOn: true,
      camOn: true,
      screenSharing: false,
    });

    // Carol is updated
    expect(updated.find((p) => p.peerId === 'p-carol')?.presence).toEqual({
      micOn: false,
      camOn: false,
      screenSharing: true,
    });
  });

  it('drops the leaving peer entry, clearing their presence and name', () => {
    const peers: RemotePeer[] = [
      { peerId: 'p-bob', name: 'Bob', stream: null, presence: { micOn: true, camOn: true, screenSharing: false } },
      { peerId: 'p-carol', name: 'Carol', stream: null, presence: { micOn: false, camOn: false, screenSharing: true } },
    ];

    const remaining = removeRemotePeer(peers, 'p-carol');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.peerId).toBe('p-bob');
    expect(remaining[0]?.name).toBe('Bob');
    expect(remaining.some((p) => p.peerId === 'p-carol')).toBe(false);
  });
});

