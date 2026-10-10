import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { playLocally, setSpeaker } from '@/lib/speaker';

const stream = Object.assign(new EventTarget(), { id: 'pads' }) as unknown as MediaStream;
const srcOf = (el: HTMLAudioElement) => (el as { srcObject?: unknown }).srcObject;

describe('playLocally', () => {
  let sink: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // jsdom has no setSinkId; this one records the sink on the element, as a browser does.
    sink = vi.fn(function (this: HTMLMediaElement, id: string) {
      Object.defineProperty(this, 'sinkId', { value: id, configurable: true });
      return Promise.resolve();
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', {
      configurable: true,
      writable: true,
      value: sink,
    });
  });

  afterEach(() => {
    setSpeaker('');
    localStorage.removeItem('om_speaker');
    delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
    document.querySelectorAll('audio').forEach((a) => a.remove());
  });

  it('plays the stream through an element of its own, on the chosen speaker, until it is stopped', () => {
    setSpeaker('out-b');
    const stop = playLocally(stream);
    const el = document.querySelector('audio')!;
    expect(srcOf(el)).toBe(stream);
    expect(el.autoplay).toBe(true);
    expect((el as { sinkId?: string }).sinkId).toBe('out-b');

    setSpeaker('out-a');
    expect((el as { sinkId?: string }).sinkId).toBe('out-a');

    stop();
    expect(document.querySelector('audio')).toBeNull();
    expect(srcOf(el)).toBeNull();
    setSpeaker('out-b');
    expect((el as { sinkId?: string }).sinkId).toBe('out-a');
  });

  it('leaves the element on the system default when no speaker was chosen', () => {
    const stop = playLocally(stream);
    const el = document.querySelector('audio')!;
    expect(srcOf(el)).toBe(stream);
    expect(sink).not.toHaveBeenCalled();
    stop();
  });

  it('plays on the system default, without an error, where the browser cannot choose an output', () => {
    delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
    setSpeaker('out-b');
    const stop = playLocally(stream);
    const el = document.querySelector('audio')!;
    expect(srcOf(el)).toBe(stream);
    stop();
    expect(document.querySelector('audio')).toBeNull();
  });
});
