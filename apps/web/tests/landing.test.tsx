import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import Landing from '@/app/page';

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('Landing page', () => {
  beforeEach(() => {
    globalThis.ResizeObserver = MockResizeObserver as any;
    vi.stubGlobal('fetch', vi.fn());
    delete (window as any).location;
    (window as any).location = new URL('http://localhost:3000/');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('checkoutUrl: null → today’s plain landing (no wall)', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          checkoutUrl: null,
          sponsors: [],
          available: 1,
        }),
        { status: 200 }
      )
    );

    render(<Landing />);

    // Should render hero content
    expect(await screen.findByRole('heading', { name: /Studio-quality remote recording/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New Room/i })).toBeInTheDocument();

    // No sponsor wall
    expect(screen.queryByLabelText('Sponsors')).toBeNull();
    expect(screen.queryByRole('link', { name: /Sponsor openMeet/i })).toBeNull();
  });

  it('fetch failure → plain landing', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));

    render(<Landing />);

    expect(await screen.findByRole('heading', { name: /Studio-quality remote recording/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New Room/i })).toBeInTheDocument();
    expect(screen.queryByLabelText('Sponsors')).toBeNull();
  });

  it('page renders the pitch and the panel side by side when configured', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          checkoutUrl: 'https://buy.polar.sh/openmeet',
          sponsors: [
            { name: 'Acme', url: 'https://acme.com', logo: null, weight: 0.5 },
          ],
          available: 0.5,
        }),
        { status: 200 }
      )
    );

    const { container } = render(<Landing />);
    expect(await screen.findByLabelText('Sponsors')).toBeInTheDocument();

    // Pitch elements on the left
    const header = container.querySelector('header.head');
    expect(header).toBeInTheDocument();
    expect(header!.textContent).toContain('openMeet');

    expect(screen.getByRole('heading', { name: /Studio-quality remote recording/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New Room/i })).toBeInTheDocument();

    // Side panel on the right
    const side = container.querySelector('aside.side');
    expect(side).toBeInTheDocument();
    expect(side!.querySelector('[aria-label="Sponsors"]')).toBeInTheDocument();

    // Footer with github link and checkout sponsor link
    const footerLink = screen.getByRole('link', { name: /open-source/i });
    expect(footerLink).toBeInTheDocument();
    expect(container.textContent).toContain('self-hostable · MIT licensed');

    const sponsorLinks = screen.getAllByRole('link', { name: /Sponsor openMeet/i });
    expect(sponsorLinks.some((l) => l.getAttribute('href') === 'https://buy.polar.sh/openmeet')).toBe(true);
  });

  it('?sponsored=1 → thank-you line', async () => {
    (window as any).location = new URL('http://localhost:3000/?sponsored=1');

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          checkoutUrl: 'https://buy.polar.sh/openmeet',
          sponsors: [
            { name: 'Acme', url: 'https://acme.com', logo: null, weight: 0.5 },
          ],
          available: 0.5,
        }),
        { status: 200 }
      )
    );

    render(<Landing />);

    expect(
      await screen.findByText("Thank you! Your logo appears here once it's approved.")
    ).toBeInTheDocument();
  });
});

