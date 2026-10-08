import {
  BROWSER_NOTES,
  MAX_RECORDED_PEERS,
  ROOM_TTL_MS,
  WS_CLOSE_CAPACITY_FULL,
  WS_CLOSE_EXPIRED_SLUG,
  WS_CLOSE_INVALID_MESSAGE,
  WS_CLOSE_INVALID_SLUG,
  WS_CLOSE_REPLACED,
  type ClientMessage,
  type Role,
  type ServerMessage,
} from '@openmeet/protocol';
import type { Env } from '../env.js';
import { parseHostTokenCookie } from '../lib/cookie.js';
import { timingSafeEqualHex } from '../lib/token.js';
import { isValidSlugFormat } from '../lib/slug.js';
import {
  endSession,
  getRoomBySlug,
  insertParticipant,
  insertRecording,
  insertSession,
  markParticipantLeft,
  markRoomConsumed,
  touchRoom,
} from '../db/queries.js';

/**
 * Per-peer state, held as a WebSocket attachment (`ws.serializeAttachment`) so
 * it survives hibernation: the DO can be evicted from memory between messages
 * and rebuilt from `state.getWebSockets()` + each socket's attachment, rather
 * than an in-memory Map that would be empty on wake. No WebSocket inside —
 * attachments must be serialisable.
 */
interface PeerAttachment {
  role: Role;
  displayName: string | null;
  userAgent: string | null;
  joined: boolean;
  /**
   * Join-order position. For any PAIR the lower ordinal is impolite, which is a
   * total order — so every pair has exactly one impolite side regardless of how
   * many peers are present. Assigned when the socket is accepted, never reused.
   */
  ordinal: number;
  peerId: string;
  participantId?: string;
  /**
   * Set once close/error has been processed for this socket, so a manual
   * close (`closeExistingHosts`) and the runtime's own `webSocketClose`/
   * `webSocketError` callback for the same socket don't double-process.
   */
  left?: boolean;
  clientId?: string;
  companion?: boolean;
}

interface RoomRow {
  slug: string;
  hostToken: string;
}

interface SessionRow {
  sessionId: string | null;
  recording: boolean;
  recordingCount?: number;
  notRecorded?: string[];
}

/**
 * Producers ride on top of the recorded cap. They publish nothing and are never
 * recorded, so they don't consume a seat — but they do consume a mesh
 * connection, hence a bound of their own.
 */
const MAX_PRODUCERS = 2;

/**
 * Bounds on what a client can make the Room store. Names and user agents are
 * truncated rather than refused, so a browser with a long user agent still
 * joins; both also sit in the socket attachment, which is limited to 2048
 * bytes at two bytes a character outside Latin-1. A recording id is a UUID
 * and a filename `host_<uuid>.mp4`, and a take is one row, so no honest
 * session comes near the other three. A room seats four recorded guests, so
 * sixteen remembered tabs is generous: past that, the oldest is forgotten and
 * arrives as recorded the next time it connects.
 */
const MAX_DISPLAY_NAME_LENGTH = 64;
const MAX_USER_AGENT_LENGTH = 512;
const MAX_RECORDING_ID_LENGTH = 64;
const MAX_FILENAME_LENGTH = 255;
const MAX_RECORDINGS_PER_SESSION = 256;
const MAX_NOT_RECORDED_CLIENTS = 16;

/** Cut to `max` UTF-16 units, dropping the half of a surrogate pair a cut can leave behind. */
function truncate(s: string, max: number): string {
  return s.slice(0, max).replace(/[\uD800-\uDBFF]$/, '');
}

