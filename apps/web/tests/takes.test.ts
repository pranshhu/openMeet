import { describe, it, expect } from 'vitest';
import { takeName } from '@/hooks/recording-controller';

/**
 * Real shoots aren't one continuous recording: false start, muffed intro,
 * "let's do that again". Before this, stopping ended the session — restarting
 * meant a new room, a new folder prompt, and files with no relationship to the
 * first attempt.
 */
describe('takeName', () => {
  it('leaves the first take unsuffixed so the common case stays clean', () => {
    expect(takeName('host', 'abc', 1, 'mp4')).toBe('host_abc.mp4');
    expect(takeName('guest', 'abc', 1, 'wav')).toBe('guest_abc.wav');
  });

  it('suffixes later takes so they cannot overwrite earlier ones', () => {
    expect(takeName('host', 'abc', 2, 'mp4')).toBe('host_abc_take2.mp4');
    expect(takeName('host', 'abc', 7, 'wav')).toBe('host_abc_take7.wav');
  });

  it('treats a missing or zero take as the first', () => {
    expect(takeName('host', 'abc', 0, 'mp4')).toBe('host_abc.mp4');
  });

  it('keeps every take of a session distinct across both roles and formats', () => {
    const names = new Set<string>();
    for (const take of [1, 2, 3]) {
      for (const role of ['host', 'guest'] as const) {
        for (const ext of ['mp4', 'wav']) names.add(takeName(role, 'id', take, ext));
      }
    }
    expect(names.size).toBe(12); // 3 takes x 2 roles x 2 formats, no collisions
  });
});
