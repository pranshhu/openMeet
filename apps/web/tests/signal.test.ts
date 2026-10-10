import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SignalClient } from '@/lib/signal';
import { WS_HEARTBEAT_INTERVAL_MS, WS_HEARTBEAT_TIMEOUT_MS, type ServerMessage } from '@openmeet/protocol';

class FakeWS {
  static instances: FakeWS[] = [];
  url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; }
  fireOpen() { this.readyState = 1; this.onopen?.(); }
  fireMessage(m: ServerMessage) { this.onmessage?.({ data: JSON.stringify(m) }); }
  fireClose(code = 1006) { this.readyState = 3; this.onclose?.({ code, reason: '' }); }
}

describe('SignalClient', () => {
  beforeEach(() => {
    FakeWS.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeClient() {
    return new SignalClient({
      slug: 'xyz-abcd-pqr',
      wsBase: 'ws://localhost:8787',
      displayName: 'Alice',
      userAgent: 'test-ua',
      wsFactory: (url) => new FakeWS(url) as unknown as WebSocket,
    });
  }

  it('connects to the DO ws path and sends join on open', () => {
    const c = makeClient();
    c.connect();
    const ws = FakeWS.instances[0]!;
    expect(ws.url).toBe('ws://localhost:8787/ws/r/xyz-abcd-pqr');
    ws.fireOpen();
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      type: 'join',
      displayName: 'Alice',
      userAgent: 'test-ua',
    });
  });

  it('includes hostToken in the join message when provided (host)', () => {
    const c = new SignalClient({
      slug: 'xyz-abcd-pqr',
      wsBase: 'ws://localhost:8787',
      displayName: 'Host',
      userAgent: 'test-ua',
      hostToken: 'tok-secret',
      wsFactory: (url) => new FakeWS(url) as unknown as WebSocket,
    });
    c.connect();
    const ws = FakeWS.instances[0]!;
    ws.fireOpen();
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      type: 'join',
      displayName: 'Host',
      userAgent: 'test-ua',
      hostToken: 'tok-secret',
    });
  });

  it('includes companion in the join message when companion is true', () => {
    const c = new SignalClient({
      slug: 'xyz-abcd-pqr',
      wsBase: 'ws://localhost:8787',
      displayName: 'Alice Companion',
      userAgent: 'test-ua',
      companion: true,
      wsFactory: (url) => new FakeWS(url) as unknown as WebSocket,
    });
    c.connect();
    const ws = FakeWS.instances[0]!;
    ws.fireOpen();
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      type: 'join',
      displayName: 'Alice Companion',
      userAgent: 'test-ua',
      companion: true,
    });
  });

  it('includes clientId in the join message when provided', () => {
    const c = new SignalClient({
      slug: 'xyz-abcd-pqr',
      wsBase: 'ws://localhost:8787',
      displayName: 'Alice',
      userAgent: 'test-ua',
      clientId: 'tab-1234',
      wsFactory: (url) => new FakeWS(url) as unknown as WebSocket,
    });
    c.connect();
    const ws = FakeWS.instances[0]!;
    ws.fireOpen();
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      type: 'join',
      displayName: 'Alice',
      userAgent: 'test-ua',
      clientId: 'tab-1234',
    });
  });

  it('preserves clientId in the join message when reconnecting', () => {
    const c = new SignalClient({
      slug: 'xyz-abcd-pqr',
      wsBase: 'ws://localhost:8787',
      displayName: 'Alice',
      userAgent: 'test-ua',
      clientId: 'tab-1234',
      wsFactory: (url) => new FakeWS(url) as unknown as WebSocket,
    });
    c.connect();
    const ws1 = FakeWS.instances[0]!;
    ws1.fireOpen();
    ws1.fireClose(1006);
    vi.advanceTimersByTime(1000);
    expect(FakeWS.instances.length).toBe(2);
    const ws2 = FakeWS.instances[1]!;
    ws2.fireOpen();
    expect(JSON.parse(ws2.sent[0]!)).toEqual({
      type: 'join',
      displayName: 'Alice',
      userAgent: 'test-ua',
      clientId: 'tab-1234',
    });
  });

  it('dispatches typed server messages to subscribers', () => {
    const c = makeClient();
    const onRole = vi.fn();
    c.on('role-assigned', onRole);
    c.connect();
    const ws = FakeWS.instances[0]!;
    ws.fireOpen();
    ws.fireMessage({ type: 'role-assigned', role: 'host', peerCount: 1, peerId: 'p1', ordinal: 0, peers: [] });
    expect(onRole).toHaveBeenCalledWith({ type: 'role-assigned', role: 'host', peerCount: 1, peerId: 'p1', ordinal: 0, peers: [] });
  });

  it('ignores malformed (non-protocol) messages', () => {
    const c = makeClient();
    const spy = vi.fn();
    c.onAny(spy);
    c.connect();
    const ws = FakeWS.instances[0]!;
    ws.fireOpen();
    ws.onmessage?.({ data: 'not json' });
    ws.onmessage?.({ data: JSON.stringify({ type: 'bogus' }) });
    expect(spy).not.toHaveBeenCalled();
  });

  it('sends ping on the heartbeat interval', () => {
    const c = makeClient();
    c.connect();
    const ws = FakeWS.instances[0]!;
    ws.fireOpen();
    ws.sent.length = 0;
    vi.advanceTimersByTime(30_000);
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: 'ping' });
  });

  it('reconnects with backoff after unexpected close, re-joining', () => {
    const c = makeClient();
    c.connect();
    const ws1 = FakeWS.instances[0]!;
    ws1.fireOpen();
    ws1.fireClose(1006);
    vi.advanceTimersByTime(1000);
    expect(FakeWS.instances.length).toBe(2);
    FakeWS.instances[1]!.fireOpen();
    expect(JSON.parse(FakeWS.instances[1]!.sent[0]!).type).toBe('join');
  });

  it('does not reconnect on a fatal close code and reports it', () => {
    const onFatalClose = vi.fn();
    const c = new SignalClient({
      slug: 'xyz-abcd-pqr',
      wsBase: 'ws://localhost:8787',
      displayName: 'Bob',
      userAgent: 'test-ua',
      onFatalClose,
      wsFactory: (url) => new FakeWS(url) as unknown as WebSocket,
    });
    c.connect();
    FakeWS.instances[0]!.fireOpen();
    FakeWS.instances[0]!.fireClose(4001); // WS_CLOSE_CAPACITY_FULL
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.instances.length).toBe(1); // no reconnect attempt
    expect(onFatalClose).toHaveBeenCalledWith(4001, '');
  });

  it('does not reconnect on code 4006 (WS_CLOSE_REPLACED) and reports it', () => {
    const onFatalClose = vi.fn();
    const c = new SignalClient({
      slug: 'xyz-abcd-pqr',
      wsBase: 'ws://localhost:8787',
      displayName: 'Host',
      userAgent: 'test-ua',
      onFatalClose,
      wsFactory: (url) => new FakeWS(url) as unknown as WebSocket,
    });
    c.connect();
    FakeWS.instances[0]!.fireOpen();
    FakeWS.instances[0]!.fireClose(4006); // WS_CLOSE_REPLACED
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.instances.length).toBe(1); // no reconnect attempt
    expect(onFatalClose).toHaveBeenCalledWith(4006, '');
  });

  it('a watchdog-detected death reconnects immediately without waiting for onclose, and a late onclose on the abandoned socket does not open a third socket', () => {
    const c = makeClient();
    c.connect();
    const ws1 = FakeWS.instances[0]!;
    ws1.fireOpen();

    // Trip the heartbeat watchdog. ws1.close() (called internally) never fires
    // onclose in this fake, exactly like Chrome's real ~60s closing-handshake
    // hang on a genuinely half-open socket: no close frame ever comes back.
    vi.advanceTimersByTime(Math.ceil(WS_HEARTBEAT_TIMEOUT_MS / WS_HEARTBEAT_INTERVAL_MS + 1) * WS_HEARTBEAT_INTERVAL_MS);
    // The reconnect must not wait on the dead socket's onclose: it is scheduled
    // eagerly by the watchdog itself, with the normal backoff (attempt 0 = 1s).
    vi.advanceTimersByTime(1000);
    expect(FakeWS.instances.length).toBe(2);
    expect(ws1.readyState).toBe(3);

    // The abandoned socket's close handshake finally completes, long after the
    // watchdog already moved on. Must be a no-op, not a second reconnect.
    ws1.fireClose(1006);
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.instances.length).toBe(2);
  });

  it('does not reconnect after an intentional close()', () => {
    const c = makeClient();
    c.connect();
    FakeWS.instances[0]!.fireOpen();
    c.close();
    FakeWS.instances[0]!.fireClose(1000);
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.instances.length).toBe(1);
  });

  it('reconnect() closes the current socket and opens a new connection immediately', () => {
    const c = makeClient();
    c.connect();
    const ws1 = FakeWS.instances[0]!;
    ws1.fireOpen();
    c.reconnect();
    expect(ws1.readyState).toBe(3);
    expect(FakeWS.instances.length).toBe(2);
    const ws2 = FakeWS.instances[1]!;
    ws2.fireOpen();
    expect(JSON.parse(ws2.sent[0]!).type).toBe('join');
  });
});

describe('SignalClient: removed by the host', () => {
  beforeEach(() => {
    FakeWS.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not reconnect on code 4007 (WS_CLOSE_REMOVED) and reports it', () => {
    const onFatalClose = vi.fn();
    const c = new SignalClient({
      slug: 'xyz-abcd-pqr',
      wsBase: 'ws://localhost:8787',
      displayName: 'Guest',
      userAgent: 'test-ua',
      onFatalClose,
      wsFactory: (url) => new FakeWS(url) as unknown as WebSocket,
    });
    c.connect();
    FakeWS.instances[0]!.fireOpen();
    FakeWS.instances[0]!.fireClose(4007);
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.instances.length).toBe(1); // no reconnect attempt
    expect(onFatalClose).toHaveBeenCalledWith(4007, '');
  });
});
