import { describe, it, expect, beforeEach } from 'vitest';
import { recallName, rememberName } from '@/lib/join-name';

describe('join name', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('is empty until a name is typed, then comes back', () => {
    expect(recallName()).toBe('');
    rememberName('Ana');
    expect(recallName()).toBe('Ana');
  });
});
