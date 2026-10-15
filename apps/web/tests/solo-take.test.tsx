import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { RECORD_COUNTDOWN_S } from '@openmeet/protocol';
import { RoomView } from '@/components/RoomView';
import { cameraVideoBps, chooseBitrate, DEFAULT_BITRATE_ID } from '@/lib/quality';
import { FakeDirectoryHandle } from './fake-opfs';

const SLUG = 'xyz-abcd-pqr';

let state: Record<string, unknown>;
const join = vi.fn();

vi.mock('@/hooks/useRoom', () => ({
  useRoom: () => ({ state, join, leave: vi.fn(), setMic: vi.fn(), setCam: vi.fn() }),
}));

function fakeStream(withVideo = true, withAudio = true): MediaStream {
  const tracks = [
    // Two channels, so the ordinary lobby would offer the stereo choice.
    ...(withAudio
      ? [{ kind: 'audio', enabled: true, stop: vi.fn(), getSettings: () => ({ deviceId: 'mic1', channelCount: 2 }) }]
      : []),
    ...(withVideo
      ? [
          {
            kind: 'video',
            enabled: true,
            stop: vi.fn(),
            getSettings: () => ({ deviceId: 'cam1', width: 1920, height: 1080, frameRate: 30 }),
          },
        ]
      : []),
  ];
  return Object.assign(new EventTarget(), {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  }) as unknown as MediaStream;
}

/** Records one chunk when stopped, as a real recorder hands over its last data. */
class FakeMediaRecorder {
  static isTypeSupported = () => true;
  static made: FakeMediaRecorder[] = [];
  static failStop = false;
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  state = 'inactive';
  constructor() {
    FakeMediaRecorder.made.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    if (FakeMediaRecorder.failStop) throw new Error('recorder is gone');
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob([new Uint8Array(16)]) });
    this.onstop?.();
  }
}

/** One 10 ms frame, then the end of the capture. */
class FakeTrackProcessor {
  readable = new ReadableStream({
    start(c) {
      c.enqueue({
        sampleRate: 48000,
        numberOfChannels: 1,
        numberOfFrames: 480,
        allocationSize: () => 480 * 4,
        copyTo: () => {},
        close: () => {},
      });
      c.close();
    },
  });
}

/** Storage that takes the first part of a recording and refuses every later one. */
class FlakyDirectoryHandle extends FakeDirectoryHandle {
  override async getDirectoryHandle(name: string): Promise<FakeDirectoryHandle> {
    const dir = new FlakyDirectoryHandle(name);
    this.entries.set(name, dir);
    return dir;
  }

  override async getFileHandle(name: string, opts?: { create?: boolean }) {
    if (/^0000(0[1-9]|[1-9]\d)\.part$/.test(name)) throw new Error('no room');
    return super.getFileHandle(name, opts);
  }
}

let root: FakeDirectoryHandle;
let getUserMedia: ReturnType<typeof vi.fn>;
const wakeLock = { released: false, release: vi.fn().mockResolvedValue(undefined) };
const wakeLockRequest = vi.fn();

const dirNames = () => [...root.entries.keys()];

function stubBrowser(opts: { storage?: boolean; recorder?: boolean; pcm?: boolean; stream?: MediaStream } = {}) {
  const { storage = true, recorder = true, pcm = true, stream = fakeStream() } = opts;
  getUserMedia = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal('navigator', {
    userAgent: 'test',
    mediaDevices: {
      getUserMedia,
      enumerateDevices: vi.fn().mockResolvedValue([
        { kind: 'videoinput', deviceId: 'cam1', label: 'Webcam' },
        { kind: 'videoinput', deviceId: 'cam2', label: 'Other webcam' },
        { kind: 'audioinput', deviceId: 'mic1', label: 'Mic' },
      ]),
    },
    wakeLock: { request: wakeLockRequest },
    ...(storage ? { storage: { getDirectory: async () => root } } : {}),
  });
  if (recorder) vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  else Reflect.deleteProperty(globalThis, 'MediaRecorder');
  if (pcm) vi.stubGlobal('MediaStreamTrackProcessor', FakeTrackProcessor);
  else Reflect.deleteProperty(globalThis, 'MediaStreamTrackProcessor');
}

