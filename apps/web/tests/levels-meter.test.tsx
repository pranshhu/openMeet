import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { LevelsPanel, levelPercent } from '@/components/LevelsPanel';
import { FakeAudioContext } from './fake-audio-context';

// EventTargets, as every stand-in stream in this suite is: a tile listens on its stream.
const standIn = (props: object) => Object.assign(new EventTarget(), props) as unknown as MediaStream;
const bob = standIn({ id: 'stream-bob' });
const carol = standIn({ id: 'stream-carol' });
const peers = [
  { peerId: 'p-bob', name: 'Bob', stream: bob },
  { peerId: 'p-carol', name: 'Carol', stream: carol },
];
const tick = () =>
  act(() => {
    vi.advanceTimersByTime(100);
  });

describe('LevelsPanel meters', () => {
  beforeEach(() => {
    FakeAudioContext.made = [];
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows how loud each person arrives, and lets a bar fall back when they stop', () => {
    render(<LevelsPanel peers={peers} volumes={new Map()} onVolume={vi.fn()} />);
    const ctx = FakeAudioContext.made[0]!;
    ctx.analysers[0]!.level = 1;
    ctx.analysers[1]!.level = 0.1;
    tick();
    const bobMeter = screen.getByRole('meter', { name: 'Level for Bob' });
    expect(bobMeter).toHaveAttribute('aria-valuenow', '100');
    expect((bobMeter.firstElementChild as HTMLElement).style.width).toBe('100%');
    expect(screen.getByRole('meter', { name: 'Level for Carol' })).toHaveAttribute('aria-valuenow', '67');

    ctx.analysers[0]!.level = 0;
    tick();
    expect(bobMeter).toHaveAttribute('aria-valuenow', '95');
  });

  it('shows what arrives, whatever the fader says', () => {
    render(<LevelsPanel peers={peers} volumes={new Map([['p-bob', 0]])} onVolume={vi.fn()} />);
    FakeAudioContext.made[0]!.analysers[0]!.level = 1;
    tick();
    expect(screen.getByRole('meter', { name: 'Level for Bob' })).toHaveAttribute('aria-valuenow', '100');
  });

  // The whole point of the design: nothing the meter hears can be played or recorded.
  it('only listens: each stream goes to one analyser and no further', () => {
    render(<LevelsPanel peers={peers} volumes={new Map()} onVolume={vi.fn()} />);
    expect(FakeAudioContext.made).toHaveLength(1);
    const ctx = FakeAudioContext.made[0]!;
    expect(ctx.sources.map((s) => s.stream)).toEqual([bob, carol]);
    ctx.sources.forEach((source, i) => {
      expect(source.connect).toHaveBeenCalledTimes(1);
      expect(source.connect).toHaveBeenCalledWith(ctx.analysers[i]);
    });
    for (const analyser of ctx.analysers) expect(analyser.connect).not.toHaveBeenCalled();
    expect(ctx.createMediaStreamDestination).not.toHaveBeenCalled();
  });

  // A reading covers the analyser's whole window, and at 48 kHz that window is
  // longer than the 100 ms gap between two readings, so no sound falls between them.
  it('reads a window longer than the gap between two readings', () => {
    render(<LevelsPanel peers={[peers[0]!]} volumes={new Map()} onVolume={vi.fn()} />);
    const analyser = FakeAudioContext.made[0]!.analysers[0]!;
    const read = vi.spyOn(analyser, 'getFloatTimeDomainData');
    tick();
    expect(read.mock.calls[0]![0]).toHaveLength(analyser.fftSize);
    // 48 samples per millisecond at 48 kHz.
    expect(analyser.fftSize / 48).toBeGreaterThan(100);
  });

  it('stops listening when the panel goes', () => {
    const { unmount } = render(<LevelsPanel peers={peers} volumes={new Map()} onVolume={vi.fn()} />);
    const ctx = FakeAudioContext.made[0]!;
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it('follows a person whose connection was rebuilt, and empties the bar while they have no stream', () => {
    const { rerender } = render(<LevelsPanel peers={peers} volumes={new Map()} onVolume={vi.fn()} />);
    const ctx = FakeAudioContext.made[0]!;
    ctx.analysers[0]!.level = 1;
    tick();
    const meter = screen.getByRole('meter', { name: 'Level for Bob' });
    expect(meter).toHaveAttribute('aria-valuenow', '100');

    rerender(<LevelsPanel peers={[{ ...peers[0]!, stream: null }, peers[1]!]} volumes={new Map()} onVolume={vi.fn()} />);
    expect(meter).toHaveAttribute('aria-valuenow', '0');
    expect(ctx.sources[0]!.disconnect).toHaveBeenCalledTimes(1);

    const rebuilt = standIn({ id: 'stream-bob-2' });
    rerender(<LevelsPanel peers={[{ ...peers[0]!, stream: rebuilt }, peers[1]!]} volumes={new Map()} onVolume={vi.fn()} />);
    expect(ctx.sources[2]!.stream).toBe(rebuilt);
    ctx.analysers[2]!.level = 1;
    tick();
    expect(meter).toHaveAttribute('aria-valuenow', '100');
  });

  it('keeps the faders where there is no Web Audio, or a stream has no sound in it', () => {
    vi.unstubAllGlobals(); // as in a browser without Web Audio
    render(<LevelsPanel peers={peers} volumes={new Map()} onVolume={vi.fn()} />);
    expect(screen.getByRole('slider', { name: 'Volume for Bob' })).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Level for Bob' })).toHaveAttribute('aria-valuenow', '0');
    cleanup();

    vi.stubGlobal('AudioContext', FakeAudioContext);
    const videoOnly = standIn({ id: 'stream-dan', noAudio: true });
    render(
      <LevelsPanel
        peers={[{ peerId: 'p-dan', name: 'Dan', stream: videoOnly }, peers[0]!]}
        volumes={new Map()}
        onVolume={vi.fn()}
      />
    );
    expect(screen.getByRole('slider', { name: 'Volume for Dan' })).toBeInTheDocument();
    // The next person is still metered.
    expect(FakeAudioContext.made[0]!.sources.map((s) => s.stream)).toEqual([bob]);
  });

  it('reads a peak in decibels: empty at -60 dBFS, full at full scale', () => {
    expect(levelPercent(1)).toBe(100);
    expect(levelPercent(0.1)).toBe(67);
    expect(levelPercent(0.001)).toBe(0);
    expect(levelPercent(0)).toBe(0);
    expect(levelPercent(2)).toBe(100);
    expect(levelPercent(Number.NaN)).toBe(0);
  });
});
