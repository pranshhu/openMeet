/**
 * How much bitrate to spend on the LIVE stream, per remote peer.
 *
 * This is deliberately unrelated to recording quality. Every peer records its
 * OWN camera locally, at the full quality it chose — the stream sent over the
 * wire exists only so people can see and hear each other while they talk. Its
 * bitrate never reaches any file.
 *
 * That distinction was never enforced, so a mesh call sent RECORDING-grade video
 * to every peer. In a full mesh each peer sends N-1 copies of its stream, so the
 * cost grows with the room:
 *
 *   peers   streams out   uplink @1080p   + screen   encoders running
 *   2       1             ~2.5 Mbps       ~5.5       2
 *   3       2             ~5.0 Mbps       ~11.0      4
 *   4       3             ~7.5 Mbps       ~16.5      6
 *
 * At four people with a screen share that is ~16.5 Mbps up — past most home
 * uplinks — and six simultaneous H.264 encodes of the same two sources, because
 * separate PeerConnections do not share an encoder. The result is jitter, lag
 * and a screen share that will not start.
 *
 * So: hold the TOTAL roughly constant and divide it by the number of remotes.
 * Adding a fourth person now costs picture quality instead of costing the call.
 */

/** Total live-video budget across all remote peers, camera. */
const CAMERA_TOTAL_BPS = 2_400_000;
/** Same for a screen share, which runs alongside the camera. */
const SCREEN_TOTAL_BPS = 1_800_000;

/** Below this a stream is worse than useless, so stop dividing. */
const CAMERA_FLOOR_BPS = 250_000;
const SCREEN_FLOOR_BPS = 300_000;

/**
 * Screen content is mostly static, and text is the payload. Spending the budget
 * on RESOLUTION at a low frame rate keeps it readable; spending it on frame rate
 * turns it to mush. So the screen is never scaled down — its frame rate is
 * capped instead.
 */
const SCREEN_MAX_FPS = 8;

export type SendKind = 'camera' | 'screen';

/**
 * Encoder settings for one outbound track, given how many people are in the
 * room. `peerCount` includes yourself, so it matches `remotePeers.length + 1`.
 */
export function sendEncoding(peerCount: number, kind: SendKind): RTCRtpEncodingParameters {
  const remotes = Math.max(1, peerCount - 1);

  if (kind === 'screen') {
    return {
      maxBitrate: Math.max(SCREEN_FLOOR_BPS, Math.floor(SCREEN_TOTAL_BPS / remotes)),
      maxFramerate: SCREEN_MAX_FPS,
    };
  }

  return {
    maxBitrate: Math.max(CAMERA_FLOOR_BPS, Math.floor(CAMERA_TOTAL_BPS / remotes)),
    // Sending 1080p at 600 kbps looks far worse than sending 540p at 600 kbps:
    // the encoder spreads too few bits over too many pixels and everything
    // smears. Drop the resolution with the bitrate so each pixel keeps its bits.
    scaleResolutionDownBy: cameraScale(remotes),
  };
}

function cameraScale(remotes: number): number {
  if (remotes <= 1) return 1; // one-to-one: send it as captured
  if (remotes === 2) return 1.5;
  return 2;
}

/**
 * Live-video upload for the whole room, in bits per second. Exported for the
 * green room, so someone can be told what a four-person call will cost them
 * before they are in one.
 */
export function totalUploadBps(peerCount: number, sharingScreen: boolean): number {
  const remotes = Math.max(0, peerCount - 1);
  if (remotes === 0) return 0;
  const cam = sendEncoding(peerCount, 'camera').maxBitrate ?? 0;
  const scr = sharingScreen ? (sendEncoding(peerCount, 'screen').maxBitrate ?? 0) : 0;
  return remotes * (cam + scr);
}
