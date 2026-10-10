import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { VideoTile } from '@/components/VideoTile';

const newStream = () => new EventTarget() as unknown as MediaStream;

function tile(stream: MediaStream | null) {
  return <VideoTile stream={stream} muted={false} label="Bob" />;
}

function record(container: HTMLElement): { video: HTMLVideoElement; given: unknown[] } {
  const video = container.querySelector('video')!;
  const given: unknown[] = [];
  Object.defineProperty(video, 'srcObject', {
    configurable: true,
    get: () => given.at(-1) ?? null,
    set: (v) => {
      given.push(v);
    },
  });
  return { video, given };
}

describe('VideoTile', () => {
  it('gives the element its stream again when a track is taken out before anything loaded', () => {
    const stream = newStream();
    const { container } = render(tile(stream));
    const { given } = record(container);
    stream.dispatchEvent(new Event('removetrack'));
    expect(given).toEqual([stream]);
  });

  it('leaves an element that already plays alone', () => {
    const stream = newStream();
    const { container } = render(tile(stream));
    const { video, given } = record(container);
    Object.defineProperty(video, 'readyState', { configurable: true, get: () => 4 });
    stream.dispatchEvent(new Event('removetrack'));
    expect(given).toEqual([]);
  });

  it('stops listening to a stream it no longer shows', () => {
    const a = newStream();
    const b = newStream();
    const { container, rerender } = render(tile(a));
    const { given } = record(container);
    rerender(tile(b));
    given.length = 0;
    a.dispatchEvent(new Event('removetrack'));
    expect(given).toEqual([]);
    b.dispatchEvent(new Event('removetrack'));
    expect(given).toEqual([b]);
  });

  it('a tile with no stream sets nothing up', () => {
    const { container } = render(tile(null));
    expect(container.querySelector('video')!.srcObject).toBeNull();
  });
});
