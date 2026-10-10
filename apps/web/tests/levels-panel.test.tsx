import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LevelsPanel } from '@/components/LevelsPanel';

const peers = [
  { peerId: 'p-bob', name: 'Bob', stream: null },
  { peerId: 'p-carol', name: null, stream: null },
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

  // A name is chosen by its person, so two people can carry the same one.
  it('gives two people with the same name a row and a fader each', () => {
    const onVolume = vi.fn();
    const sams = [
      { peerId: 'p-1', name: 'Sam', stream: null },
      { peerId: 'p-2', name: 'Sam', stream: null },
    ];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { rerender } = render(<LevelsPanel peers={sams} volumes={new Map([['p-2', 0.2]])} onVolume={onVolume} />);
      const faders = screen.getAllByRole('slider', { name: 'Volume for Sam' }) as HTMLInputElement[];
      expect(faders.map((f) => f.value)).toEqual(['100', '20']);
      fireEvent.change(faders[1]!, { target: { value: '60' } });
      expect(onVolume).toHaveBeenLastCalledWith('p-2', 0.6);
      rerender(<LevelsPanel peers={[sams[1]!]} volumes={new Map([['p-2', 0.2]])} onVolume={onVolume} />);
      expect((screen.getAllByRole('slider') as HTMLInputElement[]).map((f) => f.value)).toEqual(['20']);
      // React reports two rows that share a key here.
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
