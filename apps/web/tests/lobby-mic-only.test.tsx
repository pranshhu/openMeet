import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { Lobby } from '@/components/Lobby';
import { NO_CAMERA, cameraConstraints, deviceConstraints } from '@/lib/media';

type Track = {
  kind: 'audio' | 'video';
  enabled: boolean;
  stop: ReturnType<typeof vi.fn>;
  getSettings: () => Record<string, unknown>;
};

const micTrack = (): Track => ({
  kind: 'audio',
  enabled: true,
  stop: vi.fn(),
  getSettings: () => ({ deviceId: 'mic1', sampleRate: 48000 }),
});
const camTrack = (): Track => ({
  kind: 'video',
  enabled: true,
  stop: vi.fn(),
  getSettings: () => ({ deviceId: 'cam1', width: 1280, height: 720, frameRate: 30 }),
});

function streamOf(...tracks: Track[]): MediaStream {
  return Object.assign(new EventTarget(), {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  }) as unknown as MediaStream;
}

const DEVICES = [
  { kind: 'videoinput', deviceId: 'cam1', label: 'Webcam' },
  { kind: 'audioinput', deviceId: 'mic1', label: 'Mic' },
];

function stubMedia(getUserMedia: ReturnType<typeof vi.fn>, getDisplayMedia?: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('navigator', {
    userAgent: 'test',
    mediaDevices: { getUserMedia, enumerateDevices: vi.fn().mockResolvedValue(DEVICES), getDisplayMedia },
  });
}

const micOnlyButton = () => screen.getByRole('button', { name: 'Microphone only' });

describe('deviceConstraints with no camera', () => {
  it('asks for the microphone alone', () => {
    const c = deviceConstraints('mic-1', NO_CAMERA, '720p', 25);
    expect(c.video).toBe(false);
    expect(c.audio).toMatchObject({
      deviceId: { exact: 'mic-1' },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
  });
});

describe('cameraConstraints with the facing choices', () => {
  it('still asks for the front camera and the rear camera', () => {
    expect(cameraConstraints('user')).toMatchObject({ facingMode: { exact: 'user' } });
    expect(cameraConstraints('environment')).toMatchObject({ facingMode: { exact: 'environment' } });
  });
});

describe('Lobby: microphone only', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lets a person with no camera join with the microphone alone', async () => {
    const mic = streamOf(micTrack());
    const getUserMedia = vi.fn().mockImplementation(async (c: MediaStreamConstraints) => {
      if (c.video === false) return mic;
      throw Object.assign(new Error('no camera'), { name: 'NotFoundError' });
    });
    stubMedia(getUserMedia);
    const onJoin = vi.fn();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('press Microphone only');
    expect(screen.getByRole('button', { name: /join now/i })).toBeDisabled();
    expect(micOnlyButton()).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(micOnlyButton());
    await screen.findByRole('button', { name: /turn off microphone/i });
    expect(micOnlyButton()).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('alert')).toBeNull();
    // The failed first preview listed no devices; the press reads them.
    expect(await screen.findByLabelText('Microphone')).toBeVisible();

    fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Ana' } });
    fireEvent.click(screen.getByRole('button', { name: /join now/i }));
    await waitFor(() => expect(onJoin).toHaveBeenCalledWith(mic, 'Ana', false, undefined, false));
  });

  it('opens the microphone alone by choice, and the camera again', async () => {
    const mic = streamOf(micTrack());
    const getUserMedia = vi
      .fn()
      .mockImplementation(async (c: MediaStreamConstraints) =>
        c.video === false ? mic : streamOf(micTrack(), camTrack())
      );
    stubMedia(getUserMedia);
    const { container } = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    await screen.findByLabelText('Camera');
    const first = (await getUserMedia.mock.results[0]!.value) as MediaStream;
    expect(container.querySelector('video')).toHaveClass('opacity-100');
    expect(screen.getByRole('button', { name: 'Framing guide' })).toBeInTheDocument();
    expect(screen.getByText('No camera, or a slow computer? Join with sound only.')).toBeInTheDocument();

    fireEvent.click(micOnlyButton());
    await waitFor(() => expect(micOnlyButton()).toHaveAttribute('aria-pressed', 'true'));
    expect(getUserMedia.mock.calls.at(-1)![0].video).toBe(false);
    // The camera is let go, so its light does not stay on.
    for (const t of first.getTracks()) expect(t.stop).toHaveBeenCalled();
    expect(screen.queryByLabelText('Camera')).toBeNull();
    expect(screen.getByLabelText('Recording quality')).not.toBeVisible();
    expect(screen.getByLabelText('Recording bitrate')).not.toBeVisible();
    expect(screen.getByLabelText('Frame rate')).not.toBeVisible();
    expect(screen.getByLabelText('Microphone')).toBeVisible();
    expect(screen.queryByRole('button', { name: /turn (on|off) camera/i })).toBeNull();
    // An initial is not a picture to frame.
    expect(screen.queryByRole('button', { name: 'Framing guide' })).toBeNull();
    expect(container.querySelector('video')).toHaveClass('opacity-0');
    expect(
      screen.getByText(
        'You’ll join with sound only: your audio is recorded, with no video. Press again to use your camera.'
      )
    ).toBeInTheDocument();

    fireEvent.click(micOnlyButton());
    await waitFor(() => expect(micOnlyButton()).toHaveAttribute('aria-pressed', 'false'));
    expect((getUserMedia.mock.calls.at(-1)![0].video as MediaTrackConstraints).deviceId).toEqual({
      exact: 'cam1',
    });
    expect(await screen.findByLabelText('Camera')).toBeVisible();
    expect(screen.getByLabelText('Recording quality')).toBeVisible();
    expect(screen.getByRole('button', { name: /turn off camera/i })).toBeInTheDocument();
    expect(container.querySelector('video')).toHaveClass('opacity-100');
  });
});

