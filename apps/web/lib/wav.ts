/**
 * RIFF/WAVE header for linear PCM, plus the float->int conversion the recorder
 * needs.
 *
 * The header carries the total data size, which isn't known until recording
 * ends. That's fine here: FileWriter does POSITIONAL writes, so we emit a
 * placeholder header at offset 0, stream samples from offset 80, and rewrite
 * offset 0 at finalize. An append-only transport would need a rewrite pass.
 *
 * Every header this app writes keeps a 28-byte `JUNK` chunk after `WAVE`. When
 * a master passes 4 GiB the chunk becomes `ds64` and the file is RF64, which
 * ffmpeg and most audio editors read in full. A 44-byte header, from a file
 * written without that room, has nowhere to put 64-bit sizes and saturates.
 */

export const WAV_HEADER_BYTES = 80;

/** Largest value a RIFF size field can hold. */
const U32_MAX = 0xffff_ffff;

/**
 * Saturate rather than wrap.
 *
 * These fields are 32-bit, and `setUint32` silently takes the value mod 2^32,
 * so a header with no reserved chunk that described a session past 4 GiB
 * (24-bit/48k stereo crosses it at 4h08m) declared a WRONG SMALL number and
 * every decoder stopped there. A 5-hour recording read as 51 minutes with no
 * error anywhere.
 *
 * Clamping declares more data than the file holds, which decoders handle by
 * reading to EOF. Measured with ffprobe on a 1-second file: honest header reads
 * 1.000s, clamped reads 1.000s, wrapped reads 0.244s. Clamping recovers
 * everything; wrapping loses most of it. Only a 44-byte header reaches this,
 * because a header with the reserved chunk is written as RF64 instead.
 */
function u32(n: number): number {
  return n > U32_MAX ? U32_MAX : n;
}

export interface WavFormat {
  sampleRate: number;
  channels: number;
  bitDepth: number;
}

/**
 * 80-byte header: RIFF, a reserved `JUNK` chunk, `fmt `, `data`. `dataBytes`
 * may be 0 for the placeholder written at start. The sizes come from
 * `resizeWavHeader`, so a header and a later resize of it never disagree.
 */
export function wavHeader(fmt: WavFormat, dataBytes: number): ArrayBuffer {
  const { sampleRate, channels, bitDepth } = fmt;
  const bytesPerSample = bitDepth / 8;
  const buf = new ArrayBuffer(WAV_HEADER_BYTES);
  const view = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, WAV_HEADER_BYTES - 8, true); // size of everything after this field
  ascii(8, 'WAVE');
  ascii(12, 'JUNK');
  view.setUint32(16, RESERVED_BYTES, true);
  ascii(48, 'fmt ');
  view.setUint32(52, 16, true); // PCM fmt chunk length
  view.setUint16(56, 1, true); // 1 = linear PCM
  view.setUint16(58, channels, true);
  view.setUint32(60, sampleRate, true);
  view.setUint32(64, sampleRate * channels * bytesPerSample, true); // byte rate
  view.setUint16(68, channels * bytesPerSample, true); // block align
  view.setUint16(70, bitDepth, true);
  ascii(72, 'data');
  return dataBytes > 0 ? (resizeWavHeader(buf, WAV_HEADER_BYTES + dataBytes) ?? buf) : buf;
}

/**
 * Most bytes of a file's start that a header can take: 12 for RIFF and WAVE,
 * 8 and 28 for a reserved chunk, 24 for `fmt `, 8 for `data`. A caller that
 * hands `resizeWavHeader` the first this many bytes of a file hands it every
 * header it can read.
 */
export const WAV_HEAD_MAX_BYTES = 80;

/** Size of the reserved chunk a header can hold after WAVE: room for a `ds64` body. */
const RESERVED_BYTES = 28;

