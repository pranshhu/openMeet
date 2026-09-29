import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Teleprompter, clampToViewport } from '@/components/Teleprompter';

beforeEach(() => localStorage.clear());

describe('Teleprompter', () => {
  it('opens straight into edit mode when the room has no saved script', () => {
    render(<Teleprompter slug="abc-defg-hij" onClose={() => {}} />);
    expect(screen.getByPlaceholderText(/paste your script/i)).toBeTruthy();
  });

  it('persists the script per room, not globally', () => {
    const { unmount } = render(<Teleprompter slug="room-one" onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/paste your script/i), {
      target: { value: 'Welcome to episode 12' },
    });
    unmount();

    // Same room: script comes back, and in read mode rather than edit.
    render(<Teleprompter slug="room-one" onClose={() => {}} />);
    expect(screen.getByText('Welcome to episode 12')).toBeTruthy();
    unmount();
  });

  it('does not leak one room’s script into another', () => {
    const { unmount } = render(<Teleprompter slug="room-one" onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/paste your script/i), {
      target: { value: 'Room one script' },
    });
    unmount();
    render(<Teleprompter slug="room-two" onClose={() => {}} />);
    expect(screen.queryByText('Room one script')).toBeNull();
  });

  it('survives localStorage being unavailable (private mode)', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => render(<Teleprompter slug="x" onClose={() => {}} />)).not.toThrow();
    spy.mockRestore();
  });

  it('auto-scrolls while playing and stops when paused', () => {
    vi.useFakeTimers();
    localStorage.setItem('om_prompter_r', 'line\n'.repeat(200));
    render(<Teleprompter slug="r" onClose={() => {}} />);

    const box = document.querySelector('.overflow-y-auto') as HTMLElement;
    // jsdom reports zero layout, so give the element a scrollable geometry.
    Object.defineProperty(box, 'scrollHeight', { value: 5000, configurable: true });
    Object.defineProperty(box, 'clientHeight', { value: 200, configurable: true });

    fireEvent.click(screen.getByText('Play'));
    act(() => { vi.advanceTimersByTime(1000); });
    const afterPlay = box.scrollTop;
    expect(afterPlay).toBeGreaterThan(0);

    fireEvent.click(screen.getByText('Pause'));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(box.scrollTop).toBe(afterPlay);
    vi.useRealTimers();
  });

  // The scrolling box only exists outside the editor, so Play pressed while
  // editing said Pause and nothing moved until Done.
  it('leaves the editor and scrolls when Play is pressed while editing', () => {
    vi.useFakeTimers();
    try {
      render(<Teleprompter slug="edit-play" onClose={() => {}} />);
      expect(screen.getByText('Play')).toBeDisabled();
      fireEvent.change(screen.getByPlaceholderText(/paste your script/i), {
        target: { value: 'a\n'.repeat(200) },
      });
      fireEvent.click(screen.getByText('Play'));
      expect(screen.queryByPlaceholderText(/paste your script/i)).toBeNull();
      expect(screen.getByText('Pause')).toBeTruthy();

      const box = document.querySelector('.overflow-y-auto') as HTMLElement;
      Object.defineProperty(box, 'scrollHeight', { value: 5000, configurable: true });
      Object.defineProperty(box, 'clientHeight', { value: 200, configurable: true });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(box.scrollTop).toBeGreaterThan(0);

      // Editing always pauses.
      fireEvent.click(screen.getByText('Edit'));
      expect(screen.getByText('Play')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fades only the backdrop, never the controls', () => {
    render(<Teleprompter slug="fade" onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Backdrop opacity'), { target: { value: '30' } });
    const panel = document.querySelector('.rounded-xl') as HTMLElement;
    expect(panel.style.opacity).toBe('');
    expect(panel.style.backgroundColor).toBe('rgba(0, 0, 0, 0.3)');
  });

  it('Restart returns to the top', () => {
    localStorage.setItem('om_prompter_r2', 'a\n'.repeat(200));
    render(<Teleprompter slug="r2" onClose={() => {}} />);
    const box = document.querySelector('.overflow-y-auto') as HTMLElement;
    box.scrollTop = 400;
    fireEvent.click(screen.getByText('Restart'));
    expect(box.scrollTop).toBe(0);
  });
});

describe('clampToViewport', () => {
  // The failure this exists to prevent: a panel dragged past the edge takes its
  // header — the only drag handle — with it, and becomes unreachable.
  it('keeps the panel fully inside the viewport', () => {
    expect(clampToViewport(-50, -80, 400, 200, 1000, 800)).toEqual({ x: 0, y: 0 });
    expect(clampToViewport(9999, 9999, 400, 200, 1000, 800)).toEqual({ x: 600, y: 600 });
  });

  it('leaves a position that already fits alone', () => {
    expect(clampToViewport(120, 60, 400, 200, 1000, 800)).toEqual({ x: 120, y: 60 });
  });

  it('pins to the origin when the panel is larger than the viewport', () => {
    // Never returns a negative bound, which would push it off the top-left.
    expect(clampToViewport(50, 50, 1200, 900, 1000, 800)).toEqual({ x: 0, y: 0 });
  });

  it('allows the exact bottom-right resting position', () => {
    expect(clampToViewport(600, 600, 400, 200, 1000, 800)).toEqual({ x: 600, y: 600 });
  });
});

describe('dragging', () => {
  const header = () => document.querySelector('.cursor-grab, .cursor-grabbing') as HTMLElement;
  const panel = () => document.querySelector('.rounded-xl') as HTMLElement;

  function drag(from: { x: number; y: number }, to: { x: number; y: number }) {
    const h = header();
    fireEvent.pointerDown(h, { clientX: from.x, clientY: from.y, pointerId: 1 });
    fireEvent.pointerMove(h, { clientX: to.x, clientY: to.y, pointerId: 1 });
    fireEvent.pointerUp(h, { clientX: to.x, clientY: to.y, pointerId: 1 });
  }

  it('moves the panel when the header is dragged', () => {
    render(<Teleprompter slug="drag-room" onClose={() => {}} />);
    expect(panel().style.left).toBe(''); // default placement until dragged
    drag({ x: 0, y: 0 }, { x: 300, y: 200 });
    expect(panel().style.left).toBe('300px');
    expect(panel().style.top).toBe('200px');
  });

  // The grabbed point must stay under the cursor. Ignoring the offset makes the
  // panel jump so its corner snaps to the pointer on every drag.
  it('preserves the grab offset instead of snapping the corner to the cursor', () => {
    render(<Teleprompter slug="drag-offset" onClose={() => {}} />);
    drag({ x: 40, y: 25 }, { x: 300, y: 200 });
    expect(panel().style.left).toBe('260px'); // 300 - 40
    expect(panel().style.top).toBe('175px'); // 200 - 25
  });

  it('does not drag when the pointer starts on a control', () => {
    // Otherwise pressing Play or nudging a slider would yank the panel across
    // the screen.
    render(<Teleprompter slug="drag-room-2" onClose={() => {}} />);
    const play = screen.getByText('Play');
    fireEvent.pointerDown(play, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(header(), { clientX: 400, clientY: 300, pointerId: 1 });
    expect(panel().style.left).toBe('');
  });

  it('remembers the position across mounts', () => {
    const { unmount } = render(<Teleprompter slug="drag-room-3" onClose={() => {}} />);
    drag({ x: 0, y: 0 }, { x: 250, y: 150 });
    unmount();

    render(<Teleprompter slug="drag-room-3" onClose={() => {}} />);
    expect(panel().style.left).toBe('250px');
  });

  it('shares one placement across rooms — position is a preference, not room content', () => {
    const { unmount } = render(<Teleprompter slug="room-a" onClose={() => {}} />);
    drag({ x: 0, y: 0 }, { x: 180, y: 90 });
    unmount();
    render(<Teleprompter slug="room-b" onClose={() => {}} />);
    expect(panel().style.left).toBe('180px');
  });

  it('clamps a drag past the edge so the handle stays reachable', () => {
    render(<Teleprompter slug="drag-room-4" onClose={() => {}} />);
    drag({ x: 0, y: 0 }, { x: -500, y: -500 });
    expect(panel().style.left).toBe('0px');
    expect(panel().style.top).toBe('0px');
  });
});

describe('restored position', () => {
  const panel = () => document.querySelector('.rounded-xl') as HTMLElement;
  const realW = window.innerWidth;
  const realH = window.innerHeight;

  function viewport(w: number, h: number) {
    Object.defineProperty(window, 'innerWidth', { value: w, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: h, configurable: true });
  }

  beforeEach(() => {
    // jsdom has no layout; give the panel the size it has on a phone.
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(374);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(250);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    viewport(realW, realH);
  });

  // The saved placement is global, so one drag on a wide window used to strand
  // the panel off screen on every narrower one — toolbar says open, nothing shows.
  it('pulls a position saved on a wider window back on screen when it opens', () => {
    localStorage.setItem('om_prompter_pos', JSON.stringify({ x: 672, y: 564 }));
    viewport(390, 700);
    render(<Teleprompter slug="narrow" onClose={() => {}} />);
    expect(panel().style.left).toBe('16px'); // 390 - 374
    expect(panel().style.top).toBe('450px'); // 700 - 250
  });

  it('pulls it back in when the window shrinks while it is open', () => {
    localStorage.setItem('om_prompter_pos', JSON.stringify({ x: 600, y: 100 }));
    viewport(1440, 900);
    render(<Teleprompter slug="shrink" onClose={() => {}} />);
    expect(panel().style.left).toBe('600px');
    viewport(390, 700);
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(panel().style.left).toBe('16px');
  });

  it('gives the script box a real label, not just a placeholder', () => {
    render(<Teleprompter slug="label" onClose={() => {}} />);
    const box = screen.getByPlaceholderText(/paste your script/i) as HTMLTextAreaElement;
    expect(box.labels?.[0]?.textContent).toBe('Teleprompter script');
  });
});
