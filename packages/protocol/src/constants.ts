export const CHUNK_TIMESLICE_MS = 2000;
/**
 * Largest single RTCDataChannel message we will send.
 *
 * SCTP caps message size — Chrome negotiates 256 KiB, and 64 KiB is the floor
 * every implementation accepts. EVERY chunk openMeet produces is over that cap
 * (1080p/2s is ~1.2 MiB, 4K/2s is ~6 MiB, 24-bit stereo WAV/2s is ~562 KiB), so
 * payloads are fragmented to this size before they go on the wire. Exceeding it
 * throws "Trying to send message larger than max-message-size" and, before the
 * recorder's tail chain was made rejection-proof, silently ended the recording.
 *
 * Fragmenting is nearly free here because the transport is POSITIONAL: each
 * fragment carries its own absolute offset and is written straight to disk, so
 * nothing has to be reassembled in memory on the receiving side.
 */
export const DC_MAX_MESSAGE_BYTES = 64 * 1024;
export const DC_BUFFERED_HIGH_WATERMARK = 16 * 1024 * 1024;
export const DC_BUFFERED_LOW_WATERMARK = 8 * 1024 * 1024;
export const GUEST_RETRANSMIT_BUFFER_CAP = 32 * 1024 * 1024;
export const STREAM_BACKLOG_CAP_BYTES = 256 * 1024 * 1024; // 256 MiB
export const ACK_EVERY_N_CHUNKS = 5;
export const ACK_EVERY_N_MS = 10_000;
export const WS_HEARTBEAT_INTERVAL_MS = 30_000;
export const WS_HEARTBEAT_TIMEOUT_MS = 90_000;
export const DRAIN_HARD_CAP_MS = 30_000;
export const DRAIN_NO_PROGRESS_TIMEOUT_MS = 30_000;
export const HOST_TAIL_NO_PROGRESS_TIMEOUT_MS = 45_000;
// Rooms are reusable and their expiry SLIDES on every join, so this is "time
// since last use", not "time since creation". 24h would kill a weekly show's
// link between episodes; rooms nobody returns to still lapse on their own.
export const ROOM_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// TURN credentials are fetched once per join and never refreshed, and Cloudflare
// cuts a relayed call shortly after its credential expires, so this must outlast
// the longest session (Cloudflare's maximum is 48 h). Known limit: one long-lived
// credential per join; refresh via setConfiguration() if leaked credentials
// ever become a cost problem.
export const TURN_CRED_TTL_S = 12 * 60 * 60;

// Codec support is NOT uniform across platforms, even within Chrome. Measured on
// Chrome 151:
//   Linux (both the official .deb and the Chromium snap): AAC-LC is ABSENT.
//     `video/mp4;codecs=avc1.42E01F,mp4a.40.2` -> false
//     `video/mp4;codecs=avc1.42E01F,opus`      -> true
//     H.264 itself is fine; it is the AAC *audio* encoder that is missing.
//   macOS / Windows: AAC-LC is present (system encoder), so the first entry wins.
//
// So the recorder probes this list at runtime and takes the first supported entry
// rather than assuming one string works everywhere. Ordered by how well editors
// import the result: AAC first (universal), Opus after (Premiere/Resolve support
// for Opus-in-MP4 is uneven, so it is a fallback, not a peer).
//
// EVERY candidate stays in the MP4 container on purpose. The host opens
// `guest_<id>.mp4` before the guest has chosen a codec, so a WebM fallback would
// put WebM bytes behind an .mp4 extension. Keeping the container fixed makes the
// filename honest without negotiating anything between peers. If no entry is
// supported, recording is unavailable — that is the documented Chromium-only
// design, not a bug.
// avc1 vs avc3 in each pair below is bytestream signalling, not a different codec:
// avc1 puts the parameter sets (SPS/PPS) once in an out-of-band avcC box, avc3 repeats
// them in-band on every keyframe. A resolution change mid-recording (shared window
// resized, camera switching mode) changes those parameter sets — avc1 has nowhere to
// put the new ones and corrupts every frame after the change; avc3 just emits a new
// in-band set. So each avc3 variant is tried before its avc1 twin.
export const RECORDING_MIME_CANDIDATES = [
  'video/mp4;codecs=avc3.42E01F,mp4a.40.2', // H.264 baseline (in-band) + AAC-LC
  'video/mp4;codecs=avc1.42E01F,mp4a.40.2', // H.264 baseline + AAC-LC
  'video/mp4;codecs=avc3.640028,mp4a.40.2', // H.264 high (in-band) + AAC-LC
  'video/mp4;codecs=avc1.640028,mp4a.40.2', // H.264 high + AAC-LC
  'video/mp4;codecs=avc3.42E01F,opus', // H.264 baseline (in-band) + Opus
  'video/mp4;codecs=avc1.42E01F,opus', // H.264 baseline + Opus
  'video/mp4;codecs=avc3.640028,opus', // H.264 high (in-band) + Opus
  'video/mp4;codecs=avc1.640028,opus', // H.264 high + Opus
  'video/mp4', // last resort: let the browser choose within MP4
] as const;

