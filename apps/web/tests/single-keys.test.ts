import { describe, it, expect, vi, beforeEach } from 'vitest';

type SingleKeys = typeof import('@/hooks/use-single-keys');

describe('single-key shortcuts: the stored choice', () => {
  let keys: SingleKeys;

  beforeEach(async () => {
    localStorage.clear();
    // The choice is read from storage once per page: a fresh module is a fresh page.
    vi.resetModules();
    keys = await import('@/hooks/use-single-keys');
  });

  it('is on for a person who never touched it, and stores nothing until they do', () => {
    expect(keys.singleKeysOn()).toBe(true);
    expect(localStorage.getItem('om_single_keys')).toBeNull();
  });

  it('keeps a change for the next visit and tells whoever listens, once per change', async () => {
    const heard = vi.fn();
    const stop = keys.onSingleKeysChange(heard);
    keys.setSingleKeys(false);
    expect(keys.singleKeysOn()).toBe(false);
    expect(localStorage.getItem('om_single_keys')).toBe('0');
    expect(heard).toHaveBeenCalledTimes(1);
    // The same answer again is not a change.
    keys.setSingleKeys(false);
    expect(heard).toHaveBeenCalledTimes(1);

    vi.resetModules();
    const nextVisit = await import('@/hooks/use-single-keys');
    expect(nextVisit.singleKeysOn()).toBe(false);

    stop();
    keys.setSingleKeys(true);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('om_single_keys')).toBe('1');
  });

  it('reads only its own "0" as off', async () => {
    for (const stored of ['1', '', 'false', 'off', '{"a":1}']) {
      localStorage.setItem('om_single_keys', stored);
      vi.resetModules();
      const page = await import('@/hooks/use-single-keys');
      expect(page.singleKeysOn()).toBe(true);
    }
  });

  it('holds the choice for this page when storage is closed, and never throws', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      expect(keys.singleKeysOn()).toBe(true);
      expect(() => keys.setSingleKeys(false)).not.toThrow();
      expect(keys.singleKeysOn()).toBe(false);
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});
