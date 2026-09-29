/**
 * Canonical 44-byte RIFF/WAVE header for linear PCM, plus the float->int
 * conversion the recorder needs.
 *
 * The header carries the total data size, which isn't known until recording
 * ends. That's fine here: FileWriter does POSITIONAL writes, so we emit a
 * placeholder header at offset 0, stream samples from offset 44, and rewrite
 * offset 0 at finalize. An append-only transport would need a rewrite pass.
 */

export const WAV_HEADER_BYTES = 44;

/** Largest value a RIFF size field can hold. */
const U32_MAX = 0xffff_ffff;

/**
 * Saturate rather than wrap.
 *
 * These fields are 32-bit, and `setUint32` silently takes the value mod 2^32 —
 * so a session past 4 GiB (24-bit/48k stereo crosses it at 4h08m) declared a
 * WRONG SMALL number and every decoder stopped there. A 5-hour recording read
 * as 51 minutes with no error anywhere.
 *
 * Clamping declares more data than the file holds, which decoders handle by
 * reading to EOF. Measured with ffprobe on a 1-second file: honest header reads
 * 1.000s, clamped reads 1.000s, wrapped reads 0.244s. Clamping recovers
 * everything; wrapping loses most of it.
 *
 * The real fix for >4 GiB is RF64, which openMeet does not write. Until then
 * this turns silent truncation into a fully readable file.
 */
function u32(n: number): number {
  return n > U32_MAX ? U32_MAX : n;
}

export interface WavFormat {
  sampleRate: number;
  channels: number;
  bitDepth: number;
}

/** 44-byte header. `dataBytes` may be 0 for the placeholder written at start. */
export function wavHeader(fmt: WavFormat, dataBytes: number): ArrayBuffer {
  const { sampleRate, channels, bitDepth } = fmt;
  const bytesPerSample = bitDepth / 8;
  const buf = new ArrayBuffer(WAV_HEADER_BYTES);
  const view = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, u32(36 + dataBytes), true); // size of everything after this field
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk length
  view.setUint16(20, 1, true); // 1 = linear PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true); // byte rate
  view.setUint16(32, channels * bytesPerSample, true); // block align
  view.setUint16(34, bitDepth, true);
  ascii(36, 'data');
  view.setUint32(40, u32(dataBytes), true);
  return buf;
}

/**
 * Patch an incomplete or abandoned WAV file's RIFF and data chunk sizes
 * based on the actual PCM data bytes written.
 */
export async function patchWavHeader(
  writer: { write(position: number, data: ArrayBuffer | ArrayBufferView): Promise<void> },
  dataBytes: number
): Promise<void> {
  const riffBuf = new ArrayBuffer(4);
  new DataView(riffBuf).setUint32(0, u32(36 + dataBytes), true);

  const dataBuf = new ArrayBuffer(4);
  new DataView(dataBuf).setUint32(0, u32(dataBytes), true);

  await writer.write(4, riffBuf);
  await writer.write(40, dataBuf);
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
