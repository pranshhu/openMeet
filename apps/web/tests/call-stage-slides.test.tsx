import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import type { PresentedSlides } from '@/lib/slides';
import { CallStage } from '@/components/CallStage';

const props = {
  role: 'guest' as const,
  phase: 'in-call' as const,
  localStream: null,
  remoteStream: null,
  remotePeers: [],
  remoteScreenStream: null,
  localScreenStream: null,
  localName: 'Alice',
  screenSharing: false,
  canRecord: false,
  roomRecording: false,
  recordBlocked: false,
  messages: [],
  screenShareSupported: true,
  backupUrl: null,
  wavBackupUrl: null,
  syncReportUrl: null,
  recordingError: null,
  recordUnavailableReason: null,
  onToggleMic: vi.fn(),
  onToggleCam: vi.fn(),
  onRecord: vi.fn(),
  onEnd: vi.fn(),
  onLeave: vi.fn(),
  onSendChat: vi.fn(),
  slug: 'abc-defg-hij',
  onMark: vi.fn(),
  markerCount: 0,
  chaptersUrl: null,
  summary: null,
  takes: [],
  onNewTake: vi.fn(),
  onDiscardTake: vi.fn(),
  onOpenMediaBoard: vi.fn(() => null),
  onToggleScreen: vi.fn(),
  capabilities: {},
};

/** How loud each <video> that plays this stream is set. */
const volumesOf = (container: HTMLElement, stream: MediaStream) =>
  Array.from(container.querySelectorAll('video'))
    .filter((v) => (v as { srcObject?: unknown }).srcObject === stream)
    .map((v) => v.volume);


const deck = {
  count: 3,
  index: 0,
  show: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn(),
  stream: Object.assign(new EventTarget(), { id: 'stream-deck' }) as unknown as MediaStream,
} satisfies PresentedSlides;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const openPresentMenu = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Choose what to present' }));
  return screen.getByRole('menu', { name: 'Present options' });
};

describe('CallStage: slides', () => {
  it('offers Slides (pictures) in the Present menu and hands the chosen files over as a list', () => {
    const onToggleScreen = vi.fn();
    render(<CallStage {...props} onToggleScreen={onToggleScreen} />);
    const menu = openPresentMenu();
    const item = within(menu).getByText('Slides (pictures)').closest('label') as HTMLLabelElement;
    expect(item).toHaveAttribute('role', 'menuitem');
    expect(item.className).toContain('min-h-11');
    const input = item.querySelector('input') as HTMLInputElement;
    expect(input.accept).toBe('image/*');
    expect(input.multiple).toBe(true);

    const a = new File(['a'], 'a.png', { type: 'image/png' });
    const b = new File(['b'], 'b.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [a, b] } });

    expect(onToggleScreen).toHaveBeenCalledTimes(1);
    expect(onToggleScreen).toHaveBeenCalledWith([a, b]);
    expect(screen.queryByRole('menu', { name: 'Present options' })).toBeNull();
  });

  it('does nothing when no file was chosen', () => {
    const onToggleScreen = vi.fn();
    render(<CallStage {...props} onToggleScreen={onToggleScreen} />);
    const menu = openPresentMenu();
    const input = within(menu).getByText('Slides (pictures)').closest('label')!.querySelector('input')!;
    fireEvent.change(input, { target: { files: [] } });
    expect(onToggleScreen).not.toHaveBeenCalled();
    expect(screen.getByRole('menu', { name: 'Present options' })).toBeInTheDocument();
  });

  it('keeps A photo or video as it was', () => {
    const onToggleScreen = vi.fn();
    render(<CallStage {...props} onToggleScreen={onToggleScreen} />);
    const menu = openPresentMenu();
    const input = within(menu).getByText('A photo or video').closest('label')!.querySelector('input')!;
    expect(input.multiple).toBe(false);
    const photo = new File(['p'], 'p.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [photo] } });
    expect(onToggleScreen).toHaveBeenCalledWith(photo);
  });

  it('shows the Previous and Next row while a deck is presented, and only then', () => {
    const { rerender } = render(<CallStage {...props} />);
    expect(screen.queryByRole('group', { name: 'Slides' })).toBeNull();

    rerender(<CallStage {...props} screenSharing slides={deck} />);
    const row = screen.getByRole('group', { name: 'Slides' });
    expect(within(row).getByRole('button', { name: 'Next' })).toBeInTheDocument();
    expect(within(row).getByText('Slide 1 of 3')).toBeInTheDocument();

    rerender(<CallStage {...props} slides={null} />);
    expect(screen.queryByRole('group', { name: 'Slides' })).toBeNull();
  });

  it('starts a second deck from its own first slide', () => {
    const second = { ...deck, count: 5, stream: Object.assign(new EventTarget(), { id: 'stream-deck-2' }) as unknown as MediaStream };
    const { rerender } = render(<CallStage {...props} screenSharing slides={deck} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Slide 2 of 3')).toBeInTheDocument();

    rerender(<CallStage {...props} screenSharing slides={second} />);
    expect(screen.getByText('Slide 1 of 5')).toBeInTheDocument();
  });
});
