import { describe, it, expect } from 'vitest';
import { withScreen, withoutScreen, screenLabelOf, type RemoteScreen } from '@/lib/remote-screens';

const stream = () => new EventTarget() as unknown as MediaStream;

describe('withScreen', () => {
  it('appends a person who holds no screen yet, last', () => {
    const a = stream();
    const b = stream();
    const list = withScreen(withScreen([], 'a', a), 'b', b);
    expect(list.map((r) => r.peerId)).toEqual(['a', 'b']);
    expect(list[0]?.stream).toBe(a);
    expect(list[1]?.stream).toBe(b);
  });

  it("replaces the same person's screen and keeps its place in the list", () => {
    const a1 = stream();
    const a2 = stream();
    const b = stream();
    const list = withScreen([{ peerId: 'a', stream: a1 }, { peerId: 'b', stream: b }], 'a', a2);
    expect(list.map((r) => r.peerId)).toEqual(['a', 'b']);
    expect(list[0]?.stream).toBe(a2);
    expect(list[1]?.stream).toBe(b);
  });

  it('returns the same list when the person already holds this stream', () => {
    const a = stream();
    const list: RemoteScreen[] = [{ peerId: 'a', stream: a }];
    expect(withScreen(list, 'a', a)).toBe(list);
  });
});

describe('withoutScreen', () => {
  const a = stream();
  const b = stream();
  const list: RemoteScreen[] = [{ peerId: 'a', stream: a }, { peerId: 'b', stream: b }];

  it("drops that person's screen and nobody else's", () => {
    const rest = withoutScreen(list, 'a');
    expect(rest.map((r) => r.peerId)).toEqual(['b']);
    expect(rest[0]?.stream).toBe(b);
  });

  it('drops the screen when it is the stream they hold', () => {
    expect(withoutScreen(list, 'a', a).map((r) => r.peerId)).toEqual(['b']);
  });

  it('keeps the screen when given a stream they do not hold', () => {
    expect(withoutScreen(list, 'a', b)).toBe(list);
  });

  it('returns the same list when the person holds no screen', () => {
    expect(withoutScreen(list, 'z')).toBe(list);
  });
});

describe('screenLabelOf', () => {
  it('names a guest by their screen', () => {
    expect(screenLabelOf({ name: 'Ana' })).toBe("Ana's screen");
  });

  it('calls a nameless guest Guest', () => {
    expect(screenLabelOf({ name: null })).toBe("Guest's screen");
    expect(screenLabelOf({})).toBe("Guest's screen");
  });

  it('says Presenting for a present-only device', () => {
    expect(screenLabelOf({ name: 'Ana', companion: true })).toBe('Ana (Presenting)');
    expect(screenLabelOf({ name: '', companion: true })).toBe('Guest (Presenting)');
  });
});
