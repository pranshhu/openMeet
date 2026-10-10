import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { MediaBoardPanel } from '@/components/MediaBoardPanel';
import { BOARD_SOUNDS, soundFile } from '@/lib/board-sounds';
import { fakeBoard } from './board-fakes';

const RATE = 48_000;
const sound = (name: string) => BOARD_SOUNDS.find((s) => s.name === name)!;
const peak = (s: Float32Array) => s.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe('ready sounds', () => {
  it('are a chime, a rimshot and a bed', () => {
    expect(BOARD_SOUNDS.map((s) => [s.name, !!s.bed])).toEqual([
      ['Chime', false],
      ['Rimshot', false],
      ['Soft bed', true],
    ]);
  });

  // A pad is mixed over the voice at full gain and has no volume of its own.
  it.each(['Chime', 'Rimshot'])('%s starts and ends in silence and leaves room for the voice', (name) => {
    const s = sound(name).render(RATE);
    expect(s.length).toBeGreaterThan(RATE / 2);
    expect(s.length).toBeLessThan(RATE * 2);
    expect(s[0]).toBe(0);
    expect(Math.abs(s[s.length - 1]!)).toBeLessThan(0.001);
    expect(peak(s)).toBeGreaterThan(0.2);
    expect(peak(s)).toBeLessThan(0.5);
  });

  it('makes a bed that is quiet and runs into its own start without a step', () => {
    const s = sound('Soft bed').render(RATE);
    expect(s.length).toBe(RATE * 4);
    expect(peak(s)).toBeGreaterThan(0.05);
    expect(peak(s)).toBeLessThan(0.15);
    // The last sample, the first and the second lie on one smooth curve.
    expect(Math.abs(s[s.length - 1]! - 2 * s[0]! + s[1]!)).toBeLessThan(0.001);
  });

  it('wraps a sound as a WAV file named after it', async () => {
    const chime = sound('Chime');
    const samples = chime.render(RATE).length;
    const file = soundFile(chime);
    expect(file.name).toBe('Chime');
    expect(file.type).toBe('audio/wav');
    // 44 bytes of header, then three bytes for every sample.
    expect(file.size).toBe(44 + 3 * samples);
    // jsdom has no Blob.prototype.arrayBuffer.
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
    // The header has to say what the samples are, or the board decodes noise.
    const header = new DataView(bytes);
    expect(header.getUint16(22, true)).toBe(1); // channels
    expect(header.getUint32(24, true)).toBe(RATE);
    expect(header.getUint16(34, true)).toBe(24); // bits in a sample
    expect(header.getUint32(40, true)).toBe(3 * samples); // bytes of samples
  });
});

