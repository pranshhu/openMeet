import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Logo, SiteHeader } from '@/components/Logo';

describe('Logo', () => {
  it('renders dark tone with white text and light blue Meet', () => {
    const { container } = render(<Logo tone="dark" />);
    const root = container.firstElementChild!;
    expect(root.textContent).toBe('openMeet');
    expect(root.className).toMatch(/text-\[22px\]/);
    expect(root.className).toMatch(/font-medium/);
    expect(root.className).toMatch(/tracking-tight/);
    expect(root.className).toMatch(/text-white/);
    const meetSpan = root.querySelector('span')!;
    expect(meetSpan.textContent).toBe('Meet');
    expect(meetSpan.className).toMatch(/text-\[#8ab4f8\]/);
  });

  it('renders light tone with dark text and blue Meet', () => {
    const { container } = render(<Logo tone="light" />);
    const root = container.firstElementChild!;
    expect(root.textContent).toBe('openMeet');
    expect(root.className).toMatch(/text-\[22px\]/);
    expect(root.className).toMatch(/font-medium/);
    expect(root.className).toMatch(/tracking-tight/);
    expect(root.className).toMatch(/text-\[#202124\]/);
    const meetSpan = root.querySelector('span')!;
    expect(meetSpan.textContent).toBe('Meet');
    expect(meetSpan.className).toMatch(/text-\[#0b57d0\]/);
  });

  it('SiteHeader links the logo home', () => {
    const { getByRole } = render(<SiteHeader />);
    expect(getByRole('link', { name: 'openMeet home' }).getAttribute('href')).toBe('/');
  });
});
