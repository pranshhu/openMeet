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

describe('SlideControls keys', () => {
  const press = (key: string, init: KeyboardEventInit = {}, target: Window | Element = window) =>
    fireEvent.keyDown(target, { key, ...init });

  afterEach(() => localStorage.removeItem('om_single_keys'));

  it('turns to the next slide with ArrowRight and PageDown, and back with ArrowLeft and PageUp', () => {
    for (const [forward, back] of [
      ['ArrowRight', 'ArrowLeft'],
      ['PageDown', 'PageUp'],
    ] as const) {
      const slides = deckAt(1);
      render(<SlideControls slides={slides} />);
      press(forward);
      expect(slides.show).toHaveBeenLastCalledWith(2);
      expect(screen.getByText('Slide 3 of 3')).toBeInTheDocument();
      press(back);
      press(back);
      expect(slides.show).toHaveBeenLastCalledWith(0);
      expect(screen.getByText('Slide 1 of 3')).toBeInTheDocument();
      cleanup();
    }
  });

  it('does nothing past the first or the last slide, and still takes the key from the page', () => {
    const last = deckAt(2);
    render(<SlideControls slides={last} />);
    expect(press('ArrowRight')).toBe(false);
    expect(press('PageDown')).toBe(false);
    expect(last.show).not.toHaveBeenCalled();
    cleanup();

    const first = deckAt(0);
    render(<SlideControls slides={first} />);
    expect(press('ArrowLeft')).toBe(false);
    expect(press('PageUp')).toBe(false);
    expect(first.show).not.toHaveBeenCalled();
  });

  it('takes the key it used from the page and leaves every other key alone', () => {
    const slides = deckAt(0);
    render(<SlideControls slides={slides} />);
    expect(press('ArrowRight')).toBe(false);
    for (const key of ['ArrowDown', 'ArrowUp', ' ', 'Enter', 'Home', 'End']) expect(press(key)).toBe(true);
    expect(slides.show).toHaveBeenCalledTimes(1);
  });

  it('leaves a held key and a key with Ctrl, Cmd, Alt or Shift to the browser', () => {
    const slides = deckAt(1);
    render(<SlideControls slides={slides} />);
    for (const init of [
      { repeat: true },
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { shiftKey: true },
    ]) {
      expect(press('ArrowRight', init)).toBe(true);
    }
    expect(slides.show).not.toHaveBeenCalled();
  });

  it('leaves the arrow keys to a field, a list and a fader', () => {
    const slides = deckAt(1);
    render(
      <>
        <SlideControls slides={slides} />
        <input aria-label="field" />
        <textarea aria-label="area" />
        <select aria-label="list" />
        <div contentEditable suppressContentEditableWarning aria-label="editable" />
      </>
    );
    for (const label of ['field', 'area', 'list', 'editable']) {
      expect(press('ArrowRight', {}, screen.getByLabelText(label))).toBe(true);
    }
    expect(slides.show).not.toHaveBeenCalled();
  });

  it('leaves the keys alone while its row is not displayed', () => {
    const slides = deckAt(1);
    render(<SlideControls slides={slides} />);
    screen.getByRole('group', { name: 'Slides' }).checkVisibility = () => false;
    expect(press('ArrowRight')).toBe(true);
    expect(slides.show).not.toHaveBeenCalled();
  });

  it('stops listening when it unmounts', () => {
    const slides = deckAt(1);
    const { unmount } = render(<SlideControls slides={slides} />);
    unmount();
    expect(press('ArrowRight')).toBe(true);
    expect(slides.show).not.toHaveBeenCalled();
  });

  it('turns the slide while the single keys are off', () => {
    localStorage.setItem('om_single_keys', '0');
    const slides = deckAt(0);
    render(<SlideControls slides={slides} />);
    press('ArrowRight');
    expect(slides.show).toHaveBeenCalledWith(1);
  });

  it('names its keys on its buttons', () => {
    render(<SlideControls slides={deckAt(1)} />);
    expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute('aria-keyshortcuts', 'ArrowRight PageDown');
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveAttribute('aria-keyshortcuts', 'ArrowLeft PageUp');
  });
});
