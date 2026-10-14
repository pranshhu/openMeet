import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';
import { SignalClient } from '@/lib/signal';

const mic = { id: 'mic', kind: 'audio', enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack;
const cam = { id: 'cam', kind: 'video', enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack;

// jsdom has no MediaStream; this is an event target that holds tracks, as a real stream is.
class FakeStream extends EventTarget {
  constructor(private tracks: MediaStreamTrack[] = []) {
    super();
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
}

vi.mock('@/lib/api', () => ({
  getTurnCred: vi.fn().mockResolvedValue({ urls: [], username: 'stub', credential: 'stub', ttl: 0 }),
  getRoom: vi.fn().mockResolvedValue({ slug: 'test-room', expires_at: Date.now() + 10000 }),
  patchRecording: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/host-token', () => ({
  getHostToken: vi.fn().mockReturnValue(null),
}));

vi.mock('@/lib/signal', () => ({
  SignalClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    close: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
  })),
}));

async function joinWith(
  tracks: MediaStreamTrack[],
  asProducer = false,
  asCompanion = false
): Promise<Record<string, unknown>> {
  const hook = renderHook(() => useRoom('abc-defg-hij'));
  await act(async () => {
    await hook.result.current.join(
      new FakeStream(tracks) as unknown as MediaStream,
      'Me',
      asProducer,
      asCompanion
    );
  });
  const calls = vi.mocked(SignalClient).mock.calls;
  return calls[calls.length - 1]![0] as unknown as Record<string, unknown>;
}

describe('joining the room with the microphone only', () => {
  beforeEach(() => {
    vi.stubGlobal('MediaStream', FakeStream);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('claims audioOnly when the stream the lobby handed over has no video track', async () => {
    expect((await joinWith([mic])).audioOnly).toBe(true);
  });

  it('does not claim audioOnly when the stream has a video track', async () => {
    expect(await joinWith([mic, cam])).not.toHaveProperty('audioOnly');
  });

  it('does not claim audioOnly as a producer', async () => {
    expect(await joinWith([], true)).not.toHaveProperty('audioOnly');
  });

  it('does not claim audioOnly as a companion', async () => {
    expect(await joinWith([], false, true)).not.toHaveProperty('audioOnly');
  });
});
