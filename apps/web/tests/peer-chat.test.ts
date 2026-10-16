import { describe, it, expect } from 'vitest';
import {
  MAX_PEER_CHAT_FRAME,
  PEER_CHAT_HELLO,
  encodePeerChat,
  readPeerChat,
} from '@/lib/peer-chat';
import { MAX_CHAT_MESSAGE_LENGTH } from '@/lib/sync-report';

describe('readPeerChat', () => {
  it('reads a hello, a line and a private line', () => {
    expect(readPeerChat(PEER_CHAT_HELLO)).toEqual({ type: 'hello' });
    expect(readPeerChat(encodePeerChat('hi', false))).toEqual({ type: 'chat', text: 'hi', private: false });
    expect(readPeerChat(encodePeerChat('psst', true))).toEqual({ type: 'chat', text: 'psst', private: true });
  });

  it('gives back text with quotes and line breaks', () => {
    expect(readPeerChat(encodePeerChat('a"b\n', true))).toEqual({ type: 'chat', text: 'a"b\n', private: true });
  });

  it('puts private on the wire only for a private line', () => {
    expect(JSON.parse(encodePeerChat('hi', false))).toEqual({ type: 'chat', text: 'hi' });
    expect(JSON.parse(encodePeerChat('hi', true))).toEqual({ type: 'chat', text: 'hi', private: true });
  });

  it('returns a new object of the known fields only', () => {
    const frame = readPeerChat('{"type":"chat","text":"hi","from":"host","fromPeerId":"p-x","extra":1}');
    expect(frame).toEqual({ type: 'chat', text: 'hi', private: false });
    expect(Object.keys(frame as object).sort()).toEqual(['private', 'text', 'type']);
    expect(readPeerChat('{"type":"hello","text":"x"}')).toEqual({ type: 'hello' });
  });

  it('accepts a line of the longest length, and a frame of the longest size when every unit is escaped', () => {
    const longest = 'x'.repeat(MAX_CHAT_MESSAGE_LENGTH);
    expect(readPeerChat(encodePeerChat(longest, false))).toEqual({ type: 'chat', text: longest, private: false });
    const escaped = '\u0001'.repeat(MAX_CHAT_MESSAGE_LENGTH);
    const frame = encodePeerChat(escaped, true);
    expect(frame.length).toBeLessThanOrEqual(MAX_PEER_CHAT_FRAME);
    expect(readPeerChat(frame)).toEqual({ type: 'chat', text: escaped, private: true });
  });

  it.each([
    ['an ArrayBuffer', new ArrayBuffer(8)],
    ['a Blob', new Blob(['{"type":"hello"}'])],
    ['undefined', undefined],
    ['a number', 5],
    ['a string over the frame limit', 'x'.repeat(32_769)],
    ['a valid frame over the frame limit', JSON.stringify({ type: 'hello', pad: 'x'.repeat(32_760) })],
    ['an object that reads as a valid frame', { toString: () => PEER_CHAT_HELLO }],
    ['text JSON.parse refuses', '{"type":'],
    ['null', 'null'],
    ['an array', '[{"type":"hello"}]'],
    ['a number in JSON', '7'],
    ['a string in JSON', '"hello"'],
    ['an unknown type', '{"type":"bye"}'],
    ['no type', '{"text":"hi"}'],
    ['text that is not a string', '{"type":"chat","text":5}'],
    ['no text', '{"type":"chat"}'],
    ['text of 4001 units', JSON.stringify({ type: 'chat', text: 'x'.repeat(4001) })],
    ['private that is not a boolean', '{"type":"chat","text":"hi","private":"yes"}'],
    ['private that is null', '{"type":"chat","text":"hi","private":null}'],
  ])('returns null for %s', (_name, data) => {
    expect(readPeerChat(data)).toBeNull();
  });
});
