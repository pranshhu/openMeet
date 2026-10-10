import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { CallStage } from '@/components/CallStage';
import { setSpeaker } from '@/lib/speaker';

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
    const localStream = Object.assign(new EventTarget(), {
      getTracks: () => [destinationAudioTrack],
      getAudioTracks: () => [destinationAudioTrack],
      getVideoTracks: () => [],
    }) as unknown as MediaStream;

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

describe('CallStage speaker picker', () => {
  const WITH_OUTPUTS: MediaDeviceInfo[] = [
    ...MOCK_DEVICES,
    { deviceId: 'default', kind: 'audiooutput', label: 'Default - Speakers', groupId: 'g5', toJSON: () => ({}) },
    { deviceId: 'out-speakers', kind: 'audiooutput', label: 'Speakers', groupId: 'g5', toJSON: () => ({}) },
    { deviceId: 'out-headphones', kind: 'audiooutput', label: 'Headphones', groupId: 'g6', toJSON: () => ({}) },
  ];
  // A tile listens to its stream, so a stream handed to one is an EventTarget.
  const bob = Object.assign(new EventTarget(), { id: 'stream-bob' }) as unknown as MediaStream;
  const shared = Object.assign(new EventTarget(), { id: 'stream-screen' }) as unknown as MediaStream;
  const inCall = {
    ...baseProps,
    remoteStream: bob,
    remotePeers: [
      { peerId: 'p-bob', name: 'Bob', stream: bob, presence: { micOn: true, camOn: true, screenSharing: false } },
    ],
  };

  beforeEach(() => {
    setSpeaker('');
    localStorage.removeItem('om_speaker');
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue(WITH_OUTPUTS),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    // jsdom has no setSinkId; this one records the sink on the element, as a browser does.
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', {
      configurable: true,
      writable: true,
      value: vi.fn(function (this: HTMLMediaElement, id: string) {
        Object.defineProperty(this, 'sinkId', { value: id, configurable: true });
        return Promise.resolve();
      }),
    });
  });

  afterEach(() => {
    delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
    localStorage.removeItem('om_speaker');
  });

  async function openSpeakerSelect(): Promise<HTMLSelectElement> {
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/select microphone/i));
    });
    return (await screen.findByRole('combobox', { name: 'Speaker' })) as HTMLSelectElement;
  }

  it('puts the speaker choice first in the microphone menu, on the system default', async () => {
    render(<CallStage {...inCall} />);
    const select = await openSpeakerSelect();

    expect(Array.from(select.options).map((o) => [o.value, o.text])).toEqual([
      ['', 'System default'],
      ['out-speakers', 'Speakers'],
      ['out-headphones', 'Headphones'],
    ]);
    expect(select).toHaveValue('');
    const menu = screen.getByRole('menu');
    // First, so it is in sight however many microphones are listed under it.
    expect(menu.firstElementChild).toContainElement(select);
    // Nobody chose anything: no element was moved.
    expect(HTMLMediaElement.prototype.setSinkId).not.toHaveBeenCalled();
  });

  it('plays everyone else, and a screen they present, through the chosen output, and remembers it', async () => {
    const { container } = render(<CallStage {...inCall} remoteScreenStream={shared} />);
    const select = await openSpeakerSelect();
    fireEvent.change(select, { target: { value: 'out-headphones' } });

    const videos = Array.from(container.querySelectorAll('video'));
    const sounding = videos.filter((v) => !v.muted);
    expect(sounding.map((v) => (v as { srcObject?: unknown }).srcObject)).toEqual(
      expect.arrayContaining([bob, shared])
    );
    expect(sounding.map((v) => v.sinkId)).toEqual(sounding.map(() => 'out-headphones'));
    // Your own tile is muted and plays nothing, so it stays where it is.
    const silent = videos.filter((v) => v.muted);
    expect(silent.length).toBeGreaterThan(0);
    expect(silent.map((v) => v.sinkId)).toEqual(silent.map(() => undefined));
    expect(select).toHaveValue('out-headphones');
    expect(localStorage.getItem('om_speaker')).toBe('out-headphones');
  });

  it('shows the speaker chosen earlier', async () => {
    setSpeaker('out-speakers');
    render(<CallStage {...inCall} />);
    expect(await openSpeakerSelect()).toHaveValue('out-speakers');
  });
});
