import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { MediaBoardPanel } from '@/components/MediaBoardPanel';
import { fakeBoard } from './board-fakes';

// The repository lists no recording, so the panel is given one here.
vi.mock('@/lib/sound-files', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sound-files')>()),
  SOUND_FILES: [{ name: 'Applause', file: 'crowd applause.mp3', license: 'CC0-1.0', source: 'test' }],
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
});