describe('Lobby: microphone only, the rest of its behaviour', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not open the microphone alone until it is pressed', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(Object.assign(new Error('no camera'), { name: 'NotFoundError' }));
    stubMedia(getUserMedia);
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);

    await screen.findByRole('alert');
    expect(getUserMedia.mock.calls.some(([c]) => c.video === false)).toBe(false);
    expect(micOnlyButton()).toHaveAttribute('aria-pressed', 'false');
  });

  it('says why, and keeps the preview, when the microphone cannot be opened alone', async () => {
    const getUserMedia = vi.fn().mockImplementation(async (c: MediaStreamConstraints) => {
      if (c.video === false) throw Object.assign(new Error('Microphone is busy'), { name: 'NotReadableError' });
      return streamOf(micTrack(), camTrack());
    });
    stubMedia(getUserMedia);
    const { container } = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    await screen.findByLabelText('Camera');

    fireEvent.click(micOnlyButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Microphone is busy');
    expect(micOnlyButton()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByLabelText('Camera')).toBeVisible();
    expect(container.querySelector('video')).toHaveClass('opacity-100');
  });

  it('describes the button by its line, and is a 44 px target with the focus ring', async () => {
    stubMedia(vi.fn().mockRejectedValue(Object.assign(new Error('no camera'), { name: 'NotFoundError' })));
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);

    await screen.findByRole('alert');
    expect(micOnlyButton()).toHaveAttribute('type', 'button');
    expect(micOnlyButton()).toHaveAccessibleDescription('No camera, or a slow computer? Join with sound only.');
    expect(micOnlyButton()).toHaveClass('min-h-11', 'focus-visible:outline-[#0b57d0]');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows on the check page, where the join form is hidden', async () => {
    const getUserMedia = vi.fn().mockImplementation(async (c: MediaStreamConstraints) => {
      if (c.video === false) return streamOf(micTrack());
      throw Object.assign(new Error('no camera'), { name: 'NotFoundError' });
    });
    stubMedia(getUserMedia);
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} checkOnly />);

    await screen.findByRole('alert');
    expect(micOnlyButton()).toBeVisible();
    fireEvent.click(micOnlyButton());
    await waitFor(() => expect(micOnlyButton()).toHaveAttribute('aria-pressed', 'true'));
  });

  it('opens the camera again with the quality, frame rate and microphone chosen', async () => {
    const getUserMedia = vi.fn().mockImplementation(async (c: MediaStreamConstraints) =>
      c.video === false ? streamOf(micTrack()) : streamOf(micTrack(), camTrack())
    );
    stubMedia(getUserMedia);
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    await screen.findByLabelText('Camera');
    // Reached with Tab after the preview's own toggles.
    expect(
      screen.getByRole('button', { name: 'Turn off camera' }).compareDocumentPosition(micOnlyButton()) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Recording quality'), { target: { value: '720p' } });
    await waitFor(() => expect(screen.getByLabelText('Recording quality')).toHaveValue('720p'));
    fireEvent.change(screen.getByLabelText('Frame rate'), { target: { value: '25' } });
    await waitFor(() => expect(screen.getByLabelText('Frame rate')).toHaveValue('25'));

    fireEvent.click(micOnlyButton());
    await waitFor(() => expect(micOnlyButton()).toHaveAttribute('aria-pressed', 'true'));
    expect(micOnlyButton()).toHaveClass('bg-[#0b57d0]/10');
    expect(screen.queryByText(/^Capturing /)).toBeNull();

    fireEvent.click(micOnlyButton());
    await waitFor(() => expect(micOnlyButton()).toHaveAttribute('aria-pressed', 'false'));
    expect(getUserMedia.mock.calls.at(-1)![0]).toMatchObject({
      audio: { deviceId: { exact: 'mic1' } },
      video: { deviceId: { exact: 'cam1' }, height: { ideal: 720 }, frameRate: { ideal: 25 } },
    });
    expect(await screen.findByText(/^Capturing 1280x720/)).toBeInTheDocument();
  });

  it('still opens the microphone alone when the device list cannot be read, with no pickers', async () => {
    let listable = true;
    const getUserMedia = vi.fn().mockImplementation(async (c: MediaStreamConstraints) =>
      c.video === false ? streamOf(micTrack()) : streamOf(micTrack(), camTrack())
    );
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      mediaDevices: {
        getUserMedia,
        enumerateDevices: vi.fn(async () => {
          if (!listable) throw new Error('Device list unavailable');
          return DEVICES;
        }),
      },
    });
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    await screen.findByLabelText('Camera');

    listable = false;
    fireEvent.click(micOnlyButton());
    await waitFor(() => expect(micOnlyButton()).toHaveAttribute('aria-pressed', 'true'));
    await waitFor(() => expect(screen.queryByLabelText('Microphone')).toBeNull());
    expect(screen.queryByLabelText('Camera')).toBeNull();
  });

  it('keeps the camera off when it was turned off before the press', async () => {
    let cam: Track | undefined;
    const getUserMedia = vi.fn().mockImplementation(async (c: MediaStreamConstraints) => {
      if (c.video === false) return streamOf(micTrack());
      cam = camTrack();
      return streamOf(micTrack(), cam);
    });
    stubMedia(getUserMedia);
    const { container } = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    await screen.findByLabelText('Camera');

    fireEvent.click(screen.getByRole('button', { name: 'Turn off camera' }));
    fireEvent.click(micOnlyButton());
    await waitFor(() => expect(micOnlyButton()).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(micOnlyButton());
    await waitFor(() => expect(micOnlyButton()).toHaveAttribute('aria-pressed', 'false'));

    expect(cam!.enabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Turn on camera' })).toBeInTheDocument();
    expect(container.querySelector('video')).toHaveClass('opacity-0');
  });

  it('is off while the first preview is still being opened, so no second capture is asked for', async () => {
    const first = streamOf(micTrack(), camTrack());
    let open!: (s: MediaStream) => void;
    const getUserMedia = vi.fn().mockImplementation(
      () =>
        new Promise<MediaStream>((resolve) => {
          open = resolve;
        })
    );
    stubMedia(getUserMedia);
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    expect(micOnlyButton()).toBeDisabled();
    fireEvent.click(micOnlyButton());
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    await act(async () => {
      open(first);
    });
    await screen.findByLabelText('Camera');
    expect(micOnlyButton()).toBeEnabled();
    expect(micOnlyButton()).toHaveAttribute('aria-pressed', 'false');
  });

  it('Try again asks for nothing while the microphone is being opened alone', async () => {
    let open!: (s: MediaStream) => void;
    const getUserMedia = vi.fn().mockImplementation((c: MediaStreamConstraints) =>
      c.video === false
        ? new Promise<MediaStream>((resolve) => {
            open = resolve;
          })
        : Promise.reject(Object.assign(new Error('busy'), { name: 'NotReadableError' }))
    );
    stubMedia(getUserMedia);
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    await screen.findByRole('alert');
    fireEvent.click(micOnlyButton());
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(getUserMedia).toHaveBeenCalledTimes(2);

    await act(async () => {
      open(streamOf(micTrack()));
    });
    await waitFor(() => expect(micOnlyButton()).toHaveAttribute('aria-pressed', 'true'));
  });

  it('stays microphone only when another microphone is picked and when the headphones question is answered', async () => {
    const getUserMedia = vi.fn().mockImplementation(async (c: MediaStreamConstraints) =>
      c.video === false ? streamOf(micTrack()) : streamOf(micTrack(), camTrack())
    );
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      mediaDevices: {
        getUserMedia,
        enumerateDevices: vi
          .fn()
          .mockResolvedValue([...DEVICES, { kind: 'audioinput', deviceId: 'mic2', label: 'Second mic' }]),
      },
    });
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    await screen.findByLabelText('Camera');
    fireEvent.click(micOnlyButton());
    await waitFor(() => expect(micOnlyButton()).toHaveAttribute('aria-pressed', 'true'));
    const before = getUserMedia.mock.calls.length;

    fireEvent.change(screen.getByLabelText('Microphone'), { target: { value: 'mic2' } });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(before + 1));
    expect(getUserMedia.mock.calls.at(-1)![0]).toMatchObject({
      audio: { deviceId: { exact: 'mic2' } },
      video: false,
    });
    await waitFor(() => expect(screen.getByLabelText('Microphone')).toHaveValue('mic2'));

    fireEvent.change(screen.getByLabelText('Headphones or speakers'), { target: { value: 'speakers-ec' } });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(before + 2));
    expect(getUserMedia.mock.calls.at(-1)![0]).toMatchObject({
      audio: { echoCancellation: true },
      video: false,
    });
    await waitFor(() => expect(micOnlyButton()).toHaveAttribute('aria-pressed', 'true'));
  });

  it('asks for any camera on the second press when none is listed', async () => {
    const getUserMedia = vi.fn().mockImplementation(async (c: MediaStreamConstraints) => {
      if (c.video === false) return streamOf(micTrack());
      throw Object.assign(new Error('no camera'), { name: 'NotFoundError' });
    });
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      mediaDevices: { getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([DEVICES[1]]) },
    });
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    await screen.findByRole('alert');
    fireEvent.click(micOnlyButton());
    await waitFor(() => expect(micOnlyButton()).toHaveAttribute('aria-pressed', 'true'));
    const before = getUserMedia.mock.calls.length;

    fireEvent.click(micOnlyButton());
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(before + 1));
    const video = getUserMedia.mock.calls.at(-1)![0].video as MediaTrackConstraints;
    expect(video).not.toBe(false);
    expect(video.deviceId).toBeUndefined();
    // No camera answered, so the microphone stays as it was.
    expect(micOnlyButton()).toHaveAttribute('aria-pressed', 'true');
  });

  it('reads as off while it cannot be pressed', async () => {
    stubMedia(vi.fn().mockReturnValue(new Promise<MediaStream>(() => {})));
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(micOnlyButton()).toBeDisabled();
    expect(micOnlyButton()).toHaveClass(
      'enabled:hover:bg-[#0b57d0]/10',
      'disabled:cursor-not-allowed',
      'disabled:opacity-50'
    );
  });

  it('is off while the microphone is opened again for the echo-cancellation answer', async () => {
    let reopen!: (s: MediaStream) => void;
    const getUserMedia = vi.fn().mockImplementation((c: MediaStreamConstraints) =>
      (c.audio as MediaTrackConstraints | undefined)?.echoCancellation === true
        ? new Promise<MediaStream>((resolve) => {
            reopen = resolve;
          })
        : Promise.resolve(streamOf(micTrack(), camTrack()))
    );
    stubMedia(getUserMedia);
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    await screen.findByLabelText('Camera');

    fireEvent.change(screen.getByLabelText('Headphones or speakers'), { target: { value: 'speakers-ec' } });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    expect(micOnlyButton()).toBeDisabled();

    await act(async () => {
      reopen(streamOf(micTrack(), camTrack()));
    });
    await waitFor(() => expect(micOnlyButton()).toBeEnabled());
  });

  it('keeps the preview that was joined with, and lets go of a capture that arrives after Join', async () => {
    const preview = streamOf(micTrack(), camTrack());
    const late = streamOf(micTrack());
    let open!: (s: MediaStream) => void;
    const getUserMedia = vi.fn().mockImplementation((c: MediaStreamConstraints) =>
      c.video === false
        ? new Promise<MediaStream>((resolve) => {
            open = resolve;
          })
        : Promise.resolve(preview)
    );
    stubMedia(getUserMedia);
    const onJoin = vi.fn();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} />);
    await screen.findByLabelText('Camera');
    fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Ana' } });

    fireEvent.click(micOnlyButton());
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: /join now/i }));
    await waitFor(() => expect(onJoin).toHaveBeenCalledWith(preview, 'Ana', false, undefined, false));

    await act(async () => {
      open(late);
    });
    for (const t of preview.getTracks()) expect(t.stop).not.toHaveBeenCalled();
    for (const t of late.getTracks()) expect(t.stop).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('lets go of a camera that arrives after a microphone-only person has joined', async () => {
    const micAlone = streamOf(micTrack());
    const late = streamOf(micTrack(), camTrack());
    let open!: (s: MediaStream) => void;
    let asked = 0;
    const getUserMedia = vi.fn().mockImplementation((c: MediaStreamConstraints) => {
      asked += 1;
      if (asked === 1) return Promise.resolve(streamOf(micTrack(), camTrack()));
      if (c.video === false) return Promise.resolve(micAlone);
      return new Promise<MediaStream>((resolve) => {
        open = resolve;
      });
    });
    stubMedia(getUserMedia);
    const onJoin = vi.fn();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} />);
    await screen.findByLabelText('Camera');
    fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Ana' } });
    fireEvent.click(micOnlyButton());
    await waitFor(() => expect(micOnlyButton()).toHaveAttribute('aria-pressed', 'true'));

    fireEvent.click(micOnlyButton());
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole('button', { name: /join now/i }));
    await waitFor(() => expect(onJoin).toHaveBeenCalledWith(micAlone, 'Ana', false, undefined, false));

    await act(async () => {
      open(late);
    });
    for (const t of micAlone.getTracks()) expect(t.stop).not.toHaveBeenCalled();
    for (const t of late.getTracks()) expect(t.stop).toHaveBeenCalledTimes(1);
  });

  it('joins with the capture that arrived while the join was being answered', async () => {
    const preview = streamOf(micTrack(), camTrack());
    const arrived = streamOf(micTrack());
    let open!: (s: MediaStream) => void;
    let answerSeat!: (held: boolean) => void;
    const getUserMedia = vi.fn().mockImplementation((c: MediaStreamConstraints) =>
      c.video === false
        ? new Promise<MediaStream>((resolve) => {
            open = resolve;
          })
        : Promise.resolve(preview)
    );
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      mediaDevices: { getUserMedia, enumerateDevices: vi.fn().mockResolvedValue(DEVICES) },
      // The question "is another tab recording this room", held open.
      locks: {
        request: () =>
          new Promise<boolean>((resolve) => {
            answerSeat = resolve;
          }),
      },
    });
    const onJoin = vi.fn();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} />);
    await screen.findByLabelText('Camera');
    fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Ana' } });

    fireEvent.click(micOnlyButton());
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: /join now/i }));
    await act(async () => {
      open(arrived);
    });
    await waitFor(() => expect(micOnlyButton()).toHaveAttribute('aria-pressed', 'true'));
    await act(async () => {
      answerSeat(false);
    });

    await waitFor(() => expect(onJoin).toHaveBeenCalledWith(arrived, 'Ana', false, undefined, false));
    for (const t of preview.getTracks()) expect(t.stop).toHaveBeenCalledTimes(1);
    for (const t of arrived.getTracks()) expect(t.stop).not.toHaveBeenCalled();
  });
});

