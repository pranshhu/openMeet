import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { CallStage } from '@/components/CallStage';

const baseProps = {
  role: 'guest' as const,
  phase: 'in-call' as const,
  localStream: null,
  remoteStream: null,
  remotePeers: [],
  remoteScreenStream: null,
  localScreenStream: null,
  localName: 'Ana',
  peerName: 'Bo',
  screenSharing: false,
  canRecord: false,
  roomRecording: false,
  recordBlocked: false,
  messages: [],
  peerPresence: null,
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

function localStream(withCamera: boolean): MediaStream {
  const mic = { kind: 'audio', enabled: true, getSettings: () => ({}) };
  const cam = { kind: 'video', enabled: true, readyState: 'live', getSettings: () => ({ deviceId: 'cam1' }) };
  return Object.assign(new EventTarget(), {
    getTracks: () => (withCamera ? [mic, cam] : [mic]),
    getAudioTracks: () => [mic],
    getVideoTracks: () => (withCamera ? [cam] : []),
  }) as unknown as MediaStream;
}

describe('CallStage for a person who joined without a camera', () => {
  let enumerateDevices: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    enumerateDevices = vi.fn().mockResolvedValue([
      { deviceId: 'cam1', kind: 'videoinput', label: 'Webcam', groupId: 'g1', toJSON: () => ({}) },
    ]);
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      mediaDevices: { enumerateDevices, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
  });

  afterEach(() => {
    // Unmount first: CallStage removes its device listener on unmount, which needs the stub.
    cleanup();
    vi.unstubAllGlobals();
  });

  it('has no camera to turn on or pick, and says how to get one', async () => {
    const onToggleCam = vi.fn();
    const onSwitchCamera = vi.fn();
    render(
      <CallStage
        {...baseProps}
        localStream={localStream(false)}
        onToggleCam={onToggleCam}
        onSwitchCamera={onSwitchCamera}
        onSetIncomingVideoOff={vi.fn()}
      />
    );
    const button = screen.getByRole('button', { name: 'No camera in this call' });
    expect(button).toBeDisabled();
    // Grey, not the red of a camera that is turned off: there is nothing to turn on.
    expect(button).not.toHaveClass('bg-[#ea4335]');
    // A disabled button still names its key, as Record does.
    expect(button).toHaveAttribute('aria-keyshortcuts', 'V');
    expect(button).toHaveAttribute('title', 'No camera in this call (V)');
    expect(screen.queryByRole('button', { name: /turn (on|off) camera/i })).toBeNull();
    fireEvent.click(button);
    expect(onToggleCam).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Select camera' }));
    });
    await waitFor(() => expect(enumerateDevices).toHaveBeenCalled());
    expect(
      screen.getByText('You joined without a camera. To use one, leave and join again.')
    ).toBeInTheDocument();
    expect(screen.queryByText('Webcam')).toBeNull();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Stop incoming video' })).toBeInTheDocument();
    expect(screen.getByText('Camera')).toBeInTheDocument();
    expect(onSwitchCamera).not.toHaveBeenCalled();
  });

  it('shows their own initial where a picture would be', () => {
    render(<CallStage {...baseProps} localStream={localStream(false)} />);
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('keeps the camera button and the camera list for a person with a camera', async () => {
    const onToggleCam = vi.fn();
    render(<CallStage {...baseProps} localStream={localStream(true)} onToggleCam={onToggleCam} />);
    const button = screen.getByRole('button', { name: 'Turn off camera' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onToggleCam).toHaveBeenCalledWith(false);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Select camera' }));
    });
    expect(await screen.findByText('Webcam')).toBeInTheDocument();
    expect(screen.queryByText('You joined without a camera. To use one, leave and join again.')).toBeNull();
  });

  it('closes its camera menu on Escape', async () => {
    const line = 'You joined without a camera. To use one, leave and join again.';
    render(<CallStage {...baseProps} localStream={localStream(false)} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Select camera' }));
    });
    expect(screen.getByText(line)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText(line)).toBeNull();
  });
});

describe('CallStage for a remote person who joined with the microphone only', () => {
  // EventTargets, because a tile listens on the stream it is given.
  const bob = Object.assign(new EventTarget(), { id: 'stream-bob' }) as unknown as MediaStream;
  const carol = Object.assign(new EventTarget(), { id: 'stream-carol' }) as unknown as MediaStream;
  const camOn = { micOn: true, camOn: true, screenSharing: false };

  afterEach(() => {
    cleanup();
  });

  /** The picture of a stream is the <video> that plays it; it is hidden when the tile is an initial. */
  const pictureShown = (container: HTMLElement, stream: MediaStream) =>
    Array.from(container.querySelectorAll('video'))
      .filter((v) => (v as { srcObject?: unknown }).srcObject === stream)
      .some((v) => v.className.includes('opacity-100'));

  function stage(bobAudioOnly: boolean, carolAudioOnly: boolean) {
    return render(
      <CallStage
        {...baseProps}
        remoteStream={bob}
        remotePeers={[
          { peerId: 'p-bob', name: 'Bob', stream: bob, presence: camOn, audioOnly: bobAudioOnly },
          { peerId: 'p-carol', name: 'Carol', stream: carol, presence: camOn, audioOnly: carolAudioOnly },
        ]}
      />
    );
  }

  it('draws the first remote person as an initial whatever their presence says', () => {
    const { container } = stage(true, false);
    expect(screen.getByText('B')).toBeInTheDocument();
    expect(pictureShown(container, bob)).toBe(false);
    expect(pictureShown(container, carol)).toBe(true);
    expect(screen.queryByText('C')).toBeNull();
  });

  it('draws one of the others as an initial whatever their presence says', () => {
    const { container } = stage(false, true);
    expect(screen.getByText('C')).toBeInTheDocument();
    expect(pictureShown(container, carol)).toBe(false);
    expect(pictureShown(container, bob)).toBe(true);
    expect(screen.queryByText('B')).toBeNull();
  });

  it('draws the same people with their pictures without the flag', () => {
    const { container } = stage(false, false);
    expect(pictureShown(container, bob)).toBe(true);
    expect(pictureShown(container, carol)).toBe(true);
    expect(screen.queryByText('B')).toBeNull();
    expect(screen.queryByText('C')).toBeNull();
  });
});
