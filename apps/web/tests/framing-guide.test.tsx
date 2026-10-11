import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FramingGuide } from '@/components/FramingGuide';
import { Lobby } from '@/components/Lobby';

describe('FramingGuide', () => {
  it('lays four lines over the preview while its button is pressed, and none before or after', () => {
    render(<FramingGuide />);
    const button = screen.getByRole('button', { name: 'Framing guide' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('framing-guide')).toBeNull();

    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    const lines = screen.getByTestId('framing-guide');
    expect(lines.children).toHaveLength(4);
    // Decoration over the picture: not read out, and a click goes through to what is under it.
    expect(lines).toHaveAttribute('aria-hidden', 'true');
    expect(lines.className).toMatch(/\bpointer-events-none\b/);

    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('framing-guide')).toBeNull();
  });

  it('places two lines across and two down at the thirds of the box', () => {
    render(<FramingGuide />);
    fireEvent.click(screen.getByRole('button', { name: 'Framing guide' }));
    // jsdom lays nothing out, so the positions are read from the classes the lines are drawn with.
    const classes = Array.from(screen.getByTestId('framing-guide').children, (line) => line.className).join(' ');
    expect(classes).toContain('left-1/3');
    expect(classes).toContain('left-2/3');
    expect(classes).toContain('top-1/3');
    expect(classes).toContain('top-2/3');
  });

  it('is not offered on a phone', () => {
    const userAgent = navigator.userAgent;
    try {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)',
        configurable: true,
      });
      const { container } = render(<FramingGuide />);
      expect(container).toBeEmptyDOMElement();
    } finally {
      Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true });
    }
  });
});

// The preview tile listens to its stream, so the stream is an EventTarget.
function fakeStream(): MediaStream {
  const tracks = [
    { kind: 'audio', enabled: true, stop: vi.fn() },
    { kind: 'video', enabled: true, stop: vi.fn() },
  ];
  return Object.assign(new EventTarget(), {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  }) as unknown as MediaStream;
}

describe('Lobby framing guide', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is on the preview while the camera is on, and never before the camera has started', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(fakeStream()),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
    });
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Framing guide' })).toBeNull();

    const button = await screen.findByRole('button', { name: 'Framing guide' });
    // In the preview's own box, so the lines lie over the picture and nothing else.
    expect(button.parentElement!.querySelector('video')).not.toBeNull();
    fireEvent.click(button);
    expect(screen.getByTestId('framing-guide').parentElement).toBe(button.parentElement);

    fireEvent.click(screen.getByRole('button', { name: 'Turn off camera' }));
    expect(screen.queryByRole('button', { name: 'Framing guide' })).toBeNull();
    expect(screen.queryByTestId('framing-guide')).toBeNull();
  });
});
