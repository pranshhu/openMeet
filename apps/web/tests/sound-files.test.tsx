import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { MediaBoardPanel } from '@/components/MediaBoardPanel';
import { fakeBoard } from './board-fakes';

// The repository lists no recording, so the panel is given two here: one as
// it is and one listed as a bed.
vi.mock('@/lib/sound-files', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sound-files')>()),
  SOUND_FILES: [
    { name: 'Applause', file: 'crowd applause.mp3', license: 'CC0-1.0', source: 'test' },
    { name: 'Lounge', file: 'lounge.mp3', license: 'CC0-1.0', source: 'test', bed: true },
  ],
}));

const fetchMock = vi.fn();
const answer = (ok: boolean) =>
  fetchMock.mockResolvedValue({ ok, status: ok ? 200 : 404, blob: async () => new Blob(['abc']) });

describe('MediaBoardPanel: ready sounds from files', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const click = (name: string) =>
    act(async () => {
      fireEvent.click(screen.getByRole('button', { name }));
    });

  it('offers a listed recording after the made sounds and fetches it only when it is added', async () => {
    answer(true);
    const board = fakeBoard();
    render(<MediaBoardPanel board={board} onFire={() => {}} onClose={() => {}} />);
    const group = screen.getByRole('group', { name: 'Ready sounds' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual([
      '+ Chime',
      '+ Rimshot',
      '+ Soft bed',
      '+ Applause',
      '+ Lounge',
    ]);
    await click('Add Chime');
    expect(fetchMock).not.toHaveBeenCalled();

    await click('Add Applause');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/sounds/crowd%20applause.mp3');
    expect(board.pads.map((p) => p.name)).toEqual(['Chime', 'Applause']);
    expect(screen.queryByRole('button', { name: 'Add Applause' })).toBeNull();
  });

  it('says so when the recording cannot be fetched, and leaves its button', async () => {
    answer(false);
    const board = fakeBoard();
    render(<MediaBoardPanel board={board} onFire={() => {}} onClose={() => {}} />);
    await click('Add Applause');
    expect(screen.getByRole('alert')).toHaveTextContent('Could not add Applause.');
    expect(board.pads).toEqual([]);
    expect(screen.getByRole('button', { name: 'Add Applause' })).toBeEnabled();
  });

  it('puts a recording listed as a bed on the board set to loop and to fade, and another as it is', async () => {
    answer(true);
    render(<MediaBoardPanel board={fakeBoard()} onFire={() => {}} onClose={() => {}} />);
    await click('Add Lounge');
    await click('Add Applause');
    const pressed = (name: string) => screen.getByRole('button', { name }).getAttribute('aria-pressed');
    expect(pressed('Loop Lounge')).toBe('true');
    expect(pressed('Fade Lounge')).toBe('true');
    expect(pressed('Loop Applause')).toBe('false');
    expect(pressed('Fade Applause')).toBe('false');
  });
});
