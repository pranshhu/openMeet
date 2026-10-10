import {
  isServerMessage,
  WS_CLOSE_CAPACITY_FULL,
  WS_CLOSE_EXPIRED_SLUG,
  WS_CLOSE_INVALID_SLUG,
  WS_CLOSE_REMOVED,
  WS_CLOSE_REPLACED,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_HEARTBEAT_TIMEOUT_MS,
  type ClientMessage,
  type ServerMessage,
} from '@openmeet/protocol';
import { nextBackoffMs } from './backoff';

type ServerType = ServerMessage['type'];
type Handler<T extends ServerType> = (msg: Extract<ServerMessage, { type: T }>) => void;

// Server-initiated close codes that are terminal: reconnecting would just be
// rejected again, so surface them to the caller instead of looping with backoff.
const FATAL_CLOSE_CODES = new Set<number>([
  WS_CLOSE_CAPACITY_FULL,
  WS_CLOSE_INVALID_SLUG,
  WS_CLOSE_EXPIRED_SLUG,
  WS_CLOSE_REMOVED,
  WS_CLOSE_REPLACED,
]);

export interface SignalClientOpts {
  slug: string;
  wsBase: string;
  displayName: string;
  userAgent: string;
  // Present only for the host (cross-origin host auth). Sent in the join message.
  hostToken?: string;
  /** Join as an unrecorded observer. */
  producer?: boolean;
  /** Join as a screen-sharing companion. */
  companion?: boolean;
  /** Per-tab client ID so a reconnecting tab replaces its own stale socket. */
  clientId?: string;
  // Invoked when the server closes with a terminal code (room full / invalid /
  // expired). No reconnect is attempted after this fires.
  onFatalClose?: (code: number, reason: string) => void;
  wsFactory?: (url: string) => WebSocket;
}

export class SignalClient {
  private readonly opts: SignalClientOpts;
  private readonly factory: (url: string) => WebSocket;
  private ws: WebSocket | null = null;
  private handlers = new Map<ServerType, Set<(m: ServerMessage) => void>>();
  /** When the socket last proved it was alive. Drives the heartbeat deadline. */
  private lastSeenAt = 0;
  private anyHandlers = new Set<(m: ServerMessage) => void>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closed = false;

  constructor(opts: SignalClientOpts) {
    this.opts = opts;
    this.factory = opts.wsFactory ?? ((url) => new WebSocket(url));
  }

  connect(): void {
    this.closed = false;
    const url = `${this.opts.wsBase}/ws/r/${this.opts.slug}`;
    const ws = this.factory(url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.send({
        type: 'join',
        displayName: this.opts.displayName,
        userAgent: this.opts.userAgent,
        // exactOptionalPropertyTypes: only include the key when defined.
        ...(this.opts.hostToken ? { hostToken: this.opts.hostToken } : {}),
        ...(this.opts.producer ? { producer: true } : {}),
        ...(this.opts.companion ? { companion: true } : {}),
        ...(this.opts.clientId ? { clientId: this.opts.clientId } : {}),
      });
      this.startHeartbeat();
    };
    ws.onmessage = (ev: { data: unknown }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (!isServerMessage(parsed)) return;
      const msg = parsed;
      // ANY frame proves the socket is alive, not just `pong`. A busy call is
      // constantly relaying chat, presence and ICE, so treating those as
      // liveness avoids tearing down a healthy connection that merely lost one
      // heartbeat.
      this.lastSeenAt = Date.now();
      this.anyHandlers.forEach((h) => h(msg));
      this.handlers.get(msg.type)?.forEach((h) => h(msg));
    };
    ws.onclose = (ev?: { code?: number; reason?: string }) => {
      this.stopHeartbeat();
      if (this.closed) return;
      const code = ev?.code ?? 0;
      if (FATAL_CLOSE_CODES.has(code)) {
        // Terminal rejection — don't reconnect; let the caller render the reason.
        this.closed = true;
        this.opts.onFatalClose?.(code, ev?.reason ?? '');
        return;
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // close handler drives reconnect; nothing extra needed.
    };
  }

  on<T extends ServerType>(type: T, handler: Handler<T>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    const wrapped = handler as (m: ServerMessage) => void;
    set.add(wrapped);
    return () => set!.delete(wrapped);
  }

  onAny(handler: (m: ServerMessage) => void): () => void {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
  }

  /**
   * Immediately close the current socket (if any) and establish a new connection.
   * Resets the backoff attempt counter and detaches handlers from the old socket.
   */
  reconnect(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.abandon(this.ws);
    }
    this.attempt = 0;
    this.connect();
  }

  /**
   * Ping on a timer AND enforce a reply deadline.
   *
   * The pings went out but nothing ever read a `pong` — there was no pong
   * handler at all, and WS_HEARTBEAT_TIMEOUT_MS sat in constants with zero
   * references. The feature was implemented halfway. So on a half-open socket
   * (mobile NAT rebind, laptop sleep) readyState stayed 1, `onclose` never
   * fired and reconnect never ran: chat, presence, markers and — worst —
   * `recording-stop` all silently stopped being delivered while the UI showed a
   * healthy call. The guest recorded indefinitely and the host truncated its
   * tail waiting for a finalize that could never arrive.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastSeenAt = Date.now();
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastSeenAt > WS_HEARTBEAT_TIMEOUT_MS) {
        // A genuinely half-open socket never sends a close frame back, so
        // Chrome's closing-handshake timeout can hold `close()` for ~60s
        // before `onclose` fires. Waiting on it would mean every
        // watchdog-detected death costs an extra 60s before reconnecting. So
        // detach this socket's handlers (a late onclose must not drive a
        // second reconnect) and schedule the reconnect ourselves, immediately.
        this.stopHeartbeat();
        if (this.ws) this.abandon(this.ws);
        this.scheduleReconnect();
        return;
      }
      this.send({ type: 'ping' });
    }, WS_HEARTBEAT_INTERVAL_MS);
  }

  private abandon(ws: WebSocket): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      /* already gone */
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private scheduleReconnect(): void {
    const delay = nextBackoffMs(this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