describe('Lobby: no capture stays open behind a hand-over', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const screenShare = () => vi.fn().mockResolvedValue(streamOf(camTrack()));

  it('lets go of the first preview when it arrives after Present only', async () => {
    const late = streamOf(micTrack(), camTrack());
    let open!: (s: MediaStream) => void;
    const getUserMedia = vi.fn().mockImplementation(
      () =>
        new Promise<MediaStream>((resolve) => {
          open = resolve;
        })
    );
    stubMedia(getUserMedia, screenShare());
    const onJoin = vi.fn();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Ana' } });

    fireEvent.click(screen.getByRole('button', { name: 'Present only' }));
    await waitFor(() => expect(onJoin).toHaveBeenCalledTimes(1));
    await act(async () => {
      open(late);
    });

    for (const t of late.getTracks()) expect(t.stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('Camera')).toBeNull();
    expect(screen.getByRole('button', { name: /join now/i })).toBeDisabled();
  });

  it('lets go of a capture that Try again asked for when it arrives after Present only', async () => {
    const late = streamOf(micTrack(), camTrack());
    let open!: (s: MediaStream) => void;
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { name: 'NotReadableError' }))
      .mockImplementation(
        () =>
          new Promise<MediaStream>((resolve) => {
            open = resolve;
          })
      );
    stubMedia(getUserMedia, screenShare());
    const onJoin = vi.fn();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} />);
    await screen.findByRole('alert');
    fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Ana' } });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('button', { name: 'Present only' }));
    await waitFor(() => expect(onJoin).toHaveBeenCalledTimes(1));
    await act(async () => {
      open(late);
    });

    for (const t of late.getTracks()) expect(t.stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('Camera')).toBeNull();
  });

  it('lets go of a capture that Microphone only asked for when it arrives after Present only', async () => {
    const late = streamOf(micTrack());
    let open!: (s: MediaStream) => void;
    const getUserMedia = vi.fn().mockImplementation((c: MediaStreamConstraints) =>
      c.video === false
        ? new Promise<MediaStream>((resolve) => {
            open = resolve;
          })
        : Promise.resolve(streamOf(micTrack(), camTrack()))
    );
    stubMedia(getUserMedia, screenShare());
    const onJoin = vi.fn();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} />);
    await screen.findByLabelText('Camera');
    fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Ana' } });
    fireEvent.click(micOnlyButton());
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('button', { name: 'Present only' }));
    await waitFor(() => expect(onJoin).toHaveBeenCalledTimes(1));
    await act(async () => {
      open(late);
    });

    for (const t of late.getTracks()) expect(t.stop).toHaveBeenCalledTimes(1);
    expect(micOnlyButton()).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps only the preview of the run that stayed when the first run was cleaned up', async () => {
    const opens: Array<(s: MediaStream) => void> = [];
    const getUserMedia = vi.fn().mockImplementation(
      () =>
        new Promise<MediaStream>((resolve) => {
          opens.push(resolve);
        })
    );
    stubMedia(getUserMedia);
    render(
      <StrictMode>
        <Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />
      </StrictMode>
    );
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    const cleanedUp = streamOf(micTrack(), camTrack());
    const kept = streamOf(micTrack(), camTrack());

    await act(async () => {
      opens[1]!(kept);
    });
    await screen.findByLabelText('Camera');
    await act(async () => {
      opens[0]!(cleanedUp);
    });

    for (const t of cleanedUp.getTracks()) expect(t.stop).toHaveBeenCalledTimes(1);
    for (const t of kept.getTracks()) expect(t.stop).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /turn off camera/i })).toBeInTheDocument();
  });

  it('lets go of a preview that arrives after the lobby is closed', async () => {
    const late = streamOf(micTrack(), camTrack());
    let open!: (s: MediaStream) => void;
    stubMedia(
      vi.fn().mockImplementation(
        () =>
          new Promise<MediaStream>((resolve) => {
            open = resolve;
          })
      )
    );
    const { unmount } = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    unmount();
    await act(async () => {
      open(late);
    });

    for (const t of late.getTracks()) expect(t.stop).toHaveBeenCalledTimes(1);
  });

  it('shows no old alert, and keeps Microphone only off, while the echo answer reopens the microphone', async () => {
    let reopen!: (s: MediaStream) => void;
    const getUserMedia = vi.fn().mockImplementation((c: MediaStreamConstraints) => {
      if ((c.audio as MediaTrackConstraints | undefined)?.echoCancellation === true) {
        return new Promise<MediaStream>((resolve) => {
          reopen = resolve;
        });
      }
      if (c.video === false) return Promise.resolve(streamOf(micTrack()));
      return Promise.reject(Object.assign(new Error('no camera'), { name: 'NotFoundError' }));
    });
    stubMedia(getUserMedia);
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    await screen.findByRole('alert');
    fireEvent.click(micOnlyButton());
    await waitFor(() => expect(micOnlyButton()).toHaveAttribute('aria-pressed', 'true'));

    fireEvent.change(screen.getByLabelText('Headphones or speakers'), { target: { value: 'speakers-ec' } });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(3));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(micOnlyButton()).toBeDisabled();
    await act(async () => {
      reopen(streamOf(micTrack()));
    });
    await waitFor(() => expect(micOnlyButton()).toBeEnabled());
  });

  it('tells a person who chose Microphone only that Join waits for the microphone', async () => {
    let reopen!: (s: MediaStream) => void;
    const getUserMedia = vi.fn().mockImplementation((c: MediaStreamConstraints) =>
      (c.audio as MediaTrackConstraints | undefined)?.echoCancellation === true
        ? new Promise<MediaStream>((resolve) => {
            reopen = resolve;
          })
        : Promise.resolve(c.video === false ? streamOf(micTrack()) : streamOf(micTrack(), camTrack()))
    );
    stubMedia(getUserMedia);
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    await screen.findByLabelText('Camera');
    fireEvent.click(micOnlyButton());
    await waitFor(() => expect(micOnlyButton()).toHaveAttribute('aria-pressed', 'true'));

    fireEvent.change(screen.getByLabelText('Headphones or speakers'), { target: { value: 'speakers-ec' } });
    expect(await screen.findByText('Join opens once your microphone is on.')).toBeInTheDocument();
    expect(screen.queryByText('Join opens once your camera and mic are on.')).toBeNull();

    await act(async () => {
      reopen(streamOf(micTrack()));
    });
    await waitFor(() => expect(screen.queryByText(/^Join opens once/)).toBeNull());
  });

  it('tells a person with a camera that Join waits for the camera and mic', async () => {
    stubMedia(vi.fn().mockReturnValue(new Promise<MediaStream>(() => {})));
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);

    expect(screen.getByText('Join opens once your camera and mic are on.')).toBeInTheDocument();
    expect(screen.queryByText('Join opens once your microphone is on.')).toBeNull();
  });
});

