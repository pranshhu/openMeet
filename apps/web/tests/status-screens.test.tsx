import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { RoomView } from '@/components/RoomView';
import Landing from '@/app/page';
import NotFound from '@/app/not-found';
import RoomPage from '@/app/r/[slug]/page';

/**
 * Every terminal screen says what happened, offers the next step, and lets go
 * of the camera and mic. Driven through the real RoomView + useRoom + media
 * manager; only the network (signal, peer, REST) and the lobby's device
 * picker are faked.
 */

let handlers: Record<string, ((m: unknown) => void)[]> = {};
let signalOpts: { onFatalClose: (code: number) => void } | null = null;
const signalClose = vi.fn();
let joinStream: MediaStream;

vi.mock('@/lib/api', () => ({
  createRoom: vi.fn(),
  getRoom: vi.fn(),
  getTurnCred: vi.fn(),
  patchRecording: vi.fn().mockResolvedValue({}),
  getSponsors: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/host-token', () => ({
  getHostToken: vi.fn().mockReturnValue(null),
  storeHostToken: vi.fn(),
}));

vi.mock('@/lib/signal', () => ({
  SignalClient: vi.fn().mockImplementation((opts) => {
    signalOpts = opts;
    return {
      connect: vi.fn(),
      close: signalClose,
      send: vi.fn(),
      on: vi.fn((type: string, h: (m: unknown) => void) => {
        (handlers[type] ??= []).push(h);
      }),
    };
  }),
}));

vi.mock('@/lib/peer', () => ({
  PeerConnection: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    close: vi.fn(),
    setLocalStream: vi.fn(),
    setLocalStreamAfterFirstOffer: vi.fn(),
    createControlChannel: vi.fn(),
    addTransceiver: vi.fn(),
    restartIce: vi.fn(),
    connectionState: 'new',
    rawConnection: null,
    setPeerCount: vi.fn(),
    whenConnected: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@/components/Lobby', () => ({
  Lobby: ({ onJoin }: { onJoin: (s: MediaStream, name: string) => void }) => (
    <button onClick={() => onJoin(joinStream, 'Ana')}>Join now</button>
  ),
}));

function emit(type: string, m: unknown) {
  act(() => {
    for (const h of handlers[type] ?? []) h(m);
  });
}

function fakeTracks() {
  const audio = { kind: 'audio', enabled: true, stop: vi.fn() };
  const video = { kind: 'video', enabled: true, stop: vi.fn() };
  joinStream = Object.assign(new EventTarget(), {
    id: 'local',
    getTracks: () => [audio, video],
    getAudioTracks: () => [audio],
    getVideoTracks: () => [video],
  }) as unknown as MediaStream;
  return [audio, video];
}

