import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { CallStage } from '@/components/CallStage';
import { popOut } from '@/hooks/use-pop-out';

// EventTargets, because a tile listens on the stream it is given.
const streamOf = (id: string) => Object.assign(new EventTarget(), { id }) as unknown as MediaStream;
const bob = streamOf('stream-bob');
const carol = streamOf('stream-carol');

// Bob and Carol are on camera. Pat (a producer) and Dana's present-only device
// have no camera tile, whatever they send.
const props = {
  role: 'guest' as const,
  phase: 'in-call' as const,
  localStream: null,
  remoteStream: bob,
  remotePeers: [
    { peerId: 'p-bob', name: 'Bob', stream: bob },
    { peerId: 'p-carol', name: 'Carol', stream: carol },
    { peerId: 'p-pat', name: 'Pat', stream: streamOf('stream-pat'), role: 'producer' as const },
    { peerId: 'p-dana', name: 'Dana', stream: streamOf('stream-dana'), role: 'guest' as const, companion: true },
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

/** The elements pop out made, in order. jsdom plays nothing, so play() is where each one shows up. */
let made: HTMLVideoElement[];
/** The element this stand-in browser is floating. */
let floating: HTMLVideoElement | null;
let request: ReturnType<typeof vi.fn>;
let exit: ReturnType<typeof vi.fn>;
const realPlay = HTMLMediaElement.prototype.play;

beforeEach(() => {
  made = [];
  floating = null;
  Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: true });
  // Closing the window tells its element, as a browser does.
  exit = vi.fn(() => {
    const el = floating;
    floating = null;
    el?.dispatchEvent(new Event('leavepictureinpicture'));
    return Promise.resolve();
  });
  Object.defineProperty(document, 'exitPictureInPicture', { configurable: true, writable: true, value: exit });
  request = vi.fn(function (this: HTMLVideoElement) {
    floating = this;
    return Promise.resolve({});
  });
  Object.defineProperty(HTMLVideoElement.prototype, 'requestPictureInPicture', {
    configurable: true,
    writable: true,
    value: request,
  });
  HTMLMediaElement.prototype.play = vi.fn(function (this: HTMLMediaElement) {
    made.push(this as HTMLVideoElement);
    return Promise.resolve();
  });
});

afterEach(() => {
  // First, while the stand-ins are still there: leaving the screen closes an open window.
  cleanup();
  HTMLMediaElement.prototype.play = realPlay;
  delete (HTMLVideoElement.prototype as { requestPictureInPicture?: unknown }).requestPictureInPicture;
  delete (document as { exitPictureInPicture?: unknown }).exitPictureInPicture;
  delete (document as { pictureInPictureEnabled?: unknown }).pictureInPictureEnabled;
});

const toggleMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Select camera' }));
const item = (name: string) => screen.getByRole('menuitemcheckbox', { name: `Pop out ${name}` });
/** Whether the menu shows that person as popped out. Opens the menu and closes it again. */
function ticked(name: string): boolean {
  toggleMenu();
  const on = item(name).getAttribute('aria-checked') === 'true';
  toggleMenu();
  return on;
}
/** Clicks "Pop out <name>" and lets the first frame arrive, as it does within a moment in a browser. */
async function popOutPerson(name: string) {
  toggleMenu();
  fireEvent.click(item(name));
  await act(async () => {
    made.at(-1)!.dispatchEvent(new Event('loadedmetadata'));
    // The browser's answer is a promise: let it land before the test goes on.
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('CallStage: pop out', () => {
  it('floats the person picked in a muted element of its own, and ticks them until it is closed', async () => {
    const { container } = render(<CallStage {...props} />);
    toggleMenu();
    // Everyone on camera, and nobody else.
    expect(screen.getAllByRole('menuitemcheckbox').map((i) => i.textContent)).toEqual([
      'Pop out Bob',
      'Pop out Carol',
    ]);

    fireEvent.click(item('Bob'));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(made).toHaveLength(1);
    expect(made[0]!.srcObject).toBe(bob);
    expect(made[0]!.muted).toBe(true);
    // The browser is asked only once there is a picture.
    expect(request).not.toHaveBeenCalled();
    await act(async () => {
      made[0]!.dispatchEvent(new Event('loadedmetadata'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(floating).toBe(made[0]);
    expect(ticked('Bob')).toBe(true);
    expect(ticked('Carol')).toBe(false);
    // Bob's tile on the page still holds his stream and still sounds.
    const tiles = Array.from(container.querySelectorAll('video')).filter((v) => v.srcObject === bob);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]!.muted).toBe(false);

    toggleMenu();
    fireEvent.click(item('Bob'));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(floating).toBeNull();
    expect(made[0]!.srcObject).toBeNull();
    expect(ticked('Bob')).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('moves the window to the next person picked, and closes it with the call screen', async () => {
    const view = render(<CallStage {...props} />);
    await popOutPerson('Bob');
    await popOutPerson('Carol');
    expect(made[1]!.srcObject).toBe(carol);
    expect(floating).toBe(made[1]);
    expect(made[0]!.srcObject).toBeNull();
    expect(ticked('Carol')).toBe(true);
    expect(ticked('Bob')).toBe(false);

    view.unmount();
    expect(floating).toBeNull();
    expect(made[1]!.srcObject).toBeNull();
  });

  it('unticks the person when the window is closed from the window itself', async () => {
    render(<CallStage {...props} />);
    await popOutPerson('Bob');
    act(() => {
      floating = null;
      made[0]!.dispatchEvent(new Event('leavepictureinpicture'));
    });
    expect(ticked('Bob')).toBe(false);
    expect(made[0]!.srcObject).toBeNull();
    expect(exit).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('is not offered on a phone, where the browser has no such window, or for a person whose picture has not arrived', () => {
    const userAgent = navigator.userAgent;
    try {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)',
        configurable: true,
      });
      render(<CallStage {...props} />);
      toggleMenu();
      expect(screen.queryAllByRole('menuitemcheckbox')).toEqual([]);
    } finally {
      Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true });
    }
    cleanup();

    Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: false });
    render(<CallStage {...props} />);
    toggleMenu();
    expect(screen.queryAllByRole('menuitemcheckbox')).toEqual([]);
    cleanup();

    Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: true });
    render(
      <CallStage {...props} remotePeers={[...props.remotePeers, { peerId: 'p-eve', name: 'Eve', stream: null }]} />
    );
    toggleMenu();
    expect(screen.getAllByRole('menuitemcheckbox').map((i) => i.textContent)).toEqual([
      'Pop out Bob',
      'Pop out Carol',
    ]);
  });

  it('is not offered in a browser that has no floating window at all', () => {
    // Such a browser has no such property: it is not there to read false.
    delete (document as { pictureInPictureEnabled?: unknown }).pictureInPictureEnabled;
    render(<CallStage {...props} />);
    toggleMenu();
    expect(screen.queryAllByRole('menuitemcheckbox')).toEqual([]);
  });

  it('says so when the browser refuses the window, and forgets that on the next try', async () => {
    request.mockImplementationOnce(() => Promise.reject(new Error('refused')));
    render(<CallStage {...props} />);
    await popOutPerson('Bob');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not open the pop-out window. Try again once you can see them.'
    );
    expect(ticked('Bob')).toBe(false);
    expect(made[0]!.srcObject).toBeNull();

    await popOutPerson('Bob');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(ticked('Bob')).toBe(true);
  });

  it('asks the browser for the window once, on the first frame', async () => {
    render(<CallStage {...props} />);
    await popOutPerson('Bob');
    // A second first-frame event with no click behind it would be refused and reported.
    await act(async () => {
      made[0]!.dispatchEvent(new Event('loadedmetadata'));
      await Promise.resolve();
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('draws the tick only on the person popped out', async () => {
    render(<CallStage {...props} />);
    await popOutPerson('Bob');
    toggleMenu();
    expect(item('Bob').querySelector('svg')).not.toBeNull();
    expect(item('Carol').querySelector('svg')).toBeNull();
  });

  it('names a person who gave no display name Guest', () => {
    render(<CallStage {...props} remotePeers={[{ peerId: 'p-gus', name: null, stream: streamOf('stream-gus') }]} />);
    toggleMenu();
    expect(screen.getAllByRole('menuitemcheckbox').map((i) => i.textContent)).toEqual(['Pop out Guest']);
  });

  it('lists the items after Stop incoming video and before the cameras', () => {
    render(<CallStage {...props} onSetIncomingVideoOff={vi.fn()} />);
    toggleMenu();
    expect(Array.from(screen.getByRole('menu').children).slice(0, 4).map((c) => c.textContent)).toEqual([
      'Stop incoming video',
      'Pop out Bob',
      'Pop out Carol',
      'Camera',
    ]);
  });
});

describe('CallStage: a popped-out window without its picture', () => {
  it('closes when that person’s connection is rebuilt or they leave, and is not opened again by itself', async () => {
    const view = render(<CallStage {...props} />);
    await popOutPerson('Bob');
    // A rebuilt connection hands the page a new stream under the same peerId.
    const bobAgain = streamOf('stream-bob-again');
    const rebuilt = props.remotePeers.map((p) => (p.peerId === 'p-bob' ? { ...p, stream: bobAgain } : p));
    view.rerender(<CallStage {...props} remoteStream={bobAgain} remotePeers={rebuilt} />);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(floating).toBeNull();
    expect(made).toHaveLength(1);
    expect(ticked('Bob')).toBe(false);

    await popOutPerson('Carol');
    view.rerender(
      <CallStage {...props} remoteStream={bobAgain} remotePeers={rebuilt.filter((p) => p.peerId !== 'p-carol')} />
    );
    expect(exit).toHaveBeenCalledTimes(2);
    expect(floating).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('closes, and the items go, while incoming video is stopped', async () => {
    const view = render(<CallStage {...props} onSetIncomingVideoOff={vi.fn()} />);
    await popOutPerson('Bob');
    view.rerender(<CallStage {...props} incomingVideoOff onSetIncomingVideoOff={vi.fn()} />);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(floating).toBeNull();
    toggleMenu();
    expect(screen.getAllByRole('menuitemcheckbox').map((i) => i.textContent)).toEqual(['Stop incoming video']);
    toggleMenu();

    view.rerender(<CallStage {...props} onSetIncomingVideoOff={vi.fn()} />);
    expect(ticked('Bob')).toBe(false);
  });

  it('says so and unticks the person when no picture comes within three seconds', () => {
    vi.useFakeTimers();
    try {
      render(<CallStage {...props} />);
      toggleMenu();
      fireEvent.click(item('Bob'));
      act(() => {
        vi.advanceTimersByTime(2999);
      });
      expect(screen.queryByRole('alert')).toBeNull();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Could not open the pop-out window. Try again once you can see them.'
      );
      expect(made[0]!.srcObject).toBeNull();
      expect(request).not.toHaveBeenCalled();
      expect(ticked('Bob')).toBe(false);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('stays open on the same element while other people leave, join and present', async () => {
    const view = render(<CallStage {...props} />);
    await popOutPerson('Bob');
    // Carol leaves: one stream fewer, and every entry is a new object around the same stream.
    const withoutCarol = props.remotePeers.filter((p) => p.peerId !== 'p-carol').map((p) => ({ ...p }));
    view.rerender(<CallStage {...props} remotePeers={withoutCarol} />);
    // Erin joins: listed before her picture arrives, then with it.
    const erin = streamOf('stream-erin');
    view.rerender(
      <CallStage {...props} remotePeers={[...withoutCarol, { peerId: 'p-erin', name: 'Erin', stream: null }]} />
    );
    view.rerender(
      <CallStage {...props} remotePeers={[...withoutCarol, { peerId: 'p-erin', name: 'Erin', stream: erin }]} />
    );
    // Someone presents a screen and stops: the layout changes twice.
    view.rerender(<CallStage {...props} remoteScreenStream={streamOf('stream-screen')} />);
    view.rerender(<CallStage {...props} />);
    expect(made).toHaveLength(1);
    expect(floating).toBe(made[0]);
    expect(made[0]!.srcObject).toBe(bob);
    expect(exit).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    expect(ticked('Bob')).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('popOut', () => {
  it('stops waiting once a picture has come', async () => {
    vi.useFakeTimers();
    try {
      const onEnd = vi.fn();
      const close = popOut(bob, onEnd);
      made[0]!.dispatchEvent(new Event('loadedmetadata'));
      await Promise.resolve();
      await Promise.resolve();
      expect(floating).toBe(made[0]);
      vi.advanceTimersByTime(60_000);
      expect(onEnd).not.toHaveBeenCalled();
      expect(floating).toBe(made[0]);
      close();
      expect(floating).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves no timer behind when it is closed before a picture came', () => {
    vi.useFakeTimers();
    try {
      const close = popOut(bob, vi.fn());
      expect(vi.getTimerCount()).toBe(1);
      close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands back a window the browser grants after it was closed, and reports no end', async () => {
    let grant!: () => void;
    request.mockImplementationOnce(function (this: HTMLVideoElement) {
      return new Promise((resolve) => {
        grant = () => {
          floating = this;
          resolve({});
        };
      });
    });
    const onEnd = vi.fn();
    const close = popOut(bob, onEnd);
    made[0]!.dispatchEvent(new Event('loadedmetadata'));
    close();
    expect(exit).not.toHaveBeenCalled();
    grant();
    await Promise.resolve();
    await Promise.resolve();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(floating).toBeNull();
    expect(onEnd).not.toHaveBeenCalled();
  });
});
