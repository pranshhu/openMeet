import { describe, it, expect } from 'vitest';
import { wavHeader, f32ToS24LE, WAV_HEADER_BYTES } from '@/lib/wav';

const str = (v: DataView, off: number, len: number) =>
  Array.from({ length: len }, (_, i) => String.fromCharCode(v.getUint8(off + i))).join('');

describe('wavHeader', () => {
  it('writes a canonical 44-byte RIFF/WAVE PCM header', () => {
    const buf = wavHeader({ sampleRate: 48000, channels: 1, bitDepth: 24 }, 1_440_000);
    expect(buf.byteLength).toBe(WAV_HEADER_BYTES);
    const v = new DataView(buf);
    expect(str(v, 0, 4)).toBe('RIFF');
    expect(str(v, 8, 4)).toBe('WAVE');
    expect(str(v, 12, 4)).toBe('fmt ');
    expect(str(v, 36, 4)).toBe('data');
    expect(v.getUint32(4, true)).toBe(36 + 1_440_000); // everything after this field
    expect(v.getUint32(16, true)).toBe(16); // PCM fmt chunk length
    expect(v.getUint16(20, true)).toBe(1); // linear PCM
    expect(v.getUint16(22, true)).toBe(1); // channels
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint32(28, true)).toBe(48000 * 1 * 3); // byte rate
    expect(v.getUint16(32, true)).toBe(3); // block align
    expect(v.getUint16(34, true)).toBe(24);
    expect(v.getUint32(40, true)).toBe(1_440_000);
  });

  it('derives byte rate and block align from channel count', () => {
    const v = new DataView(wavHeader({ sampleRate: 44100, channels: 2, bitDepth: 24 }, 0));
    expect(v.getUint32(28, true)).toBe(44100 * 2 * 3);
    expect(v.getUint16(32, true)).toBe(6);
  });

  // The placeholder written at offset 0 before any samples exist. It must still
  // be a structurally valid header, because a crashed session leaves it in place
  // and the file should open (truncated) rather than be unreadable.
  it('is valid with dataBytes 0 (the placeholder case)', () => {
    const v = new DataView(wavHeader({ sampleRate: 48000, channels: 1, bitDepth: 24 }, 0));
    expect(str(v, 0, 4)).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(36);
    expect(v.getUint32(40, true)).toBe(0);
  });
});

describe('f32ToS24LE', () => {
  it('produces 3 bytes per sample', () => {
    expect(f32ToS24LE(new Float32Array(10)).byteLength).toBe(30);
  });

  it('maps full scale symmetrically and silence to zero', () => {
    const out = new Uint8Array(f32ToS24LE(new Float32Array([0, 1, -1])));
    const read = (i: number) => {
      const b = (out[i * 3]! | (out[i * 3 + 1]! << 8) | (out[i * 3 + 2]! << 16)) << 8;
      return b >> 8; // sign-extend 24 -> 32
    };
    expect(read(0)).toBe(0);
    expect(read(1)).toBe(8388607); // 2^23 - 1
    expect(read(2)).toBe(-8388607); // symmetric, cannot overflow the sign bit
  });

  it('clamps out-of-range samples instead of wrapping', () => {
    // Wrapping would turn a loud peak into a full-scale sample of the OPPOSITE
    // sign — an audible click, and the classic way naive PCM conversion fails.
    const out = new Uint8Array(f32ToS24LE(new Float32Array([2.5, -2.5])));
    const read = (i: number) => {
      const b = (out[i * 3]! | (out[i * 3 + 1]! << 8) | (out[i * 3 + 2]! << 16)) << 8;
      return b >> 8;
    };
    expect(read(0)).toBe(8388607);
    expect(read(1)).toBe(-8388607);
  });

  it('writes little-endian byte order', () => {
    // 0.5 * 8388607 = 4194303.5 -> 4194304 = 0x400000
    const out = new Uint8Array(f32ToS24LE(new Float32Array([0.5])));
    expect(Array.from(out)).toEqual([0x00, 0x00, 0x40]);
  });
});