describe('Lobby: the last ways a capture is handed over stopped or left open', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const asksForEcho = (c: MediaStreamConstraints) =>
    (c.audio as MediaTrackConstraints | undefined)?.echoCancellation === true;

  it('does not join with a microphone that was stopped for the echo-cancellation answer', async () => {
    const preview = streamOf(micTrack(), camTrack());
    const reopened = streamOf(micTrack(), camTrack());
    let reopen!: (s: MediaStream) => void;
    let answerSeat!: (held: boolean) => void;
    let seatAsked = 0;
    const getUserMedia = vi.fn().mockImplementation((c: MediaStreamConstraints) =>
      asksForEcho(c)
        ? new Promise<MediaStream>((resolve) => {
            reopen = resolve;
          })
        : Promise.resolve(preview)
    );
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      mediaDevices: { getUserMedia, enumerateDevices: vi.fn().mockResolvedValue(DEVICES) },
      // The first question, "is another tab recording this room", is held open.
      locks: {
        request: () => {
          seatAsked += 1;
          return seatAsked === 1
            ? new Promise<boolean>((resolve) => {
                answerSeat = resolve;
              })
            : Promise.resolve(false);
        },
      },
    });
    const onJoin = vi.fn();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} />);
    await screen.findByLabelText('Camera');
    fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Ana' } });

    fireEvent.click(screen.getByRole('button', { name: /join now/i }));
    fireEvent.change(screen.getByLabelText('Headphones or speakers'), { target: { value: 'speakers-ec' } });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    await act(async () => {
      answerSeat(false);
    });
    expect(onJoin).not.toHaveBeenCalled();

    await act(async () => {
      reopen(reopened);
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /join now/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /join now/i }));
    await waitFor(() => expect(onJoin).toHaveBeenCalledWith(reopened, 'Ana', false, undefined, false));
    for (const t of reopened.getTracks()) expect(t.stop).not.toHaveBeenCalled();
  });

  it('lets go of a capture that Microphone only asked for when it arrives after the lobby is closed', async () => {
    const late = streamOf(micTrack());
    let open!: (s: MediaStream) => void;
    const getUserMedia = vi.fn().mockImplementation((c: MediaStreamConstraints) =>
      c.video === false
        ? new Promise<MediaStream>((resolve) => {
            open = resolve;
          })
        : Promise.resolve(streamOf(micTrack(), camTrack()))
    );
    stubMedia(getUserMedia);
    const { unmount } = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    await screen.findByLabelText('Camera');
    fireEvent.click(micOnlyButton());
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));

    unmount();
    await act(async () => {
      open(late);
    });

    for (const t of late.getTracks()) expect(t.stop).toHaveBeenCalledTimes(1);
  });

  describe('Try again after Microphone only', () => {
    // The echo-cancellation reopen is always refused; every other capture works.
    function refuseEcho() {
      const getUserMedia = vi.fn().mockImplementation(async (c: MediaStreamConstraints) => {
        if (asksForEcho(c)) throw Object.assign(new Error('busy'), { name: 'NotReadableError' });
        return c.video === false ? streamOf(micTrack()) : streamOf(micTrack(), camTrack());
      });
      stubMedia(getUserMedia);
      return getUserMedia;
    }

    async function refuseTheEchoAnswer() {
      fireEvent.change(screen.getByLabelText('Headphones or speakers'), { target: { value: 'speakers-ec' } });
      await screen.findByRole('alert');
    }

    it('asks for the microphone alone', async () => {
      const getUserMedia = refuseEcho();
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      await screen.findByLabelText('Camera');
      fireEvent.click(micOnlyButton());
      await waitFor(() => expect(micOnlyButton()).toHaveAttribute('aria-pressed', 'true'));
      await refuseTheEchoAnswer();
      expect(getUserMedia).toHaveBeenCalledTimes(3);

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(4));

      expect(getUserMedia.mock.calls.at(-1)![0].video).toBe(false);
      await waitFor(() => expect(micOnlyButton()).toHaveAttribute('aria-pressed', 'true'));
    });

    it('still asks for the microphone alone the next time it is needed', async () => {
      const getUserMedia = refuseEcho();
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      await screen.findByLabelText('Camera');
      fireEvent.click(micOnlyButton());
      await waitFor(() => expect(micOnlyButton()).toHaveAttribute('aria-pressed', 'true'));
      await refuseTheEchoAnswer();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
      await waitFor(() => expect(screen.getByLabelText('Headphones or speakers')).toBeEnabled());

      await refuseTheEchoAnswer();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(6));

      expect(getUserMedia.mock.calls.at(-1)![0].video).toBe(false);
    });

    it('asks for the camera as well when Microphone only was not chosen', async () => {
      const getUserMedia = refuseEcho();
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      await screen.findByLabelText('Camera');
      await refuseTheEchoAnswer();

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(3));

      expect(getUserMedia.mock.calls.at(-1)![0].video).not.toBe(false);
    });
  });

  it('shows no error for a capture that fails after its run of the mount effect was cleaned up', async () => {
    const opens: Array<{ resolve: (s: MediaStream) => void; reject: (e: unknown) => void }> = [];
    const getUserMedia = vi.fn().mockImplementation(
      () =>
        new Promise<MediaStream>((resolve, reject) => {
          opens.push({ resolve, reject });
        })
    );
    stubMedia(getUserMedia);
    render(
      <StrictMode>
        <Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />
      </StrictMode>
    );
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));

    await act(async () => {
      opens[0]!.reject(Object.assign(new Error('busy'), { name: 'NotReadableError' }));
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Allow camera and mic')).toBeInTheDocument();

    await act(async () => {
      opens[1]!.resolve(streamOf(micTrack(), camTrack()));
    });
    expect(await screen.findByLabelText('Camera')).toBeVisible();
  });

  it('does not stop the stream it handed to the call when the lobby is closed after Join', async () => {
    const preview = streamOf(micTrack(), camTrack());
    stubMedia(vi.fn().mockResolvedValue(preview));
    const onJoin = vi.fn();
    const { unmount } = render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} />);
    await screen.findByLabelText('Camera');
    fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Ana' } });
    fireEvent.click(screen.getByRole('button', { name: /join now/i }));
    await waitFor(() => expect(onJoin).toHaveBeenCalledWith(preview, 'Ana', false, undefined, false));

    unmount();

    for (const t of preview.getTracks()) expect(t.stop).not.toHaveBeenCalled();
  });

  it('lets go of the preview it has open when Present only is pressed', async () => {
    const preview = streamOf(micTrack(), camTrack());
    stubMedia(vi.fn().mockResolvedValue(preview), vi.fn().mockResolvedValue(streamOf(camTrack())));
    const onJoin = vi.fn();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} />);
    await screen.findByLabelText('Camera');
    fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Ana' } });

    fireEvent.click(screen.getByRole('button', { name: 'Present only' }));
    await waitFor(() => expect(onJoin).toHaveBeenCalledTimes(1));

    for (const t of preview.getTracks()) expect(t.stop).toHaveBeenCalled();
  });
});
