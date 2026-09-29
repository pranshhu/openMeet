// FIPS 180-4 SHA-256, computed incrementally. O(1) memory: keeps only the eight
// 32-bit state words plus a <=64-byte block remainder — it does NOT retain the
// hashed bytes. The previous implementation buffered a copy of every chunk and
// concatenated them at digest time, so its memory grew with the whole recording
// (a multi-GB RAM sink on long calls). This streams instead.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export class StreamingSha256 {
  private readonly h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly block = new Uint8Array(64);
  private blockLen = 0;
  private totalLen = 0; // total bytes consumed
  private readonly w = new Uint32Array(64); // message-schedule scratch

  update(buf: ArrayBuffer | ArrayBufferView): void {
    const u8 = ArrayBuffer.isView(buf)
      ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
      : new Uint8Array(buf as ArrayBuffer);
    this.totalLen += u8.byteLength;
    let i = 0;
    // Top up a partial block from a previous update first.
    if (this.blockLen > 0) {
      while (i < u8.length && this.blockLen < 64) this.block[this.blockLen++] = u8[i++]!;
      if (this.blockLen === 64) {
        this.processBlock(this.h, this.w, this.block, 0);
        this.blockLen = 0;
      }
    }
    // Process full 64-byte blocks straight from the input (no copy).
    while (i + 64 <= u8.length) {
      this.processBlock(this.h, this.w, u8, i);
      i += 64;
    }
    // Stash the remainder for next time.
    while (i < u8.length) this.block[this.blockLen++] = u8[i++]!;
  }

  // Finalizes on a CLONE of the running state, so the instance can keep being
  // updated (and digested again) afterwards — matches the old digest-on-demand
  // semantics. Kept async to avoid churning the (awaited) call sites.
  async digestHex(): Promise<string> {
    const h = this.h.slice();
    const bitLen = this.totalLen * 8;
    // Padding: 0x80, zero-fill, then the 64-bit big-endian bit length.
    const padTo = this.blockLen < 56 ? 56 : 120;
    const tail = new Uint8Array(this.blockLen + (padTo - this.blockLen) + 8);
    tail.set(this.block.subarray(0, this.blockLen), 0);
    tail[this.blockLen] = 0x80;
    const dv = new DataView(tail.buffer);
    dv.setUint32(tail.length - 8, Math.floor(bitLen / 0x100000000));
    dv.setUint32(tail.length - 4, bitLen >>> 0);
    for (let off = 0; off < tail.length; off += 64) this.processBlock(h, this.w, tail, off);
    return [...h].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }

  private processBlock(h: Uint32Array, w: Uint32Array, data: Uint8Array, off: number): void {
    for (let t = 0; t < 16; t++) {
      const j = off + 4 * t;
      w[t] = ((data[j]! << 24) | (data[j + 1]! << 16) | (data[j + 2]! << 8) | data[j + 3]!) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15]!;
      const b = w[t - 2]!;
      const s0 = (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) >>> 0;
      const s1 = (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)) >>> 0;
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) | 0;
    }
    let a = h[0]!,
      b = h[1]!,
      c = h[2]!,
      d = h[3]!,
      e = h[4]!,
      f = h[5]!,
      g = h[6]!,
      hh = h[7]!;
    for (let t = 0; t < 64; t++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[t]! + w[t]!) | 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0]! + a) | 0;
    h[1] = (h[1]! + b) | 0;
    h[2] = (h[2]! + c) | 0;
    h[3] = (h[3]! + d) | 0;
    h[4] = (h[4]! + e) | 0;
    h[5] = (h[5]! + f) | 0;
    h[6] = (h[6]! + g) | 0;
    h[7] = (h[7]! + hh) | 0;
  }
}
