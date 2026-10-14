import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Lobby } from '@/components/Lobby';

type Size = { width: number; height: number };

/** A lobby stream whose camera reports the size it was opened at. */
function streamAt({ width, height }: Size, withVideo = true) {
  const audio = {
    kind: 'audio',
    enabled: true,
    stop: vi.fn(),
    getSettings: () => ({ sampleRate: 48000, echoCancellation: false }),
  };
  const video = {
    kind: 'video',
    enabled: true,
    stop: vi.fn(),
    getSettings: () => ({ width, height, frameRate: 30 }),
    getCapabilities: () => ({ width: { max: 1920 }, height: { max: 1080 } }),
  };
  const tracks = withVideo ? [audio, video] : [audio];
  // An EventTarget, as a real stream is: the preview tile listens on it.
  return Object.assign(new EventTarget(), {
    getTracks: () => tracks,
    getAudioTracks: () => [audio],
    getVideoTracks: () => (withVideo ? [video] : []),
  }) as unknown as MediaStream;
}

const ideal = (c: unknown) => (c as { ideal: number }).ideal;

/**
 * getUserMedia that answers every call with a new stream. By default the camera
 * delivers the size it was asked for; `deliver` says what it gives instead.
 */
function stubMedia(options: { userAgent?: string; deliver?: (asked: Size) => Size } = {}) {
  const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
    const v = constraints.video as MediaTrackConstraints | false;
    if (v === false) return streamAt({ width: 0, height: 0 }, false);
    const asked = { width: ideal(v.width), height: ideal(v.height) };
    return streamAt(options.deliver ? options.deliver(asked) : asked);
  });
  vi.stubGlobal('navigator', {
    userAgent: options.userAgent ?? 'test',
    mediaDevices: {
      getUserMedia,
      enumerateDevices: vi.fn().mockResolvedValue([
        { kind: 'videoinput', deviceId: 'cam1', label: 'Webcam' },
        { kind: 'audioinput', deviceId: 'mic1', label: 'Mic' },
      ]),
    },
  });
  return getUserMedia;
}

const askedSize = (getUserMedia: ReturnType<typeof stubMedia>, call: number) => {
  const v = getUserMedia.mock.calls[call]![0].video as MediaTrackConstraints;
  return [ideal(v.width), ideal(v.height)];
};

/** The shape picker, once the preview is up and it can be used. */
async function ready(): Promise<HTMLSelectElement> {
  const select = (await screen.findByLabelText('Picture shape')) as HTMLSelectElement;
  await waitFor(() => expect(select).not.toBeDisabled());
  return select;
}

const choose = (select: HTMLSelectElement, value: 'portrait' | 'landscape') =>
  fireEvent.change(select, { target: { value } });

