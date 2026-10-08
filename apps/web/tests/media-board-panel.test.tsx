import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MediaBoardPanel } from '@/components/MediaBoardPanel';
import type { MediaBoard, Pad } from '@/lib/media-board';

/** The board is the source of truth for what is playing; the panel only mirrors it. */
function fakeBoard(initialPads: Pad[] = []) {
  let pads = [...initialPads];
  const playing = new Set<string>();
  const listeners = new Set<(id: string) => void>();
  const end = (id: string) => {
    playing.delete(id);
    for (const l of listeners) l(id);
  };
  return {
    get pads() {
      return pads;
    },
    async load(file: File): Promise<Pad> {
      if (file.name.endsWith('.bad')) throw new Error('decode error');
      const pad: Pad = { id: `pad-${pads.length + 1}`, name: file.name, durationMs: 3000 };
      pads = [...pads, pad];
      return pad;
    },
    play: (id: string) => void playing.add(id),
    stop: end,
    finish: end,
    isPlaying: (id: string) => playing.has(id),
    setLoop(id: string, loop: boolean) {
      pads = pads.map((p) => (p.id === id ? { ...p, loop } : p));
    },
    onPadEnded(l: (id: string) => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  } as unknown as MediaBoard & { finish: (id: string) => void };
}

const isLit = (el: HTMLElement) => el.className.includes('bg-[#0b57d0]');

describe('MediaBoardPanel', () => {
  it('clears the decode error once a valid file loads', async () => {
    const board = fakeBoard();
    render(<MediaBoardPanel board={board} onFire={() => {}} onClose={() => {}} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], 'fake-audio.bad')] } });
    });
    expect(screen.getByText(/Could not decode fake-audio\.bad/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], 'sting.wav')] } });
    });
    expect(screen.queryByText(/Could not decode/)).toBeNull();
    expect(screen.getByText('sting.wav')).toBeInTheDocument();
  });

  it('still shows a pad as playing after close and reopen, and clears it when the pad ends', () => {
    const board = fakeBoard([{ id: 'pad-1', name: 'intro.wav', durationMs: 2500 }]);
    const first = render(<MediaBoardPanel board={board} onFire={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByTitle('intro.wav'));
    expect(isLit(screen.getByTitle('intro.wav'))).toBe(true);

    first.unmount();
    render(<MediaBoardPanel board={board} onFire={() => {}} onClose={() => {}} />);
    expect(isLit(screen.getByTitle('intro.wav'))).toBe(true);

    act(() => board.finish('pad-1'));
    expect(isLit(screen.getByTitle('intro.wav'))).toBe(false);
  });

  // white/70 on the playing blue is 3.9:1.
  it('brightens the duration while its pad plays', () => {
    const board = fakeBoard([{ id: 'pad-1', name: 'intro.wav', durationMs: 2500 }]);
    render(<MediaBoardPanel board={board} onFire={() => {}} onClose={() => {}} />);
    expect(screen.getByText('2.5s').className).toMatch(/text-white\/70/);
    fireEvent.click(screen.getByTitle('intro.wav'));
    expect(screen.getByText('2.5s').className).toMatch(/text-white\/90/);
  });

  it('fires a pad on click and stops it on the next click', () => {
    const board = fakeBoard([{ id: 'pad-1', name: 'intro.wav', durationMs: 2500 }]);
    const fired: string[] = [];
    render(<MediaBoardPanel board={board} onFire={(n) => fired.push(n)} onClose={() => {}} />);

    fireEvent.click(screen.getByTitle('intro.wav'));
    expect(board.isPlaying('pad-1')).toBe(true);
    expect(fired).toEqual(['intro.wav']);

    fireEvent.click(screen.getByTitle('intro.wav'));
    expect(board.isPlaying('pad-1')).toBe(false);
    expect(isLit(screen.getByTitle('intro.wav'))).toBe(false);
    expect(fired).toEqual(['intro.wav']);
  });

  it('sets a pad to loop from its Loop switch, without firing it', () => {
    const board = fakeBoard([{ id: 'pad-1', name: 'bed.wav', durationMs: 2500 }]);
    const fired: string[] = [];
    render(<MediaBoardPanel board={board} onFire={(n) => fired.push(n)} onClose={() => {}} />);
    const loop = screen.getByRole('button', { name: 'Loop bed.wav' });
    expect(loop.textContent).toBe('Loop');
    expect(loop.getAttribute('title')).toBe('Repeat until stopped');
    // 44 px to tap on a phone, compact from sm up.
    expect(loop.className).toMatch(/min-h-11.*sm:min-h-0/);
    expect(loop.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(loop);
    expect(board.pads[0]?.loop).toBe(true);
    expect(screen.getByRole('button', { name: 'Loop bed.wav' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Loop bed.wav' }).className).toMatch(/bg-white text-\[#202124\]/);
    expect(board.isPlaying('pad-1')).toBe(false);
    expect(fired).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Loop bed.wav' }));
    expect(board.pads[0]?.loop).toBe(false);
    expect(screen.getByRole('button', { name: 'Loop bed.wav' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Loop bed.wav' }).className).toMatch(/bg-white\/10/);
  });

  // The switch reads the board, as the playing state does: the panel unmounts on close.
  it('still shows a pad as looping after close and reopen', () => {
    const board = fakeBoard([{ id: 'pad-1', name: 'bed.wav', durationMs: 2500 }]);
    const first = render(<MediaBoardPanel board={board} onFire={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Loop bed.wav' }));
    first.unmount();

    render(<MediaBoardPanel board={board} onFire={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Loop bed.wav' }).getAttribute('aria-pressed')).toBe('true');
  });

  // A phone has room for about two rows of pads above the control bar.
  it('scrolls a long list of pads inside the panel', () => {
    const board = fakeBoard([{ id: 'pad-1', name: 'bed.wav', durationMs: 2500 }]);
    render(<MediaBoardPanel board={board} onFire={() => {}} onClose={() => {}} />);
    const list = screen.getByRole('list');
    expect(list.className).toMatch(/max-h-\[40dvh\].*overflow-y-auto/);
    // A scroll box clips at its edge: the padding is where a focused pad's outline goes.
    expect(list.className).toMatch(/(^| )-m-1 .* p-1( |$)/);
  });

  // Lit or not was colour alone; a screen reader couldn't tell a pad was playing.
  it('tells assistive tech whether a pad is playing', () => {
    const board = fakeBoard([{ id: 'pad-1', name: 'intro.wav', durationMs: 2500 }]);
    render(<MediaBoardPanel board={board} onFire={() => {}} onClose={() => {}} />);
    const pad = screen.getByTitle('intro.wav');
    expect(pad.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(pad);
    expect(pad.getAttribute('aria-pressed')).toBe('true');
  });
});
