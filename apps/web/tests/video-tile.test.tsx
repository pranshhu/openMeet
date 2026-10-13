import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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

describe('VideoTile: a title under the name', () => {
  it('holds both texts in the tag, the name in a block of its own, and names both in the tooltip', () => {
    const { container } = render(<VideoTile stream={null} muted={false} label="Bob" title="Founder, Acme" />);
    const tag = container.querySelector('[title]') as HTMLElement;
    expect(tag.title).toBe('Bob\nFounder, Acme');
    const lines = Array.from(tag.children);
    expect(lines.map((l) => l.textContent)).toEqual(['Bob', 'Founder, Acme']);
    expect(lines[0]!.className).toMatch(/\bblock\b/);
    expect(lines[1]!.className).toMatch(/\bblock\b|:block\b/);
  });

  it('hides the second line in a tile narrower than 224 px, in CSS', () => {
    const { container } = render(<VideoTile stream={null} muted={false} label="Bob" title="Founder" />);
    expect((container.firstElementChild as HTMLElement).className).toMatch(/(^|\s)@container(\s|$)/);
    const second = screen.getByText('Founder');
    expect(second.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(second.className).toMatch(/@\[224px\]:block/);
  });

  it('draws the title smaller and dimmer than the name, truncated like it', () => {
    render(<VideoTile stream={null} muted={false} label="Bob" title="Founder" />);
    const name = screen.getByText('Bob');
    const second = screen.getByText('Founder');
    expect(second.className).toMatch(/\btruncate\b/);
    expect(second.className).toMatch(/text-\[11px\]/);
    expect(second.className).toMatch(/text-white\/70/);
    expect(name.className).not.toMatch(/text-white\/70/);
    expect(name.className).toMatch(/\btruncate\b/);
  });

  it('draws the tag as one text with no second element when there is no title', () => {
    const { container } = render(<VideoTile stream={null} muted={false} label="Bob" />);
    const tag = container.querySelector('[title]') as HTMLElement;
    expect(tag.title).toBe('Bob');
    expect(tag.children).toHaveLength(0);
    expect(tag.textContent).toBe('Bob');
  });
});
