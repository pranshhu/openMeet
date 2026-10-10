import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { CallStage } from '@/components/CallStage';

// EventTargets, because a tile listens on the stream it is given.
const bob = Object.assign(new EventTarget(), { id: 'stream-bob' }) as unknown as MediaStream;
const carol = Object.assign(new EventTarget(), { id: 'stream-carol' }) as unknown as MediaStream;
const shared = Object.assign(new EventTarget(), { id: 'stream-screen' }) as unknown as MediaStream;

// Bob and Carol have a tile. Pat (a producer) and Dana's present-only device
// send no voice of their own, so they have none.
const props = {
  role: 'guest' as const,
  phase: 'in-call' as const,
  localStream: null,
  remoteStream: bob,
  remotePeers: [
    { peerId: 'p-bob', name: 'Bob', stream: bob },
    { peerId: 'p-carol', name: 'Carol', stream: carol },
    { peerId: 'p-pat', name: 'Pat', stream: null, role: 'producer' as const },
    { peerId: 'p-dana', name: 'Dana', stream: null, role: 'guest' as const, companion: true },
  ],
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

describe('CallStage: levels', () => {
  it('turns one person down in this tab, and nobody else', () => {
    const { container } = render(<CallStage {...props} />);
    for (const v of container.querySelectorAll('video')) expect(v.volume).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Levels' }));
    const panel = screen.getByRole('region', { name: 'Levels' });
    expect(within(panel).getAllByRole('slider').map((s) => s.getAttribute('aria-label'))).toEqual([
      'Volume for Bob',
      'Volume for Carol',
    ]);

    fireEvent.change(within(panel).getByRole('slider', { name: 'Volume for Bob' }), { target: { value: '30' } });
    expect(volumesOf(container, bob)).toEqual([0.3]);
    expect(volumesOf(container, carol)).toEqual([1]);

    fireEvent.change(within(panel).getByRole('slider', { name: 'Volume for Carol' }), { target: { value: '50' } });
    expect(volumesOf(container, carol)).toEqual([0.5]);
    expect(volumesOf(container, bob)).toEqual([0.3]);
  });

  // While a screen is presented the first other person is drawn twice (the
  // floating tile and the camera column) and both elements play.
  it('reaches both tiles of a person while a screen is presented, and leaves the screen’s own sound alone', () => {
    const { container } = render(<CallStage {...props} remoteScreenStream={shared} />);
    fireEvent.click(screen.getByRole('button', { name: 'Levels' }));
    fireEvent.change(screen.getByRole('slider', { name: 'Volume for Bob' }), { target: { value: '30' } });
    expect(volumesOf(container, bob)).toEqual([0.3, 0.3]);
    expect(volumesOf(container, shared)).toEqual([1]);
  });

  it('keeps a level while the panel is hidden, and says so on the button', () => {
    const { container } = render(<CallStage {...props} />);
    const closed = screen.getByRole('button', { name: 'Levels' });
    expect(within(closed).queryByTestId('badge')).toBeNull();
    fireEvent.click(closed);
    fireEvent.change(screen.getByRole('slider', { name: 'Volume for Bob' }), { target: { value: '30' } });

    fireEvent.click(screen.getByRole('button', { name: 'Hide levels' }));
    expect(screen.queryByRole('region', { name: 'Levels' })).toBeNull();
    expect(volumesOf(container, bob)).toEqual([0.3]);

    const marked = screen.getByRole('button', { name: 'Levels (someone is turned down)' });
    expect(within(marked).getByTestId('badge')).toBeInTheDocument();
    fireEvent.click(marked);
    expect((screen.getByRole('slider', { name: 'Volume for Bob' }) as HTMLInputElement).value).toBe('30');
  });

  it('draws an icon on the button, and lights it while the panel is open', () => {
    render(<CallStage {...props} />);
    const button = screen.getByRole('button', { name: 'Levels' });
    expect(button.querySelector('svg path')).not.toBeNull();
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: 'Hide levels' }).className).toMatch(/bg-white text-\[#202124\]/);
  });

  // The strip sits in the flow between the stage and the control bar, so it
  // covers no face and no other panel.
  it('opens a strip in the flow between the stage and the control bar', () => {
    render(<CallStage {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Levels' }));
    const panel = screen.getByRole('region', { name: 'Levels' });
    const main = screen.getByTestId('stage-main');
    expect(main.contains(panel)).toBe(false);
    expect(main.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel.compareDocumentPosition(screen.getByLabelText('Leave call')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel.className).not.toMatch(/\b(absolute|fixed)\b/);
  });

  it('is offered to a producer, and not to a present-only device, which plays nobody', () => {
    render(<CallStage {...props} role="producer" />);
    expect(screen.getByRole('button', { name: 'Levels' })).toBeInTheDocument();
    cleanup();

    render(<CallStage {...props} companion />);
    expect(screen.queryByRole('button', { name: 'Levels' })).toBeNull();
  });
});
