import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { CallStage } from '@/components/CallStage';

const baseProps = {
  role: 'host' as const,
  phase: 'in-call' as const,
  localStream: null,
  remoteStream: null,
  remotePeers: [],
  remoteScreenStream: null,
  localScreenStream: null,
  localName: 'Alice',
  peerName: 'Bob',
  screenSharing: false,
  canRecord: true,
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

const MOCK_DEVICES: MediaDeviceInfo[] = [
  {
    deviceId: 'mic-default',
    kind: 'audioinput',
    label: 'Default Microphone',
    groupId: 'g1',
    toJSON: () => ({}),
  },
  {
    deviceId: 'mic-usb',
    kind: 'audioinput',
    label: 'USB Podcast Mic',
    groupId: 'g2',
    toJSON: () => ({}),
  },
  {
    deviceId: 'cam-builtin',
    kind: 'videoinput',
    label: 'FaceTime HD Camera',
    groupId: 'g3',
    toJSON: () => ({}),
  },
  {
    deviceId: 'cam-external',
    kind: 'videoinput',
    label: 'Logitech 4K Pro',
    groupId: 'g4',
    toJSON: () => ({}),
  },
];

describe('CallStage device pickers', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue(MOCK_DEVICES),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
  });

  it('renders arrow buttons next to the mic and camera buttons to list devices and call switch', async () => {
    const onSwitchMic = vi.fn().mockResolvedValue(undefined);
    const onSwitchCamera = vi.fn().mockResolvedValue(undefined);

    render(
      <CallStage
        {...baseProps}
        onSwitchMic={onSwitchMic}
        onSwitchCamera={onSwitchCamera}
      />
    );

    // Mic arrow
    const micArrow = screen.getByLabelText(/select microphone/i);
    expect(micArrow).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(micArrow);
    });

    await waitFor(() => {
      expect(screen.getByText('USB Podcast Mic')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('USB Podcast Mic'));
    });
    expect(onSwitchMic).toHaveBeenCalledWith('mic-usb');

    // Camera arrow
    const camArrow = screen.getByLabelText(/select camera/i);
    expect(camArrow).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(camArrow);
    });

    await waitFor(() => {
      expect(screen.getByText('Logitech 4K Pro')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Logitech 4K Pro'));
    });
    expect(onSwitchCamera).toHaveBeenCalledWith('cam-external');
  });

  it('shows Flip camera on devices reporting facingMode', async () => {
    const mobileDevices: MediaDeviceInfo[] = [
      {
        deviceId: 'cam-front',
        kind: 'videoinput',
        label: 'Front Camera',
        groupId: 'g1',
        facingMode: 'user',
        toJSON: () => ({}),
      } as any,
      {
        deviceId: 'cam-back',
        kind: 'videoinput',
        label: 'Back Camera',
        groupId: 'g2',
        facingMode: 'environment',
        toJSON: () => ({}),
      } as any,
    ];

    vi.stubGlobal('navigator', {
      userAgent: 'test-mobile',
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue(mobileDevices),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });

    const onSwitchCamera = vi.fn().mockResolvedValue(undefined);

    render(
      <CallStage
        {...baseProps}
        onSwitchCamera={onSwitchCamera}
      />
    );

    const camArrow = screen.getByLabelText(/select camera/i);
    await act(async () => {
      fireEvent.click(camArrow);
    });

    await waitFor(() => {
      expect(screen.getByText(/flip camera/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText(/flip camera/i));
    });
    expect(onSwitchCamera).toHaveBeenCalledWith(expect.stringMatching(/user|environment/));
  });

  it('shows an error banner when device switch fails and keeps call stage intact', async () => {
    const onSwitchCamera = vi.fn().mockRejectedValue(new Error('Camera is busy'));

    render(
      <CallStage
        {...baseProps}
        onSwitchCamera={onSwitchCamera}
      />
    );

    const camArrow = screen.getByLabelText(/select camera/i);
    fireEvent.click(camArrow);

    await waitFor(() => {
      expect(screen.getByText('Logitech 4K Pro')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Logitech 4K Pro'));

    await waitFor(() => {
      const banner = screen.getByRole('alert');
      expect(banner).toHaveTextContent('Camera is busy');
      expect(banner.className).toMatch(/\brelative\b/);
      expect(banner.className).toMatch(/\bz-50\b/);
    });
  });

  it('shows "Switch after this take" in fallback mode during a take', async () => {
    const onSwitchCamera = vi.fn().mockResolvedValue(undefined);

    render(
      <CallStage
        {...baseProps}
        phase="recording"
        roomRecording={true}
        isFallbackMedia={true}
        onSwitchCamera={onSwitchCamera}
      />
    );

    const camArrow = screen.getByLabelText(/select camera/i);
    fireEvent.click(camArrow);

    await waitFor(() => {
      expect(screen.getByText(/switch after this take/i)).toBeInTheDocument();
    });

    expect(onSwitchCamera).not.toHaveBeenCalled();
  });

  it('shows checkmark on the second microphone after switching to it', async () => {
    // The Web Audio destination track has no deviceId
    const destinationAudioTrack = {
      kind: 'audio',
      id: 'dest-audio-track',
      enabled: true,
      getSettings: () => ({ sampleRate: 48000, channelCount: 2 }),
    } as unknown as MediaStreamTrack;
    const localStream = {
      getTracks: () => [destinationAudioTrack],
      getAudioTracks: () => [destinationAudioTrack],
      getVideoTracks: () => [],
    } as unknown as MediaStream;

    let activeMicId = 'mic-default';
    const onSwitchMic = vi.fn().mockImplementation(async (id: string) => {
      activeMicId = id;
    });

    const { rerender } = render(
      <CallStage
        {...baseProps}
        localStream={localStream}
        activeMicId={activeMicId}
        onSwitchMic={onSwitchMic}
      />
    );

    const micArrow = screen.getByLabelText(/select microphone/i);
    await act(async () => {
      fireEvent.click(micArrow);
    });

    await waitFor(() => {
      expect(screen.getByText('Default Microphone')).toBeInTheDocument();
      expect(screen.getByText('USB Podcast Mic')).toBeInTheDocument();
    });

    const defaultMicItem = screen.getByRole('menuitemradio', { name: /default microphone/i });
    const usbMicItem = screen.getByRole('menuitemradio', { name: /usb podcast mic/i });

    expect(defaultMicItem.querySelector('svg')).toBeInTheDocument();
    expect(usbMicItem.querySelector('svg')).not.toBeInTheDocument();
    // The check icon is aria-hidden; a screen reader hears the selection from aria-checked.
    expect(defaultMicItem).toHaveAttribute('aria-checked', 'true');
    expect(usbMicItem).toHaveAttribute('aria-checked', 'false');

    await act(async () => {
      fireEvent.click(usbMicItem);
    });

    expect(onSwitchMic).toHaveBeenCalledWith('mic-usb');

    rerender(
      <CallStage
        {...baseProps}
        localStream={localStream}
        activeMicId={activeMicId}
        onSwitchMic={onSwitchMic}
      />
    );

    await act(async () => {
      fireEvent.click(micArrow);
    });

    await waitFor(() => {
      expect(screen.getByText('USB Podcast Mic')).toBeInTheDocument();
    });

    const defaultMicAfter = screen.getByRole('menuitemradio', { name: /default microphone/i });
    const usbMicAfter = screen.getByRole('menuitemradio', { name: /usb podcast mic/i });

    expect(usbMicAfter.querySelector('svg')).toBeInTheDocument();
    expect(defaultMicAfter.querySelector('svg')).not.toBeInTheDocument();
  });
});

describe('CallStage device menus from the keyboard', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue(MOCK_DEVICES),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
  });

  it('exposes the open state on the trigger and closes on Escape, handing focus back to it', async () => {
    render(<CallStage {...baseProps} onSwitchMic={vi.fn()} />);
    const micArrow = screen.getByLabelText(/select microphone/i);
    expect(micArrow).toHaveAttribute('aria-haspopup', 'menu');
    expect(micArrow).toHaveAttribute('aria-expanded', 'false');

    await act(async () => {
      fireEvent.click(micArrow);
    });
    expect(micArrow).toHaveAttribute('aria-expanded', 'true');
    const item = await screen.findByRole('menuitemradio', { name: /usb podcast mic/i });
    item.focus();

    fireEvent.keyDown(item, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(micArrow).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(micArrow);
  });
});
