import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Lobby } from '@/components/Lobby';
import { chooseListening, listeningField } from '@/lib/listening';

/** A lobby stream whose microphone reports the echo cancellation it was opened with. */
function streamWith(echoCancellation: boolean) {
  const audio = {
    kind: 'audio',
    enabled: true,
    stop: vi.fn(),
    getSettings: () => ({ sampleRate: 48000, echoCancellation }),
  };
  const video = {
    kind: 'video',
    enabled: true,
    stop: vi.fn(),
    getSettings: () => ({ width: 1280, height: 720, frameRate: 30 }),
    getCapabilities: () => ({ width: { max: 1280 }, height: { max: 720 } }),
  };
  // An EventTarget, as a real stream is: the preview tile listens on it.
  const stream = Object.assign(new EventTarget(), {
    getTracks: () => [audio, video],
    getAudioTracks: () => [audio],
    getVideoTracks: () => [video],
  }) as unknown as MediaStream;
  return { audio, stream };
}

/**
 * getUserMedia that answers every call with a new stream. `deliver` is what the
 * microphone reports for what it was asked: by default, exactly that.
 */
function stubMedia(deliver: (asked: boolean) => boolean = (asked) => asked) {
  const opened: ReturnType<typeof streamWith>[] = [];
  const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
    const asked = (constraints.audio as MediaTrackConstraints).echoCancellation === true;
    const made = streamWith(deliver(asked));
    opened.push(made);
    return made.stream;
  });
  vi.stubGlobal('navigator', {
    userAgent: 'test',
    mediaDevices: {
      getUserMedia,
      enumerateDevices: vi.fn().mockResolvedValue([
        { kind: 'videoinput', deviceId: 'cam1', label: 'Webcam' },
        { kind: 'audioinput', deviceId: 'mic1', label: 'Mic' },
        { kind: 'audioinput', deviceId: 'mic2', label: 'Other mic' },
      ]),
    },
  });
  return { getUserMedia, opened };
}

/** The question, once the preview is up and it can be answered. */
async function ready(): Promise<HTMLSelectElement> {
  const select = (await screen.findByLabelText('Headphones or speakers')) as HTMLSelectElement;
  await waitFor(() => expect(select).not.toBeDisabled());
  // The pickers' ids and the "Capturing" line arrive together, a tick later.
  await screen.findByText(/Capturing 1280x720/);
  return select;
}

const askedAudio = (getUserMedia: ReturnType<typeof stubMedia>['getUserMedia'], call: number) =>
  getUserMedia.mock.calls[call]![0].audio as MediaTrackConstraints;

const capturing = () => screen.getByText(/Capturing 1280x720/).textContent;

const busy = () => Object.assign(new Error('busy'), { name: 'NotReadableError' });

