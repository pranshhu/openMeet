import { describe, it, expect } from 'vitest';
import { isRoomName, isRoomSlug } from '../src/room-slug.js';

describe('isRoomSlug', () => {
  it('accepts a random slug and a chosen name', () => {
    expect(isRoomSlug('abc-defg-hij')).toBe(true);
    expect(isRoomSlug('my-show')).toBe(true);
    expect(isRoomSlug('ep1')).toBe(true);
    expect(isRoomSlug('a'.repeat(32))).toBe(true);
  });

  it('refuses anything else without throwing', () => {
    for (const s of ['ab', 'a'.repeat(33), 'My-Show', '-show', 'show-', 'my_show', 'my show', '../x', '', 42, null]) {
      expect(isRoomSlug(s)).toBe(false);
    }
  });
});

describe('isRoomName', () => {
  it('refuses the shape the Worker makes up', () => {
    expect(isRoomName('abc-defg-hij')).toBe(false);
  });

  it('accepts a chosen name and refuses what is not a slug', () => {
    expect(isRoomName('my-show')).toBe(true);
    expect(isRoomName('My-Show')).toBe(false);
    expect(isRoomName(undefined)).toBe(false);
  });
});