describe('Lobby: the picture shape', () => {
  afterEach(() => {
    localStorage.removeItem('om_portrait');
    localStorage.removeItem('om_quality');
    vi.unstubAllGlobals();
  });

  it('opens the camera again as a portrait picture, and remembers it', async () => {
    const getUserMedia = stubMedia();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const select = await ready();
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      'Shape: Landscape · 16:9',
      'Shape: Portrait · 9:16 vertical',
    ]);
    expect(select).toHaveValue('landscape');
    expect(askedSize(getUserMedia, 0)).toEqual([1920, 1080]);

    choose(select, 'portrait');
    await waitFor(() => expect(select).toHaveValue('portrait'));
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(askedSize(getUserMedia, 1)).toEqual([608, 1080]);
    expect(localStorage.getItem('om_portrait')).toBe('1');
    await screen.findByText(/Capturing 608x1080/);

    choose(select, 'landscape');
    await waitFor(() => expect(select).toHaveValue('landscape'));
    expect(askedSize(getUserMedia, 2)).toEqual([1920, 1080]);
    expect(localStorage.getItem('om_portrait')).not.toBe('1');
  });

  it('asks for a portrait picture on the first preview when that was stored', async () => {
    localStorage.setItem('om_portrait', '1');
    const getUserMedia = stubMedia();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    expect(await ready()).toHaveValue('portrait');
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(askedSize(getUserMedia, 0)).toEqual([608, 1080]);
  });

  it('reads anything but 1 in storage as landscape', async () => {
    localStorage.setItem('om_portrait', 'true');
    const getUserMedia = stubMedia();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    expect(await ready()).toHaveValue('landscape');
    expect(askedSize(getUserMedia, 0)).toEqual([1920, 1080]);
  });

  it('keeps the shape when another picker opens the camera again', async () => {
    const getUserMedia = stubMedia();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    choose(await ready(), 'portrait');
    await screen.findByText(/Capturing 608x1080/);

    fireEvent.change(screen.getByLabelText('Recording quality'), { target: { value: '720p' } });
    await screen.findByText(/Capturing 406x720/);
    expect(askedSize(getUserMedia, 2)).toEqual([406, 720]);

    fireEvent.change(screen.getByLabelText('Frame rate'), { target: { value: '25' } });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(4));
    expect(askedSize(getUserMedia, 3)).toEqual([406, 720]);
  });

  it('asks for the shape again on Try again', async () => {
    localStorage.setItem('om_portrait', '1');
    const getUserMedia = stubMedia();
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error('busy'), { name: 'NotReadableError' }));
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await ready()).toHaveValue('portrait');
    expect(askedSize(getUserMedia, 1)).toEqual([608, 1080]);
  });

  it('keeps the old shape and stores nothing when the camera cannot be opened again', async () => {
    const getUserMedia = stubMedia();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const select = await ready();
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error('busy'), { name: 'NotReadableError' }));
    choose(select, 'portrait');
    await screen.findByText('busy');
    expect(select).toHaveValue('landscape');
    expect(localStorage.getItem('om_portrait')).toBeNull();
  });

  it('is turned off with no preview and takes no change beside a capture on its way', async () => {
    const getUserMedia = stubMedia();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const select = await ready();

    let open!: (s: MediaStream) => void;
    getUserMedia.mockImplementationOnce(() => new Promise<MediaStream>((resolve) => (open = resolve)));
    fireEvent.change(screen.getByLabelText('Recording quality'), { target: { value: '720p' } });
    choose(select, 'portrait');
    expect(getUserMedia).toHaveBeenCalledTimes(2);

    open(streamAt({ width: 1280, height: 720 }));
    await screen.findByText(/Capturing 1280x720/);
    expect(select).toHaveValue('landscape');
    expect(localStorage.getItem('om_portrait')).not.toBe('1');
  });

  it('is turned off while there is no preview', async () => {
    const getUserMedia = stubMedia();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const select = await ready();
    // Echo cancellation lets the microphone go first, which takes the preview down.
    getUserMedia.mockImplementationOnce(() => new Promise<MediaStream>(() => {}));
    fireEvent.change(screen.getByLabelText('Headphones or speakers'), { target: { value: 'speakers-ec' } });
    expect(select).toBeDisabled();
  });

  it('shows a line when the camera gives a wide picture to a portrait ask', async () => {
    stubMedia({ deliver: () => ({ width: 1920, height: 1080 }) });
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const select = await ready();
    await screen.findByText(/Capturing 1920x1080/);
    expect(screen.queryByText('This camera gave a wide picture, not a portrait one.')).toBeNull();

    choose(select, 'portrait');
    await waitFor(() => expect(select).toHaveValue('portrait'));
    const line = await screen.findByText('This camera gave a wide picture, not a portrait one.');
    expect(line).toHaveAttribute('role', 'status');
  });

  it('counts a square picture as not a portrait one', async () => {
    stubMedia({ deliver: () => ({ width: 1080, height: 1080 }) });
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    choose(await ready(), 'portrait');
    expect(await screen.findByText('This camera gave a wide picture, not a portrait one.')).toBeInTheDocument();
  });

  it('shows no such line when the picture is tall', async () => {
    stubMedia();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    choose(await ready(), 'portrait');
    await screen.findByText(/Capturing 608x1080/);
    expect(screen.queryByText('This camera gave a wide picture, not a portrait one.')).toBeNull();
  });

  it('is not offered on a phone, which asks for landscape even with 1 stored', async () => {
    localStorage.setItem('om_portrait', '1');
    const getUserMedia = stubMedia({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    await screen.findByText(/Capturing 1920x1080/);
    expect(screen.getByLabelText('Recording quality')).toBeInTheDocument();
    expect(screen.queryByLabelText('Picture shape')).toBeNull();
    expect(askedSize(getUserMedia, 0)).toEqual([1920, 1080]);
  });

  it('is hidden while only the microphone is open', async () => {
    stubMedia();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const select = await ready();
    expect(select.closest('label')).not.toHaveAttribute('hidden');
    fireEvent.click(screen.getByRole('button', { name: 'Microphone only' }));
    await waitFor(() => expect(select.closest('label')).toHaveAttribute('hidden'));
  });

  it('has no framing guide while portrait is chosen, and has it back with landscape', async () => {
    stubMedia();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const select = await ready();
    expect(screen.getByRole('button', { name: 'Framing guide' })).toBeInTheDocument();

    choose(select, 'portrait');
    await screen.findByText(/Capturing 608x1080/);
    expect(screen.queryByRole('button', { name: 'Framing guide' })).toBeNull();

    choose(select, 'landscape');
    await screen.findByText(/Capturing 1920x1080/);
    expect(screen.getByRole('button', { name: 'Framing guide' })).toBeInTheDocument();
  });

  it('is not offered to a producer or a presenter, who open no camera', () => {
    const getUserMedia = stubMedia();
    const { unmount } = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} producer />);
    expect(screen.queryByLabelText('Picture shape')).toBeNull();
    unmount();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} present />);
    expect(screen.queryByLabelText('Picture shape')).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
