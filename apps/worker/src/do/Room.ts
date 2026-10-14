import {
  BROWSER_NOTES,
  MAX_PASSCODE_LENGTH,
  MAX_RECORDED_PEERS,
  MAX_SCRIPT_LENGTH,
  MIN_PASSCODE_LENGTH,
  ROOM_TTL_MS,
  WS_CLOSE_CAPACITY_FULL,
  WS_CLOSE_EXPIRED_SLUG,
  WS_CLOSE_INVALID_MESSAGE,
  WS_CLOSE_INVALID_SLUG,
  WS_CLOSE_NOT_ADMITTED,
  WS_CLOSE_REMOVED,
  WS_CLOSE_REPLACED,
  isHelpAsk,
  isListening,
  isLogo,
  isLookAccent,
  isReaction,
  titleFrom,
  type ClientMessage,
  type Role,
  type ServerMessage,
  type ServerRoomAccess,
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
  /** Held at the door by the waiting room: connected, and not part of the room. */
  waiting?: boolean;
  /** The host let this socket in, so neither the lock nor the waiting room holds it again. */
  admitted?: boolean;
  /** Wrong passcodes this socket has given, so one socket cannot guess without end. */
  passFails?: number;
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
  removed?: string[];
  locked?: boolean;
  admitted?: string[];
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
 * sixteen remembered tabs is generous: past that, the oldest tab that has left
 * is forgotten and arrives as recorded the next time it connects.
 */
const MAX_DISPLAY_NAME_LENGTH = 64;
const MAX_USER_AGENT_LENGTH = 512;
const MAX_RECORDING_ID_LENGTH = 64;
const MAX_FILENAME_LENGTH = 255;
const MAX_RECORDINGS_PER_SESSION = 256;
const MAX_NOT_RECORDED_CLIENTS = 16;
// Tabs the host removed, kept so the same tab stays out until the session
// ends. Past the bound the oldest is forgotten and can join again.
const MAX_REMOVED_CLIENTS = 16;
// Tabs seated in this session, kept so that a tab that was in the room can come
// back while it is locked. Past the bound, a tab that has left is forgotten
// before one that is still here.
const MAX_ADMITTED_CLIENTS = 32;
// Sockets the waiting room holds at once, and so the most a host is shown. The
// names are chosen by anyone with the link, so the list is bounded.
const MAX_WAITING = 8;
// Wrong passcodes one socket may give before it is closed, and the room as a
// whole in a window that starts at the first of them. The passcode is as short
// as six characters, so guesses are bounded per socket and across sockets.
const MAX_PASSCODE_TRIES_PER_SOCKET = 5;
const MAX_PASSCODE_TRIES_PER_ROOM = 20;
const PASSCODE_WINDOW_MS = 10 * 60_000;

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
  // Client ids of the tabs the host removed in this session. By client id for
  // the same reason: it is what a tab presents again on its next socket.
  private removed: string[] = [];
  // The host locked the room: a tab not in `admitted` is refused until it is
  // unlocked or the session ends.
  private locked = false;
  // Client ids of the tabs seated in this session that are not a host's.
  private admitted: string[] = [];
  // New people wait until the host lets them in. A setting of the room, not of
  // the session: it stays when everyone leaves, so it is kept under its own key.
  private waitingRoom = false;
  // Lowercase hex SHA-256 of `<slug>:<passcode>`; the passcode itself is never kept.
  private passcodeHash: string | null = null;
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
        this.removed = session.removed ?? [];
        this.locked = session.locked === true;
        this.admitted = session.admitted ?? [];
      }
      const access = await this.state.storage.get<{ waitingRoom?: boolean; passcodeHash?: string }>('access');
      this.waitingRoom = access?.waitingRoom === true;
      this.passcodeHash = typeof access?.passcodeHash === 'string' ? access.passcodeHash : null;
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

  /**
   * Close a socket the Room refuses to seat. It is flagged left first: the
   * close takes effect later, and what the socket has sent by then must not be
   * acted on as from a live one.
   */
  private refuse(ws: WebSocket, p: PeerAttachment, code: number, reason: string): void {
    p.left = true;
    this.save(ws, p);
    try {
      ws.close(code, reason);
    } catch {
      // already gone
    }
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

  /** The sockets the waiting room holds, in the order they arrived. */
  private waitingPeers(): Array<{ ws: WebSocket; p: PeerAttachment }> {
    return this.allPeers()
      .filter(({ p }) => p.waiting)
      .sort((a, b) => a.p.ordinal - b.p.ordinal);
  }

  private accessMessage(): ServerRoomAccess {
    return {
      type: 'room-access',
      locked: this.locked,
      waitingRoom: this.waitingRoom,
      passcode: this.passcodeHash !== null,
      waiting: this.waitingPeers().map(({ p }) => ({
        peerId: p.peerId,
        displayName: p.displayName ?? '',
        role: p.role === 'producer' ? ('producer' as const) : ('guest' as const),
        ...(p.companion ? { companion: true } : {}),
      })),
    };
  }

  private async saveAccess(): Promise<void> {
    await this.state.storage.put('access', {
      waitingRoom: this.waitingRoom,
      ...(this.passcodeHash ? { passcodeHash: this.passcodeHash } : {}),
    });
  }

  private async passcodeDigest(passcode: string): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${this.slug}:${passcode}`));
    return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** The wrong passcodes the room has counted, or null once their window has passed. */
  private async passcodeFails(): Promise<{ count: number; since: number } | null> {
    const fails = await this.state.storage.get<{ count: number; since: number }>('passFails');
    return fails && Date.now() - fails.since < PASSCODE_WINDOW_MS ? fails : null;
  }

  private tellHosts(): void {
    const msg = this.accessMessage();
    for (const { ws, p } of this.joinedPeers()) {
      if (p.role === 'host') this.send(ws, msg);
    }
  }

  private async saveSession(): Promise<void> {
    await this.state.storage.put('session', {
      sessionId: this.sessionId,
      recording: this.recording,
      recordingCount: this.recordingCount,
      notRecorded: this.notRecorded,
      removed: this.removed,
      locked: this.locked,
      admitted: this.admitted,
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
        // announce the same peer again; a waiting socket's name is the one the
        // host was shown.
        if (p.joined || p.waiting) break;
        if (typeof parsed.displayName !== 'string' || typeof parsed.userAgent !== 'string') {
          this.send(ws, {
            type: 'error',
            code: 'invalid_join',
            message: 'join requires string displayName and userAgent',
          });
          console.error('room:invalid_join');
          this.refuse(ws, p, WS_CLOSE_INVALID_MESSAGE, 'invalid_join');
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
        // A tab the host removed stays out until the session ends. A host is
        // never refused: the token outranks whatever id its tab presents.
        if (p.role !== 'host' && p.clientId && this.removed.includes(p.clientId)) {
          this.refuse(ws, p, WS_CLOSE_REMOVED, 'removed');
          return;
        }
        // A locked room seats nobody it has not seated already in this session.
        // A host is never refused, and the link is the same for every role.
        const seatedBefore = !!p.clientId && this.admitted.includes(p.clientId);
        if (this.locked && p.role !== 'host' && !p.admitted && !seatedBefore) {
          this.refuse(ws, p, WS_CLOSE_NOT_ADMITTED, 'locked');
          return;
        }
        // A room with a passcode seats nobody who has not given it, on the same
        // terms as the lock. The socket stays open and unseated, and may send
        // `join` again with another try.
        if (this.passcodeHash && p.role !== 'host' && !p.admitted && !seatedBefore) {
          if ((this.peer(ws).passFails ?? 0) >= MAX_PASSCODE_TRIES_PER_SOCKET) {
            this.refuse(ws, p, WS_CLOSE_NOT_ADMITTED, 'passcode');
            return;
          }
          const given = parsed.passcode;
          if (typeof given !== 'string' || given.length === 0 || given.length > MAX_PASSCODE_LENGTH) {
            this.send(ws, { type: 'door', state: 'passcode' });
            return;
          }
          const spent = await this.passcodeFails();
          if (spent && spent.count >= MAX_PASSCODE_TRIES_PER_ROOM) {
            this.refuse(ws, p, WS_CLOSE_NOT_ADMITTED, 'passcode');
            return;
          }
          const digest = await this.passcodeDigest(given);
          // The awaits above let this socket's other messages run; whatever
          // they did to its attachment, or to the passcode, is what counts.
          const now = this.peer(ws);
          if (now.joined || now.waiting || now.left) return;
          if (this.passcodeHash && !timingSafeEqualHex(digest, this.passcodeHash)) {
            const fails = (await this.passcodeFails()) ?? { count: 0, since: Date.now() };
            await this.state.storage.put('passFails', { count: fails.count + 1, since: fails.since });
            p.passFails = (now.passFails ?? 0) + 1;
            this.save(ws, p);
            if (p.passFails >= MAX_PASSCODE_TRIES_PER_SOCKET) {
              this.refuse(ws, p, WS_CLOSE_NOT_ADMITTED, 'passcode');
              return;
            }
            this.send(ws, { type: 'door', state: 'passcode', wrong: true });
            return;
          }
        }
        // With the waiting room on, a newcomer is held until the host answers:
        // it is not seated, and so creates no row, extends no expiry and is
        // reached by nothing that goes to the room.
        if (this.waitingRoom && p.role !== 'host' && !p.admitted && !seatedBefore) {
          if (this.waitingPeers().length >= MAX_WAITING) {
            this.refuse(ws, p, WS_CLOSE_NOT_ADMITTED, 'busy');
            return;
          }
          p.waiting = true;
          this.save(ws, p);
          this.send(ws, { type: 'door', state: 'waiting' });
          this.tellHosts();
          return;
        }
        // Now the role is known: enforce per-role caps.
        // A companion does not count toward MAX_RECORDED_PEERS; it counts with
        // producers toward the 2 unrecorded slots.
        const isUnrecorded = p.role === 'producer' || p.companion === true;
        if (isUnrecorded) {
          const unrecorded = this.allPeers().filter(
            ({ ws: pws, p: pp }) => pws !== ws && pp.joined && (pp.role === 'producer' || pp.companion === true)
          ).length;
          if (unrecorded >= MAX_PRODUCERS) {
            this.refuse(ws, p, WS_CLOSE_CAPACITY_FULL, 'room_full');
            return;
          }
        } else {
          const recorded = this.allPeers().filter(
            ({ ws: pws, p: pp }) => pws !== ws && pp.joined && pp.role !== 'producer' && !pp.companion
          ).length;
          if (recorded >= MAX_RECORDED_PEERS) {
            this.refuse(ws, p, WS_CLOSE_CAPACITY_FULL, 'room_full');
            return;
          }
        }
        // Only now, and before the first await so a concurrent join counts
        // this seat: a socket refused above never becomes part of the room.
        p.joined = true;
        this.save(ws, p);
        if (p.role !== 'host' && p.clientId && !this.admitted.includes(p.clientId)) {
          const next = [...this.admitted, p.clientId];
          if (next.length > MAX_ADMITTED_CLIENTS) {
            const here = new Set(this.joinedPeers().map(({ p: pp }) => pp.clientId));
            next.splice(Math.max(next.findIndex((id) => !here.has(id)), 0), 1);
          }
          this.admitted = next;
          await this.saveSession();
        }
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
        if (p.role === 'host') this.send(ws, this.accessMessage());
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
      case 'private-message': {
        // One person's message for one other person in the room. Unlike the
        // relays around it, it goes to that socket alone and never falls
        // back to the room: a `to` that is not another joined peer's id
        // matches nobody, and the message is dropped.
        const target = this.joinedPeers().find(({ ws: tws, p: pp }) => tws !== ws && pp.peerId === parsed.to);
        if (!target) break;
        this.send(target.ws, {
          type: 'private-message',
          text: parsed.text,
          from: p.role,
          fromPeerId: p.peerId,
          ...(p.displayName ? { fromName: p.displayName } : {}),
        });
        break;
      }
      case 'presence':
        this.broadcastExcept(ws, {
          type: 'presence',
          micOn: parsed.micOn,
          camOn: parsed.camOn,
          screenSharing: parsed.screenSharing,
          // A raised hand travels only as a real `true`: the field is the
          // sender's, and every other screen draws what is passed on here.
          ...(parsed.handRaised === true ? { handRaised: true } : {}),
          // The title is the sender's own text: it goes on only when it is
          // one, and as the trimmed text, so no page draws more than it is
          // allowed to hold.
          ...(titleFrom(parsed.title) ? { title: titleFrom(parsed.title) } : {}),
          from: p.role,
          fromPeerId: p.peerId,
          ...(p.displayName ? { fromName: p.displayName } : {}),
        });
        break;
      case 'reaction':
        // Relay only, like presence: a picture on the sender's tile for a
        // moment. Nothing is kept, and a code that is not on the list goes
        // nowhere, so no page is handed one it cannot draw. Only the code
        // travels, whatever else the message carried.
        if (!isReaction(parsed.reaction)) break;
        this.broadcastExcept(ws, {
          type: 'reaction',
          reaction: parsed.reaction,
          from: p.role,
          fromPeerId: p.peerId,
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
      case 'recording-countdown':
        // A cue for the other screens that the host is about to record. Only
        // the host's is passed on, and nothing is kept: the take starts with
        // recording-started, so `recording` stays as it was.
        if (p.role !== 'host' || !Number.isFinite(parsed.seconds)) break;
        this.broadcastExcept(ws, { type: 'recording-countdown', seconds: parsed.seconds });
        break;
      case 'script':
        // The host's teleprompter script, for the others to take or leave.
        // Only the host's is passed on, and only a text within the bound.
        // Nothing is kept, so a person who joins later is not sent it.
        if (
          p.role !== 'host' ||
          typeof parsed.text !== 'string' ||
          parsed.text.length > MAX_SCRIPT_LENGTH
        ) {
          break;
        }
        this.broadcastExcept(ws, { type: 'script', text: parsed.text });
        break;
      case 'look':
        // The host's accent colour for the name tags and logo. Only the
        // host's is passed on, with an accent only when it is on the list and
        // a logo only when isLogo accepts it. Nothing is kept, so a person who
        // joins later is sent it by the host's page.
        if (p.role !== 'host') break;
        this.broadcastExcept(ws, {
          type: 'look',
          ...(isLookAccent(parsed.accent) ? { accent: parsed.accent } : {}),
          ...(isLogo(parsed.logo) ? { logo: parsed.logo } : {}),
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
          ...(isListening(parsed.listening) ? { listening: parsed.listening } : {}),
          from: p.role,
          fromPeerId: p.peerId,
        });
        break;
      case 'peer-mute': {
        // A request, passed on only from the host and only to the one person
        // named. That person's own page turns the microphone off and can turn
        // it back on; the Room reaches no microphone, and nothing here turns
        // one on.
        if (p.role !== 'host' || typeof parsed.peerId !== 'string') break;
        const target = this.joinedPeers().find(({ ws: to, p: pp }) => to !== ws && pp.peerId === parsed.peerId);
        if (target) this.send(target.ws, { type: 'peer-mute' });
        break;
      }
      case 'peer-help': {
        // A question, passed on only from the host, only to the one person
        // named, and only as the fixed shape. Their own page asks them and
        // acts on their press alone; nothing is kept and no answer comes back.
        if (p.role !== 'host' || typeof parsed.peerId !== 'string' || !isHelpAsk(parsed.ask)) break;
        const target = this.joinedPeers().find(({ ws: to, p: pp }) => to !== ws && pp.peerId === parsed.peerId);
        if (target) this.send(target.ws, { type: 'peer-help', ask: parsed.ask });
        break;
      }
      case 'peer-remove': {
        // Only the host removes, and never a host. The tab is remembered before
        // its socket is closed, so it cannot be seated again in between.
        if (p.role !== 'host' || typeof parsed.peerId !== 'string') break;
        const target = this.joinedPeers().find(({ p: pp }) => pp.peerId === parsed.peerId);
        if (!target || target.p.role === 'host') break;
        const clientId = target.p.clientId;
        if (clientId) {
          this.removed = [...this.removed, clientId].slice(-MAX_REMOVED_CLIENTS);
          await this.saveSession();
        }
        try {
          target.ws.close(WS_CLOSE_REMOVED, 'removed');
        } catch {
          // already gone
        }
        // Tells everyone else, with this reason, and marks the socket left, so
        // the close callback that follows does not tell them again.
        await this.onClose(target.ws, 'removed');
        break;
      }
      case 'room-access': {
        // Only the host changes these, and each only with a real boolean (the
        // passcode with `null` or a string of the allowed length). Nobody is
        // closed by the lock or the passcode: they decide the joins that come
        // after. Turning the waiting room off lets in everyone who waits.
        const lock = typeof parsed.locked === 'boolean';
        const door = typeof parsed.waitingRoom === 'boolean';
        const code = parsed.passcode;
        const pass =
          code === null ||
          (typeof code === 'string' && code.length >= MIN_PASSCODE_LENGTH && code.length <= MAX_PASSCODE_LENGTH);
        if (p.role !== 'host' || !(lock || door || pass)) break;
        if (lock) {
          this.locked = parsed.locked === true;
          await this.saveSession();
        }
        if (door) {
          this.waitingRoom = parsed.waitingRoom === true;
          await this.saveAccess();
          if (!this.waitingRoom) {
            for (const target of this.waitingPeers()) await this.answerWaiting(target.ws, true);
          }
        }
        if (pass) {
          this.passcodeHash = typeof code === 'string' ? await this.passcodeDigest(code) : null;
          await this.saveAccess();
          await this.state.storage.delete('passFails');
        }
        this.tellHosts();
        break;
      }
      case 'admit': {
        // Only the host answers, for a socket that waits (a `peerId` that is not
        // a string names none) and with a real boolean.
        if (p.role !== 'host' || typeof parsed.admit !== 'boolean') break;
        const target = this.waitingPeers().find(({ p: pp }) => pp.peerId === parsed.peerId);
        if (!target) break;
        await this.answerWaiting(target.ws, parsed.admit);
        this.tellHosts();
        break;
      }
      case 'peer-recorded': {
        // The host's choice for the takes that follow. Refused from anyone else,
        // and while a take is running, so who is recorded never changes under a
        // capture already in progress.
        if (p.role !== 'host' || this.recording || typeof parsed.recorded !== 'boolean') break;
        const target = this.joinedPeers().find(({ p: pp }) => pp.peerId === parsed.peerId)?.p;
        // Only a guest whose tab sent a client id: that id is what the choice is
        // remembered by, and a choice that cannot be remembered is not announced.
        if (target?.role !== 'guest' || !target.clientId) break;
        const next = this.notRecorded.filter((id) => id !== target.clientId);
        if (!parsed.recorded) next.push(target.clientId);
        // Past the bound, a tab that has left is forgotten before one that is
        // still here: a guest in the room must not become recorded again
        // because sixteen others came and went.
        if (next.length > MAX_NOT_RECORDED_CLIENTS) {
          const here = new Set(this.joinedPeers().map(({ p: pp }) => pp.clientId));
          next.splice(Math.max(next.findIndex((id) => !here.has(id)), 0), 1);
        }
        this.notRecorded = next;
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

  /**
   * Let a waiting socket in, or refuse it. Letting in runs the `join` path
   * again from what the socket's attachment holds (its role, companion flag and
   * client id are there already), so the caps, the rows, the `role-assigned`
   * and the `peer-joined` are the ones every join gets.
   */
  private async answerWaiting(ws: WebSocket, admit: boolean): Promise<void> {
    const p = this.peer(ws);
    if (admit) {
      p.waiting = false;
      p.admitted = true;
      this.save(ws, p);
      await this.webSocketMessage(
        ws,
        JSON.stringify({ type: 'join', displayName: p.displayName ?? '', userAgent: p.userAgent ?? '' })
      );
      return;
    }
    try {
      ws.close(WS_CLOSE_NOT_ADMITTED, 'refused');
    } catch {
      // already gone
    }
    await this.onClose(ws, 'refused');
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
    if (p.waiting) this.tellHosts();
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
      this.removed = [];
      this.locked = false;
      this.admitted = [];
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
