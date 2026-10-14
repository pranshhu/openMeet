import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
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

describe('VideoTile with a picture taller than wide', () => {
  function sized(video: HTMLVideoElement, videoWidth: number, videoHeight: number, event: string) {
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: videoWidth });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: videoHeight });
    act(() => {
      video.dispatchEvent(new Event(event));
    });
  }

  it('draws a tall picture whole', () => {
    const { container } = render(tile(newStream()));
    const video = container.querySelector('video')!;
    expect(video.className).toContain('object-cover');
    sized(video, 608, 1080, 'resize');
    expect(video.className).toContain('object-contain');
    expect(video.className).not.toContain('object-cover');
  });

  it('puts the tall picture on a black box', () => {
    const { container } = render(tile(newStream()));
    sized(container.querySelector('video')!, 608, 1080, 'resize');
    expect((container.firstChild as HTMLElement).className).toContain('bg-black');
  });

  it('keeps the usual background while the camera is off, and goes black when it is on', () => {
    const stream = newStream();
    const { container, rerender } = render(<VideoTile stream={stream} muted={false} label="Bob" camOff />);
    sized(container.querySelector('video')!, 608, 1080, 'resize');
    const box = container.firstChild as HTMLElement;
    expect(box.className).toContain('bg-[#3c4043]');
    expect(box.className).not.toContain('bg-black');
    rerender(<VideoTile stream={stream} muted={false} label="Bob" />);
    expect(box.className).toContain('bg-black');
    expect(box.className).not.toContain('bg-[#3c4043]');
  });

  it('fills the tile again when the picture turns wide', () => {
    const { container } = render(tile(newStream()));
    const video = container.querySelector('video')!;
    sized(video, 608, 1080, 'resize');
    sized(video, 1920, 1080, 'resize');
    expect(video.className).toContain('object-cover');
    expect(video.className).not.toContain('object-contain');
    expect((container.firstChild as HTMLElement).className).not.toContain('bg-black');
  });

  it('reads the size when the element first reports it', () => {
    const { container } = render(tile(newStream()));
    const video = container.querySelector('video')!;
    sized(video, 608, 1080, 'loadedmetadata');
    expect(video.className).toContain('object-contain');
  });

  it('treats an unknown size as not tall', () => {
    const { container } = render(tile(newStream()));
    const video = container.querySelector('video')!;
    sized(video, 0, 0, 'resize');
    expect(video.className).toContain('object-cover');
  });

  it('treats a square picture as not tall', () => {
    const { container } = render(tile(newStream()));
    const video = container.querySelector('video')!;
    sized(video, 720, 720, 'resize');
    expect(video.className).toContain('object-cover');
  });

  it('treats a picture with no width as not tall', () => {
    const { container } = render(tile(newStream()));
    const video = container.querySelector('video')!;
    sized(video, 0, 1080, 'resize');
    expect(video.className).toContain('object-cover');
  });

  it('starts again as not tall when given another stream', () => {
    const { container, rerender } = render(tile(newStream()));
    const video = container.querySelector('video')!;
    sized(video, 608, 1080, 'resize');
    rerender(tile(newStream()));
    expect(video.className).toContain('object-cover');
    sized(video, 608, 1080, 'loadedmetadata');
    expect(video.className).toContain('object-contain');
  });

  it('starts again as not tall when the stream is taken away', () => {
    const { container, rerender } = render(tile(newStream()));
    const video = container.querySelector('video')!;
    sized(video, 608, 1080, 'resize');
    rerender(tile(null));
    expect(video.className).toContain('object-cover');
  });

  it('keeps contain for a wide picture when asked for contain', () => {
    const { container } = render(<VideoTile stream={newStream()} muted={false} label="Bob" fit="contain" />);
    const video = container.querySelector('video')!;
    sized(video, 1920, 1080, 'resize');
    expect(video.className).toContain('object-contain');
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
