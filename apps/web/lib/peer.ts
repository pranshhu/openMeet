import type {
  ClientMessage,
  IceCandidatePayload,
  ServerIceCandidate,
  ServerWebrtcAnswer,
  ServerWebrtcOffer,
} from '@openmeet/protocol';
import { sendEncoding, type SendKind } from './send-quality';
import {
  DATA_CHANNEL_RECORDING,
  DATA_CHANNEL_RECORDING_AUDIO,
  DATA_CHANNEL_RECORDING_SCREEN,
  recordingChannelKind,
} from '@openmeet/protocol';

type InboundSignal = ServerWebrtcOffer | ServerWebrtcAnswer | ServerIceCandidate;

export interface PeerOpts {
  polite: boolean;
  /** Remote peer this connection talks to. Stamped onto every outbound signal. */
  remotePeerId?: string;
  iceServers: RTCIceServer[];
  sendSignal: (msg: ClientMessage) => void;
  onRemoteStream: (stream: MediaStream) => void;
  pcFactory?: (config: RTCConfiguration) => RTCPeerConnection;
  onDataChannel?: (channel: RTCDataChannel) => void;
  /**
   * Reports RTCPeerConnection state changes.
   *
   * Nothing used to observe this, which made ICE failure completely silent: the
   * signalling channel stays healthy (both peers "joined"), but no candidate
   * pair ever succeeds, so no media arrives and the app sits on "Connecting…"
   * forever with no message anywhere. That is the expected outcome whenever a
   * direct path is unavailable and TURN is not configured.
   */
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  // Screen share arrives as a SECOND remote MediaStream (distinct stream id).
  // The first remote stream seen is the camera; any later distinct one is the
  // shared screen, routed here instead of overwriting the camera.
  onRemoteScreen?: (stream: MediaStream) => void;
  onRemoteScreenEnded?: () => void;
  /** Negotiation failed locally (see onnegotiationneeded). */
  onNegotiationError?: (err: unknown) => void;
  /** Peer is unrecorded/screen-only (companion or producer). Every stream is routed to onRemoteScreen. */
  screenOnly?: boolean;
}

export class ConnectionTimeoutError extends Error {
  constructor(message = 'The peer connection never connected.') {
    super(message);
    this.name = 'ConnectionTimeoutError';
  }
}

// Perfect-negotiation pattern
// (https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation).
// Exactly one peer must be impolite.
// `polite` is assigned by the room on join order and passed in — deliberately NOT
// derived from host/guest, because role assignment degrades to two guests
// whenever the host token doesn't reach the tab, and two polite peers deadlock.
export class PeerConnection {
  private readonly opts: PeerOpts;
  private pc: RTCPeerConnection | null = null;
  private makingOffer = false;
  private ignoreOffer = false;
  // The first remote stream id is the camera; a different id is the screen.
  private remoteCameraStreamId: string | null = null;
  // ICE candidates that arrived before a remote description existed. Holding
  // them is the difference between a connection and a permanent 'checking'.
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private hasRemoteDescription = false;
  private screenChannelSeq = 0;
  /** People in the room including us. 2 until told otherwise. */
  private peerCount = 2;
  /** Serializes handleSignal() calls so signals are processed strictly in order. */
  private signalTail: Promise<void> = Promise.resolve();
  // Lazily created by whenConnected() so a caller that never asks pays nothing.
  private connectedPromise: Promise<void> | null = null;
  private resolveConnected: (() => void) | null = null;
  private connectedListeners: (() => void)[] = [];
  private pendingLocalStream: MediaStream | null = null;
  private pendingScreenStream: MediaStream | null = null;
  private controlChannel: RTCDataChannel | null = null;

  constructor(opts: PeerOpts) {
    this.opts = opts;
  }

