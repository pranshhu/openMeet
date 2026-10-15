import { describe, it, expect } from 'vitest';
import { findViewed, parseViewLink, viewCamOff, viewName } from '@/lib/view-link';

const stream = new EventTarget() as unknown as MediaStream;

describe('parseViewLink', () => {
  it('is null for an address with no view parameter', () => {
    expect(parseViewLink('')).toBeNull();
    expect(parseViewLink('?producer=1&name=Ana')).toBeNull();
  });

  it('reads view=host', () => {
    expect(parseViewLink('?view=host')).toEqual({ kind: 'host' });
  });

  it('reads view=guest with its name', () => {
    expect(parseViewLink('?view=guest&name=Ana')).toEqual({ kind: 'guest', name: 'Ana' });
    expect(parseViewLink('?view=guest&name=Ana%20Mar%C3%ADa')).toEqual({ kind: 'guest', name: 'Ana María' });
  });

  it('cuts the name to the 64 characters the Room keeps', () => {
    const link = parseViewLink(`?view=guest&name=${'a'.repeat(70)}`);
    expect(link).toEqual({ kind: 'guest', name: 'a'.repeat(64) });
  });

  it('does not leave half of a character at the cut', () => {
    const link = parseViewLink(`?view=guest&name=${'a'.repeat(63)}${encodeURIComponent('😀')}`);
    expect(link).toEqual({ kind: 'guest', name: 'a'.repeat(63) });
  });

  it('is incomplete for a guest with no name, or one that is only spaces', () => {
    expect(parseViewLink('?view=guest')).toEqual({ kind: 'incomplete' });
    expect(parseViewLink('?view=guest&name=')).toEqual({ kind: 'incomplete' });
    expect(parseViewLink('?view=guest&name=%20')).toEqual({ kind: 'incomplete' });
  });

  it('is incomplete for any other value', () => {
    expect(parseViewLink('?view=nope')).toEqual({ kind: 'incomplete' });
    expect(parseViewLink('?view=')).toEqual({ kind: 'incomplete' });
    expect(parseViewLink('?view=nope&name=Ana')).toEqual({ kind: 'incomplete' });
  });
});

describe('viewName', () => {
  it('names the seat for the person it shows', () => {
    expect(viewName({ kind: 'host' })).toBe('View of the host');
    expect(viewName({ kind: 'guest', name: 'Ana' })).toBe('View of Ana');
  });
});

describe('findViewed', () => {
  const peers = [
    { peerId: 'p0', name: null, stream: null, role: 'guest' as const },
    { peerId: 'p1', name: 'Deck', stream: null, role: 'guest' as const, companion: true },
    { peerId: 'p2', name: 'Ana', stream: null, role: 'producer' as const },
    { peerId: 'p3', name: 'Ana', stream: null, role: 'host' as const },
    { peerId: 'p4', name: ' ana ', stream: null, role: 'guest' as const },
    { peerId: 'p5', name: 'Ana', stream: null, role: 'guest' as const },
  ];

  it('finds the host by role', () => {
    expect(findViewed(peers, { kind: 'host' })?.peerId).toBe('p3');
  });

  it('finds a guest by name in another case with spaces around it', () => {
    expect(findViewed(peers, { kind: 'guest', name: ' ANA ' })?.peerId).toBe('p4');
    expect(findViewed(peers, { kind: 'guest', name: 'ANA' })?.peerId).toBe('p4');
    expect(findViewed(peers, { kind: 'guest', name: ' ana  ' })?.peerId).toBe('p4');
  });

  it('takes the first of two guests of one name', () => {
    expect(findViewed([...peers].reverse(), { kind: 'guest', name: 'Ana' })?.peerId).toBe('p5');
  });

  it('never finds a producer or a Present-only device by name', () => {
    expect(findViewed(peers.slice(0, 2), { kind: 'guest', name: 'Ana' })).toBeNull();
    expect(findViewed(peers.slice(0, 2), { kind: 'guest', name: 'Deck' })).toBeNull();
  });

  it('never finds the host by name', () => {
    expect(findViewed([peers[2]!], { kind: 'guest', name: 'Ana' })).toBeNull();
  });

  it('never finds a guest as the host', () => {
    expect(findViewed(peers.filter((p) => p.role !== 'host'), { kind: 'host' })).toBeNull();
  });

  it('finds nobody for an incomplete link', () => {
    expect(findViewed(peers, { kind: 'incomplete' })).toBeNull();
  });
});

describe('viewCamOff', () => {
  it('is off for a microphone-only seat even with a stream and a camera presence', () => {
    expect(viewCamOff({ audioOnly: true, stream, presence: { camOn: true } })).toBe(true);
  });

  it('follows the presence when there is one', () => {
    expect(viewCamOff({ stream, presence: { camOn: false } })).toBe(true);
    expect(viewCamOff({ stream: null, presence: { camOn: true } })).toBe(false);
  });

  it('with no presence, is off exactly when there is no stream', () => {
    expect(viewCamOff({ stream: null })).toBe(true);
    expect(viewCamOff({ stream })).toBe(false);
  });
});

describe('the stage view link', () => {
  it('parses view=stage to the stage, whatever else the address holds', () => {
    expect(parseViewLink('?view=stage')).toEqual({ kind: 'stage' });
    expect(parseViewLink('?view=stage&name=Ana')).toEqual({ kind: 'stage' });
  });

  it('names the seat for the stage view', () => {
    expect(viewName({ kind: 'stage' })).toBe('Stage view');
  });

  it('finds nobody by name or role for the stage', () => {
    expect(findViewed([{ name: 'Ana', role: 'host' as const }], { kind: 'stage' })).toBeNull();
  });
});
