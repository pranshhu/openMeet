import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { RoomView } from '@/components/RoomView';

/**
 * A room link with `?view=` shows one person's camera and sound on a black
 * page. The hook is replaced by a fixed state, as room-view-screens does.
 */

let state: Record<string, unknown>;
let hook: Record<string, unknown>;

vi.mock('@/hooks/useRoom', () => ({
  useRoom: () => ({ state, join: vi.fn(), leave: vi.fn(), setMic: vi.fn(), setCam: vi.fn(), ...hook }),
}));

const anaStream = new EventTarget() as unknown as MediaStream;
const ana = { peerId: 'p-ana', name: 'Ana', stream: anaStream, role: 'guest' };
const camOn = { micOn: true, camOn: true, screenSharing: false };

const open = (search: string) => window.history.replaceState({}, '', `/r/abc-defg-hij/${search}`);

const spyOnPlay = () => vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
let play: ReturnType<typeof spyOnPlay>;

beforeEach(() => {
  hook = {};
  state = { phase: 'in-call', role: 'producer', door: null, localStream: null, localName: 'View of Ana', remotePeers: [ana] };
  play = spyOnPlay();
  open('?view=guest&name=Ana');
});

afterEach(() => {
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
});

const refusal = () => new DOMException('no gesture', 'NotAllowedError');

