import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { CallStage } from '@/components/CallStage';

const summary = {
  files: { host: 'host_1.mp4', guest: 'guest_1.mp4' },
  fileList: [
    { name: 'host_1.mp4', kind: 'video' as const },
    { name: 'guest_1.mp4', kind: 'video' as const },
  ],
  audioMasters: { host: null },
  screenFiles: [],
  alignment: '',
  backupNote: '',
  integrity: { ok: true, text: 'Integrity verified' },
  warnings: [],
  markers: [],
  commands: [],
};

// A host whose take is running, and the same page once that take is saved.
const recording = {
  role: 'host' as const,
  phase: 'recording' as const,
  localStream: null,
  remoteStream: null,
  remotePeers: [],
  remoteScreenStream: null,
  localScreenStream: null,
  localName: 'Alice',
  screenSharing: false,
  canRecord: true,
  roomRecording: true,
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
const saved = {
  ...recording,
  phase: 'done' as const,
  roomRecording: false,
  summary,
  takes: [{ take: 1, durationMs: 60_000, discarded: false }],
};

describe('CallStage: pause a take', () => {
  it('gives the host Pause beside End & save while a take records, and it ends the take', () => {
    const onEnd = vi.fn();
    render(<CallStage {...recording} onEnd={onEnd} />);
    const pause = screen.getByRole('button', { name: 'Pause recording' });
    expect(pause).toHaveTextContent('Pause');
    expect(pause.querySelector('svg path')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'End & save recording' })).toBeInTheDocument();

    fireEvent.click(pause);
    expect(onEnd).toHaveBeenCalledTimes(1);
    cleanup();

    // Only the host ends a take, and outside a take there is nothing to pause.
    render(<CallStage {...recording} role="guest" canRecord={false} />);
    expect(screen.queryByRole('button', { name: 'Pause recording' })).toBeNull();
    cleanup();
    render(<CallStage {...recording} phase="in-call" roomRecording={false} />);
    expect(screen.queryByRole('button', { name: 'Pause recording' })).toBeNull();
  });

  it('says Paused once the take is saved, never while it saves, and offers Continue', () => {
    const fns = { onNewTake: vi.fn(), onRecord: vi.fn() };
    const { rerender } = render(<CallStage {...recording} {...fns} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause recording' }));

    // Still saving, whatever summary is in state: nothing reads Paused yet.
    rerender(<CallStage {...saved} {...fns} phase="finalizing" />);
    expect(screen.getByTestId('status-bar')).not.toHaveTextContent('Paused');

    rerender(<CallStage {...saved} {...fns} />);
    const bar = screen.getByTestId('status-bar');
    expect(bar).toHaveTextContent('Paused. Continue starts a new take.');
    expect(bar).toHaveTextContent('Saved — 2 files in your recording folder.');
    expect(within(bar).queryByText('Recording')).toBeNull();

    const inSummary = within(screen.getByTestId('summary-column')).getByRole('button', {
      name: 'Continue recording',
    });
    const inBar = screen.getAllByRole('button', { name: 'Continue recording' }).find((b) => b !== inSummary)!;
    expect(inBar).toHaveTextContent('Continue');
    expect(inBar).toHaveAttribute('aria-keyshortcuts', 'Alt+R');
    expect(screen.queryByRole('button', { name: 'Start recording' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record another take' })).toBeNull();

    fireEvent.click(inBar);
    expect(fns.onNewTake).toHaveBeenCalledTimes(1);
    expect(fns.onRecord).toHaveBeenCalledTimes(1);
    expect(fns.onNewTake.mock.invocationCallOrder[0]!).toBeLessThan(fns.onRecord.mock.invocationCallOrder[0]!);
  });

  it('drops the word when the next take records, so End & save reads Saved as before', () => {
    const { rerender } = render(<CallStage {...recording} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause recording' }));
    rerender(<CallStage {...saved} />);
    expect(screen.getByTestId('status-bar')).toHaveTextContent('Paused.');

    // The next part records and is ended with End & save.
    rerender(<CallStage {...recording} />);
    fireEvent.click(screen.getByRole('button', { name: 'End & save recording' }));
    rerender(<CallStage {...saved} />);
    const bar = screen.getByTestId('status-bar');
    expect(bar).not.toHaveTextContent('Paused');
    expect(bar).toHaveTextContent('Saved — 2 files in your recording folder.');
    expect(screen.getByRole('button', { name: 'Start recording' })).toHaveTextContent('Record');
    expect(screen.getByRole('button', { name: 'Record another take' })).toBeInTheDocument();
  });

  it('does not say Paused over a save that did not finish', () => {
    const { rerender } = render(<CallStage {...recording} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause recording' }));
    rerender(
      <CallStage
        {...recording}
        phase="done"
        roomRecording={false}
        recordingError="Saving didn’t finish (disk full). Some files in your recording folder may be incomplete."
      />
    );
    const bar = screen.getByTestId('status-bar');
    expect(bar).toHaveTextContent('Saving didn’t finish.');
    expect(bar).not.toHaveTextContent('Paused');
  });

  it('has no Pause while the take is being saved, or once it is saved', () => {
    const { rerender } = render(<CallStage {...recording} />);
    expect(screen.getByRole('button', { name: 'Pause recording' })).toBeInTheDocument();
    // A second press there would end the take a second time, over the save.
    rerender(<CallStage {...saved} phase="finalizing" />);
    expect(screen.queryByRole('button', { name: 'Pause recording' })).toBeNull();
    rerender(<CallStage {...saved} />);
    expect(screen.queryByRole('button', { name: 'Pause recording' })).toBeNull();
  });

  it('does not say Paused while the room still reports a take', () => {
    const { rerender } = render(<CallStage {...recording} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause recording' }));
    rerender(<CallStage {...saved} roomRecording />);
    const bar = screen.getByTestId('status-bar');
    expect(bar).not.toHaveTextContent('Paused');
    expect(within(bar).getByText('Recording')).toBeInTheDocument();
  });

  it('carries no key, so Alt+S ends the take as End & save and the page reads Saved', () => {
    const onEnd = vi.fn();
    const { rerender } = render(<CallStage {...recording} onEnd={onEnd} />);
    expect(screen.getByRole('button', { name: 'Pause recording' })).not.toHaveAttribute('aria-keyshortcuts');
    fireEvent.keyDown(document.body, { key: 's', code: 'KeyS', keyCode: 83, altKey: true });
    expect(onEnd).toHaveBeenCalledTimes(1);
    rerender(<CallStage {...saved} onEnd={onEnd} />);
    const bar = screen.getByTestId('status-bar');
    expect(bar).not.toHaveTextContent('Paused');
    expect(bar).toHaveTextContent('Saved — 2 files in your recording folder.');
  });

  it('keeps Continue on Record until a take records, with no Paused line before one', () => {
    const { rerender } = render(<CallStage {...recording} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause recording' }));
    rerender(<CallStage {...saved} />);
    // Continue was pressed and the take has not started: the call screen as before a take.
    rerender(<CallStage {...recording} phase="in-call" roomRecording={false} />);
    expect(screen.getByTestId('status-bar')).not.toHaveTextContent('Paused');
    expect(screen.getByRole('button', { name: 'Continue recording' })).toHaveTextContent('Continue');
    expect(screen.queryByRole('button', { name: 'Start recording' })).toBeNull();
  });
});
