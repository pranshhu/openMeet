import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { VideoTile } from '@/components/VideoTile';
import { Stage, type StageFeed } from '@/components/Stage';
import { setSpeaker } from '@/lib/speaker';

// A tile listens to its stream, so a stream handed to one is an EventTarget.
const stream = Object.assign(new EventTarget(), { id: 'bob' }) as unknown as MediaStream;

describe('VideoTile: the chosen speaker', () => {
  beforeEach(() => {
    // jsdom has no setSinkId; this one records the sink on the element, as a browser does.
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', {
      configurable: true,
      writable: true,
      value: vi.fn(function (this: HTMLMediaElement, id: string) {
        Object.defineProperty(this, 'sinkId', { value: id, configurable: true });
        return Promise.resolve();
      }),
    });
  });

  afterEach(() => {
    setSpeaker('');
    localStorage.removeItem('om_speaker');
    delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
  });

  it('starts a tile that sounds on the chosen speaker and moves it with the choice', () => {
    setSpeaker('out-a');
    const { container } = render(<VideoTile stream={stream} muted={false} label="Bob" />);
    const video = container.querySelector('video')!;
    expect(video.sinkId).toBe('out-a');

    setSpeaker('out-b');
    expect(video.sinkId).toBe('out-b');
  });

  it('never moves a muted tile', () => {
    setSpeaker('out-a');
    render(<VideoTile stream={stream} muted label="Alice (You)" />);
    setSpeaker('out-b');
    expect(HTMLMediaElement.prototype.setSinkId).not.toHaveBeenCalled();
  });

  it('does not touch a tile while the system default is chosen', () => {
    render(<VideoTile stream={stream} muted={false} label="Bob" />);
    expect(HTMLMediaElement.prototype.setSinkId).not.toHaveBeenCalled();
  });

  it('stops moving a tile that has left the stage', () => {
    const { unmount } = render(<VideoTile stream={stream} muted={false} label="Bob" />);
    unmount();
    setSpeaker('out-a');
    expect(HTMLMediaElement.prototype.setSinkId).not.toHaveBeenCalled();
  });

  it('follows the choice from the moment a mounted tile starts to sound, and not once it is muted again', () => {
    setSpeaker('out-a');
    const { container, rerender } = render(<VideoTile stream={stream} muted label="Alice (You)" />);
    const video = container.querySelector('video')!;
    expect(video.sinkId).toBeUndefined();

    // A layout can hand a mounted tile another person: the element stays, `muted` changes.
    rerender(<VideoTile stream={stream} muted={false} label="Bob" />);
    expect(video.sinkId).toBe('out-a');

    rerender(<VideoTile stream={stream} muted label="Alice (You)" />);
    setSpeaker('out-b');
    expect(video.sinkId).toBe('out-a');
  });

  it('keeps the other person on the chosen speaker when the spotlight is swapped', () => {
    setSpeaker('out-a');
    const local: StageFeed = { stream: null, name: 'Alice', muted: true, camOff: true };
    const remote: StageFeed = { stream, name: 'Bob', muted: false, camOff: false };
    const stage = (spotlight: 'local' | 'remote') => (
      <Stage
        local={local}
        remote={remote}
        remoteScreen={null}
        localPresenting={false}
        spotlight={spotlight}
        onSwapSpotlight={() => {}}
      />
    );
    const { container, rerender } = render(stage('remote'));
    const playsBob = () =>
      Array.from(container.querySelectorAll('video')).find(
        (v) => (v as { srcObject?: unknown }).srcObject === stream
      )!;
    const big = playsBob();
    expect(big.sinkId).toBe('out-a');

    // The two tiles swap what they show; neither is mounted again.
    rerender(stage('local'));
    expect(playsBob()).not.toBe(big);
    expect(playsBob().muted).toBe(false);
    expect(playsBob().sinkId).toBe('out-a');
  });
});