  start(): RTCPeerConnection {
    const factory = this.opts.pcFactory ?? ((c: RTCConfiguration) => new RTCPeerConnection(c));
    const pc = factory({ iceServers: this.opts.iceServers });
    this.pc = pc;

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        const sdp = pc.localDescription?.sdp ?? '';
        this.opts.sendSignal({ type: 'webrtc-offer', sdp, ...this.addr() });
      } catch (err) {
        // try/finally with no catch made a setLocalDescription failure an
        // unhandled rejection: negotiation stalls, no offer is ever sent, and
        // the call sits on "Connecting…" with nothing in the console but a
        // stack trace nobody is watching for.
        this.opts.onNegotiationError?.(err);
      } finally {
        this.makingOffer = false;
      }
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.opts.sendSignal({
          type: 'ice-candidate',
          candidate: ev.candidate.toJSON() as IceCandidatePayload,
          ...this.addr(),
        });
      }
    };

    pc.ontrack = (ev) => {
      const stream = ev.streams[0];
      if (!stream) return;
      if (this.opts.screenOnly) {
        this.opts.onRemoteScreen?.(stream);
        const vt = stream.getVideoTracks()[0];
        if (vt) vt.addEventListener('ended', () => this.opts.onRemoteScreenEnded?.());
        return;
      }
      // First remote stream (or any track of it) = camera.
      if (this.remoteCameraStreamId === null || stream.id === this.remoteCameraStreamId) {
        this.remoteCameraStreamId = stream.id;
        this.opts.onRemoteStream(stream);
        return;
      }
      // A distinct stream id = the shared screen.
      this.opts.onRemoteScreen?.(stream);
      const vt = stream.getVideoTracks()[0];
      if (vt) vt.addEventListener('ended', () => this.opts.onRemoteScreenEnded?.());
    };

    pc.ondatachannel = (ev) => {
      // Video and uncompressed audio arrive on separate channels so each carries
      // exactly one file. The consumer routes on label. A label may carry a
      // stable key after '#' (see recordingChannelKind) — filter on the base.
      const { base } = recordingChannelKind(ev.channel.label);
      if (
        base === DATA_CHANNEL_RECORDING ||
        base === DATA_CHANNEL_RECORDING_AUDIO ||
        ev.channel.label.startsWith(DATA_CHANNEL_RECORDING_SCREEN)
      ) {
        this.opts.onDataChannel?.(ev.channel);
      }
    };

    pc.onconnectionstatechange = () => {
      this.opts.onConnectionStateChange?.(pc.connectionState);
      if (pc.connectionState === 'connected') {
        this.resolveConnected?.();
        const listeners = this.connectedListeners;
        this.connectedListeners = [];
        for (const l of listeners) l();
      }
    };

    return pc;
  }

  /**
   * Ask ICE to gather fresh candidates and try again. Worth one attempt on
   * 'failed': it recovers a genuine network change (wifi -> cellular), though
   * it cannot conjure a relay path that was never available.
   */
  restartIce(): void {
    this.pc?.restartIce();
  }

  /** Escape hatch for callers that need sender-level access (track replacement). */
  get rawConnection(): RTCPeerConnection | null {
    return this.pc;
  }

  get connectionState(): RTCPeerConnectionState | null {
    return this.pc?.connectionState ?? null;
  }

  /**
   * Resolves once this connection first reaches 'connected' — immediately if
   * it already has. Rejects with ConnectionTimeoutError if timeoutMs elapses
   * before reaching 'connected'.
   */
  whenConnected(timeoutMs = 15_000): Promise<void> {
    if (this.connectionState === 'connected') return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;

      const onConnected = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };

      this.connectedListeners.push(onConnected);

      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          this.connectedListeners = this.connectedListeners.filter((l) => l !== onConnected);
          reject(new ConnectionTimeoutError());
        }, timeoutMs);
        if (typeof timer === 'object' && 'unref' in timer) {
          timer.unref();
        }
      }
    });
  }

  /**
   * Stores the local stream to add right after answering the first remote offer.
   * Ensures existing peers never offer first to an incoming joiner.
   */
  setLocalStreamAfterFirstOffer(stream: MediaStream, screenStream?: MediaStream | null): void {
    this.pendingLocalStream = stream;
    this.pendingScreenStream = screenStream ?? null;
  }

  setLocalStream(stream: MediaStream): void {
    this.pendingLocalStream = null;
    const pc = this.requirePc();
    for (const track of stream.getTracks()) {
      // Tells the encoder what it is looking at. 'motion' biases toward
      // temporal smoothness, which is what a talking head wants.
      if (track.kind === 'video') track.contentHint = 'motion';
      pc.addTrack(track, stream);
    }
    this.applySendQuality();
  }

  /**
   * Swap what this connection sends as audio (the media board's mic+pads mix)
   * without renegotiating. A connection still waiting for its first offer has
   * no sender yet, so the swap goes into the stream it will add then.
   */
  replaceAudioTrack(track: MediaStreamTrack): void {
    const pending = this.pendingLocalStream;
    if (pending) this.pendingLocalStream = new MediaStream([...pending.getVideoTracks(), track]);
    const sender = this.pc?.getSenders().find((sn) => sn.track?.kind === 'audio');
    void sender?.replaceTrack(track);
  }

  /**
   * Swap what this connection sends as camera without renegotiating.
   * Finds the camera sender by its current track (never by kind, because screen share
   * adds a second video sender).
   */
  replaceCameraTrack(newTrack: MediaStreamTrack, oldTrack: MediaStreamTrack): void {
    const pending = this.pendingLocalStream;
    if (pending) {
      this.pendingLocalStream = new MediaStream(
        pending.getTracks().map((t) => (t === oldTrack ? newTrack : t))
      );
    }
    const sender = this.pc?.getSenders().find((sn) => sn.track === oldTrack);
    void sender?.replaceTrack(newTrack);
  }

  addTransceiver(
    trackOrKind: MediaStreamTrack | 'audio' | 'video',
    init?: RTCRtpTransceiverInit
  ): RTCRtpTransceiver {
    return this.requirePc().addTransceiver(trackOrKind, init);
  }

  addTrack(track: MediaStreamTrack, stream: MediaStream): void {
    // 'detail' is the screen-share hint: keep text sharp, sacrifice frame rate.
    // It also lets applySendQuality tell a screen sender from a camera one
    // without threading extra state through every call site.
    if (track.kind === 'video') track.contentHint = 'detail';
    this.requirePc().addTrack(track, stream);
    this.applySendQuality();
  }

  /**
   * How many people are in the room, including you. Drives how the outbound
   * budget is divided; re-apply whenever it changes.
   */
  setPeerCount(n: number): void {
    if (n === this.peerCount) return;
    this.peerCount = n;
    this.applySendQuality();
  }

  /**
   * Cap every outbound video sender.
   *
   * Without this each sender encodes at whatever it likes, and in a mesh that
   * multiplies by the number of remotes — at four people with a screen share
   * roughly 16.5 Mbps up and six concurrent encodes, which is the jitter.
   *
   * Failures are ignored on purpose: this is an optimisation, and a browser
   * that rejects the parameters should still get a working call.
   */
  applySendQuality(): void {
    const pc = this.pc;
    if (!pc) return;
    for (const sender of pc.getSenders()) {
      const track = sender.track;
      if (!track || track.kind !== 'video') continue;
      const kind: SendKind = track.contentHint === 'detail' ? 'screen' : 'camera';
      const params = sender.getParameters();
      // Before the first negotiation `encodings` can be empty; setting it then
      // throws, so seed one entry rather than skipping the cap entirely.
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      const want = sendEncoding(this.peerCount, kind);
      params.encodings[0] = { ...params.encodings[0], ...want };
      void sender.setParameters(params).catch(() => {
        /* unsupported here; the call still works, just uncapped */
      });
    }
  }

  // Remove a previously added track (e.g. stop screen share) and let perfect
  // negotiation renegotiate. No-op if the track has no sender.
  removeTrack(track: MediaStreamTrack): void {
    const pc = this.requirePc();
    const sender = pc.getSenders().find((s) => s.track === track);
    if (sender) pc.removeTrack(sender);
  }

  /**
   * Opens an initial data channel so the joiner's first offer carries the SCTP
   * m-line. Per JSEP, only the first data channel negotiates; every later channel
   * (e.g. recording) opens in-band via DCEP without triggering renegotiation.
   * Idempotent — a second call returns the existing channel.
   */
  createControlChannel(): RTCDataChannel {
    if (this.controlChannel) return this.controlChannel;
    const pc = this.requirePc();
    this.controlChannel = pc.createDataChannel('control', { ordered: true });
    return this.controlChannel;
  }

  /**
   * `key`, when given, is suffixed onto the label as `recording#<key>`. Passing
   * the same key across a channel rebind (e.g. the guest's own recordingId) is
   * what lets the host route the rebuilt channel back to the same slot/file
   * instead of by the DO's fresh-per-socket peerId. Omitted, the label is
   * unchanged from before.
   */
  createRecordingChannel(key?: string): RTCDataChannel {
    const pc = this.requirePc();
    const label = key ? `${DATA_CHANNEL_RECORDING}#${key}` : DATA_CHANNEL_RECORDING;
    return pc.createDataChannel(label, { ordered: true });
  }

  /** Separate channel for the uncompressed WAV master (see chunk-sender). */
  createRecordingAudioChannel(key?: string): RTCDataChannel {
    const pc = this.requirePc();
    const label = key ? `${DATA_CHANNEL_RECORDING_AUDIO}#${key}` : DATA_CHANNEL_RECORDING_AUDIO;
    return pc.createDataChannel(label, { ordered: true });
  }

  /**
   * One channel per screen-share stretch. A label can only be used once per
   * connection, so segments are suffixed; the host matches on the prefix.
   */
  createRecordingScreenChannel(): RTCDataChannel {
    const pc = this.requirePc();
    const label = `${DATA_CHANNEL_RECORDING_SCREEN}-${++this.screenChannelSeq}`;
    return pc.createDataChannel(label, { ordered: true });
  }

  /**
   * Signals arrive over WS and useRoom relays them with a bare `void
   * handleSignal(...)` call, so two inbound messages can land back-to-back
   * with no guarantee the first has finished. An offer that arrives while a
   * prior answer's setRemoteDescription() is still resolving would then be
   * evaluated against the STALE signalingState and get misread as a glare
   * collision — dropped forever, deadlocking negotiation. Chaining through
   * `signalTail` processes one signal fully before the next one starts.
   * `.catch(() => {})` keeps the chain alive after a rejection so one bad
   * signal doesn't wedge every signal after it; the promise returned to the
   * caller still reflects this message's own outcome.
   */
  handleSignal(msg: InboundSignal): Promise<void> {
    const result = this.signalTail.then(() => this.process(msg));
    this.signalTail = result.catch(() => {});
    return result;
  }

  private async process(msg: InboundSignal): Promise<void> {
    const pc = this.requirePc();
    if (msg.type === 'ice-candidate') {
      // addIceCandidate() throws until a remote description exists. This used to
      // swallow that and DISCARD the candidate permanently, which broke the call
      // outright: on glare the impolite peer ignores the other's offer, so it has
      // no remote description while the other peer's trickled candidates are
      // already arriving. Every one of them was thrown away, and by the time the
      // answer landed there was nothing left to pair with — ICE sat in
      // 'checking' forever with an empty candidate pair and no media.
      if (!this.hasRemoteDescription) {
        this.pendingCandidates.push(msg.candidate as RTCIceCandidateInit);
        return;
      }
      try {
        await pc.addIceCandidate(msg.candidate as RTCIceCandidateInit);
      } catch {
        // A candidate genuinely obsoleted by rollback is safe to drop.
      }
      return;
    }

    const description = { type: msg.type === 'webrtc-offer' ? 'offer' : 'answer', sdp: msg.sdp };
    const offerCollision =
      description.type === 'offer' &&
      (this.makingOffer || pc.signalingState !== 'stable');
    this.ignoreOffer = !this.opts.polite && offerCollision;
    if (this.ignoreOffer) return;

    // An answer is only legal while a local offer is outstanding. setLocalStream
    // adds one track per kind, which can fire onnegotiationneeded more than once
    // and put two offers on the wire; both get answered. Applying the second
    // answer throws "Failed to set remote answer sdp: Called in wrong state:
    // stable", and because useRoom relayed with `void handleSignal(...)` the
    // rejection was invisible while the connection stayed broken.
    if (description.type === 'answer' && pc.signalingState !== 'have-local-offer') return;

    await pc.setRemoteDescription(description as RTCSessionDescriptionInit);
    await this.flushPendingCandidates();
    if (description.type === 'offer') {
      await pc.setLocalDescription();
      const sdp = pc.localDescription?.sdp ?? '';
      this.opts.sendSignal({ type: 'webrtc-answer', sdp, ...this.addr() });
      if (this.pendingLocalStream) {
        const stream = this.pendingLocalStream;
        this.pendingLocalStream = null;
        this.setLocalStream(stream);
      }
      if (this.pendingScreenStream) {
        const screen = this.pendingScreenStream;
        this.pendingScreenStream = null;
        for (const track of screen.getTracks()) {
          this.addTrack(track, screen);
        }
      }
    }
  }

  /** Address every outbound signal, or omit `to` in the two-person case. */
  private addr(): { to?: string } {
    return this.opts.remotePeerId ? { to: this.opts.remotePeerId } : {};
  }

  /** Apply everything that arrived before we had a remote description. */
  private async flushPendingCandidates(): Promise<void> {
    this.hasRemoteDescription = true;
    if (this.pendingCandidates.length === 0) return;
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const c of queued) {
      try {
        await this.requirePc().addIceCandidate(c);
      } catch {
        // Individual stale candidates are fine to drop; the rest still apply.
      }
    }
  }

  close(): void {
    this.pc?.close();
    this.pc = null;
    this.pendingCandidates = [];
    this.hasRemoteDescription = false;
    this.pendingLocalStream = null;
    this.connectedListeners = [];
    this.controlChannel = null;
  }

  private requirePc(): RTCPeerConnection {
    if (!this.pc) throw new Error('PeerConnection not started');
    return this.pc;
  }
}
