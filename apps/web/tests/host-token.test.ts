import { describe, it, expect, beforeEach } from 'vitest';
import { storeHostToken, getHostToken, clearHostToken } from '@/lib/host-token';

beforeEach(() => {
  localStorage.clear();
  try { sessionStorage.clear(); } catch { /* not present in this env */ }
});

describe('host token storage', () => {
  // Rooms are reusable, so "host" has to survive closing the tab. With
  // sessionStorage the creator silently became a guest in their own room.
  it('persists across tabs, not just the creating one', () => {
    storeHostToken('abc-defg-hij', 'tok123');
    expect(getHostToken('abc-defg-hij')).toBe('tok123');
    expect(localStorage.getItem('om_host_abc-defg-hij')).toBe('tok123');
  });

  it('keeps rooms separate', () => {
    storeHostToken('room-one', 'tok-one');
    expect(getHostToken('room-two')).toBeNull();
  });

  it('promotes a legacy sessionStorage token instead of demoting the host', () => {
    // Someone mid-session when this shipped would otherwise lose host status.
    sessionStorage.setItem('om_host_leg-acyy-aaa', 'legacy-tok');
    expect(getHostToken('leg-acyy-aaa')).toBe('legacy-tok');
    expect(localStorage.getItem('om_host_leg-acyy-aaa')).toBe('legacy-tok');
  });

  it('clears from both stores', () => {
    storeHostToken('x', 'a');
    sessionStorage.setItem('om_host_x', 'a');
    clearHostToken('x');
    expect(getHostToken('x')).toBeNull();
  });
});
