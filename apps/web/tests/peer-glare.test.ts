import { describe, it, expect, vi } from 'vitest';
import { PeerConnection } from '@/lib/peer';

/**
 * Regression cover for the failure seen in production:
 *
 *   InvalidStateError: Failed to execute 'setRemoteDescription' on
 *   'RTCPeerConnection': Failed to set remote answer sdp: Called in wrong
 *   state: stable
 *
 * setLocalStream() calls addTrack() once per track (audio + video), which can
 * fire onnegotiationneeded more than once. Two offers go out, two answers come
 * back. The first answer moves the connection to 'stable'; applying the second
 * throws. useRoom relays signals with `void peer.handleSignal(m)`, so the
 * rejection was swallowed and the call silently never connected — both peers
 * showing each other as joined with no media.
 */

type State = RTCSignalingState;

function fakePc(initial: State = 'stable') {
  const pc = {
    signalingState: initial as State,
    localDescription: { sdp: 'LOCAL_SDP' },
    setRemoteDescription: vi.fn(async (d: RTCSessionDescriptionInit) => {
      // Model the real browser: an answer is only legal while a local offer
      // is outstanding.
      if (d.type === 'answer' && pc.signalingState !== 'have-local-offer') {
        throw Object.assign(
          new Error("Failed to set remote answer sdp: Called in wrong state: " + pc.signalingState),
          { name: 'InvalidStateError' }
        );
      }
      pc.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
    }),
    setLocalDescription: vi.fn(async () => {
      pc.signalingState = pc.signalingState === 'have-remote-offer' ? 'stable' : 'have-local-offer';
    }),
    addIceCandidate: vi.fn(async () => {}),
    addTrack: vi.fn(),
    getSenders: () => [],
    close: vi.fn(),
    restartIce: vi.fn(),
    connectionState: 'new' as RTCPeerConnectionState,
  };
  return pc;
}

function mkPeer(polite: boolean, pc: ReturnType<typeof fakePc>) {
  const sent: unknown[] = [];
  const peer = new PeerConnection({
    polite,
    iceServers: [],
    sendSignal: (m) => sent.push(m),
    onRemoteStream: () => {},
    pcFactory: () => pc as unknown as RTCPeerConnection,
  });
  peer.start();
  return { peer, sent };
}

