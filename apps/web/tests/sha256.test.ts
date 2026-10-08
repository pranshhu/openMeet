import { describe, it, expect } from 'vitest';
import { StreamingSha256 } from '@/lib/sha256';

describe('StreamingSha256', () => {
  it('matches a known SHA-256 vector for "abc"', async () => {
    const h = new StreamingSha256();
    h.update(new TextEncoder().encode('abc').buffer);
    expect(await h.digestHex()).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('is order-sensitive across multiple updates', async () => {
    const a = new StreamingSha256();
    a.update(new TextEncoder().encode('ab').buffer);
    a.update(new TextEncoder().encode('c').buffer);
    const b = new StreamingSha256();
    b.update(new TextEncoder().encode('abc').buffer);
    expect(await a.digestHex()).toBe(await b.digestHex());
  });

  it('digests empty input to the empty SHA-256', async () => {
    const h = new StreamingSha256();
    expect(await h.digestHex()).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });

  async function webcryptoHex(bytes: Uint8Array): Promise<string> {
    // Copy into a fresh ArrayBuffer-backed view so it satisfies BufferSource
    // under the newer generic Uint8Array<ArrayBufferLike> lib types.
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    const d = await crypto.subtle.digest('SHA-256', copy);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Exercises every padding branch: exact-block (64), block-boundary lengths
  // (55/56/57 straddle the < 56 pad cutoff), and large multi-block input.
  it.each([0, 1, 55, 56, 57, 63, 64, 65, 127, 128, 1000, 100_000])(
    'matches WebCrypto for %i pseudo-random bytes',
    async (n) => {
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = (i * 2654435761) & 0xff; // deterministic
      const h = new StreamingSha256();
      h.update(bytes);
      expect(await h.digestHex()).toBe(await webcryptoHex(bytes));
    }
  );

  it('matches WebCrypto regardless of how updates are split', async () => {
    const total = new Uint8Array(5000);
    for (let i = 0; i < total.length; i++) total[i] = (i * 40503) & 0xff;
    const h = new StreamingSha256();
    // Irregular split sizes, including ones that cross 64-byte boundaries.
    let off = 0;
    for (const size of [1, 63, 1, 64, 100, 7, 64, 4700]) {
      h.update(total.subarray(off, off + size));
      off += size;
    }
    expect(off).toBe(total.length);
    expect(await h.digestHex()).toBe(await webcryptoHex(total));
  });

  it('can be digested more than once and keep updating (clone-finalize)', async () => {
    const h = new StreamingSha256();
    h.update(new TextEncoder().encode('ab'));
    const first = await h.digestHex();
    const second = await h.digestHex(); // digest must not mutate running state
    expect(second).toBe(first);
    h.update(new TextEncoder().encode('c'));
    const ref = new StreamingSha256();
    ref.update(new TextEncoder().encode('abc'));
    expect(await h.digestHex()).toBe(await ref.digestHex());
  });

  it('continues from a restored state across three updates as it does from one', async () => {
    const bytes = new Uint8Array(200);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
    const whole = new StreamingSha256();
    whole.update(bytes);
    const expected = await whole.digestHex();

    let h = new StreamingSha256();
    h.update(bytes.subarray(0, 70));
    h = StreamingSha256.fromJSON(JSON.parse(JSON.stringify(h.toJSON())))!;
    h.update(bytes.subarray(70, 135));
    h = StreamingSha256.fromJSON(JSON.parse(JSON.stringify(h.toJSON())))!;
    h.update(bytes.subarray(135));
    expect(await h.digestHex()).toBe(expected);
  });

  it('returns null from fromJSON for anything that is not a running state', async () => {
    const good = new StreamingSha256();
    good.update(new Uint8Array([1, 2, 3]));
    const state = JSON.parse(JSON.stringify(good.toJSON()));

    const cases: unknown[] = [
      { ...state, words: state.words.slice(1) },
      { ...state, words: [...state.words, 0] },
      { ...state, words: [...state.words.slice(1), 1.5] },
      { ...state, words: [...state.words.slice(1), -1] },
      { ...state, words: [...state.words.slice(1), 2 ** 32] },
      { ...state, length: 65, remainder: new Array(65).fill(0) },
      { ...state, length: state.length + 1 },
      { ...state, remainder: [256, 0, 0] },
      { ...state, remainder: [-1, 0, 0] },
      { ...state, remainder: [1.5, 0, 0] },
      { ...state, length: -64, remainder: [] },
      { ...state, length: 1.5 },
      { ...state, length: 2 ** 53, remainder: [] },
      null,
      'x',
      {},
    ];
    for (const value of cases) {
      expect(StreamingSha256.fromJSON(value)).toBeNull();
    }
    expect(await StreamingSha256.fromJSON(state)!.digestHex()).toBe(await good.digestHex());
  });

  it('leaves a live digest unchanged when restore refuses a value', async () => {
    const h = new StreamingSha256();
    h.update(new TextEncoder().encode('abc'));
    const before = await h.digestHex();

    for (const value of [null, 'x', {}, { words: [1], remainder: [], length: 0 }]) {
      expect(h.restore(value)).toBe(false);
    }
    expect(await h.digestHex()).toBe(before);

    h.update(new TextEncoder().encode('d'));
    const reference = new StreamingSha256();
    reference.update(new TextEncoder().encode('abcd'));
    expect(await h.digestHex()).toBe(await reference.digestHex());
  });

  it('keeps the state bounded however much is hashed', async () => {
    for (const n of [200, 1_000_000]) {
      const h = new StreamingSha256();
      h.update(new Uint8Array(n));
      const state = h.toJSON();
      expect(state.words).toHaveLength(8);
      expect(state.remainder.length).toBeLessThanOrEqual(64);
      expect(state.length).toBe(n);
      expect(JSON.stringify(state).length).toBeLessThan(1024);
    }
  });
});
