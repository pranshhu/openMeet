import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import RoomPage from '@/app/r/[slug]/page';

vi.mock('@/components/RoomView', () => ({
  RoomView: ({ slug }: { slug: string }) => <p>room:{slug}</p>,
}));

describe('room page address', () => {
  beforeEach(() => {
    delete (window as any).location;
  });

  it('opens the room named in lowercase when the address has capitals', async () => {
    (window as any).location = new URL('http://localhost:3000/r/My-Show/');
    render(<RoomPage />);
    expect(await screen.findByText('room:my-show')).toBeInTheDocument();
  });

  it('opens a random room link as typed', async () => {
    (window as any).location = new URL('http://localhost:3000/r/abc-defg-hij/');
    render(<RoomPage />);
    expect(await screen.findByText('room:abc-defg-hij')).toBeInTheDocument();
  });
});
