import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SponsorWall } from '@/components/SponsorWall';
import type { Rect } from '@/lib/treemap';

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('SponsorWall', () => {
  beforeEach(() => {
    globalThis.ResizeObserver = MockResizeObserver as any;
  });

  it('renders wall with aria-label="Sponsors" and caption', () => {
    render(
      <SponsorWall
        sponsors={[
          { name: 'Acme', url: 'https://acme.com', logo: 'https://acme.com/logo.png', weight: 0.5 },
        ]}
        available={0.5}
        checkoutUrl="https://buy.polar.sh/openmeet"
      />
    );

    const wall = screen.getByLabelText('Sponsors');
    expect(wall).toBeInTheDocument();
    expect(
      screen.getByText('Tile size is proportional to support. Every open cell is available.')
    ).toBeInTheDocument();
  });

  it('the panel shows "N% open" from available', () => {
    const { rerender } = render(
      <SponsorWall
        sponsors={[
          { name: 'Acme', url: 'https://acme.com', logo: null, weight: 0.6 },
        ]}
        available={0.4}
        checkoutUrl="https://buy.polar.sh/openmeet"
      />
    );

    expect(screen.getByText('40% open')).toBeInTheDocument();

    rerender(
      <SponsorWall
        sponsors={[]}
        available={1}
        checkoutUrl="https://buy.polar.sh/openmeet"
      />
    );

    expect(screen.getByText('100% open')).toBeInTheDocument();
  });

  it('a sponsor tile links with rel containing sponsored', () => {
    render(
      <SponsorWall
        sponsors={[
          { name: 'Acme', url: 'https://acme.com', logo: null, weight: 0.6 },
        ]}
        available={0.4}
        checkoutUrl="https://buy.polar.sh/openmeet"
      />
    );

    const link = screen.getByRole('link', { name: /Sponsor: Acme/i });
    expect(link).toHaveAttribute('href', 'https://acme.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('sponsored');
  });

  it('no-logo tile shows the name', () => {
    render(
      <SponsorWall
        sponsors={[
          { name: 'NoLogo Corp', url: 'https://nologo.com', logo: null, weight: 0.6 },
        ]}
        available={0.4}
        checkoutUrl="https://buy.polar.sh/openmeet"
      />
    );

    expect(screen.getByText('NoLogo Corp')).toBeInTheDocument();
  });

  it('shows logo img when present and falls back to name if img fails to load', () => {
    render(
      <SponsorWall
        sponsors={[
          { name: 'Acme', url: 'https://acme.com', logo: 'https://acme.com/bad.png', weight: 0.6 },
        ]}
        available={0.4}
        checkoutUrl="https://buy.polar.sh/openmeet"
      />
    );

    const img = screen.getByAltText('Acme');
    expect(img).toHaveAttribute('referrerPolicy', 'no-referrer');

    // Simulate img error
    fireEvent.error(img);

    // Name text should now appear
    expect(screen.getByText('Acme')).toBeInTheDocument();
  });

  it('renders plain box without url when sponsor url is null', () => {
    render(
      <SponsorWall
        sponsors={[
          { name: 'Secret Sponsor', url: null, logo: null, weight: 0.5 },
        ]}
        available={0.5}
        checkoutUrl="https://buy.polar.sh/openmeet"
      />
    );

    expect(screen.queryByRole('link', { name: /Sponsor: Secret Sponsor/i })).toBeNull();
    expect(screen.getByText('Secret Sponsor')).toBeInTheDocument();
  });

  it('the open-space grid is a single link to checkout', () => {
    render(
      <SponsorWall
        sponsors={[
          { name: 'Acme', url: 'https://acme.com', logo: null, weight: 0.2 },
        ]}
        available={0.8}
        checkoutUrl="https://buy.polar.sh/openmeet"
      />
    );

    const openLink = screen.getByRole('link', { name: /Sponsor openMeet — your logo here/i });
    expect(openLink).toBeInTheDocument();
    expect(openLink).toHaveAttribute('href', 'https://buy.polar.sh/openmeet');
  });

  it('empty state shows "Be the first sponsor"', () => {
    render(
      <SponsorWall
        sponsors={[]}
        available={1}
        checkoutUrl="https://buy.polar.sh/openmeet"
      />
    );

    expect(screen.getByText(/Be the first sponsor/i)).toBeInTheDocument();
  });

  it('draws cells and handles hover below the block for a small sponsor', () => {
    const { container } = render(
      <SponsorWall
        sponsors={[
          { name: 'First Fan', url: null, logo: null, weight: 0.025 },
        ]}
        available={0.975}
        checkoutUrl="https://buy.polar.sh/openmeet"
        bounds={{ w: 1440, h: 900 }}
      />
    );

    const path = container.querySelector('svg path');
    expect(path).not.toBeNull();
    expect(path?.getAttribute('fill-rule')).toBe('evenodd');

    const openLink = screen.getByRole('link', { name: /Sponsor openMeet — your logo here/i });
    const hl = container.querySelector('.hl') as HTMLElement;
    expect(hl).not.toBeNull();

    // Hover below the block: column 0, row 11 (pitch = 16, oy = 8 -> clientX = 8, clientY = 8 + 11 * 16 + 8 = 192)
    fireEvent.mouseMove(openLink, { clientX: 8, clientY: 192 });
    expect(hl.style.display).toBe('block');

    // Hover inside the block: column 0, row 0 (clientX = 8, clientY = 16)
    fireEvent.mouseMove(openLink, { clientX: 8, clientY: 16 });
    expect(hl.style.display).toBe('none');
  });
});