describe('MediaBoardPanel: ready sounds', () => {
  afterEach(() => vi.restoreAllMocks());

  const click = (name: string) =>
    act(async () => {
      fireEvent.click(screen.getByRole('button', { name }));
    });

  it('adds a ready sound as a pad with one click and stops offering it', async () => {
    const board = fakeBoard();
    const fired: string[] = [];
    const first = render(<MediaBoardPanel board={board} onFire={(n) => fired.push(n)} onClose={() => {}} />);
    const group = screen.getByRole('group', { name: 'Ready sounds' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual([
      '+ Chime',
      '+ Rimshot',
      '+ Soft bed',
    ]);
    // On a phone the label takes a line of its own and each button is 44 px to tap.
    expect(group.className).toMatch(/flex-wrap/);
    expect(within(group).getByText('Ready sounds').className).toMatch(/w-full.*sm:w-auto/);
    expect(screen.getByRole('button', { name: 'Add Chime' }).className).toMatch(/min-h-11.*sm:min-h-0/);

    await click('Add Chime');
    expect(board.pads.map((p) => p.name)).toEqual(['Chime']);
    expect(screen.queryByRole('button', { name: 'Add Chime' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add Rimshot' })).toBeInTheDocument();
    // Adding is not firing: the marker is dropped when the pad is clicked.
    expect(fired).toEqual([]);
    fireEvent.click(screen.getByTitle('Chime'));
    expect(fired).toEqual(['Chime']);

    // The panel unmounts on close; what is on the board is still not offered.
    first.unmount();
    render(<MediaBoardPanel board={board} onFire={() => {}} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Add Chime' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add Soft bed' })).toBeInTheDocument();
  });

  it('puts the bed on the board set to loop and to fade, and a sting as it is', async () => {
    render(<MediaBoardPanel board={fakeBoard()} onFire={() => {}} onClose={() => {}} />);
    await click('Add Soft bed');
    await click('Add Chime');
    const pressed = (name: string) => screen.getByRole('button', { name }).getAttribute('aria-pressed');
    expect(pressed('Loop Soft bed')).toBe('true');
    expect(pressed('Fade Soft bed')).toBe('true');
    expect(pressed('Loop Chime')).toBe('false');
    expect(pressed('Fade Chime')).toBe('false');
  });

  it('makes no sound before its button is clicked', async () => {
    const made = BOARD_SOUNDS.map((s) => vi.spyOn(s, 'render'));
    render(<MediaBoardPanel board={fakeBoard()} onFire={() => {}} onClose={() => {}} />);
    expect(made.map((m) => m.mock.calls.length)).toEqual([0, 0, 0]);
    await click('Add Rimshot');
    expect(made.map((m) => m.mock.calls.length)).toEqual([0, 1, 0]);
  });

  it('adds a sound once when its button is clicked twice', async () => {
    const board = fakeBoard();
    render(<MediaBoardPanel board={board} onFire={() => {}} onClose={() => {}} />);
    const add = screen.getByRole('button', { name: 'Add Chime' });
    // Two separate clicks: the page is drawn again between them, as in a browser.
    fireEvent.click(add);
    fireEvent.click(add);
    await act(async () => {});
    expect(board.pads).toHaveLength(1);
  });

  it('says so when a sound cannot be added, and leaves its button', async () => {
    const board = fakeBoard();
    const load = board.load;
    board.load = async () => {
      throw new Error('decode error');
    };
    render(<MediaBoardPanel board={board} onFire={() => {}} onClose={() => {}} />);
    await click('Add Chime');
    expect(screen.getByRole('alert')).toHaveTextContent('Could not add Chime.');
    expect(board.pads).toEqual([]);
    expect(screen.getByRole('button', { name: 'Add Chime' })).toBeEnabled();

    // The next try starts clean: the message does not stay over a pad that came.
    board.load = load;
    await click('Add Chime');
    expect(board.pads.map((p) => p.name)).toEqual(['Chime']);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('draws no row when there is nothing to offer', async () => {
    // No microphone to mix into: there is no board to put a sound on.
    const none = render(<MediaBoardPanel board={null} onFire={() => {}} onClose={() => {}} />);
    expect(screen.queryByRole('group', { name: 'Ready sounds' })).toBeNull();
    none.unmount();

    render(<MediaBoardPanel board={fakeBoard()} onFire={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('group', { name: 'Ready sounds' })).toBeInTheDocument();
    for (const s of BOARD_SOUNDS) await click(`Add ${s.name}`);
    expect(screen.queryByRole('group', { name: 'Ready sounds' })).toBeNull();
  });

  // The panel grows upward over the stage, and only the list of pads scrolls:
  // a row outside it would push a full board up over the status bar on a phone.
  it('keeps the ready sounds inside the scrolling list once the board has pads', async () => {
    render(<MediaBoardPanel board={fakeBoard()} onFire={() => {}} onClose={() => {}} />);
    // An empty board has no list: the row stands right above its opening text.
    expect(screen.queryByRole('list')).toBeNull();
    const text = screen.getByText(/Load intros, stingers or ad reads/);
    expect(text.previousElementSibling?.contains(screen.getByRole('group', { name: 'Ready sounds' }))).toBe(true);

    await click('Add Chime');
    // getByRole fails on two matches, so this is also "drawn once".
    const group = screen.getByRole('group', { name: 'Ready sounds' });
    // First in the list, above the pads, where it stood before the pad came.
    expect(screen.getByRole('list').firstElementChild?.contains(group)).toBe(true);
  });
});