/** Lets the lobby's own lookups (camera, backups, the host token) land, on real timers. */
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

/** Waits for work that is not a timer (storage, a recorder stopping), while fake time is installed. */
const until = (check: () => void) =>
  vi.waitFor(async () => {
    await act(async () => {});
    check();
  });

const press = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));

async function openSolo(search = '?solo=1') {
  window.history.replaceState({}, '', `/r/${SLUG}/${search}`);
  const view = render(<RoomView slug={SLUG} />);
  await settle();
  return view;
}

/** Press Record and let the count run out. Fake time stays installed. */
async function startTake() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  press('Record');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(RECORD_COUNTDOWN_S * 1000);
  });
}

beforeEach(() => {
  root = new FakeDirectoryHandle('root');
  FakeMediaRecorder.made = [];
  FakeMediaRecorder.failStop = false;
  join.mockClear();
  wakeLockRequest.mockReset().mockResolvedValue(wakeLock);
  wakeLock.release.mockClear();
  state = {
    phase: 'lobby',
    role: null,
    companion: false,
    localStream: null,
    localName: '',
    connectionWarning: null,
    syncReportUrl: null,
    chaptersUrl: null,
    backupBlobUrl: null,
    wavBackupBlobUrl: null,
    takes: [],
  };
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:take-${++n}`);
  URL.revokeObjectURL = vi.fn();
  stubBrowser();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
  localStorage.removeItem(`om_host_${SLUG}`);
  localStorage.removeItem('om_bitrate');
  chooseBitrate(DEFAULT_BITRATE_ID);
});

describe('the record-alone link', () => {
  it('shows the solo lobby with a Record button and joins nothing', async () => {
    await openSolo();
    expect(screen.getByRole('heading', { name: 'Record on your own' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'You’re not in the room, and nobody sees or hears you. Record yourself here and send the files to the host later.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to the room' })).toHaveAttribute('href', `/r/${SLUG}/`);
    expect(await screen.findByRole('link', { name: 'See your checks ↓' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Only you are recorded, in this browser. Nothing leaves this device while you record. Afterwards you choose whether to send it to the host.'
      )
    ).toBeInTheDocument();
    const record = screen.getByRole('button', { name: 'Record' });
    expect(record).toBeEnabled();
    expect(record.className).toMatch(/(^|\s)min-h-11(\s|$)/);

    expect(screen.queryByRole('button', { name: 'Join now' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Your name' })).toBeNull();
    expect(screen.queryByText(/The host can record this call/)).toBeNull();
    expect(screen.getByLabelText('Microphone')).toBeInTheDocument();
    expect(screen.queryByLabelText('Audio channels')).toBeNull();
    expect(join).not.toHaveBeenCalled();
  });

  it('keeps the producer lobby for ?producer=1 and the check page when ?solo is absent', async () => {
    const producer = await openSolo('?solo=1&producer=1');
    expect(screen.getByRole('heading', { name: 'Join as a producer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record' })).toBeNull();
    producer.unmount();

    const present = await openSolo('?solo=1&present=1');
    expect(screen.getByRole('heading', { name: 'Ready to present?' })).toBeInTheDocument();
    present.unmount();

    const check = await openSolo('?check=1');
    expect(screen.getByRole('heading', { name: 'Check your setup' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record' })).toBeNull();
    check.unmount();

    await openSolo('?solo=1&check=1');
    expect(screen.getByRole('heading', { name: 'Record on your own' })).toBeInTheDocument();
  });

  it('still looks the room up first: an unknown room shows the expired page', async () => {
    state = { ...state, phase: 'not-found' };
    await openSolo();
    expect(screen.getByText('Room not found or expired')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record' })).toBeNull();
  });

  it('keeps Record off until the preview is up', async () => {
    getUserMedia.mockReturnValue(new Promise(() => {}));
    await openSolo();
    expect(screen.getByRole('button', { name: 'Record' })).toBeDisabled();
  });

  it('says which browsers cannot record, and offers no Record button there', async () => {
    stubBrowser({ recorder: false });
    await openSolo();
    expect(
      screen.getByText('This browser can’t record. Open this link in Chrome or Edge on a computer.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record' })).toBeNull();
    // The lobby's own line about being recorded in a call does not apply here.
    expect(screen.queryByText(/can’t record you/)).toBeNull();
  });

  it('tells the host’s own browser to use the room, with no Record button', async () => {
    localStorage.setItem(`om_host_${SLUG}`, 'host-tok');
    await openSolo();
    expect(
      screen.getByText('This link is for guests. To record on your own, go to the room and press Continue alone.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record' })).toBeNull();
  });
});

describe('recording alone', () => {
  it('counts down, then records into two directories named for the room', async () => {
    await openSolo();
    await settle();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    press('Record');
    expect(screen.getByRole('status')).toHaveTextContent(`Recording starts in ${RECORD_COUNTDOWN_S}`);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(dirNames()).toEqual([]);
    expect(FakeMediaRecorder.made).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECORD_COUNTDOWN_S * 1000);
    });
    await until(() => expect(dirNames()).toHaveLength(2));
    const names = dirNames().sort();
    expect(names[0]).toMatch(new RegExp(`^openmeet-backup-solo-\\d{13}-${SLUG}$`));
    expect(names[1]).toMatch(new RegExp(`^openmeet-backup-solo-audio-\\d{13}-${SLUG}$`));
    expect(FakeMediaRecorder.made).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Recording. Press Stop when you’re done.');
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('records no WAV where the browser cannot capture raw audio', async () => {
    stubBrowser({ pcm: false });
    await openSolo();
    await settle();
    await startTake();
    await until(() => expect(dirNames()).toHaveLength(1));
    expect(dirNames()[0]).toMatch(new RegExp(`^openmeet-backup-solo-\\d{13}-${SLUG}$`));
  });

  it('records no WAV for a stream with no microphone track', async () => {
    stubBrowser({ stream: fakeStream(true, false) });
    await openSolo();
    await settle();
    await startTake();
    await until(() => expect(dirNames()).toHaveLength(1));
    expect(dirNames()[0]).toMatch(new RegExp(`^openmeet-backup-solo-\\d{13}-${SLUG}$`));
  });

  it('starts nothing when the page is left during the count', async () => {
    const view = await openSolo();
    await settle();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    press('Record');
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECORD_COUNTDOWN_S * 1000);
    });
    expect(FakeMediaRecorder.made).toHaveLength(0);
    expect(dirNames()).toEqual([]);
  });

  it('records the bitrate level the lobby shows', async () => {
    localStorage.setItem('om_bitrate', 'max');
    await openSolo();
    await settle();
    const track = fakeStream().getVideoTracks()[0]!;
    const standard = cameraVideoBps(track);
    await startTake();
    expect(cameraVideoBps(track)).toBe(standard * 2);
  });

  it('creates nothing when Cancel is pressed during the count', async () => {
    await openSolo();
    await settle();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    press('Record');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    press('Cancel');
    expect(screen.getByRole('button', { name: 'Record' })).toBeEnabled();
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECORD_COUNTDOWN_S * 1000);
    });
    expect(FakeMediaRecorder.made).toHaveLength(0);
    expect(dirNames()).toEqual([]);
    expect(screen.getByRole('button', { name: 'Record' })).toBeEnabled();
  });

  it('keeps wake lock held from the end of the count to the end of the stop', async () => {
    await openSolo();
    await settle();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    press('Record');
    expect(wakeLockRequest).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECORD_COUNTDOWN_S * 1000);
    });
    await until(() => expect(wakeLockRequest).toHaveBeenCalledWith('screen'));
    expect(wakeLock.release).not.toHaveBeenCalled();
    press('Stop');
    await until(() => expect(wakeLock.release).toHaveBeenCalled());
  });

  it('lists the take with its download links once stopped, and says it is saved here', async () => {
    await openSolo();
    await settle();
    await startTake();
    await until(() => expect(dirNames()).toHaveLength(2));
    press('Stop');
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    await until(() => expect(screen.getByText('Take 1')).toBeInTheDocument());

    expect(screen.getByRole('link', { name: 'Download video' })).toHaveAttribute('download', `openmeet-solo-${SLUG}-take1.mp4`);
    expect(screen.getByRole('link', { name: 'Download audio (WAV)' })).toHaveAttribute(
      'download',
      `openmeet-solo-${SLUG}-take1.wav`
    );
    expect(screen.getByRole('link', { name: 'Download video' })).toHaveAttribute('href', expect.stringMatching(/^blob:take-/));
    expect(screen.getByRole('status')).toHaveTextContent(
      'Saved in this browser. To send it to the host, go to the room while they’re there, press Send to host on it, and join.'
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Record another take' })).toBeEnabled();

    // Saved takes may be left without asking.
    const leave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(false);
  });

  it('still lists the take, with the files it has, when a recorder fails to stop', async () => {
    await openSolo();
    await settle();
    await startTake();
    await until(() => expect(dirNames()).toHaveLength(2));
    FakeMediaRecorder.failStop = true;
    press('Stop');
    await until(() => expect(screen.getByText('Take 1')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Download video' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Download audio (WAV)' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Not saved in this browser.');
    expect(screen.getByRole('button', { name: 'Record another take' })).toBeEnabled();
  });

  it('does not call a take saved when storage took the start of it and refused the rest', async () => {
    root = new FlakyDirectoryHandle('root');
    await openSolo();
    await settle();
    await startTake();
    await until(() => expect(dirNames()).toHaveLength(2));
    const recorder = FakeMediaRecorder.made[0]!;
    recorder.ondataavailable?.({ data: new Blob([new Uint8Array(16)]) });
    await until(() => {
      const camera = [...root.entries.values()].find((d) => d.name.startsWith('openmeet-backup-solo-1')) as FakeDirectoryHandle;
      expect([...camera.entries.keys()]).toContain('000000.part');
    });
    press('Stop');
    await until(() => expect(screen.getByText('Take 1')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('This browser isn’t keeping this recording.');
    expect(screen.getByRole('status')).toHaveTextContent('Not saved in this browser.');
    expect(screen.getByRole('link', { name: 'Download video' })).toBeInTheDocument();
  });

  it('calls a take with no picture an audio take', async () => {
    stubBrowser({ stream: fakeStream(false) });
    await openSolo();
    await settle();
    await startTake();
    await until(() => expect(dirNames()).toHaveLength(2));
    press('Stop');
    await until(() => expect(screen.getByText('Take 1')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Download audio (MP4)' })).toHaveAttribute(
      'download',
      `openmeet-solo-${SLUG}-take1.mp4`
    );
    expect(screen.queryByRole('link', { name: 'Download video' })).toBeNull();
  });

  it('adds Take 2 in new directories and keeps the first take’s links', async () => {
    await openSolo();
    await settle();
    await startTake();
    await until(() => expect(dirNames()).toHaveLength(2));
    press('Stop');
    await until(() => expect(screen.getByText('Take 1')).toBeInTheDocument());

    press('Record another take');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECORD_COUNTDOWN_S * 1000);
    });
    await until(() => expect(dirNames()).toHaveLength(4));
    expect(new Set(dirNames()).size).toBe(4);
    // The line about the first take waits until this one is over.
    expect(screen.getByRole('status')).toHaveTextContent('Recording. Press Stop when you’re done.');
    press('Stop');
    await until(() => expect(screen.getByText('Take 2')).toBeInTheDocument());
    expect(screen.getByText('Take 1')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Download video' })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'Download video' })[1]).toHaveAttribute(
      'download',
      `openmeet-solo-${SLUG}-take2.mp4`
    );
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('lets the browser take back the links when the page is left', async () => {
    const view = await openSolo();
    await settle();
    await startTake();
    await until(() => expect(dirNames()).toHaveLength(2));
    press('Stop');
    await until(() => expect(screen.getByText('Take 1')).toBeInTheDocument());
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });
});

describe('a browser that cannot keep the recording', () => {
  beforeEach(() => stubBrowser({ storage: false }));

  it('warns during the take, says it is not saved after Stop, and asks before the page is left', async () => {
    await openSolo();
    await settle();
    const early = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(early);
    expect(early.defaultPrevented).toBe(false);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    press('Record');
    const counting = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(counting);
    expect(counting.defaultPrevented).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECORD_COUNTDOWN_S * 1000);
    });
    await until(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'This browser isn’t keeping this recording. When you stop, download the files before you close this tab.'
      )
    );
    expect(screen.getByRole('status')).toHaveTextContent('Recording. Press Stop when you’re done.');
    const recording = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(recording);
    expect(recording.defaultPrevented).toBe(true);

    press('Stop');
    await until(() => expect(screen.getByText('Take 1')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Download video' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Not saved in this browser. Download the files now: they are lost when this tab closes.'
    );
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(true);

    press('Record another take');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECORD_COUNTDOWN_S * 1000);
    });
    await until(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });

  it('clears the warning when the next take starts in a browser that keeps it', async () => {
    await openSolo();
    await settle();
    await startTake();
    await until(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    press('Stop');
    await until(() => expect(screen.getByText('Take 1')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toBeInTheDocument();

    vi.stubGlobal('navigator', { ...navigator, storage: { getDirectory: async () => root } });
    press('Record another take');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECORD_COUNTDOWN_S * 1000);
    });
    await until(() => expect(screen.queryByRole('alert')).toBeNull());
    press('Stop');
    await until(() => expect(screen.getByText('Take 2')).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('Saved in this browser.');
  });
});

describe('while a take records', () => {
  it('keeps the capture as it is: no new camera, and the pickers are off', async () => {
    await openSolo();
    await settle();
    const camera = screen.getByLabelText('Camera') as HTMLSelectElement;
    expect(camera).toBeEnabled();
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    press('Record');
    for (const label of ['Camera', 'Microphone', 'Recording quality', 'Picture shape', 'Recording bitrate', 'Frame rate']) {
      expect(screen.getByLabelText(label)).toBeDisabled();
    }
    expect(screen.getByRole('button', { name: 'Microphone only' })).toBeDisabled();
    // Counted from the press: a change made during the count is refused too.
    fireEvent.change(camera, { target: { value: 'cam2' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECORD_COUNTDOWN_S * 1000);
    });
    await until(() => expect(dirNames()).toHaveLength(2));
    fireEvent.change(camera, { target: { value: 'cam2' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    // The buttons over the preview stay: off records silence or a black picture.
    expect(screen.getByRole('button', { name: 'Turn off microphone' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Turn off camera' })).toBeEnabled();

    press('Stop');
    await until(() => expect(screen.getByText('Take 1')).toBeInTheDocument());
    for (const label of ['Camera', 'Microphone', 'Recording quality', 'Picture shape', 'Recording bitrate', 'Frame rate']) {
      expect(screen.getByLabelText(label)).toBeEnabled();
    }
    expect(screen.getByRole('button', { name: 'Microphone only' })).toBeEnabled();
    fireEvent.change(camera, { target: { value: 'cam2' } });
    await until(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
  });

  it('releases the lock when Cancel is pressed during the count', async () => {
    await openSolo();
    await settle();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    press('Record');
    expect(screen.getByLabelText('Camera')).toBeDisabled();
    press('Cancel');
    expect(screen.getByLabelText('Camera')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Microphone only' })).toBeEnabled();
  });
});