async function joinRoom() {
  render(<RoomView slug="abc-defg-hij" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Join now' }));
  await waitFor(() => expect(handlers['role-assigned']).toBeDefined());
}

function roleAssigned(peers: unknown[] = []) {
  emit('role-assigned', {
    type: 'role-assigned',
    role: 'host',
    peerId: 'p-me',
    ordinal: 2,
    peers,
    recording: false,
  });
}

beforeEach(async () => {
  handlers = {};
  signalOpts = null;
  signalClose.mockClear();
  const api = await import('@/lib/api');
  vi.mocked(api.getRoom).mockResolvedValue({ slug: 'abc-defg-hij', expires_at: Date.now() + 60_000 } as never);
  vi.mocked(api.getTurnCred).mockResolvedValue({
    urls: ['stun:stun.example.com'],
    username: 'stub',
    credential: 'stub',
    ttl: 0,
  });
});

afterEach(() => cleanup());

describe('terminal status screens', () => {
  it('room full (4001): says so, offers Try again, releases camera and mic', async () => {
    const tracks = fakeTracks();
    await joinRoom();
    act(() => signalOpts!.onFatalClose(4001));

    expect(screen.getByRole('heading', { name: 'This room is full' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Up to 4 people on camera, plus 2 producers or present‑only screens. Try again once someone leaves.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    for (const t of tracks) expect(t.stop).toHaveBeenCalled();
  });

  it('replaced by another tab (4006): says so, offers Use this tab instead, releases camera and mic', async () => {
    const tracks = fakeTracks();
    await joinRoom();
    roleAssigned();
    act(() => signalOpts!.onFatalClose(4006));

    expect(
      screen.getByRole('heading', { name: 'You joined from another tab or device' })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use this tab instead' })).toBeInTheDocument();
    expect(
      screen.getByText(/^The call continues in the other tab or device\. Using this tab instead disconnects that one/)
    ).toBeInTheDocument();
    for (const t of tracks) expect(t.stop).toHaveBeenCalled();
  });

  it('invalid or expired (4002/4003): not-found copy with a Go to openMeet link, releases camera and mic', async () => {
    const tracks = fakeTracks();
    await joinRoom();
    act(() => signalOpts!.onFatalClose(4003));

    expect(screen.getByRole('heading', { name: 'Room not found or expired' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to openMeet' })).toHaveAttribute('href', '/');
    for (const t of tracks) expect(t.stop).toHaveBeenCalled();
  });

  it('room not found at lookup: heading and Go to openMeet link', async () => {
    const api = await import('@/lib/api');
    vi.mocked(api.getRoom).mockResolvedValue(null as never);
    render(<RoomView slug="abc-defg-hij" />);

    expect(await screen.findByRole('heading', { name: 'Room not found or expired' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to openMeet' })).toHaveAttribute('href', '/');
  });

  it('lookup failed: heading with a Try again action', async () => {
    const api = await import('@/lib/api');
    vi.mocked(api.getRoom).mockRejectedValue(new Error('offline'));
    render(<RoomView slug="abc-defg-hij" />);

    expect(await screen.findByRole('heading', { name: 'Can’t reach openMeet' })).toBeInTheDocument();
    expect(screen.getByText(/couldn’t reach the openMeet server/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('peer left: stays in the room with the camera on screen, offers Leave, resumes if they return', async () => {
    const tracks = fakeTracks();
    await joinRoom();
    roleAssigned([{ peerId: 'p-bo', ordinal: 1, role: 'guest', displayName: 'Bo' }]);
    emit('peer-left', { type: 'peer-left', role: 'guest', reason: 'disconnect', peerId: 'p-bo' });

    expect(screen.getByRole('heading', { name: 'Everyone else left' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave' })).toBeInTheDocument();
    for (const t of tracks) expect(t.stop).not.toHaveBeenCalled();
    expect(signalClose).not.toHaveBeenCalled();

    emit('peer-joined', { type: 'peer-joined', peerId: 'p-bo2', ordinal: 3, role: 'guest', displayName: 'Bo' });
    expect(screen.queryByText('Everyone else left')).not.toBeInTheDocument();
  });

  // A warning from the connection that just ended is not about the next one.
  it('forgets a connection warning once everyone has left', async () => {
    fakeTracks();
    await joinRoom();
    roleAssigned([{ peerId: 'p-bo', ordinal: 1, role: 'guest', displayName: 'Bo' }]);
    const { PeerConnection } = await import('@/lib/peer');
    const opts = vi.mocked(PeerConnection).mock.calls.at(-1)![0] as unknown as {
      onConnectionStateChange: (cs: string) => void;
    };
    act(() => opts.onConnectionStateChange('disconnected'));
    expect(screen.getByRole('heading', { name: 'Having trouble connecting' })).toBeInTheDocument();

    emit('peer-left', { type: 'peer-left', role: 'guest', reason: 'disconnect', peerId: 'p-bo' });
    emit('peer-joined', { type: 'peer-joined', peerId: 'p-bo2', ordinal: 3, role: 'guest', displayName: 'Bo' });
    expect(screen.getByRole('heading', { name: 'Connecting…' })).toBeInTheDocument();
  });

  it('connecting to someone already there: the dark room with a heading and Leave, camera kept', async () => {
    const tracks = fakeTracks();
    await joinRoom();
    roleAssigned([{ peerId: 'p-bo', ordinal: 1, role: 'guest', displayName: 'Bo' }]);

    expect(screen.getByRole('heading', { name: 'Connecting…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave' })).toBeInTheDocument();
    for (const t of tracks) expect(t.stop).not.toHaveBeenCalled();
  });

  it('left: offers Rejoin and a way home', async () => {
    fakeTracks();
    await joinRoom();
    roleAssigned();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    });

    expect(await screen.findByRole('heading', { name: 'You left the call' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rejoin' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/');
    expect(screen.getByText(/You can close this tab/)).toBeInTheDocument();
  });
});

describe('unknown addresses', () => {
  it('the 404 page says so and links home', () => {
    render(<NotFound />);
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to openMeet' })).toHaveAttribute('href', '/');
  });

  it('a room address with no slug shows the 404 page instead of a blank one', async () => {
    window.history.pushState({}, '', '/r/');
    render(<RoomPage />);
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});

describe('a host tab taking over an empty room', () => {
  // The DO closes the replaced host socket and announces it; that announcement
  // can reach the new tab before or after its own role-assigned.
  it.each([
    ['before role-assigned', true],
    ['after role-assigned', false],
  ])('ignores the peer-left for the replaced host (%s) and waits as host', async (_, before) => {
    const tracks = fakeTracks();
    await joinRoom();
    const replaced = { type: 'peer-left', role: 'host', reason: 'disconnect', peerId: 'p-old-tab' };
    if (before) emit('peer-left', replaced);
    roleAssigned();
    if (!before) emit('peer-left', replaced);

    expect(screen.queryByText('Everyone else left')).not.toBeInTheDocument();
    expect(screen.getByText('Waiting for others to join')).toBeInTheDocument();
    for (const t of tracks) expect(t.stop).not.toHaveBeenCalled();
  });
});

describe('branding', () => {
  it('the landing page uses the same Logo as the room screens', async () => {
    const { container } = render(<Landing />);
    expect(container.querySelector('header img')).toBeNull();
    expect(container.querySelector('header')?.textContent).toBe('openMeet');
  });
});
