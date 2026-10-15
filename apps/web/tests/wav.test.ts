import { describe, it, expect } from 'vitest';
import { wavHeader, f32ToS24LE, resizeWavHeader, WAV_HEADER_BYTES, type WavFormat } from '@/lib/wav';

const str = (v: DataView, off: number, len: number) =>
  Array.from({ length: len }, (_, i) => String.fromCharCode(v.getUint8(off + i))).join('');

describe('wavHeader', () => {
  it('writes an 80-byte RIFF/WAVE PCM header that reserves a JUNK chunk', () => {
    const buf = wavHeader({ sampleRate: 48000, channels: 1, bitDepth: 24 }, 1_440_000);
    expect(buf.byteLength).toBe(WAV_HEADER_BYTES);
    expect(WAV_HEADER_BYTES).toBe(80);
    const v = new DataView(buf);
    expect(str(v, 0, 4)).toBe('RIFF');
    expect(str(v, 8, 4)).toBe('WAVE');
    expect(str(v, 12, 4)).toBe('JUNK');
    expect(v.getUint32(16, true)).toBe(28);
    expect(Array.from(new Uint8Array(buf, 20, 28))).toEqual(new Array(28).fill(0));
    expect(str(v, 48, 4)).toBe('fmt ');
    expect(str(v, 72, 4)).toBe('data');
    expect(v.getUint32(4, true)).toBe(72 + 1_440_000); // everything after this field
    expect(v.getUint32(52, true)).toBe(16); // PCM fmt chunk length
    expect(v.getUint16(56, true)).toBe(1); // linear PCM
    expect(v.getUint16(58, true)).toBe(1); // channels
    expect(v.getUint32(60, true)).toBe(48000);
    expect(v.getUint32(64, true)).toBe(48000 * 1 * 3); // byte rate
    expect(v.getUint16(68, true)).toBe(3); // block align
    expect(v.getUint16(70, true)).toBe(24);
    expect(v.getUint32(76, true)).toBe(1_440_000);
  });

  it('derives byte rate and block align from channel count', () => {
    const v = new DataView(wavHeader({ sampleRate: 44100, channels: 2, bitDepth: 24 }, 0));
    expect(v.getUint32(64, true)).toBe(44100 * 2 * 3);
    expect(v.getUint16(68, true)).toBe(6);
  });

  // The placeholder written at offset 0 before any samples exist. It must still
  // be a structurally valid header, because a crashed session leaves it in place
  // and the file should open (truncated) rather than be unreadable.
  it('is valid with dataBytes 0 (the placeholder case)', () => {
    const v = new DataView(wavHeader({ sampleRate: 48000, channels: 1, bitDepth: 24 }, 0));
    expect(str(v, 0, 4)).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(72);
    expect(v.getUint32(76, true)).toBe(0);
  });

  it('is RIFF at the largest plain size and RF64 one frame past it', () => {
    const f: WavFormat = { sampleRate: 48000, channels: 2, bitDepth: 24 };
    const frame = 6;
    const plain = Math.floor((0xffff_ffff - 72) / frame) * frame;
    const below = new DataView(wavHeader(f, plain));
    expect(str(below, 0, 4)).toBe('RIFF');
    expect(below.getUint32(4, true)).toBe(72 + plain);
    expect(below.getUint32(76, true)).toBe(plain);

    const whole = plain + frame;
    const past = new DataView(wavHeader(f, whole));
    expect(past.byteLength).toBe(WAV_HEADER_BYTES);
    expect(str(past, 0, 4)).toBe('RF64');
    expect(past.getUint32(4, true)).toBe(0xffff_ffff);
    expect(str(past, 12, 4)).toBe('ds64');
    expect(past.getUint32(16, true)).toBe(28);
    expect(past.getBigUint64(20, true)).toBe(BigInt(72 + whole));
    expect(past.getBigUint64(28, true)).toBe(BigInt(whole));
    expect(past.getBigUint64(36, true)).toBe(BigInt(whole / frame));
    expect(past.getUint32(76, true)).toBe(0xffff_ffff);
  });

  it.each([1, 2])('is the header resizeWavHeader writes for the same length, %i channel(s)', (channels) => {
    const f: WavFormat = { sampleRate: 48000, channels, bitDepth: 24 };
    const frame = channels * 3;
    for (const n of [frame, 1000 * frame, Math.ceil(2 ** 32 / frame) * frame, 2 ** 34 + frame]) {
      expect(Array.from(new Uint8Array(wavHeader(f, n)))).toEqual(
        Array.from(new Uint8Array(resizeWavHeader(wavHeader(f, 0), WAV_HEADER_BYTES + n)!))
      );
    }
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

describe('resizeWavHeader', () => {
  const fmt = (channels: number): WavFormat => ({ sampleRate: 48000, channels, bitDepth: 24 });
  const ascii = (v: DataView, off: number, text: string) => {
    for (let i = 0; i < text.length; i++) v.setUint8(off + i, text.charCodeAt(i));
  };
  /** A header with 28 bytes reserved after WAVE, 80 bytes in all: RIFF, size, WAVE, JUNK, 28, zeros, fmt, data, size. */
  const roomy = (f: WavFormat, dataBytes = 0): ArrayBuffer => {
    const buf = new ArrayBuffer(80);
    const v = new DataView(buf);
    ascii(v, 0, 'RIFF');
    v.setUint32(4, 72 + dataBytes, true);
    ascii(v, 8, 'WAVE');
    ascii(v, 12, 'JUNK');
    v.setUint32(16, 28, true);
    ascii(v, 48, 'fmt ');
    v.setUint32(52, 16, true);
    v.setUint16(56, 1, true);
    v.setUint16(58, f.channels, true);
    v.setUint32(60, f.sampleRate, true);
    v.setUint32(64, (f.sampleRate * f.channels * f.bitDepth) / 8, true);
    v.setUint16(68, (f.channels * f.bitDepth) / 8, true);
    v.setUint16(70, f.bitDepth, true);
    ascii(v, 72, 'data');
    v.setUint32(76, dataBytes, true);
    return buf;
  };
  /** A 44-byte header with no reserved chunk, as a file written before the room was reserved starts. */
  const plain44 = (f: WavFormat, dataBytes = 0): ArrayBuffer => {
    const buf = new ArrayBuffer(44);
    const v = new DataView(buf);
    ascii(v, 0, 'RIFF');
    v.setUint32(4, Math.min(36 + dataBytes, 0xffff_ffff), true);
    ascii(v, 8, 'WAVE');
    ascii(v, 12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, f.channels, true);
    v.setUint32(24, f.sampleRate, true);
    v.setUint32(28, (f.sampleRate * f.channels * f.bitDepth) / 8, true);
    v.setUint16(32, (f.channels * f.bitDepth) / 8, true);
    v.setUint16(34, f.bitDepth, true);
    ascii(v, 36, 'data');
    v.setUint32(40, Math.min(dataBytes, 0xffff_ffff), true);
    return buf;
  };
  const bytesOf = (b: ArrayBuffer | null) => (b ? Array.from(new Uint8Array(b)) : null);

  it.each([1, 2])('writes the header wavHeader writes for whole frames of %i channel(s)', (channels) => {
    const f = fmt(channels);
    for (const frames of [1, 1000]) {
      const bytes = frames * channels * 3;
      expect(bytesOf(resizeWavHeader(wavHeader(f, 0), WAV_HEADER_BYTES + bytes))).toEqual(bytesOf(wavHeader(f, bytes)));
    }
  });

  it('declares whole frames only when the file ends part-way through one', () => {
    expect(bytesOf(resizeWavHeader(wavHeader(fmt(1), 0), WAV_HEADER_BYTES + 3 * 10 + 2))).toEqual(
      bytesOf(wavHeader(fmt(1), 30))
    );
    expect(bytesOf(resizeWavHeader(wavHeader(fmt(2), 0), WAV_HEADER_BYTES + 6 * 10 + 5))).toEqual(
      bytesOf(wavHeader(fmt(2), 60))
    );
  });

  it('keeps a header with reserved room as RIFF with a JUNK chunk below the limit', () => {
    const out = new DataView(resizeWavHeader(roomy(fmt(2)), 80 + 600)!);
    expect(out.byteLength).toBe(80);
    expect(str(out, 0, 4)).toBe('RIFF');
    expect(out.getUint32(4, true)).toBe(72 + 600);
    expect(str(out, 12, 4)).toBe('JUNK');
    expect(out.getUint32(16, true)).toBe(28);
    expect(out.getUint32(76, true)).toBe(600);
  });

  it('turns a header with reserved room into RF64 once the sizes pass 32 bits', () => {
    const frame = 6;
    const plain = Math.floor((0xffff_ffff - 72) / frame) * frame;
    const below = new DataView(resizeWavHeader(roomy(fmt(2)), 80 + plain)!);
    expect(str(below, 0, 4)).toBe('RIFF');
    expect(below.getUint32(4, true)).toBe(72 + plain);
    expect(below.getUint32(76, true)).toBe(plain);

    const whole = plain + frame;
    const past = new DataView(resizeWavHeader(roomy(fmt(2)), 80 + whole)!);
    expect(past.byteLength).toBe(80);
    expect(str(past, 0, 4)).toBe('RF64');
    expect(past.getUint32(4, true)).toBe(0xffff_ffff);
    expect(str(past, 12, 4)).toBe('ds64');
    expect(past.getUint32(16, true)).toBe(28);
    expect(past.getBigUint64(20, true)).toBe(BigInt(72 + whole));
    expect(past.getBigUint64(28, true)).toBe(BigInt(whole));
    expect(past.getBigUint64(36, true)).toBe(BigInt(whole / frame));
    expect(past.getUint32(44, true)).toBe(0);
    expect(str(past, 48, 4)).toBe('fmt ');
    expect(str(past, 72, 4)).toBe('data');
    expect(past.getUint32(76, true)).toBe(0xffff_ffff);
  });

  it('turns an RF64 header back into RIFF with a zeroed JUNK chunk when the file is small', () => {
    const rf64 = roomy(fmt(2));
    const v = new DataView(rf64);
    ascii(v, 0, 'RF64');
    v.setUint32(4, 0xffff_ffff, true);
    ascii(v, 12, 'ds64');
    v.setBigUint64(20, 123456789n, true);
    v.setBigUint64(28, 99n, true);
    v.setBigUint64(36, 77n, true);
    v.setUint32(76, 0xffff_ffff, true);
    expect(bytesOf(resizeWavHeader(rf64, 80 + 600))).toEqual(bytesOf(roomy(fmt(2), 600)));
  });

  it('saturates a header whose 28-byte JUNK chunk sits after fmt, leaving every other byte as it is', () => {
    const base = new Uint8Array(plain44(fmt(1)));
    const late = new Uint8Array(base.length + 36);
    late.set(base.subarray(0, 36));
    const v = new DataView(late.buffer);
    ascii(v, 36, 'JUNK');
    v.setUint32(40, 28, true);
    late.fill(0xab, 44, 72);
    late.set(base.subarray(36), 72);
    const expected = new Uint8Array(late);
    const e = new DataView(expected.buffer);
    e.setUint32(4, 0xffff_ffff, true);
    e.setUint32(76, 0xffff_ffff, true);
    const out = resizeWavHeader(late.buffer, late.length + 2 ** 32 + 5)!;
    expect(bytesOf(out)).toEqual(Array.from(expected));
    expect(str(new DataView(out), 0, 4)).toBe('RIFF');
    expect(str(new DataView(out), 12, 4)).toBe('fmt ');
  });

  it('is RIFF when the RIFF size is exactly 0xFFFFFFFF and RF64 one frame more', () => {
    const whole = 0xffff_ffff - 72;
    const exact = new DataView(resizeWavHeader(roomy(fmt(1)), 80 + whole)!);
    expect(str(exact, 0, 4)).toBe('RIFF');
    expect(exact.getUint32(4, true)).toBe(0xffff_ffff);
    expect(str(exact, 12, 4)).toBe('JUNK');
    expect(exact.getUint32(76, true)).toBe(whole);

    const past = new DataView(resizeWavHeader(roomy(fmt(1)), 80 + whole + 3)!);
    expect(str(past, 0, 4)).toBe('RF64');
    expect(past.getBigUint64(20, true)).toBe(BigInt(72 + whole + 3));
  });

  it('writes a ds64 table length of 0 whatever the header had there', () => {
    const rf64 = roomy(fmt(1));
    const v = new DataView(rf64);
    ascii(v, 0, 'RF64');
    ascii(v, 12, 'ds64');
    v.setUint32(44, 0xdead_beef, true);
    const out = new DataView(resizeWavHeader(rf64, 80 + 2 ** 32 + 5)!);
    expect(str(out, 12, 4)).toBe('ds64');
    expect(out.getUint32(44, true)).toBe(0);
  });

  it('saturates both fields of a 44-byte header, which has no reserved room', () => {
    const out = resizeWavHeader(plain44(fmt(1)), 44 + 2 ** 32 + 5)!;
    expect(bytesOf(out)).toEqual(bytesOf(plain44(fmt(1), 2 ** 32 + 5)));
    const v = new DataView(out);
    expect(out.byteLength).toBe(44);
    expect(v.getUint32(4, true)).toBe(0xffff_ffff);
    expect(v.getUint32(40, true)).toBe(0xffff_ffff);
  });

  it('sizes a 44-byte header below the limit', () => {
    const out = new DataView(resizeWavHeader(plain44(fmt(2)), 44 + 600)!);
    expect(out.getUint32(4, true)).toBe(36 + 600);
    expect(out.getUint32(40, true)).toBe(600);
  });

  it('reads the frame as 1 when the header states one that does not fit its channels and depth, or is over 64', () => {
    const at = WAV_HEADER_BYTES - 4;
    const lying = wavHeader(fmt(1), 0);
    new DataView(lying).setUint16(68, 60, true);
    expect(new DataView(resizeWavHeader(lying, WAV_HEADER_BYTES + 7)!).getUint32(at, true)).toBe(7);
    const huge = wavHeader({ sampleRate: 48000, channels: 64, bitDepth: 24 }, 0);
    expect(new DataView(resizeWavHeader(huge, WAV_HEADER_BYTES + 200)!).getUint32(at, true)).toBe(200);
    const big = wavHeader({ sampleRate: 48000, channels: 16, bitDepth: 32 }, 0);
    expect(new DataView(resizeWavHeader(big, WAV_HEADER_BYTES + 130)!).getUint32(at, true)).toBe(128);
    const wide = wavHeader({ sampleRate: 48000, channels: 65, bitDepth: 8 }, 0);
    expect(new DataView(resizeWavHeader(wide, WAV_HEADER_BYTES + 130)!).getUint32(at, true)).toBe(130);
  });

  it('walks past a chunk of odd size and its pad byte to find the data', () => {
    const base = new Uint8Array(plain44(fmt(1)));
    const withList = new Uint8Array(base.length + 12);
    withList.set(base.subarray(0, 36));
    const v = new DataView(withList.buffer);
    ascii(v, 36, 'LIST');
    v.setUint32(40, 3, true);
    withList.set(base.subarray(36), 36 + 12);
    const out = resizeWavHeader(withList.buffer, withList.length + 30)!;
    expect(out.byteLength).toBe(withList.length);
    expect(new DataView(out).getUint32(withList.length - 4, true)).toBe(30);
  });

  it('treats a first chunk as reserved room only when it is JUNK or ds64 of 28 bytes', () => {
    // A JUNK chunk of 20 bytes ahead of fmt: padding of some other tool, kept as it is.
    const base = new Uint8Array(plain44(fmt(1)));
    const padded = new Uint8Array(base.length + 28);
    padded.set(base.subarray(0, 12));
    const v = new DataView(padded.buffer);
    ascii(v, 12, 'JUNK');
    v.setUint32(16, 20, true);
    padded.fill(0xab, 20, 40);
    padded.set(base.subarray(12), 40);
    const out = new Uint8Array(resizeWavHeader(padded.buffer, padded.length + 30)!);
    expect(out.subarray(12, 40)).toEqual(padded.subarray(12, 40));
    expect(new DataView(out.buffer).getUint32(padded.length - 4, true)).toBe(30);
  });

  it('reads only the first bytes a header can take', () => {
    const base = new Uint8Array(plain44(fmt(1)));
    const far = new Uint8Array(base.length + 60);
    far.set(base.subarray(0, 36));
    const v = new DataView(far.buffer);
    ascii(v, 36, 'LIST');
    v.setUint32(40, 52, true);
    far.set(base.subarray(36), 36 + 60);
    expect(resizeWavHeader(far.buffer, 10000)).toBeNull();
  });

  it('returns null for a fmt chunk shorter than 16 bytes, even when data follows it', () => {
    const base = new Uint8Array(plain44(fmt(1)));
    const short = new Uint8Array(base.length - 2);
    short.set(base.subarray(0, 34));
    short.set(base.subarray(36), 34);
    new DataView(short.buffer).setUint32(16, 14, true);
    expect(resizeWavHeader(short.buffer, 1000)).toBeNull();
  });

  it('returns null for a head that is not a header it can read', () => {
    const good = () => new Uint8Array(plain44(fmt(1)));
    expect(resizeWavHeader(plain44(fmt(1)).slice(0, 43), 1000)).toBeNull();
    const magic = good();
    magic[0] = 0x58;
    expect(resizeWavHeader(magic.buffer, 1000)).toBeNull();
    const wave = good();
    wave[8] = 0x58;
    expect(resizeWavHeader(wave.buffer, 1000)).toBeNull();
    const noFmt = good();
    noFmt[12] = 0x58;
    expect(resizeWavHeader(noFmt.buffer, 1000)).toBeNull();
    const noData = good();
    noData[36] = 0x58;
    expect(resizeWavHeader(noData.buffer, 1000)).toBeNull();
    const jump = good();
    new DataView(jump.buffer).setUint32(16, 5000, true);
    expect(resizeWavHeader(jump.buffer, 1000)).toBeNull();
    const short = good();
    new DataView(short.buffer).setUint32(16, 12, true);
    expect(resizeWavHeader(short.buffer, 1000)).toBeNull();
    const room = new DataView(roomy(fmt(1)));
    room.setUint32(16, 5000, true);
    expect(resizeWavHeader(room.buffer, 100000)).toBeNull();
  });

  it('returns null when the file holds no sound past its header', () => {
    expect(resizeWavHeader(wavHeader(fmt(1), 0), WAV_HEADER_BYTES)).toBeNull();
    expect(resizeWavHeader(wavHeader(fmt(1), 0), WAV_HEADER_BYTES - 1)).toBeNull();
    expect(resizeWavHeader(wavHeader(fmt(1), 0), Number.NaN)).toBeNull();
    expect(resizeWavHeader(roomy(fmt(1)), 80)).toBeNull();
  });

  it('never throws on random 80-byte heads', () => {
    for (let n = 0; n < 50; n++) {
      const bytes = new Uint8Array(80);
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
      const seed = new Uint8Array(roomy(fmt(1)));
      for (let i = 0; i < 80; i += 1 + (n % 3)) seed[i] = bytes[i]!;
      expect(() => resizeWavHeader(bytes.buffer, 5000)).not.toThrow();
      expect(() => resizeWavHeader(seed.buffer, 2 ** 33)).not.toThrow();
    }
  });
});