export class Room implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  // Instance caches, reloaded from DO storage in the constructor so a DO
  // woken from hibernation (a fresh instance, no history) starts from the
  // same values the evicted one had. Re-written to storage on every mutation.
  private slug: string | null = null;
  private sessionId: string | null = null;
  // Whether the HOST currently has a recording running. Reported in
  // role-assigned so a peer that joins mid-recording is told, and starts its
  // own capture, exactly like one that was here when Record was pressed.
  private recording = false;
  private recordingCount = 0;
  // Client ids of the guests the host set as not recorded. By client id, not
  // peerId: a peerId is minted per socket and does not survive a reconnect.
  private notRecorded: string[] = [];
  private hostToken: string | null = null;
  private nextOrdinal = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    // Answered by the runtime itself without waking the DO. Must match the
    // client's ping byte-for-byte (apps/web/lib/signal.ts sends exactly
    // `{"type":"ping"}`); the `ping` case below stays as a fallback for any
    // message that doesn't match verbatim.
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}')
    );
    this.state.blockConcurrencyWhile(async () => {
      const room = await this.state.storage.get<RoomRow>('room');
      if (room) {
        this.slug = room.slug;
        this.hostToken = room.hostToken;
      }
      const session = await this.state.storage.get<SessionRow>('session');
      if (session) {
        this.sessionId = session.sessionId;
        this.recording = session.recording;
        this.recordingCount = session.recordingCount ?? 0;
        this.notRecorded = session.notRecorded ?? [];
      }
      const nextOrdinal = await this.state.storage.get<number>('nextOrdinal');
      if (typeof nextOrdinal === 'number') {
        this.nextOrdinal = nextOrdinal;
      }
    });
  }

  private peer(ws: WebSocket): PeerAttachment {
    return ws.deserializeAttachment() as PeerAttachment;
  }

  private save(ws: WebSocket, p: PeerAttachment): void {
    // A caller may be mid-await (join awaits D1) holding a copy deserialised
    // before onClose ran for this same socket. If onClose already persisted
    // left:true, never let a later save un-set it — the stored value, not the
    // caller's stale copy, is the source of truth for whether this socket has
    // already been processed as closed.
    if (this.peer(ws)?.left) p.left = true;
    ws.serializeAttachment(p);
  }

  private allPeers(): Array<{ ws: WebSocket; p: PeerAttachment }> {
    return this.state
      .getWebSockets()
      .map((ws) => ({ ws, p: this.peer(ws) }))
      .filter(({ p }) => !p.left);
  }

  /**
   * The room itself: sockets whose `join` passed the caps. A socket that is
   * only connected is outside it — relays, broadcasts, peerCount and the
   * session's lifetime all go through this. allPeers() stays for what must
   * reach every socket: closing them on expiry, and finding the host or
   * client a new connection replaces, which can happen before either joins.
   */
  private joinedPeers(): Array<{ ws: WebSocket; p: PeerAttachment }> {
    return this.allPeers().filter(({ p }) => p.joined);
  }

  private async saveSession(): Promise<void> {
    await this.state.storage.put('session', {
      sessionId: this.sessionId,
      recording: this.recording,
      recordingCount: this.recordingCount,
      notRecorded: this.notRecorded,
    } satisfies SessionRow);
  }

  /**
   * Fires at the expires_at armed by the most recent `join`. Connect-time
   * expiry (in `fetch`) only ever fires for the NEXT connection, so a room
   * that expires while a call is already underway needs its own trigger —
   * otherwise the peers already inside just keep talking indefinitely.
   */
  async alarm(): Promise<void> {
    const room = this.slug ? await getRoomBySlug(this.env.DB, this.slug) : null;
    if (room && room.expires_at > Date.now()) {
      // A later join extended the room past this alarm's original firing
      // time; re-arm for the new expiry instead of closing a live room.
      await this.state.storage.setAlarm(room.expires_at);
      return;
    }
    for (const { ws } of this.allPeers()) {
      try {
        ws.close(WS_CLOSE_EXPIRED_SLUG, 'expired_slug');
      } catch {
        // already gone
      }
    }
    if (this.sessionId) {
      await endSession(this.env.DB, this.sessionId, Date.now(), 'expired').catch((e) =>
        console.error('room:endSession', e)
      );
      this.sessionId = null;
      this.recording = false;
      this.recordingCount = 0;
      await this.saveSession();
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/ws/r/')) return new Response('not found', { status: 404 });

    const upgrade = req.headers.get('Upgrade');
    if (upgrade !== 'websocket') return new Response('expected websocket', { status: 426 });

    const rawSlug = url.pathname.slice('/ws/r/'.length);
    // The router picks this object from the percent-decoded slug but forwards
    // the raw request, so the path is not trusted for the slug; the row is.
    const room = isValidSlugFormat(rawSlug) ? await getRoomBySlug(this.env.DB, rawSlug) : null;
    if (!room || room.expires_at < Date.now()) {
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      // Distinguish a never-existed slug (4002) from a known-but-expired room
      // (4003) so the client can show the right message instead of retrying.
      const [code, reason] = room
        ? ([WS_CLOSE_EXPIRED_SLUG, 'expired_slug'] as const)
        : ([WS_CLOSE_INVALID_SLUG, 'invalid_slug'] as const);
      server.close(code, reason);
      return new Response(null, { status: 101, webSocket: client });
    }

    this.slug = room.slug;
    this.hostToken = room.host_token;
    await this.state.storage.put('room', { slug: room.slug, hostToken: room.host_token } satisfies RoomRow);
    // Same-origin/local-dev path: host_token may arrive as an httpOnly cookie.
    // Cross-origin deploys (*.pages.dev + *.workers.dev) can't send it, so the
    // host also presents the token in its `join` message (see webSocketMessage).
    const cookie = parseHostTokenCookie(req.headers.get('Cookie'), room.slug);
    const isHost = !!cookie && timingSafeEqualHex(cookie, room.host_token);

    const { 0: client, 1: server } = new WebSocketPair();

    const role: Role = isHost ? 'host' : 'guest';
    // Ordinals are assigned HERE, not when `join` arrives: the DO is
    // single-threaded so a counter read at socket-accept is race-free, whereas
    // several sockets can be accepted before any of them sends `join` — and
    // then they would all read the same peer count.
    const attachment: PeerAttachment = {
      role,
      displayName: null,
      userAgent: null,
      joined: false,
      peerId: crypto.randomUUID(),
      ordinal: this.nextOrdinal++,
    };
    await this.state.storage.put('nextOrdinal', this.nextOrdinal);
    // acceptWebSocket registers the socket for hibernatable delivery
    // (webSocketMessage/Close/Error below) instead of server.accept() +
    // addEventListener, so the DO doesn't have to stay resident to relay.
    this.state.acceptWebSocket(server);
    this.save(server, attachment);
    if (isHost) {
      this.closeExistingHosts(server);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const p = this.peer(ws);
    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(typeof message === 'string' ? message : '') as ClientMessage;
    } catch {
      return;
    }
    // `null` is valid JSON, and reading its `type` would throw.
    if (typeof parsed !== 'object' || parsed === null) return;

    // A socket is in the room from a `join` that passed the caps until its
    // close. Outside that it is answered on its own join and ping and nothing
    // else: closing a socket from this side does not stop its client sending,
    // so one refused at the cap or replaced could otherwise go on talking.
    if (p.left) return;
    if (!p.joined && parsed.type !== 'join' && parsed.type !== 'ping') return;

    switch (parsed.type) {
      case 'join':
        // A repeat would insert another participant row per message and
        // announce the same peer again.
        if (p.joined) break;
        if (typeof parsed.displayName !== 'string' || typeof parsed.userAgent !== 'string') {
          this.send(ws, {
            type: 'error',
            code: 'invalid_join',
            message: 'join requires string displayName and userAgent',
          });
          console.error('room:invalid_join');
          try {
            ws.close(WS_CLOSE_INVALID_MESSAGE, 'invalid_join');
          } catch {
            // already gone
          }
          return;
        }
        parsed.displayName = truncate(parsed.displayName, MAX_DISPLAY_NAME_LENGTH);
        parsed.userAgent = truncate(parsed.userAgent, MAX_USER_AGENT_LENGTH);
        p.displayName = parsed.displayName;
        p.userAgent = parsed.userAgent;
        // Capped: it is stored in the socket attachment, which has a size limit.
        if (typeof parsed.clientId === 'string' && parsed.clientId.length > 0 && parsed.clientId.length <= 64) {
          p.clientId = parsed.clientId;
          this.closeExistingClient(ws, parsed.clientId);
        }
        // Promote to host when the join carries a matching host_token (timing-safe).
        // This is the cross-origin path; the cookie path may already have set host.
        if (parsed.producer === true) {
          p.role = 'producer';
        } else if (
          typeof parsed.hostToken === 'string' &&
          this.hostToken &&
          timingSafeEqualHex(parsed.hostToken, this.hostToken)
        ) {
          p.role = 'host';
          this.save(ws, p);
          this.closeExistingHosts(ws);
        }
        if (parsed.companion === true) {
          p.companion = true;
        }
        this.save(ws, p);
        // Now the role is known: enforce per-role caps.
        // A companion does not count toward MAX_RECORDED_PEERS; it counts with
        // producers toward the 2 unrecorded slots.
        const isUnrecorded = p.role === 'producer' || p.companion === true;
        if (isUnrecorded) {
          const unrecorded = this.allPeers().filter(
            ({ ws: pws, p: pp }) => pws !== ws && pp.joined && (pp.role === 'producer' || pp.companion === true)
          ).length;
          if (unrecorded >= MAX_PRODUCERS) {
            try {
              ws.close(WS_CLOSE_CAPACITY_FULL, 'room_full');
            } catch {
              // already gone
            }
            return;
          }
        } else {
          const recorded = this.allPeers().filter(
            ({ ws: pws, p: pp }) => pws !== ws && pp.joined && pp.role !== 'producer' && !pp.companion
          ).length;
          if (recorded >= MAX_RECORDED_PEERS) {
            try {
              ws.close(WS_CLOSE_CAPACITY_FULL, 'room_full');
            } catch {
              // already gone
            }
            return;
          }
        }
        // Only now, and before the first await so a concurrent join counts
        // this seat: a socket refused above never becomes part of the room.
        p.joined = true;
        this.save(ws, p);
        // Reusable rooms: every join pushes the expiry out, so a weekly show
        // keeps one link alive. Unused rooms still lapse on their own.
        if (this.slug) {
          const expiresAt = Date.now() + ROOM_TTL_MS;
          await touchRoom(this.env.DB, this.slug, expiresAt).catch((e) => console.error('room:touchRoom', e));
          // Arms mid-call expiry: without this a room whose expires_at passes
          // during a call just runs on until everyone happens to leave.
          await this.state.storage.setAlarm(expiresAt);
        }
        if (!this.sessionId && this.slug) {
          // Assign ONLY after the row exists. Setting the field first meant a
          // failed insert left sessionId non-null, so this guard skipped
          // re-creation for the DO's whole lifetime and every later participant
          // referenced a session row that was never written. The throw was also
          // swallowed by the caller's .catch and happened before role-assigned
          // was sent, so the joining peer waited forever with no close event.
          const id = crypto.randomUUID();
          await insertSession(this.env.DB, {
            id,
            room_slug: this.slug,
            started_at: Date.now(),
          });
          this.sessionId = id;
          this.recordingCount = 0;
          await this.saveSession();
          await markRoomConsumed(this.env.DB, this.slug);
        }
        if (this.sessionId) {
          const partId = crypto.randomUUID();
          p.participantId = partId;
          this.save(ws, p);
          await insertParticipant(this.env.DB, {
            id: partId,
            session_id: this.sessionId,
            role: p.role,
            display_name: parsed.displayName,
            joined_at: Date.now(),
            left_at: null,
            user_agent: parsed.userAgent,
          });
        }
        this.send(ws, {
          type: 'role-assigned',
          role: p.role,
          peerCount: this.joinedPeers().length,
          peerId: p.peerId,
          ordinal: p.ordinal,
          recording: this.recording,
          ...(this.isNotRecorded(p) ? { notRecorded: true } : {}),
          // Everyone already here, so a late joiner can open a connection to
          // each of them rather than only learning about future arrivals.
          peers: this.allPeers()
            .filter(({ ws: pws, p: pp }) => pws !== ws && pp.joined)
            .map(({ p: pp }) => ({
              peerId: pp.peerId,
              role: pp.role,
              displayName: pp.displayName,
              ordinal: pp.ordinal,
              ...(pp.companion ? { companion: true } : {}),
              ...(this.isNotRecorded(pp) ? { notRecorded: true } : {}),
            })),
        });
        this.broadcastExcept(ws, {
          type: 'peer-joined',
          role: p.role,
          displayName: parsed.displayName,
          userAgent: parsed.userAgent,
          peerId: p.peerId,
          ordinal: p.ordinal,
          ...(p.companion ? { companion: true } : {}),
          ...(this.isNotRecorded(p) ? { notRecorded: true } : {}),
        });
        break;
      case 'ping':
        this.send(ws, { type: 'pong' });
        break;
      case 'webrtc-offer':
        this.relay(ws, parsed.to, {
          type: 'webrtc-offer',
          sdp: parsed.sdp,
          from: p.role,
          fromPeerId: p.peerId,
        });
        break;
      case 'webrtc-answer':
        this.relay(ws, parsed.to, {
          type: 'webrtc-answer',
          sdp: parsed.sdp,
          from: p.role,
          fromPeerId: p.peerId,
        });
        break;
      case 'ice-candidate':
        this.relay(ws, parsed.to, {
          type: 'ice-candidate',
          candidate: parsed.candidate,
          from: p.role,
          fromPeerId: p.peerId,
        });
        break;
      case 'chat':
        this.broadcastExcept(ws, {
          type: 'chat',
          text: parsed.text,
          ts: parsed.ts,
          from: p.role,
          fromPeerId: p.peerId,
          ...(p.displayName ? { fromName: p.displayName } : {}),
        });
        break;
      case 'presence':
        this.broadcastExcept(ws, {
          type: 'presence',
          micOn: parsed.micOn,
          camOn: parsed.camOn,
          screenSharing: parsed.screenSharing,
          from: p.role,
          fromPeerId: p.peerId,
          ...(p.displayName ? { fromName: p.displayName } : {}),
        });
        break;
      case 'marker':
        // Relayed, never persisted — the host owns the marker list and writes it
        // into the recording's sync sidecar.
        this.broadcastExcept(ws, {
          type: 'marker',
          label: parsed.label,
          from: p.role,
          fromPeerId: p.peerId,
          ...(p.displayName ? { fromName: p.displayName } : {}),
        });
        break;
      case 'leave':
        // onClose announces it, with the leaver's reason, and marks the socket
        // left — so the close callback that follows doesn't announce it again.
        await this.onClose(ws, parsed.reason);
        try {
          ws.close(1000, 'graceful');
        } catch {
          // ignore
        }
        break;
      case 'recording-started':
        // Relayed for every peer, but persisted only for the host. Recording
        // is room-wide: guests are entitled to know they are being recorded,
        // and the relay is what starts their own capture. (Chunk ACKs still flow
        // over DataChannel — this is a control signal, not an ack.)
        if (p.role === 'host') {
          this.recording = true;
          await this.saveSession();
        }
        this.broadcastExcept(ws, {
          type: 'recording-started',
          recordingId: parsed.recordingId,
          from: p.role,
        });
        // Persist a recordings row so D1 reflects the in-progress capture.
        // Only the host writes rows — guests write nothing to D1. What is
        // bounded is the row itself and how many of them a session gets.
        if (
          p.role === 'host' &&
          this.sessionId &&
          p.participantId &&
          this.recordingCount < MAX_RECORDINGS_PER_SESSION &&
          typeof parsed.recordingId === 'string' &&
          parsed.recordingId.length > 0 &&
          parsed.recordingId.length <= MAX_RECORDING_ID_LENGTH &&
          typeof parsed.filename === 'string' &&
          parsed.filename.length > 0 &&
          parsed.filename.length <= MAX_FILENAME_LENGTH &&
          (parsed.kind === 'camera' || parsed.kind === 'screen')
        ) {
          // Counted before the insert so concurrent announcements cannot both
          // pass the cap check; a row that never lands gives the seat back.
          this.recordingCount++;
          await this.saveSession();
          try {
            const written = await insertRecording(this.env.DB, {
              id: parsed.recordingId,
              session_id: this.sessionId,
              participant_id: p.participantId,
              kind: parsed.kind,
              filename: parsed.filename,
              total_bytes: 0,
              last_offset: 0,
              sha256: null,
              status: 'recording',
              started_at: Date.now(),
              finalized_at: null,
            });
            if (!written) {
              this.recordingCount--;
              await this.saveSession();
            }
          } catch (e) {
            this.recordingCount--;
            await this.saveSession();
            console.error('room:insertRecording', e);
          }
        }
        break;
      case 'recording-stop':
        // Relay only. The host owns the disk, so it owns the stop; guests wind
        // down and flush their tails over the DataChannel.
        if (p.role === 'host') {
          this.recording = false;
          await this.saveSession();
        }
        this.broadcastExcept(ws, {
          type: 'recording-stop',
          recordingId: parsed.recordingId,
          from: p.role,
        });
        break;
      case 'recording-capability':
        // Relay only, like presence — a live UI hint for the host, not room
        // state. Lets the host see before pressing Record which participants
        // won't be captured, and why.
        this.broadcastExcept(ws, {
          type: 'recording-capability',
          mp4: parsed.mp4,
          wav: parsed.wav,
          ...((BROWSER_NOTES as readonly unknown[]).includes(parsed.note) ? { note: parsed.note } : {}),
          from: p.role,
          fromPeerId: p.peerId,
        });
        break;
      case 'peer-recorded': {
        // The host's choice for the takes that follow. Refused from anyone else,
        // and while a take is running, so who is recorded never changes under a
        // capture already in progress.
        if (p.role !== 'host' || this.recording || typeof parsed.recorded !== 'boolean') break;
        const target = this.joinedPeers().find(({ p: pp }) => pp.peerId === parsed.peerId)?.p;
        // Only a guest whose tab sent a client id: that id is what the choice is
        // remembered by, and a choice that cannot be remembered is not announced.
        if (target?.role !== 'guest' || !target.clientId) break;
        const others = this.notRecorded.filter((id) => id !== target.clientId);
        this.notRecorded = parsed.recorded
          ? others
          : [...others, target.clientId].slice(-MAX_NOT_RECORDED_CLIENTS);
        await this.saveSession();
        // To everyone, the host too: its screen follows this answer, not its own click.
        for (const { ws: to } of this.joinedPeers()) {
          this.send(to, { type: 'peer-recorded', peerId: target.peerId, recorded: parsed.recorded });
        }
        break;
      }
    }
  }

  /**
   * Deliver to one addressed peer, or to everyone else when `to` is absent.
   *
   * Signalling MUST be addressed once there are more than two peers: an offer
   * meant for B would otherwise also reach C, which would answer a negotiation
   * it was never part of. The unaddressed fallback keeps the two-person path
   * working unchanged.
   */
  private relay(fromWs: WebSocket, to: string | undefined, msg: ServerMessage): void {
    if (!to) {
      this.broadcastExcept(fromWs, msg);
      return;
    }
    for (const { ws, p } of this.joinedPeers()) {
      if (p.peerId === to) {
        this.send(ws, msg);
        return;
      }
    }
  }

  private broadcastExcept(exceptWs: WebSocket, msg: ServerMessage): void {
    for (const { ws } of this.joinedPeers()) {
      if (ws === exceptWs) continue;
      this.send(ws, msg);
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    await this.onClose(ws);
    // Reciprocate to complete the closing handshake. Without this the peer
    // that called ws.close() never sees its own close event promptly — it
    // waits out the runtime's abandoned-connection timeout instead (10s+ in
    // real Chrome). _code may be 1005/1006 (no status received/abnormal),
    // neither of which is legal to send back, so this never echoes it.
    try {
      ws.close(1000, 'closing');
    } catch {
      // already closed
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.onClose(ws);
  }

  private async onClose(ws: WebSocket, reason = 'disconnect'): Promise<void> {
    const p = this.peer(ws);
    if (!p || p.left) return;
    p.left = true;
    this.save(ws, p);
    if (p.participantId) {
      await markParticipantLeft(this.env.DB, p.participantId, Date.now()).catch((e) => console.error('room:markParticipantLeft', e));
    }
    if (p.joined) {
      this.broadcastExcept(ws, { type: 'peer-left', role: p.role, reason, peerId: p.peerId });
    }
    // The host owns the recording, so its socket closing ends it. Otherwise a
    // crashed host leaves the room advertising `recording: true`, and the next
    // guest to join starts capturing into a host that is no longer there.
    if (p.role === 'host' && !this.anyHostPresent()) {
      this.recording = false;
      await this.saveSession();
    }
    // Joined peers, not sockets: one that is connected but never joined must
    // not hold the session open after everyone in the room has gone. Except a
    // socket that proved the host cookie at connect: that is the host
    // reconnecting, and it replaces its old socket before it has joined.
    // Ending here would clear `recording` under a take that is still running;
    // if it never joins, its own close lands here and ends the session.
    if (this.joinedPeers().length === 0 && !this.anyHostPresent() && this.sessionId) {
      await endSession(
        this.env.DB,
        this.sessionId,
        Date.now(),
        p.role === 'host' ? 'host-left' : 'guest-left'
      ).catch((e) => console.error('room:endSession', e));
      // Rooms are reusable, so the next gathering is a NEW session. Without
      // this, rejoining a still-warm DO would append participants to the
      // session that just ended.
      this.sessionId = null;
      this.recording = false;
      this.recordingCount = 0;
      this.notRecorded = [];
      await this.saveSession();
    }
  }

  /**
   * Enforce unique host: when a new host connection is admitted, close any
   * previously active host connection so the newest verified host wins.
   */
  private closeExistingHosts(exceptWs: WebSocket): void {
    for (const { ws, p } of this.allPeers()) {
      if (ws !== exceptWs && p.role === 'host') {
        try {
          ws.close(WS_CLOSE_REPLACED, 'replaced');
        } catch {
          // already gone
        }
        this.onClose(ws).catch((e) => console.error('room:onClose', e));
      }
    }
  }

  /**
   * Enforce per-tab client uniqueness: when a reconnecting tab presents a
   * clientId it already used, close the previous socket so a participant never
   * finds its own stale socket holding its seat.
   */
  private closeExistingClient(exceptWs: WebSocket, clientId: string): void {
    for (const { ws, p } of this.allPeers()) {
      if (ws !== exceptWs && p.clientId === clientId) {
        try {
          ws.close(WS_CLOSE_REPLACED, 'replaced');
        } catch {
          // already gone
        }
        this.onClose(ws).catch((e) => console.error('room:onClose', e));
      }
    }
  }

  /** Another host connection is still up (reconnect overlap, or a second tab). */
  private anyHostPresent(): boolean {
    for (const { p } of this.allPeers()) if (p.role === 'host') return true;
    return false;
  }

  /** The host set this guest as not recorded. Looked up by client id, so it holds across a reconnect. */
  private isNotRecorded(p: PeerAttachment): boolean {
    return p.role === 'guest' && !!p.clientId && this.notRecorded.includes(p.clientId);
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // peer gone; ignore
    }
  }
}
