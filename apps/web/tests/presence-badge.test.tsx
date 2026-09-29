import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PresenceBadge } from '@/components/PresenceBadge';

describe('PresenceBadge accessible names', () => {
  it('exposes accessible names for muted, camera off, and sharing screen', () => {
    render(<PresenceBadge micOn={false} camOn={false} screenSharing={true} />);
    expect(screen.getByRole('img', { name: 'Muted' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Camera off' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Sharing screen' })).toBeInTheDocument();
  });
});