describe('Lobby: headphones or speakers', () => {
  afterEach(() => {
    localStorage.removeItem('om_listening');
    vi.unstubAllGlobals();
  });

  it('asks above Join, unanswered, and opens the microphone with echo cancellation off', async () => {
    const { getUserMedia } = stubMedia();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    // Nothing to answer about until a microphone is open.
    expect(screen.getByLabelText('Headphones or speakers')).toBeDisabled();
    const select = await ready();

    expect(select).toHaveValue('');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      'Headphones or speakers?',
      'Listening on: headphones',
      'Listening on: speakers',
      'Speakers, echo cancellation on',
    ]);
    expect(select).toHaveAccessibleDescription('The host sees your answer.');
    expect(askedAudio(getUserMedia, 0)).toMatchObject({ echoCancellation: false });
    expect(capturing()).not.toMatch(/echo cancellation/);
    // Above Join, so a phone shows it without scrolling past the button.
    const join = screen.getByRole('button', { name: /join now/i });
    expect(select.compareDocumentPosition(join) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('remembers headphones or speakers without opening the microphone again', async () => {
    const { getUserMedia } = stubMedia();
    const first = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const select = await ready();
    fireEvent.change(select, { target: { value: 'speakers' } });
    expect(select).toHaveValue('speakers');
    expect(select).toHaveAccessibleDescription(/Your microphone will pick up the others/);
    expect(localStorage.getItem('om_listening')).toBe('speakers');
    fireEvent.change(select, { target: { value: 'headphones' } });
    expect(localStorage.getItem('om_listening')).toBe('headphones');
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    first.unmount();

    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    expect(await ready()).toHaveValue('headphones');
    expect(askedAudio(getUserMedia, 1)).toMatchObject({ echoCancellation: false });
  });

  it('opens the microphone again with echo cancellation on, after letting the first one go', async () => {
    const { getUserMedia, opened } = stubMedia();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const select = await ready();

    fireEvent.change(select, { target: { value: 'speakers-ec' } });
    await waitFor(() => expect(select).toHaveValue('speakers-ec'));

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(askedAudio(getUserMedia, 1)).toMatchObject({
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: false,
      deviceId: { exact: 'mic1' },
    });
    expect(opened[0]!.audio.stop.mock.invocationCallOrder[0]!).toBeLessThan(
      getUserMedia.mock.invocationCallOrder[1]!
    );
    expect(capturing()).toMatch(/· echo cancellation on$/);
    expect(select).toHaveAccessibleDescription(/your recording is not raw audio/);
    expect(localStorage.getItem('om_listening')).toBe('speakers-ec');
  });

  it('opens the first microphone with echo cancellation when that was the remembered answer', async () => {
    localStorage.setItem('om_listening', 'speakers-ec');
    const { getUserMedia } = stubMedia();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    expect(await ready()).toHaveValue('speakers-ec');
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(askedAudio(getUserMedia, 0)).toMatchObject({ echoCancellation: true });
  });

  it('reads anything else in storage as not said', async () => {
    localStorage.setItem('om_listening', 'loud');
    const { getUserMedia } = stubMedia();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    expect(await ready()).toHaveValue('');
    expect(askedAudio(getUserMedia, 0)).toMatchObject({ echoCancellation: false });
  });

  it('shows speakers when the microphone does not report echo cancellation', async () => {
    const { getUserMedia } = stubMedia(() => false);
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const select = await ready();
    fireEvent.change(select, { target: { value: 'speakers-ec' } });
    await waitFor(() => expect(select).toHaveValue('speakers'));
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(capturing()).not.toMatch(/echo cancellation/);
  });

  it('keeps echo cancellation when another microphone is picked', async () => {
    const { getUserMedia, opened } = stubMedia();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const select = await ready();
    fireEvent.change(select, { target: { value: 'speakers-ec' } });
    await waitFor(() => expect(select).toHaveValue('speakers-ec'));

    fireEvent.change(screen.getByLabelText('Microphone'), { target: { value: 'mic2' } });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(3));
    expect(askedAudio(getUserMedia, 2)).toMatchObject({ echoCancellation: true, deviceId: { exact: 'mic2' } });
    // An ordinary switch keeps the old microphone until the new one is open.
    expect(opened[1]!.audio.stop.mock.invocationCallOrder[0] ?? Infinity).toBeGreaterThan(
      getUserMedia.mock.invocationCallOrder[2]!
    );
  });

  it('leaves no preview to join when the microphone cannot be opened again', async () => {
    const { getUserMedia } = stubMedia();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const select = await ready();
    fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Alice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn off microphone' }));

    getUserMedia.mockRejectedValueOnce(Object.assign(new Error('busy'), { name: 'NotReadableError' }));
    fireEvent.change(select, { target: { value: 'speakers-ec' } });

    expect(await screen.findByText('Camera or mic is busy')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /join now/i })).toBeDisabled();
    expect(select).toBeDisabled();
    expect(select).toHaveValue('');
    expect(localStorage.getItem('om_listening')).toBeNull();

    // Try again opens both with their tracks on, and the buttons say so.
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Turn off microphone' })).toBeInTheDocument();
    expect(askedAudio(getUserMedia, 2)).toMatchObject({ echoCancellation: false });
  });

  // Its microphone is already stopped by then: joined, it would record silence.
  it('turns Join and the question off while the microphone is being opened again', async () => {
    const { getUserMedia } = stubMedia();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const select = await ready();
    fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Alice' } });
    const join = screen.getByRole('button', { name: /join now/i });
    expect(join).not.toBeDisabled();

    let opened!: (s: MediaStream) => void;
    getUserMedia.mockImplementationOnce(() => new Promise<MediaStream>((resolve) => (opened = resolve)));
    fireEvent.change(select, { target: { value: 'speakers-ec' } });
    expect(join).toBeDisabled();
    expect(select).toBeDisabled();

    opened(streamWith(true).stream);
    await waitFor(() => expect(join).not.toBeDisabled());
    expect(select).toHaveValue('speakers-ec');
  });

  it('does not tell a host that the host sees the answer', async () => {
    localStorage.setItem('om_host_xyz-abcd-pqr', 'host-tok');
    try {
      stubMedia();
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      const select = await ready();
      fireEvent.change(select, { target: { value: 'speakers' } });
      await waitFor(() =>
        expect(select).toHaveAccessibleDescription('Your microphone will pick up the others from your speakers.')
      );
    } finally {
      localStorage.removeItem('om_host_xyz-abcd-pqr');
    }
  });

  it('opens the microphone again without echo cancellation when another answer is picked', async () => {
    const { getUserMedia, opened } = stubMedia();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const select = await ready();
    fireEvent.change(select, { target: { value: 'speakers-ec' } });
    await waitFor(() => expect(select).toHaveValue('speakers-ec'));

    fireEvent.change(select, { target: { value: 'headphones' } });
    await waitFor(() => expect(select).toHaveValue('headphones'));

    expect(getUserMedia).toHaveBeenCalledTimes(3);
    expect(askedAudio(getUserMedia, 2)).toMatchObject({ echoCancellation: false, deviceId: { exact: 'mic1' } });
    // The echo-cancelled microphone is let go before the plain one is asked for.
    expect(opened[1]!.audio.stop.mock.invocationCallOrder[0]!).toBeLessThan(
      getUserMedia.mock.invocationCallOrder[2]!
    );
    expect(capturing()).not.toMatch(/echo cancellation/);
    expect(localStorage.getItem('om_listening')).toBe('headphones');
  });

  it('lets the camera go with a microphone that cannot be opened again, and shows it on after Try again', async () => {
    const { getUserMedia, opened } = stubMedia();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const select = await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Turn off camera' }));

    getUserMedia.mockRejectedValueOnce(busy());
    fireEvent.change(select, { target: { value: 'speakers-ec' } });
    expect(await screen.findByText('Camera or mic is busy')).toBeInTheDocument();
    // Nothing of the first capture is left open behind the tile.
    expect(opened[0]!.stream.getVideoTracks()[0]!.stop).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    // The new camera is live, so its button must not read as off.
    expect(await screen.findByRole('button', { name: 'Turn off camera' })).toBeInTheDocument();
  });

  it('asks for echo cancellation on Try again when that is the answer the lobby holds', async () => {
    localStorage.setItem('om_listening', 'speakers-ec');
    const { getUserMedia } = stubMedia();
    getUserMedia.mockRejectedValueOnce(busy());
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await ready()).toHaveValue('speakers-ec');
    expect(askedAudio(getUserMedia, 1)).toMatchObject({ echoCancellation: true });
  });

  // A browser may name the kind of cancellation instead of saying true.
  it('counts a microphone that reports echo cancellation as a word as on', async () => {
    stubMedia((asked) => (asked ? ('all' as unknown as boolean) : false));
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const select = await ready();
    fireEvent.change(select, { target: { value: 'speakers-ec' } });
    await waitFor(() => expect(select).toHaveValue('speakers-ec'));
    expect(capturing()).toMatch(/· echo cancellation on$/);
  });

  it('describes speakers when echo cancellation was asked for and the microphone does not report it', async () => {
    stubMedia(() => false);
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const select = await ready();
    fireEvent.change(select, { target: { value: 'speakers-ec' } });
    await waitFor(() => expect(select).toHaveValue('speakers'));
    expect(select).toHaveAccessibleDescription(
      'The host sees your answer. Your microphone will pick up the others from your speakers.'
    );
  });

  // A second capture opened beside one that is still on its way is never
  // stopped, and can undo the answer that was just given.
  it('turns the capture pickers off while the preview is down', async () => {
    const { getUserMedia } = stubMedia();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const select = await ready();
    const pickers = ['Camera', 'Microphone', 'Recording quality', 'Frame rate'].map((name) =>
      screen.getByLabelText(name)
    );
    for (const p of pickers) expect(p).not.toBeDisabled();

    let opened!: (s: MediaStream) => void;
    getUserMedia.mockImplementationOnce(() => new Promise<MediaStream>((resolve) => (opened = resolve)));
    fireEvent.change(select, { target: { value: 'speakers-ec' } });
    for (const p of pickers) expect(p).toBeDisabled();

    opened(streamWith(true).stream);
    await waitFor(() => expect(select).toHaveValue('speakers-ec'));
    for (const p of pickers) expect(p).not.toBeDisabled();

    // After a re-open that failed, only Try again opens a capture.
    getUserMedia.mockRejectedValueOnce(busy());
    fireEvent.change(select, { target: { value: 'headphones' } });
    expect(await screen.findByText('Camera or mic is busy')).toBeInTheDocument();
    for (const p of pickers) expect(p).toBeDisabled();
  });

  // Two captures asked for at once leave one open with nothing to stop it, and
  // the one that lands last decides the microphone and the answer.
  it('takes no second capture change while one is on its way', async () => {
    const { getUserMedia, opened } = stubMedia();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const select = await ready();
    const microphone = screen.getByLabelText('Microphone');

    let open!: (s: MediaStream) => void;
    getUserMedia.mockImplementationOnce(() => new Promise<MediaStream>((resolve) => (open = resolve)));
    fireEvent.change(microphone, { target: { value: 'mic2' } });
    // The preview is still up, so the question can be answered meanwhile.
    expect(select).not.toBeDisabled();
    fireEvent.change(select, { target: { value: 'speakers-ec' } });

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    // The microphone in the preview is not let go for a change that is not taken.
    expect(opened[0]!.audio.stop).not.toHaveBeenCalled();

    open(streamWith(false).stream);
    await waitFor(() => expect(microphone).toHaveValue('mic2'));
    expect(select).toHaveValue('');
    expect(capturing()).not.toMatch(/echo cancellation/);

    // Once that capture is open, a change is taken again.
    fireEvent.change(select, { target: { value: 'speakers-ec' } });
    await waitFor(() => expect(select).toHaveValue('speakers-ec'));
    expect(getUserMedia).toHaveBeenCalledTimes(3);
    expect(askedAudio(getUserMedia, 2)).toMatchObject({ echoCancellation: true, deviceId: { exact: 'mic2' } });
  });

  it('takes a capture change again after one that could not be opened', async () => {
    const { getUserMedia } = stubMedia();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const select = await ready();

    getUserMedia.mockRejectedValueOnce(busy());
    fireEvent.change(select, { target: { value: 'speakers-ec' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await ready();

    fireEvent.change(select, { target: { value: 'speakers-ec' } });
    await waitFor(() => expect(select).toHaveValue('speakers-ec'));
  });
});

describe('Lobby: the answer goes with the join', () => {
  afterEach(() => {
    chooseListening('');
    localStorage.removeItem('om_listening');
    vi.unstubAllGlobals();
  });

  async function join(onJoin: ReturnType<typeof vi.fn>) {
    fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Alice' } });
    const button = screen.getByRole('button', { name: /join now/i });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    // The same five arguments as before the question existed.
    await waitFor(() =>
      expect(onJoin).toHaveBeenCalledWith(expect.anything(), 'Alice', false, undefined, false)
    );
  }

  it('hands the call the answer that was showing', async () => {
    const onJoin = vi.fn();
    stubMedia();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} />);
    fireEvent.change(await ready(), { target: { value: 'speakers' } });
    await join(onJoin);
    expect(listeningField()).toEqual({ listening: 'speakers' });
  });

  it('hands over nothing when the question was left unanswered', async () => {
    // Left over from an earlier join in this page.
    chooseListening('headphones');
    const onJoin = vi.fn();
    stubMedia();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} />);
    await ready();
    await join(onJoin);
    expect(listeningField()).toEqual({});
  });

  it('hands over speakers when echo cancellation was asked for and the microphone does not report it', async () => {
    const onJoin = vi.fn();
    stubMedia(() => false);
    render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} />);
    const select = await ready();
    fireEvent.change(select, { target: { value: 'speakers-ec' } });
    await waitFor(() => expect(select).toHaveValue('speakers'));
    await join(onJoin);
    expect(listeningField()).toEqual({ listening: 'speakers' });
  });

  it('hands over nothing when storage holds something that is not an answer', async () => {
    localStorage.setItem('om_listening', 'loud');
    const onJoin = vi.fn();
    stubMedia();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} />);
    await ready();
    await join(onJoin);
    expect(listeningField()).toEqual({});
  });
});
