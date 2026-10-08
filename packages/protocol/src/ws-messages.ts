/**
 * `producer` is present but never recorded and never publishes media: a
 * technical operator who watches the session so the host can focus on the
 * conversation. It does not occupy a recorded seat.
 */
export type Role = 'host' | 'guest' | 'producer';
export type RecordingKind = 'camera' | 'screen';

export interface IceCandidatePayload {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export type ClientJoin = {
  type: 'join';
  displayName: string;
  userAgent: string;
  // Host proves identity by presenting its host_token in the join message.
  // Used when an httpOnly cookie can't cross origins (default *.pages.dev /
  // *.workers.dev deploy). Absent for guests.
  hostToken?: string;
  /** Join as an unrecorded observer. Takes no recorded seat. */
  producer?: boolean;
  /** Join as an unrecorded screen-share companion. Takes no recorded seat. */
  companion?: boolean;
  /** Per-tab client ID so a reconnecting tab replaces its own stale socket. */
  clientId?: string;
};
// `to` addresses a specific peer. Omitted means 'the other one', which is
// still correct in a two-person room and keeps the 1:1 path unchanged.
export type ClientWebrtcOffer = { type: 'webrtc-offer'; sdp: string; to?: string };
export type ClientWebrtcAnswer = { type: 'webrtc-answer'; sdp: string; to?: string };
export type ClientIceCandidate = { type: 'ice-candidate'; candidate: IceCandidatePayload; to?: string };
export type ClientRecordingStarted = {
  type: 'recording-started';
  recordingId: string;
  kind: RecordingKind;
  filename: string;
};
/**
 * Kept only so an older tab's message is still a known type: the server ignores
 * it and current clients do not send it.
 */
export type ClientRecordingCompleted = {
  type: 'recording-completed';
  recordingId: string;
  lastIdx: number;
  totalBytes: number;
  sha256: string | null;
};
/**
 * Host-driven stop. Recording is one room-wide act, not a per-peer one: the
 * host owns the disk, so it owns the start and the stop. Guests wind down on
 * this signal and the host then waits for their tails over the DataChannel.
 */
export type ClientRecordingStop = { type: 'recording-stop'; recordingId: string };
export type ClientChat = { type: 'chat'; text: string; ts: number };
export type ClientPresence = {
  type: 'presence';
  micOn: boolean;
  camOn: boolean;
  screenSharing: boolean;
};
/**
 * Chapter marker dropped during a recording.
 *
 * `label` is optional; the HOST stamps the position on receipt rather than
 * carrying a timestamp. Markers are second-granularity by nature, so the ~10-50ms
 * of relay latency is irrelevant — and stamping host-side avoids needing a live
 * clock offset for a peer whose clock may be arbitrarily wrong.
 */
export type ClientMarker = { type: 'marker'; label: string };
export type ClientLeave = { type: 'leave'; reason: string };
export type ClientPing = { type: 'ping' };
/**
 * Sent by every non-producer peer right after `role-assigned`, and again on
 * each `peer-joined` so a late joiner learns it too. Lets the host see BEFORE
 * pressing Record which participants won't be captured, and why, instead of
 * finding out at playback.
 */
/**
 * Why a browser records less than desktop Chromium. A code, not copy: the host
 * renders its own text, and the Room drops anything not on this list.
 */
export const BROWSER_NOTES = ['safari', 'ios', 'android', 'mobile'] as const;
export type BrowserNote = (typeof BROWSER_NOTES)[number];

export type ClientRecordingCapability = {
  type: 'recording-capability';
  mp4: boolean;
  wav: boolean;
  note?: BrowserNote;
};

/**
 * The host chooses whether one guest is recorded in the takes that follow.
 * Acted on only from the host, and never while a take is running.
 */
export type ClientPeerRecorded = { type: 'peer-recorded'; peerId: string; recorded: boolean };

export type ClientMessage =
  | ClientJoin
  | ClientWebrtcOffer
  | ClientWebrtcAnswer
  | ClientIceCandidate
  | ClientRecordingStarted
  | ClientRecordingCompleted
  | ClientRecordingStop
  | ClientChat
  | ClientPresence
  | ClientMarker
  | ClientLeave
  | ClientPing
  | ClientRecordingCapability
  | ClientPeerRecorded;

export interface PeerInfo {
  peerId: string;
  role: Role;
  displayName: string | null;
  ordinal: number;
  companion?: boolean;
  /**
   * The host set this guest as not recorded, so it is left out of the takes
   * that follow. Present only when true: absent means recorded, which is also
   * what a client deployed around this Worker reads.
   */
  notRecorded?: boolean;
}

export type ServerRoleAssigned = {
  type: 'role-assigned';
  role: Role;
  peerCount: number;
  /** This connection's own id. Every relayed message is addressed by these. */
  peerId: string;
  /**
   * Join-order position, and the basis for perfect-negotiation politeness
   * (https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation):
   * for any PAIR, the lower ordinal is impolite. That is a total
   * order, so every pair gets exactly one impolite side no matter how many
   * peers are in the room.
   *
   * Deliberately NOT derived from `role`. Politeness is a negotiation concern;
   * role is an authorization concern. Deriving one from the other deadlocks the
   * handshake whenever role assignment degrades — e.g. everyone opens the
   * invite link directly, so nobody holds the host token and ALL peers are
   * assigned 'guest'. Two polite peers each accept the other's colliding offer,
   * each roll back their own, and each discard the answer that comes back, so
   * no offer/answer pair completes and ICE sits in 'checking' forever.
   */
  ordinal: number;
  /** Everyone already in the room, so a late joiner can connect to all of them. */
  peers: PeerInfo[];
  /**
   * A recording is already running. Someone who rejoins mid-session — a crashed
   * tab, a dropped laptop — would otherwise never see the `recording-started`
   * broadcast that went out before they arrived, and would sit in the call
   * neither recorded nor told they were being recorded.
   *
   * Optional for wire compatibility: a client deployed ahead of the Worker (or
   * behind it) sees `undefined`, which degrades to "not recording" — the
   * pre-existing behaviour — rather than throwing.
   */
  recording?: boolean;
  /**
   * This connection: the host set this guest as not recorded. It is delivered
   * on a reconnect or a reload too, because the choice is remembered by the
   * tab's client id rather than by the peer id this socket was minted with.
   * Present only when true, and optional for wire compatibility like
   * `recording` above.
   */
  notRecorded?: boolean;
};
export type ServerPeerJoined = {
  type: 'peer-joined';
  role: Role;
  displayName: string;
  userAgent: string;
  peerId: string;
  ordinal: number;
  companion?: boolean;
  /** The host has this guest set as not recorded. Present only when true. */
  notRecorded?: boolean;
};
export type ServerMarker = {
  type: 'marker';
  label: string;
  from: Role;
  fromPeerId?: string;
  fromName?: string;
};
export type ServerPeerLeft = { type: 'peer-left'; role: Role; reason: string; peerId: string };
export type ServerWebrtcOffer = { type: 'webrtc-offer'; sdp: string; from: Role; fromPeerId: string };
export type ServerWebrtcAnswer = { type: 'webrtc-answer'; sdp: string; from: Role; fromPeerId: string };
export type ServerIceCandidate = {
  type: 'ice-candidate';
  candidate: IceCandidatePayload;
  from: Role;
  fromPeerId: string;
};
export type ServerChat = {
  type: 'chat';
  text: string;
  ts: number;
  from: Role;
  fromPeerId?: string;
  fromName?: string;
};
export type ServerPresence = {
  type: 'presence';
  micOn: boolean;
  camOn: boolean;
  screenSharing: boolean;
  from: Role;
  fromPeerId?: string;
  fromName?: string;
};
/**
 * Relayed so every peer learns the room is being recorded — consent notice for
 * guests, and the trigger that starts their own capture. The `recordingId` is
 * the HOST's; guests have no database row; each mints its own id, used as the
 * channel key.
 */
export type ServerRecordingStarted = {
  type: 'recording-started';
  recordingId: string;
  from: Role;
};
export type ServerRecordingStop = { type: 'recording-stop'; recordingId: string; from: Role };
export type ServerRecordingAck = {
  type: 'recording-ack';
  recordingId: string;
  uptoOffset: number;
  uptoIdx: number;
};
export type ServerRoomClosed = { type: 'room-closed'; reason: string };
export type ServerPong = { type: 'pong' };
export type ServerError = { type: 'error'; code: string; message: string };
/** Relay of ClientRecordingCapability, stamped like the other relay types. Never persisted. */
export type ServerRecordingCapability = {
  type: 'recording-capability';
  mp4: boolean;
  wav: boolean;
  note?: BrowserNote;
  from: Role;
  fromPeerId: string;
};

/**
 * The Room's own answer to a host's ClientPeerRecorded, sent to every peer
 * in the room, the host included. Not a relay: it carries no `from`.
 */
export type ServerPeerRecorded = { type: 'peer-recorded'; peerId: string; recorded: boolean };

export type ServerMessage =
  | ServerRoleAssigned
  | ServerPeerJoined
  | ServerPeerLeft
  | ServerWebrtcOffer
  | ServerWebrtcAnswer
  | ServerIceCandidate
  | ServerChat
  | ServerPresence
  | ServerMarker
  | ServerRecordingStarted
  | ServerRecordingStop
  | ServerRecordingAck
  | ServerRoomClosed
  | ServerPong
  | ServerError
  | ServerRecordingCapability
  | ServerPeerRecorded;

const CLIENT_TYPES = new Set<ClientMessage['type']>([
  'join',
  'webrtc-offer',
  'webrtc-answer',
  'ice-candidate',
  'recording-started',
  'recording-completed',
  'recording-stop',
  'chat',
  'presence',
  'marker',
  'leave',
  'ping',
  'recording-capability',
  'peer-recorded',
]);

const SERVER_TYPES = new Set<ServerMessage['type']>([
  'role-assigned',
  'peer-joined',
  'peer-left',
  'webrtc-offer',
  'webrtc-answer',
  'ice-candidate',
  'chat',
  'presence',
  'marker',
  'recording-started',
  'recording-stop',
  'recording-ack',
  'room-closed',
  'pong',
  'error',
  'recording-capability',
  'peer-recorded',
]);

export function isClientMessage(v: unknown): v is ClientMessage {
  if (typeof v !== 'object' || v === null) return false;
  const t = (v as { type?: unknown }).type;
  return typeof t === 'string' && CLIENT_TYPES.has(t as ClientMessage['type']);
}

export function isServerMessage(v: unknown): v is ServerMessage {
  if (typeof v !== 'object' || v === null) return false;
  const t = (v as { type?: unknown }).type;
  return typeof t === 'string' && SERVER_TYPES.has(t as ServerMessage['type']);
}