describe('PeerConnection answer handling', () => {
  it('ignores a duplicate answer instead of throwing InvalidStateError', async () => {
    const pc = fakePc('stable');
    const { peer } = mkPeer(false, pc);

    // We made an offer, so a first answer is expected and legal.
    pc.signalingState = 'have-local-offer';
    await peer.handleSignal({ type: 'webrtc-answer', sdp: 'A1', from: 'guest' } as never);
    expect(pc.signalingState).toBe('stable');

    // A second answer arrives (duplicate offer/answer round). This must be a
    // no-op, NOT an exception that kills the connection.
    await expect(
      peer.handleSignal({ type: 'webrtc-answer', sdp: 'A2', from: 'guest' } as never)
    ).resolves.toBeUndefined();
    expect(pc.signalingState).toBe('stable');
  });

  it('ignores an answer that arrives with no outstanding local offer', async () => {
    const pc = fakePc('stable');
    const { peer } = mkPeer(true, pc);
    await expect(
      peer.handleSignal({ type: 'webrtc-answer', sdp: 'STALE', from: 'host' } as never)
    ).resolves.toBeUndefined();
    // Never even attempted — a stale answer must not reach the browser.
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
  });

  it('still applies a legitimate answer', async () => {
    const pc = fakePc('have-local-offer');
    const { peer } = mkPeer(false, pc);
    await peer.handleSignal({ type: 'webrtc-answer', sdp: 'GOOD', from: 'guest' } as never);
    expect(pc.setRemoteDescription).toHaveBeenCalledOnce();
    expect(pc.signalingState).toBe('stable');
  });

  it('impolite peer still drops a colliding offer', async () => {
    const pc = fakePc('have-local-offer');
    const { peer } = mkPeer(false, pc);
    await peer.handleSignal({ type: 'webrtc-offer', sdp: 'THEIRS', from: 'guest' } as never);
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
  });

  it('buffers ICE candidates that arrive before a remote description, then applies them', async () => {
    // The bug this covers: on glare the impolite peer ignores the other's offer,
    // so it has NO remote description while the other peer's trickled candidates
    // are already arriving. They used to be silently discarded forever, leaving
    // ICE in 'checking' with an empty candidate pair and no media.
    const pc = fakePc('stable');
    pc.addIceCandidate = vi.fn(async () => {});
    const { peer } = mkPeer(false, pc);

    await peer.handleSignal({ type: 'ice-candidate', candidate: { candidate: 'c1' }, from: 'guest' } as never);
    await peer.handleSignal({ type: 'ice-candidate', candidate: { candidate: 'c2' }, from: 'guest' } as never);
    expect(pc.addIceCandidate).not.toHaveBeenCalled(); // held, not dropped

    // Remote description arrives -> everything queued must be applied.
    pc.signalingState = 'have-local-offer';
    await peer.handleSignal({ type: 'webrtc-answer', sdp: 'A', from: 'guest' } as never);

    expect(pc.addIceCandidate).toHaveBeenCalledTimes(2);
    expect(pc.addIceCandidate).toHaveBeenNthCalledWith(1, { candidate: 'c1' });
    expect(pc.addIceCandidate).toHaveBeenNthCalledWith(2, { candidate: 'c2' });
  });

  it('applies candidates directly once a remote description exists', async () => {
    const pc = fakePc('have-local-offer');
    pc.addIceCandidate = vi.fn(async () => {});
    const { peer } = mkPeer(false, pc);
    await peer.handleSignal({ type: 'webrtc-answer', sdp: 'A', from: 'guest' } as never);
    await peer.handleSignal({ type: 'ice-candidate', candidate: { candidate: 'later' }, from: 'guest' } as never);
    expect(pc.addIceCandidate).toHaveBeenLastCalledWith({ candidate: 'later' });
  });

  it('polite peer accepts a colliding offer and answers it', async () => {
    const pc = fakePc('have-local-offer');
    const { peer, sent } = mkPeer(true, pc);
    await peer.handleSignal({ type: 'webrtc-offer', sdp: 'THEIRS', from: 'host' } as never);
    expect(pc.setRemoteDescription).toHaveBeenCalledOnce();
    expect(sent.at(-1)).toMatchObject({ type: 'webrtc-answer' });
  });

  /**
   * Regression cover for the reconnect deadlock seen in production: inbound
   * signals were processed by unserialized concurrent handleSignal() calls, so
   * an offer arriving while a prior answer's setRemoteDescription was still
   * pending got evaluated against the STALE (pre-answer) signalingState and
   * was misread as a glare collision — permanently ignored, deadlocking
   * negotiation. Signals must be processed one at a time, in order.
   */
  it('serializes inbound signals: an offer arriving while a prior answer is still resolving is not misread as a collision', async () => {
    let resolveAnswer!: () => void;
    const answerGate = new Promise<void>((resolve) => {
      resolveAnswer = resolve;
    });
    const pc = {
      signalingState: 'have-local-offer' as RTCSignalingState,
      localDescription: { sdp: 'LOCAL_SDP' },
      setRemoteDescription: vi.fn(async (d: RTCSessionDescriptionInit) => {
        if (d.type === 'answer') {
          // Resolves only when the test says so — models a real
          // setRemoteDescription() that hasn't settled yet.
          await answerGate;
          pc.signalingState = 'stable';
          return;
        }
        pc.signalingState = 'have-remote-offer';
      }),
      setLocalDescription: vi.fn(async () => {
        pc.signalingState = 'stable';
      }),
      addIceCandidate: vi.fn(async () => {}),
      addTrack: vi.fn(),
      getSenders: () => [],
      close: vi.fn(),
      restartIce: vi.fn(),
      connectionState: 'new' as RTCPeerConnectionState,
    };
    const { peer, sent } = mkPeer(false, pc); // impolite, like the host

    const answerPromise = peer.handleSignal({ type: 'webrtc-answer', sdp: 'A', from: 'guest' } as never);
    // Let the answer's handleSignal start (and reach the pending
    // setRemoteDescription) before the next signal arrives.
    await Promise.resolve();
    const offerPromise = peer.handleSignal({ type: 'webrtc-offer', sdp: 'OFFER2', from: 'guest' } as never);

    resolveAnswer();
    await answerPromise;
    await offerPromise;

    // The offer must have been answered, not silently dropped as a collision.
    expect(sent.some((m) => (m as { type: string }).type === 'webrtc-answer')).toBe(true);
  });
});
