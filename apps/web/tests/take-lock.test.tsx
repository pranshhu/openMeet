import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { RoomView } from '@/components/RoomView';
import { holdTakeLock, isTakeLockHeld } from '@/lib/take-lock';

let state: Record<string, unknown>;

vi.mock('@/hooks/useRoom', () => ({
  useRoom: () => ({ state, join: vi.fn(), leave: vi.fn(), setMic: vi.fn(), setCam: vi.fn() }),
}));
vi.mock('@/components/CallStage', () => ({ CallStage: () => null }));

/** The two request shapes the guard uses: hold (name, callback) and probe (name, options, callback). */
function fakeLocks() {
  const held = new Set<string>();
  const request = vi.fn(async (name: string, a: unknown, b?: unknown) => {
    if (typeof a === 'function') {
      held.add(name);
      try {
        return await (a as (lock: unknown) => unknown)({ name });
      } finally {
        held.delete(name);
      }
    }
    // Only a request that does not wait is answered while the lock is held.
    if (held.has(name) && !(a as { ifAvailable?: boolean }).ifAvailable) throw new Error('would wait');
    return (b as (lock: unknown) => unknown)(held.has(name) ? null : { name });
  });
  return { held, request };
}

function install(locks: unknown) {
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
}

afterEach(() => {
  delete (navigator as unknown as { locks?: unknown }).locks;
});

describe('take lock', () => {
  it('a held lock is found for its own room and no other, until released', async () => {
    const locks = fakeLocks();
    install(locks);
    const release = holdTakeLock('abc-defg-hij');
    expect(await isTakeLockHeld('abc-defg-hij')).toBe(true);
    expect(locks.request).toHaveBeenCalledWith(
      'openmeet-take:abc-defg-hij',
      { mode: 'shared', ifAvailable: true },
      expect.any(Function)
    );
    expect(await isTakeLockHeld('zzz-zzzz-zzz')).toBe(false);
    release();
    // The fake lets go one microtask after the release, as a browser does later still.
    await waitFor(async () => expect(await isTakeLockHeld('abc-defg-hij')).toBe(false));
  });

  it('without a usable lock manager nothing throws and nothing is found', async () => {
    expect(() => holdTakeLock('abc-defg-hij')()).not.toThrow();
    expect(await isTakeLockHeld('abc-defg-hij')).toBe(false);
    install({ request: () => Promise.reject(new Error('no')) });
    expect(() => holdTakeLock('abc-defg-hij')()).not.toThrow();
    expect(await isTakeLockHeld('abc-defg-hij')).toBe(false);
    install({
      request: () => {
        throw new Error('no');
      },
    });
    expect(() => holdTakeLock('abc-defg-hij')()).not.toThrow();
    expect(await isTakeLockHeld('abc-defg-hij')).toBe(false);
  });
});

describe('RoomView holds the take lock', () => {
  // What RoomView reads on its way to the (replaced) call stage.
  const base = { remotePeers: [], markers: [] };

  it('a host tab holds it through the whole take', async () => {
    const locks = fakeLocks();
    install(locks);
    state = { ...base, phase: 'recording', role: 'host' };
    const { rerender } = render(<RoomView slug="abc-defg-hij" />);
    await waitFor(() => expect([...locks.held]).toEqual(['openmeet-take:abc-defg-hij']));
    state = { ...base, phase: 'finalizing', role: 'host' };
    rerender(<RoomView slug="abc-defg-hij" />);
    await act(async () => {});
    expect([...locks.held]).toEqual(['openmeet-take:abc-defg-hij']);
    state = { ...base, phase: 'done', role: 'host' };
    rerender(<RoomView slug="abc-defg-hij" />);
    await waitFor(() => expect([...locks.held]).toEqual([]));
  });

  it('a host tab holds it from a resume or a save of an interrupted take, into the take that follows', async () => {
    const locks = fakeLocks();
    install(locks);
    state = { ...base, phase: 'in-call', role: 'host', recoveryBusy: true };
    const { rerender } = render(<RoomView slug="abc-defg-hij" />);
    await waitFor(() => expect([...locks.held]).toEqual(['openmeet-take:abc-defg-hij']));
    // The resume worked: the take is live, and the lock was never let go.
    state = { ...base, phase: 'recording', role: 'host', recoveryBusy: false };
    rerender(<RoomView slug="abc-defg-hij" />);
    await act(async () => {});
    expect([...locks.held]).toEqual(['openmeet-take:abc-defg-hij']);
    expect(locks.request).toHaveBeenCalledTimes(1);
  });

  it('a host tab lets it go when the resume or the save ends without a take', async () => {
    const locks = fakeLocks();
    install(locks);
    state = { ...base, phase: 'in-call', role: 'host', recoveryBusy: true };
    const { rerender } = render(<RoomView slug="abc-defg-hij" />);
    await waitFor(() => expect([...locks.held]).toEqual(['openmeet-take:abc-defg-hij']));
    state = { ...base, phase: 'in-call', role: 'host', recoveryBusy: false };
    rerender(<RoomView slug="abc-defg-hij" />);
    await waitFor(() => expect([...locks.held]).toEqual([]));
  });

  it('a guest tab never holds it', async () => {
    const locks = fakeLocks();
    install(locks);
    state = { ...base, phase: 'recording', role: 'guest' };
    render(<RoomView slug="abc-defg-hij" />);
    await act(async () => {});
    expect(locks.request).not.toHaveBeenCalled();
  });
});