/**
 * The bytes to write at offset 0 so a WAV of `fileBytes` bytes states its own
 * length: a copy of the header `head` begins with, as long as that header,
 * with only the size fields changed. Null when `head` holds no header this can
 * read, or the file holds no sound past it.
 *
 * `head` can come from another participant's browser, so the header is found
 * by walking its chunks and every read stays inside `head`: a size that
 * leaves it, or anything that is not a header, ends the walk with null. The
 * frame is taken from the header only when it is a small number that agrees
 * with the channels and the depth beside it; anything else reads as 1, which
 * leaves a length as it is.
 *
 * A file that was cut off can end part-way through a sample frame, because a
 * stream arrives in pieces that are not a whole number of frames long. Only
 * whole frames are declared: a decoder reads what the header declares, and
 * reports an error on a frame it cannot finish.
 *
 * A header with a reserved chunk after WAVE (JUNK or ds64, 28 bytes) is RF64
 * when the sizes do not fit 32 bits, in the layout of EBU Tech 3306, and RIFF
 * with a zeroed JUNK chunk when they do. A header with no such room saturates.
 */
export function resizeWavHeader(head: ArrayBufferLike, fileBytes: number): ArrayBuffer | null {
  const bytes = new Uint8Array(head, 0, Math.min(head.byteLength, WAV_HEAD_MAX_BYTES));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  const tagIs = (at: number, id: string) => at + 4 <= bytes.length && tag(at) === id;
  if (!(tagIs(0, 'RIFF') || tagIs(0, 'RF64')) || !tagIs(8, 'WAVE')) return null;

  let at = 12;
  let reserved = false;
  let fmt = -1;
  let dataSizeAt = -1;
  while (dataSizeAt < 0) {
    if (at + 8 > bytes.length) return null;
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'data') {
      if (fmt < 0) return null;
      dataSizeAt = at + 4;
      break;
    }
    if (at === 12 && size === RESERVED_BYTES && (id === 'JUNK' || id === 'ds64')) reserved = true;
    if (id === 'fmt ') {
      if (size < 16) return null;
      fmt = body;
    }
    at = body + size + (size & 1);
  }
  const dataStart = dataSizeAt + 4;

  const blockAlign = view.getUint16(fmt + 12, true);
  const stated = (view.getUint16(fmt + 2, true) * view.getUint16(fmt + 14, true)) / 8;
  const frame = blockAlign > 0 && blockAlign <= 64 && blockAlign === stated ? blockAlign : 1;
  const data = fileBytes - dataStart;
  if (!Number.isSafeInteger(data) || data <= 0) return null;
  const whole = data - (data % frame);
  const riff = dataStart - 8 + whole;

  const out = new Uint8Array(bytes.subarray(0, dataStart));
  const w = new DataView(out.buffer);
  const put = (text: string, to: number) => out.set([...text].map((c) => c.charCodeAt(0)), to);
  put('RIFF', 0);
  if (riff <= U32_MAX || !reserved) {
    w.setUint32(4, u32(riff), true);
    w.setUint32(dataSizeAt, u32(whole), true);
    if (reserved) {
      put('JUNK', 12);
      out.fill(0, 20, 20 + RESERVED_BYTES);
    }
  } else {
    put('RF64', 0);
    w.setUint32(4, U32_MAX, true);
    put('ds64', 12);
    w.setBigUint64(20, BigInt(riff), true);
    w.setBigUint64(28, BigInt(whole), true);
    w.setBigUint64(36, BigInt(whole / frame), true);
    w.setUint32(44, 0, true);
    w.setUint32(dataSizeAt, U32_MAX, true);
  }
  return out.buffer;
}

/**
 * Interleaved Float32 [-1,1] -> interleaved signed 24-bit little-endian.
 *
 * 24-bit is the studio standard and is lossless for any real source: Float32
 * carries a 24-bit mantissa, and microphone ADCs are 24-bit at best. Full scale
 * is 2^23-1 rather than 2^23 so that -1.0 and +1.0 stay symmetric and neither
 * can overflow into the sign bit.
 */
export function f32ToS24LE(samples: Float32Array): ArrayBuffer {
  const out = new Uint8Array(samples.length * 3);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] as number;
    const clamped = s > 1 ? 1 : s < -1 ? -1 : s;
    const v = Math.round(clamped * 8388607);
    const o = i * 3;
    out[o] = v & 0xff;
    out[o + 1] = (v >> 8) & 0xff;
    out[o + 2] = (v >> 16) & 0xff;
  }
  return out.buffer;
}
