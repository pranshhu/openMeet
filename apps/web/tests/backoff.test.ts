import { describe, it, expect } from 'vitest';
import { nextBackoffMs } from '@/lib/backoff';

describe('nextBackoffMs', () => {
  it('doubles from 1s and caps at 30s (1,2,4,8,cap 30)', () => {
    expect(nextBackoffMs(0)).toBe(1000);
    expect(nextBackoffMs(1)).toBe(2000);
    expect(nextBackoffMs(2)).toBe(4000);
    expect(nextBackoffMs(3)).toBe(8000);
    expect(nextBackoffMs(4)).toBe(16000);
    expect(nextBackoffMs(5)).toBe(30000);
    expect(nextBackoffMs(100)).toBe(30000);
  });
});