describe('joining', () => {
  it('joins once, under the view’s name as a producer with no media, with no lobby', () => {
    state.phase = 'lobby';
    const join = vi.fn();
    hook.join = join;
    render(
      <StrictMode>
        <RoomView slug="abc-defg-hij" />
      </StrictMode>
    );

    expect(join).toHaveBeenCalledTimes(1);
    const [stream, name, producer] = join.mock.calls[0]!;
    expect((stream as MediaStream).getTracks()).toEqual([]);
    expect([name, producer]).toEqual(['View of Ana', true]);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.queryByRole('button', { name: /join/i })).toBeNull();
  });

  it('shows no lobby for a producer link, a check link or a Present-only link that is also a view link', () => {
    state.phase = 'lobby';
    hook.join = vi.fn();
    for (const flags of ['producer=1', 'check=1', 'present=1', 'audio=1']) {
      open(`?${flags}&view=host`);
      const { unmount } = render(<RoomView slug="abc-defg-hij" />);
      expect(screen.queryByRole('heading')).toBeNull();
      expect(hook.join).toHaveBeenLastCalledWith(expect.anything(), 'View of the host', true);
      unmount();
    }
  });

  it('joins nothing for a link that is not complete, and says so', () => {
    state.phase = 'lobby';
    const join = vi.fn();
    hook.join = join;
    for (const search of ['?view=nope', '?view=guest', '?view=stage']) {
      open(search);
      const { unmount } = render(<RoomView slug="abc-defg-hij" />);
      expect(screen.getByText('This view link is incomplete. Ask the host to copy it again.')).toBeInTheDocument();
      unmount();
    }
    expect(join).not.toHaveBeenCalled();
  });

  it('does not join in a later phase', () => {
    state.phase = 'connecting';
    const join = vi.fn();
    hook.join = join;
    render(<RoomView slug="abc-defg-hij" />);
    expect(join).not.toHaveBeenCalled();
  });

  it('leaves a link with no view to the lobby', () => {
    open('');
    state.phase = 'lobby';
    hook.join = vi.fn();
    vi.stubGlobal('navigator', { userAgent: 'test', mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(anaStream), enumerateDevices: vi.fn().mockResolvedValue([]) } });
    try {
      const { unmount } = render(<RoomView slug="abc-defg-hij" />);
      expect(screen.getByPlaceholderText(/your name/i)).toBeInTheDocument();
      expect(hook.join).not.toHaveBeenCalled();
      unmount();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the picture', () => {
  it('is the person’s stream in one video, with no name on the page', () => {
    const { container } = render(<RoomView slug="abc-defg-hij" />);

    const videos = container.querySelectorAll('video');
    expect(videos).toHaveLength(1);
    expect(videos[0]!.srcObject).toBe(anaStream);
    expect(videos[0]!.muted).toBe(false);
    expect(videos[0]!.hasAttribute('playsinline')).toBe(true);
    expect(videos[0]!.className).toMatch(/object-contain/);
    expect(document.body.textContent).not.toMatch(/Ana/);
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.firstElementChild!.className).toMatch(/fixed inset-0/);
    expect(container.firstElementChild!.className).toMatch(/bg-black/);
  });

  it('shows the initial when their camera is off, and the sound stays on the element', () => {
    state.remotePeers = [{ ...ana, presence: { ...camOn, camOn: false } }];
    const { container } = render(<RoomView slug="abc-defg-hij" />);

    expect(screen.getByText('A')).toBeInTheDocument();
    const video = container.querySelector('video')!;
    expect(video.srcObject).toBe(anaStream);
    expect(video.className).toMatch(/opacity-0/);
  });

  it('shows an initial for a host who gave no name', () => {
    open('?view=host');
    state.remotePeers = [{ peerId: 'p-host', name: null, stream: anaStream, role: 'host', presence: { ...camOn, camOn: false } }];
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.getByText('H')).toBeInTheDocument();
  });

  it('shows the initial for a microphone-only seat', () => {
    state.remotePeers = [{ ...ana, audioOnly: true, presence: camOn }];
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('shows no initial while the camera is on', () => {
    state.remotePeers = [{ ...ana, presence: camOn }];
    const { container } = render(<RoomView slug="abc-defg-hij" />);
    expect(screen.queryByText('A')).toBeNull();
    expect(container.querySelector('video')!.className).toMatch(/opacity-100/);
  });

  it('shows the host for view=host, and a guest of the same name is not the host', () => {
    open('?view=host');
    const hostStream = new EventTarget() as unknown as MediaStream;
    state.remotePeers = [ana, { peerId: 'p-host', name: 'Ana', stream: hostStream, role: 'host' }];
    const { container } = render(<RoomView slug="abc-defg-hij" />);
    expect(container.querySelector('video')!.srcObject).toBe(hostStream);
  });

  it('follows the person when they reconnect under a new peer id, and waits while they are away', () => {
    const { container, rerender } = render(<RoomView slug="abc-defg-hij" />);
    const second = new EventTarget() as unknown as MediaStream;

    state = { ...state, remotePeers: [] };
    rerender(<RoomView slug="abc-defg-hij" />);
    expect(container.querySelector('video')).toBeNull();
    expect(container).toHaveTextContent('Waiting for Ana to join');

    state = { ...state, remotePeers: [{ ...ana, peerId: 'p-ana-2', stream: second }] };
    rerender(<RoomView slug="abc-defg-hij" />);
    expect(container.querySelector('video')!.srcObject).toBe(second);
  });

  it('gives the element the stream again when a track is taken out before its first frame', () => {
    const { container } = render(<RoomView slug="abc-defg-hij" />);
    const video = container.querySelector('video')!;
    video.srcObject = null;
    anaStream.dispatchEvent(new Event('removetrack'));
    expect(video.srcObject).toBe(anaStream);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('leaves an element that already plays alone when a track is taken out', () => {
    const { container } = render(<RoomView slug="abc-defg-hij" />);
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'readyState', { value: 4 });
    video.srcObject = null;
    anaStream.dispatchEvent(new Event('removetrack'));
    expect(video.srcObject).toBeNull();
    expect(play).toHaveBeenCalledTimes(1);
  });
});

describe('the lines', () => {
  it('waits for the host, or for the guest by name', () => {
    state.remotePeers = [];
    const { container, unmount } = render(<RoomView slug="abc-defg-hij" />);
    expect(container).toHaveTextContent('Waiting for Ana to join');
    expect(container.querySelector('bdi')).toHaveTextContent('Ana');
    expect(container.querySelector('video')).toBeNull();
    unmount();

    open('?view=host');
    const second = render(<RoomView slug="abc-defg-hij" />);
    expect(second.container).toHaveTextContent('Waiting for the host to join');
  });

  it('is one centred, truncating line on black', () => {
    state.remotePeers = [];
    const { container } = render(<RoomView slug="abc-defg-hij" />);
    const line = container.querySelector('p')!;
    expect(line.className).toMatch(/text-sm/);
    expect(line.className).toMatch(/text-white\/70/);
    expect(line.className).toMatch(/truncate/);
    expect(line.className).toMatch(/text-center/);
    expect(container.firstElementChild!.className).toMatch(/fixed inset-0/);
    expect(container.firstElementChild!.className).toMatch(/bg-black/);
  });

  it('says it is waiting to be let in while the door is waiting, and not the picture', () => {
    state.door = 'waiting';
    const { container } = render(<RoomView slug="abc-defg-hij" />);
    expect(container).toHaveTextContent('Waiting for the host to let this view in');
    expect(container.querySelector('video')).toBeNull();
  });

  it('asks for the passcode and sends it', () => {
    state.door = 'passcode';
    const sendPasscode = vi.fn();
    hook.sendPasscode = sendPasscode;
    render(<RoomView slug="abc-defg-hij" />);

    expect(screen.getByText('This room needs a passcode')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Passcode'), { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(sendPasscode).toHaveBeenCalledWith('hunter2');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says a passcode was wrong', () => {
    state.door = 'wrong-passcode';
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.getByRole('alert')).toHaveTextContent('That passcode isn’t right.');
  });

  it('draws a name as text, never as markup', () => {
    open('?view=guest&name=%3Cb%3EAna%3C%2Fb%3E');
    state.remotePeers = [];
    const { container } = render(<RoomView slug="abc-defg-hij" />);
    expect(container.querySelector('b')).toBeNull();
    expect(container).toHaveTextContent('Waiting for <b>Ana</b> to join');
  });
});

describe('the other screens', () => {
  it.each([
    ['full', 'This room is full'],
    ['not-found', 'Room not found or expired'],
    ['left', 'You left the call'],
    ['removed', 'The host removed you from this call'],
    ['refused', 'The host didn’t let you in'],
    ['replaced', 'You joined from another tab or device'],
    ['error', 'Can’t reach openMeet'],
  ])('keeps the %s screen', (phase, title) => {
    Object.assign(state, { phase, role: 'producer', refusal: 'refused', takes: [], error: 'x' });
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
  });

  it('names view links among what the full room seats beyond its people', () => {
    state.phase = 'full';
    render(<RoomView slug="abc-defg-hij" />);
    expect(
      screen.getByText(/plus 2 producers, view links or present‑only screens\. Try again once someone leaves\./)
    ).toBeInTheDocument();
  });

  it('draws the black page while the room is still being checked', () => {
    Object.assign(state, { phase: 'checking', remotePeers: [] });
    const { container } = render(<RoomView slug="abc-defg-hij" />);
    expect(container).toHaveTextContent('Waiting for Ana to join');
    expect(screen.queryByText('Checking room…')).toBeNull();
  });
});

describe('the sound', () => {
  it('plays when it is given the stream', () => {
    render(<RoomView slug="abc-defg-hij" />);
    expect(play).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Turn on sound' })).toBeNull();
  });

  it('plays through the speaker the person chose', async () => {
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', { value: setSinkId, configurable: true });
    const { setSpeaker } = await import('@/lib/speaker');
    setSpeaker('speaker-2');
    try {
      render(<RoomView slug="abc-defg-hij" />);
      expect(setSinkId).toHaveBeenCalledWith('speaker-2');
    } finally {
      setSpeaker('');
      Reflect.deleteProperty(HTMLMediaElement.prototype, 'setSinkId');
    }
  });

  it('is turned on by a button when the browser refuses it, and the picture keeps running', async () => {
    play.mockRejectedValueOnce(refusal());
    const { container } = render(<RoomView slug="abc-defg-hij" />);
    const video = container.querySelector('video')!;

    const button = await screen.findByRole('button', { name: 'Turn on sound' });
    expect(video.muted).toBe(true);
    expect(play).toHaveBeenCalledTimes(2);
    expect(button.className).toMatch(/min-h-11/);
    expect(button.className).toMatch(/bottom-4/);
    expect(button.className).toMatch(/left-1\/2/);

    await act(async () => {
      fireEvent.click(button);
    });
    expect(video.muted).toBe(false);
    expect(play).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('button', { name: 'Turn on sound' })).toBeNull();
  });

  it('ignores any other refusal', async () => {
    play.mockRejectedValue(new DOMException('gone', 'AbortError'));
    const { container } = render(<RoomView slug="abc-defg-hij" />);
    await waitFor(() => expect(play).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('video')!.muted).toBe(false);
  });
});
