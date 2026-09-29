import '@testing-library/jest-dom/vitest';

// jsdom lacks WebRTC + media APIs. Tests that need them install fakes per-test.
// This file only ensures the globals exist so imports of lib modules don't throw
// at module-eval time. Behavior is supplied by per-test mocks (see peer.test.ts,
// media.test.ts).
if (!('RTCPeerConnection' in globalThis)) {
  (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = class {};
}
if (!('MediaStream' in globalThis) || typeof (globalThis as any).MediaStream.prototype?.getTracks !== 'function') {
  (globalThis as any).MediaStream = class MockMediaStream {
    private _tracks: any[];
    constructor(tracks: any[] = []) {
      this._tracks = [...tracks];
    }
    getTracks() {
      return this._tracks;
    }
    getAudioTracks() {
      return this._tracks.filter((t) => t.kind === 'audio');
    }
    getVideoTracks() {
      return this._tracks.filter((t) => t.kind === 'video');
    }
    addTrack(t: any) {
      this._tracks.push(t);
    }
    removeTrack(t: any) {
      const i = this._tracks.indexOf(t);
      if (i !== -1) this._tracks.splice(i, 1);
    }
  };
}

// This jsdom build ships no Storage at all, so anything that persists user
// settings silently took its private-mode fallback path in tests and the real
// behaviour went uncovered. Minimal in-memory implementation.
if (typeof (globalThis as { localStorage?: unknown }).localStorage === 'undefined') {
  const store = new Map<string, string>();
  class MemStorage {
    getItem(k: string): string | null {
      return store.has(k) ? (store.get(k) as string) : null;
    }
    setItem(k: string, v: string): void {
      store.set(k, String(v));
    }
    removeItem(k: string): void {
      store.delete(k);
    }
    clear(): void {
      store.clear();
    }
    key(i: number): string | null {
      return Array.from(store.keys())[i] ?? null;
    }
    get length(): number {
      return store.size;
    }
  }
  (globalThis as { localStorage?: unknown; Storage?: unknown }).Storage = MemStorage;
  (globalThis as { localStorage?: unknown }).localStorage = new MemStorage();
  (globalThis as { sessionStorage?: unknown }).sessionStorage = new MemStorage();
}

// jsdom ships no PointerEvent, so fireEvent.pointerDown delivers an event with
// NO clientX/clientY at all — any drag handler under test silently computes NaN.
// Extending MouseEvent gets the coordinates for free.
if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string } = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? 'mouse';
    }
  }
  (globalThis as { PointerEvent?: unknown }).PointerEvent = PointerEventPolyfill;
  if (typeof window !== 'undefined') {
    (window as unknown as { PointerEvent?: unknown }).PointerEvent = PointerEventPolyfill;
  }
}

// Pointer capture is likewise absent; the drag handler calls it unconditionally.
if (typeof Element !== 'undefined' && !Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = function () {};
  Element.prototype.releasePointerCapture = function () {};
  Element.prototype.hasPointerCapture = function () {
    return false;
  };
}
