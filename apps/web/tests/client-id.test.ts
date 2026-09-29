import { describe, it, expect, beforeEach } from 'vitest';
import { getOrCreateClientId } from '@/lib/client-id';

describe('getOrCreateClientId', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('generates a random UUID and keeps it in sessionStorage', () => {
    const id1 = getOrCreateClientId();
    expect(id1).toMatch(/^[0-9a-f-]{36}$/i);
    expect(sessionStorage.getItem('om_tab_id')).toBe(id1);

    const id2 = getOrCreateClientId();
    expect(id2).toBe(id1);
  });
});