// Preferred codec. Kept as the single-value export for callers that just want the
// default; use pickRecordingMime() to get one that actually works on this machine.
export const RECORDING_MIME = RECORDING_MIME_CANDIDATES[0];
// Recording quality (capture + encode). H.264 in MP4 — Chromium-only target.
// Capture dimensions are requested with `ideal` (graceful degrade on weak webcams);
// the live WebRTC send adapts down independently, the local recording keeps full res.
// Bitrate drives encoded size, and so disk use; guest RAM stays bounded (the backup
// spills to OPFS and the sha256 is incremental) — tune here.
export const RECORDING_VIDEO_WIDTH = 1920;
export const RECORDING_VIDEO_HEIGHT = 1080;
export const RECORDING_FRAME_RATE = 30;
export const RECORDING_VIDEO_BPS = 5_000_000; // ~5 Mbps 1080p30
export const RECORDING_AUDIO_BPS = 160_000; // 160 kbps (AAC-LC or Opus, whichever was picked)
export const DATA_CHANNEL_RECORDING = 'recording';
export const DATA_CHANNEL_RECORDING_SCREEN = 'recording-screen';
// Uncompressed audio rides its own channel rather than interleaving with video
// on `recording`. Each channel then carries exactly one file, so idx/offset,
// the retransmit buffer and the sha256 digest all stay per-file with no tagging
// and no changes to ChunkSender/ChunkReceiver.
export const DATA_CHANNEL_RECORDING_AUDIO = 'recording-audio';

/**
 * Recording channel labels may carry a stable key after a `#`:
 * `recording#<key>` / `recording-audio#<key>`. The DO mints a fresh peerId per
 * socket, so after a full WS reconnect a guest's rebuilt channels arrive from a
 * brand-new peerId; without a stable key the host would open a new slot/file
 * for what is really the same guest resuming. Plain labels (no `#`) behave
 * exactly as before — `base` is the whole label and `key` is absent.
 */
export function recordingChannelKind(label: string): { base: string; key?: string } {
  const i = label.indexOf('#');
  if (i === -1) return { base: label };
  return { base: label.slice(0, i), key: label.slice(i + 1) };
}

// Uncompressed WAV master, recorded in parallel with the MP4 (MediaRecorder
// cannot emit WAV, so it is a second capture path, not a codec choice).
// 24-bit is the studio standard and is lossless for any real source: Float32
// carries a 24-bit mantissa and mic ADCs are 24-bit at best.
// Cost: 48000 * 3 bytes/s = ~1.15 Mbps mono, ~518 MB/hr per peer, on top of the
// ~5 Mbps video. Doubles through TURN when a call is relayed.
export const WAV_BIT_DEPTH = 24;
export const WAV_SAMPLE_RATE = 48_000; // requested; the actual rate is read from the capture

/**
 * Peers recorded per room. Mesh (every peer connected to every other) is
 * O(n^2) connections, so this stays small on purpose; beyond ~4-5 the honest
 * answer is an SFU, which would mean a media server and would break both the
 * free-tier promise and the "bytes never touch a server" guarantee.
 */
export const MAX_RECORDED_PEERS = 4;

export const WS_CLOSE_CAPACITY_FULL = 4001;
export const WS_CLOSE_INVALID_SLUG = 4002;
export const WS_CLOSE_EXPIRED_SLUG = 4003;
export const WS_CLOSE_INVALID_MESSAGE = 4005;
export const WS_CLOSE_REPLACED = 4006;

