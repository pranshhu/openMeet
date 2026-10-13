import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NoiseRow } from '@/components/NoiseRow';

const idle = { checked: false, unavailable: false, boardInUse: false, takeActive: false, onChange: async () => {} };

describe('NoiseRow', () => {
  it('is a labelled box that says what it changes and what it leaves alone', () => {
    render(<NoiseRow {...idle} />);
    const box = screen.getByRole('checkbox', { name: 'Noise suppression' });
    expect(box).toBeEnabled();
    expect(box).not.toBeChecked();
    expect(box).toHaveAccessibleDescription('For the call only. Your recording stays raw.');
    expect(box.closest('label')).toHaveClass('min-h-11');
  });

  it('shows the choice that is on', () => {
    render(<NoiseRow {...idle} checked />);
    expect(screen.getByRole('checkbox', { name: 'Noise suppression' })).toBeChecked();
  });

  it('passes the new choice on when the box is clicked', () => {
    const onChange = vi.fn(async () => {});
    render(<NoiseRow {...idle} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Noise suppression' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('is disabled and unticked, with its reason, where the browser cannot do it', () => {
    render(<NoiseRow {...idle} checked unavailable />);
    const box = screen.getByRole('checkbox', { name: 'Noise suppression' });
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
    expect(box).toHaveAccessibleDescription('Not available in this browser.');
  });

  it('is disabled and unticked, with its reason, while the media board is in use', () => {
    render(<NoiseRow {...idle} checked boardInUse />);
    const box = screen.getByRole('checkbox', { name: 'Noise suppression' });
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
    expect(box).toHaveAccessibleDescription('Not with the media board in use.');
  });

  it('is disabled during a take and keeps showing the choice', () => {
    render(<NoiseRow {...idle} checked takeActive />);
    const box = screen.getByRole('checkbox', { name: 'Noise suppression' });
    expect(box).toBeDisabled();
    expect(box).toBeChecked();
    expect(box).toHaveAccessibleDescription('Change it between takes.');
  });

  it('puts the browser reason before the board and the board before the take', () => {
    render(<NoiseRow {...idle} unavailable boardInUse takeActive />);
    expect(screen.getByRole('checkbox')).toHaveAccessibleDescription('Not available in this browser.');
  });

  it('is disabled while a change is being carried out', async () => {
    let finish: () => void = () => {};
    const onChange = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    render(<NoiseRow {...idle} onChange={onChange} />);
    const box = screen.getByRole('checkbox', { name: 'Noise suppression' });
    fireEvent.click(box);
    expect(box).toBeDisabled();
    finish();
    await waitFor(() => expect(box).toBeEnabled());
  });
});
