import { describe, it, expect, vi } from 'vitest';
import { PeerConnection, ConnectionTimeoutError } from '@/lib/peer';
import { sendEncoding } from '@/lib/send-quality';

class FakePC {
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  signalingState = 'stable';
  // A real RTCRtpSender always exposes getParameters/setParameters, and
  // PeerConnection now uses them to cap outbound bitrate. The double has to
  // carry them or it stops representing the thing it stands in for.
  senders: {
    track: unknown;
    getParameters: () => RTCRtpSendParameters;
    setParameters: (p: RTCRtpSendParameters) => Promise<void>;
    replaceTrack: (t: unknown) => Promise<void>;
    params: RTCRtpSendParameters;
  }[] = [];
  ontrack: ((ev: { streams: MediaStream[] }) => void) | null = null;
  onicecandidate: ((ev: { candidate: RTCIceCandidate | null }) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState: RTCPeerConnectionState = 'new';
  addTrack(track: unknown) {
    const sender = {
      track,
      params: { encodings: [] } as unknown as RTCRtpSendParameters,
      getParameters() { return this.params; },
      async setParameters(p: RTCRtpSendParameters) { this.params = p; },
      async replaceTrack(t: unknown) { this.track = t; },
    };
    this.senders.push(sender);
  }
  getSenders() { return this.senders; }
  transceivers: { direction: string; receiver: { track: { kind: string } } }[] = [];
  getTransceivers() { return this.transceivers; }
  removeTrack(sender: unknown) { this.senders = this.senders.filter((s) => s !== sender); }
  async setLocalDescription(desc?: { type: string; sdp: string }) {
    this.localDescription = desc ?? { type: 'offer', sdp: 'local-offer' };
    this.signalingState = this.localDescription.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(desc: { type: string; sdp: string }) {
    this.remoteDescription = desc;
    this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async createOffer() { return { type: 'offer', sdp: 'offer-sdp' }; }
  async createAnswer() { return { type: 'answer', sdp: 'answer-sdp' }; }
  async addIceCandidate(_c: unknown) {}
  stats = new Map<string, unknown>();
  async getStats() { return this.stats; }
  close() {}
}

function setup(polite: boolean) {
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

describe('PeerConnection perfect negotiation', () => {
  it('emits an offer over sendSignal on negotiationneeded (impolite host)', async () => {
    const { peer, pc, sent } = setup(false);
    peer.start();
    await pc.onnegotiationneeded?.();
    expect(sent.some((m) => (m as { type: string }).type === 'webrtc-offer')).toBe(true);
  });

  it('forwards local ICE candidates as ice-candidate signals', () => {
    const { peer, pc, sent } = setup(false);
    peer.start();
    pc.onicecandidate?.({ candidate: { candidate: 'cand', toJSON: () => ({ candidate: 'cand' }) } as unknown as RTCIceCandidate });
    expect(sent.some((m) => (m as { type: string }).type === 'ice-candidate')).toBe(true);
  });

  it('answers an inbound offer when stable', async () => {
    const { peer, pc, sent } = setup(true);
    peer.start();
    await peer.handleSignal({ type: 'webrtc-offer', sdp: 'remote-offer', from: 'host', fromPeerId: 'p-host' });
    expect(pc.remoteDescription?.sdp).toBe('remote-offer');
    expect(sent.some((m) => (m as { type: string }).type === 'webrtc-answer')).toBe(true);
  });

  it('applies an inbound answer to a pending local offer', async () => {
    const { peer, pc } = setup(false);
    peer.start();
    await pc.setLocalDescription({ type: 'offer', sdp: 'offer-sdp' });
    await peer.handleSignal({ type: 'webrtc-answer', sdp: 'remote-answer', from: 'guest', fromPeerId: 'p-guest' });
    expect(pc.remoteDescription?.sdp).toBe('remote-answer');
  });

  it('ignores a colliding offer when impolite (glare)', async () => {
    const { peer, pc } = setup(false);
    peer.start();
    await pc.setLocalDescription({ type: 'offer', sdp: 'our-offer' });
    const before = pc.remoteDescription;
    await peer.handleSignal({ type: 'webrtc-offer', sdp: 'their-offer', from: 'guest', fromPeerId: 'p-guest' });
    expect(pc.remoteDescription).toBe(before);
  });
});

describe('PeerConnection screen-share routing', () => {
  function setupScreen() {
    const pc = new FakePC();
    const onRemoteStream = vi.fn();
    const onRemoteScreen = vi.fn();
    const onRemoteScreenEnded = vi.fn();
    const peer = new PeerConnection({
      polite: false,
      iceServers: [],
      sendSignal: () => {},
      onRemoteStream,
      onRemoteScreen,
      onRemoteScreenEnded,
      pcFactory: () => pc as unknown as RTCPeerConnection,
    });
    peer.start();
    return { peer, pc, onRemoteStream, onRemoteScreen, onRemoteScreenEnded };
  }

  function fakeStream(id: string, vt?: { addEventListener: (e: string, cb: () => void) => void }) {
    return { id, getVideoTracks: () => (vt ? [vt] : []) } as unknown as MediaStream;
  }

  it('routes the first remote stream to onRemoteStream (camera)', () => {
    const { pc, onRemoteStream, onRemoteScreen } = setupScreen();
    pc.ontrack?.({ streams: [fakeStream('cam')] });
    expect(onRemoteStream).toHaveBeenCalledOnce();
    expect(onRemoteScreen).not.toHaveBeenCalled();
  });

  it('routes a second distinct stream id to onRemoteScreen, keeps camera intact', () => {
    const { pc, onRemoteStream, onRemoteScreen } = setupScreen();
    pc.ontrack?.({ streams: [fakeStream('cam')] }); // camera (audio)
    pc.ontrack?.({ streams: [fakeStream('cam')] }); // same id -> still camera (video)
    pc.ontrack?.({ streams: [fakeStream('screen')] }); // new id -> screen
    expect(onRemoteStream).toHaveBeenCalledTimes(2);
    expect(onRemoteScreen).toHaveBeenCalledOnce();
  });

  it('fires onRemoteScreenEnded when the screen track ends', () => {
    const { pc, onRemoteScreenEnded } = setupScreen();
    let endedCb: (() => void) | null = null;
    const vt = {
      addEventListener: (e: string, cb: () => void) => {
        if (e === 'ended') endedCb = cb;
      },
    };
    pc.ontrack?.({ streams: [fakeStream('cam')] });
    pc.ontrack?.({ streams: [fakeStream('screen', vt)] });
    endedCb!();
    expect(onRemoteScreenEnded).toHaveBeenCalledOnce();
  });

  it('removeTrack removes the matching sender', () => {
    const { peer, pc } = setupScreen();
    const track = { kind: 'video' } as unknown as MediaStreamTrack;
    peer.addTrack(track, fakeStream('s'));
    expect(pc.getSenders().length).toBe(1);
    peer.removeTrack(track);
    expect(pc.getSenders().length).toBe(0);
  });

  it("routes a companion's or producer's stream to the screen callback, never as camera", () => {
    const pc = new FakePC();
    const onRemoteStream = vi.fn();
    const onRemoteScreen = vi.fn();
    const peer = new PeerConnection({
      polite: false,
      iceServers: [],
      sendSignal: () => {},
      onRemoteStream,
      onRemoteScreen,
      screenOnly: true,
      pcFactory: () => pc as unknown as RTCPeerConnection,
    });
    peer.start();
    pc.ontrack?.({ streams: [fakeStream('producer-or-companion-stream')] });
    expect(onRemoteScreen).toHaveBeenCalledOnce();
    expect(onRemoteStream).not.toHaveBeenCalled();
  });
});

describe('PeerConnection.whenConnected', () => {
  it('does not resolve until the connection reports connected', async () => {
    const { peer, pc } = setup(false);
    peer.start();
    let resolved = false;
    void peer.whenConnected().then(() => {
      resolved = true;
    });

    // Still connecting: nothing should have settled the promise.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    pc.connectionState = 'connected';
    pc.onconnectionstatechange?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it('resolves immediately when the connection is already connected', async () => {
    const { peer, pc } = setup(false);
    peer.start();
    pc.connectionState = 'connected';
    pc.onconnectionstatechange?.();
    await expect(peer.whenConnected()).resolves.toBeUndefined();
  });

  it('does not resolve for a transient state like "connecting"', async () => {
    const { peer, pc } = setup(false);
    peer.start();
    let resolved = false;
    void peer.whenConnected().then(() => {
      resolved = true;
    });
    pc.connectionState = 'connecting';
    pc.onconnectionstatechange?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it('rejects with ConnectionTimeoutError when timeout elapses before connected', async () => {
    vi.useFakeTimers();
    try {
      const { peer } = setup(false);
      peer.start();
      const promise = peer.whenConnected(1_000);
      vi.advanceTimersByTime(1_000);
      await expect(promise).rejects.toThrow(ConnectionTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('PeerConnection.replaceAudioTrack', () => {
  const mic = { id: 'mic', kind: 'audio' } as unknown as MediaStreamTrack;
  const cam = { id: 'cam', kind: 'video' } as unknown as MediaStreamTrack;
  const mix = { id: 'mix', kind: 'audio' } as unknown as MediaStreamTrack;
  class FakeStream {
    constructor(private tracks: MediaStreamTrack[]) {}
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }
  }
  const audioSenderId = (pc: FakePC) =>
    (pc.getSenders().find((s) => (s.track as MediaStreamTrack).kind === 'audio')?.track as MediaStreamTrack)?.id;

  it('swaps the track on the live audio sender and leaves video alone', () => {
    const { peer, pc } = setup(false);
    peer.start();
    peer.setLocalStream(new FakeStream([mic, cam]) as unknown as MediaStream);
    peer.replaceAudioTrack(mix);
    expect(audioSenderId(pc)).toBe('mix');
    expect(pc.getSenders().map((s) => (s.track as MediaStreamTrack).id)).toContain('cam');
  });

  it('swaps it in a stream still waiting for the first offer', async () => {
    vi.stubGlobal('MediaStream', FakeStream);
    try {
      const { peer, pc } = setup(true);
      peer.start();
      peer.setLocalStreamAfterFirstOffer(new FakeStream([mic, cam]) as unknown as MediaStream);
      peer.replaceAudioTrack(mix);
      await peer.handleSignal({ type: 'webrtc-offer', sdp: 'joiner-offer', from: 'guest', fromPeerId: 'p-guest' });
      expect(audioSenderId(pc)).toBe('mix');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('PeerConnection.cpuLimited', () => {
  it('is true when the browser reports the video encoder limited by the processor', async () => {
    const { peer, pc } = setup(false);
    peer.start();
    pc.stats.set('audio', { type: 'outbound-rtp', kind: 'audio' });
    pc.stats.set('video', { type: 'outbound-rtp', kind: 'video', qualityLimitationReason: 'cpu' });
    expect(await peer.cpuLimited()).toBe(true);
  });

  it('is false for a bandwidth limit and for an unlimited encoder', async () => {
    const { peer, pc } = setup(false);
    peer.start();
    pc.stats.set('video1', { type: 'outbound-rtp', kind: 'video', qualityLimitationReason: 'bandwidth' });
    pc.stats.set('video2', { type: 'outbound-rtp', kind: 'video', qualityLimitationReason: 'none' });
    pc.stats.set('video3', { type: 'outbound-rtp', kind: 'video', qualityLimitationReason: 'other' });
    expect(await peer.cpuLimited()).toBe(false);
  });

  it('reads as not limited when stats fail, before start and after close', async () => {
    const { peer, pc } = setup(false);
    expect(await peer.cpuLimited()).toBe(false);

    peer.start();
    pc.stats.set('video', { type: 'outbound-rtp', kind: 'video', qualityLimitationReason: 'cpu' });
    pc.getStats = () => Promise.reject(new Error('gone'));
    expect(await peer.cpuLimited()).toBe(false);

    peer.close();
    expect(await peer.cpuLimited()).toBe(false);
  });
});

describe('PeerConnection.setLowPower', () => {
  const mic = { id: 'mic', kind: 'audio' } as unknown as MediaStreamTrack;
  const cam = { id: 'cam', kind: 'video', contentHint: '' } as unknown as MediaStreamTrack;
  class FakeStream {
    constructor(private tracks: MediaStreamTrack[]) {}
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }
  }

  it('applies the low-power cap to the camera already being sent, and restores the normal one exactly', () => {
    const { peer, pc } = setup(false);
    const stream = new FakeStream([mic, cam]) as unknown as MediaStream;
    peer.start();
    peer.setLocalStream(stream);
    const videoSender = pc.getSenders().find((s) => (s.track as MediaStreamTrack).kind === 'video')!;
    expect(videoSender.params.encodings[0]).toEqual(sendEncoding(2, 'camera'));
    peer.setLowPower(true);
    expect(videoSender.params.encodings[0]).toEqual(sendEncoding(2, 'camera', true));
    peer.setLowPower(false);
    expect(videoSender.params.encodings[0]).toEqual(sendEncoding(2, 'camera'));
    const audioSender = pc.getSenders().find((s) => (s.track as MediaStreamTrack).kind === 'audio')!;
    expect(audioSender.params.encodings).toEqual([]);
  });

  it('caps a track that is added while the mode is on', () => {
    const { peer, pc } = setup(false);
    const screenTrack = { kind: 'video', contentHint: '' } as unknown as MediaStreamTrack;
    peer.start();
    peer.setLowPower(true);
    peer.addTrack(screenTrack, {} as MediaStream);
    const videoSender = pc.getSenders().find((s) => (s.track as MediaStreamTrack).kind === 'video')!;
    expect(videoSender.params.encodings[0]?.maxFramerate).toBe(4);
  });
});

describe('PeerConnection.addTrack — what is sent as a screen', () => {
  it('sends a track that carries no hint as a screen, at a screen frame rate', () => {
    const { peer, pc } = setup(false);
    const track = { kind: 'video', contentHint: '' } as unknown as MediaStreamTrack;
    peer.start();
    peer.addTrack(track, {} as MediaStream);
    expect(track.contentHint).toBe('detail');
    const sender = pc.getSenders().find((s) => s.track === track)!;
    expect(sender.params.encodings[0]).toEqual(sendEncoding(2, 'screen'));
  });

  it('sends a presented video, which arrives marked as motion, without the screen frame-rate cap', () => {
    const { peer, pc } = setup(false);
    const clip = { kind: 'video', contentHint: 'motion' } as unknown as MediaStreamTrack;
    peer.start();
    peer.addTrack(clip, {} as MediaStream);
    expect(clip.contentHint).toBe('motion');
    const sender = pc.getSenders().find((s) => s.track === clip)!;
    expect(sender.params.encodings[0]).toEqual(sendEncoding(2, 'camera'));
    expect(sender.params.encodings[0]?.maxFramerate).toBeUndefined();
  });
});

describe('PeerConnection.setIncomingVideoOff', () => {
  const t = (kind: string, direction: string) => ({ direction, receiver: { track: { kind } } });

  // What this side holds in a call where the other person also shares a screen:
  // its own audio and camera, which receive too, and the screen it only receives.
  function inCall() {
    const { peer, pc } = setup(false);
    peer.start();
    pc.transceivers = [t('audio', 'sendrecv'), t('video', 'sendrecv'), t('video', 'recvonly')];
    return { peer, pc, directions: () => pc.transceivers.map((x) => x.direction) };
  }

  it('stops taking the camera and a shared screen, keeps sending its own camera, and leaves audio alone', () => {
    const { peer, directions } = inCall();
    peer.setIncomingVideoOff(true);
    expect(directions()).toEqual(['sendrecv', 'sendonly', 'inactive']);
  });

  it('takes them again when it is turned back', () => {
    const { peer, directions } = inCall();
    peer.setIncomingVideoOff(true);
    peer.setIncomingVideoOff(false);
    expect(directions()).toEqual(['sendrecv', 'sendrecv', 'recvonly']);
  });

  it('leaves a stopped transceiver alone: setting its direction throws in a browser', () => {
    const { peer, pc, directions } = inCall();
    pc.transceivers.push(t('video', 'stopped'));
    peer.setIncomingVideoOff(true);
    expect(directions()[3]).toBe('stopped');
  });
});
