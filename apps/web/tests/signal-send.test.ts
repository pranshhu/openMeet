import { describe, it, expect } from 'vitest';
import { SignalClient } from '@/lib/signal';

// Just enough of a socket for send: a state, and what was written to it.
class FakeWS {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: unknown = null;
  onclose: unknown = null;
  onerror: unknown = null;
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
}

describe('SignalClient.send', () => {
  it('says whether the message went out: true on an open socket, false on one that is not', () => {
    const ws = new FakeWS();
    const c = new SignalClient({
      slug: 'xyz-abcd-pqr',
      wsBase: 'ws://localhost:8787',
      displayName: 'Alice',
      userAgent: 'test-ua',
      wsFactory: () => ws as unknown as WebSocket,
    });
    expect(c.send({ type: 'ping' })).toBe(false);

    c.connect();
    expect(c.send({ type: 'ping' })).toBe(false);
    expect(ws.sent).toEqual([]);

    ws.readyState = 1;
    ws.onopen?.();
    expect(c.send({ type: 'ping' })).toBe(true);
    expect(ws.sent.map((d) => JSON.parse(d).type)).toEqual(['join', 'ping']);

    // Also stops the heartbeat that opening started.
    c.close();
    expect(c.send({ type: 'ping' })).toBe(false);
  });
});
