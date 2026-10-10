import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LevelsPanel } from '@/components/LevelsPanel';

const peers = [
  { peerId: 'p-bob', name: 'Bob' },
  { peerId: 'p-carol', name: null },
];

describe('LevelsPanel', () => {
  it('shows a fader for each person at their level, full for a person never set', () => {
    render(<LevelsPanel peers={peers} volumes={new Map([['p-bob', 0.4]])} onVolume={vi.fn()} />);
    const bob = screen.getByRole('slider', { name: 'Volume for Bob' }) as HTMLInputElement;
    expect(bob.value).toBe('40');
    expect(screen.getByText('40%')).toBeInTheDocument();
    // 44px to drag on a phone.
    expect(bob.className).toMatch(/\bh-11\b/);
    // A person whose name has not arrived is listed the way the tiles list them.
    expect((screen.getByRole('slider', { name: 'Volume for Guest' }) as HTMLInputElement).value).toBe('100');
  });

  // The arrow keys move a native range by its step: from 0 to 100 in fives.
  it('moves in steps of 5 from 0 to 100', () => {
    render(<LevelsPanel peers={peers} volumes={new Map()} onVolume={vi.fn()} />);
    const bob = screen.getByRole('slider', { name: 'Volume for Bob' }) as HTMLInputElement;
    expect([bob.min, bob.max, bob.step]).toEqual(['0', '100', '5']);
  });

  it('reports a moved fader as that person’s volume between 0 and 1', () => {
    const onVolume = vi.fn();
    render(<LevelsPanel peers={peers} volumes={new Map()} onVolume={onVolume} />);
    fireEvent.change(screen.getByRole('slider', { name: 'Volume for Bob' }), { target: { value: '65' } });
    expect(onVolume).toHaveBeenLastCalledWith('p-bob', 0.65);
    fireEvent.change(screen.getByRole('slider', { name: 'Volume for Guest' }), { target: { value: '0' } });
    expect(onVolume).toHaveBeenLastCalledWith('p-carol', 0);
  });

  it('says whose ears it is for, and when there is nobody to hear', () => {
    render(<LevelsPanel peers={[]} volumes={new Map()} onVolume={vi.fn()} />);
    expect(screen.getByText('For your ears only. Recordings are not changed.')).toBeInTheDocument();
    expect(screen.getByText('No one else to hear right now.')).toBeInTheDocument();
    expect(screen.queryByRole('slider')).toBeNull();
  });
});
