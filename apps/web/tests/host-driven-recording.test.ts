import { describe, it, expect } from 'vitest';
import { shouldFollowHostRecording, waitForOpen } from '@/hooks/useRoom';

const base = { from: 'host' as const, role: 'guest' as const, producer: false, alreadyRecording: false };

describe('shouldFollowHostRecording', () => {
  it('a guest follows the host', () => {
    expect(shouldFollowHostRecording(base)).toBe(true);
  });

  // The DO broadcasts to everyone else, so the host hears the guest's own
  // recording-started echoed back. Following it would restart the host.
  it('ignores anything not stamped from the host', () => {
    expect(shouldFollowHostRecording({ ...base, from: 'guest' })).toBe(false);
    expect(shouldFollowHostRecording({ ...base, from: 'producer' })).toBe(false);
  });

  it('a producer is never recorded', () => {
    expect(shouldFollowHostRecording({ ...base, producer: true })).toBe(false);
    expect(shouldFollowHostRecording({ ...base, role: 'producer' })).toBe(false);
  });

  it('the host does not follow its own broadcast', () => {
    expect(shouldFollowHostRecording({ ...base, role: 'host' })).toBe(false);
  });

  // A late-joining guest gets recording-started replayed on reconnect; a second
  // start would open a second set of channels and orphan the first.
  it('does not restart a capture already running', () => {
    expect(shouldFollowHostRecording({ ...base, alreadyRecording: true })).toBe(false);
  });

  it('a peer with no role yet stays put', () => {
    expect(shouldFollowHostRecording({ ...base, role: null })).toBe(false);
  });
});

describe('waitForOpen', () => {
  const chan = (state: string, fire?: (open: () => void) => void) => {
    let onOpen: () => void = () => {};
    if (fire) fire(() => onOpen());
    return {
      readyState: state,
      addEventListener: (_: string, h: () => void) => { onOpen = h; },
    } as unknown as RTCDataChannel;
  };

  it('rejects when the channel closes before opening, instead of waiting forever', async () => {
    const handlers: Record<string, () => void> = {};
    const c = {
      readyState: 'connecting',
      addEventListener: (ev: string, h: () => void) => { handlers[ev] = h; },
    } as unknown as RTCDataChannel;
    const p = waitForOpen(c, Infinity);
    handlers.close!();
    await expect(p).rejects.toThrow();
  });

  it('resolves immediately for an already-open channel', async () => {
    await expect(waitForOpen(chan('open'))).resolves.toBeUndefined();
  });

  it('resolves when the channel opens', async () => {
    let open!: () => void;
    const c = chan('connecting', (o) => { open = o; });
    const p = waitForOpen(c, 1000);
    open();
    await expect(p).resolves.toBeUndefined();
  });

  // Auto-start makes this the difference between a visible error and a guest
  // that shows "being recorded" while recording nothing.
  it('rejects rather than hanging when the channel never opens', async () => {
    await expect(waitForOpen(chan('connecting'), 10)).rejects.toThrow(/never opened/);
  });
});
