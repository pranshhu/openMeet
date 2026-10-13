import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SlideControls } from '@/components/SlideControls';
import type { PresentedSlides } from '@/lib/slides';

const deckAt = (index: number, count = 3) =>
  ({
    count,
    index,
    show: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    stream: new EventTarget() as unknown as MediaStream,
  }) satisfies PresentedSlides;

afterEach(cleanup);

describe('SlideControls', () => {
  it('turns the slides with Previous and Next and says where it is', () => {
    const slides = deckAt(0);
    render(<SlideControls slides={slides} />);

    const previous = screen.getByRole('button', { name: 'Previous' });
    const next = screen.getByRole('button', { name: 'Next' });
    expect(previous).toBeDisabled();
    expect(next).toBeEnabled();
    expect(screen.getByText('Slide 1 of 3')).toBeInTheDocument();

    fireEvent.click(next);
    expect(slides.show).toHaveBeenCalledWith(1);
    expect(screen.getByText('Slide 2 of 3')).toBeInTheDocument();
    expect(previous).toBeEnabled();

    fireEvent.click(previous);
    expect(slides.show).toHaveBeenLastCalledWith(0);
    expect(screen.getByText('Slide 1 of 3')).toBeInTheDocument();
  });

  it('disables Next on the last slide', () => {
    render(<SlideControls slides={deckAt(0, 2)} />);
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Slide 2 of 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled();
  });

  it('starts from the slide the deck is on', () => {
    render(<SlideControls slides={deckAt(2)} />);
    expect(screen.getByText('Slide 3 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('is one labelled group with a polite live count and touch-sized buttons', () => {
    render(<SlideControls slides={deckAt(0)} />);
    const group = screen.getByRole('group', { name: 'Slides' });
    expect(group).toContainElement(screen.getByRole('button', { name: 'Previous' }));
    expect(screen.getByText('Slide 1 of 3')).toHaveAttribute('aria-live', 'polite');
    for (const name of ['Previous', 'Next']) {
      const button = screen.getByRole('button', { name });
      expect(button).toHaveAttribute('type', 'button');
      expect(button.className).toContain('min-h-11');
      expect(button.className).toContain('focus-visible:ring-2');
    }
  });
});
