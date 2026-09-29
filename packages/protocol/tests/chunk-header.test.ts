import { describe, it, expect } from 'vitest';
import {
  encodeChunkHeader,
  decodeChunkHeader,
  type ChunkHeader,
} from '../src/chunk-header.js';

describe('chunk header', () => {
  it('round-trips a header', () => {
    const h: ChunkHeader = { idx: 47, offset: 11_534_336, size: 248_192, ts: 1716200000000 };
    const decoded = decodeChunkHeader(encodeChunkHeader(h));
    expect(decoded).toEqual(h);
  });

  it('decodes returns null on garbage', () => {
    expect(decodeChunkHeader('not json')).toBeNull();
    expect(decodeChunkHeader('{}')).toBeNull();
    expect(decodeChunkHeader('{"idx":0}')).toBeNull();
  });

  it('rejects negative numbers', () => {
    expect(decodeChunkHeader(JSON.stringify({ idx: -1, offset: 0, size: 1, ts: 0 }))).toBeNull();
    expect(decodeChunkHeader(JSON.stringify({ idx: 0, offset: -1, size: 1, ts: 0 }))).toBeNull();
    expect(decodeChunkHeader(JSON.stringify({ idx: 0, offset: 0, size: -1, ts: 0 }))).toBeNull();
    expect(decodeChunkHeader(JSON.stringify({ idx: 0, offset: 0, size: 1, ts: -1 }))).toBeNull();
  });
});
