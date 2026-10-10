import { describe, it, expect, vi, afterEach } from 'vitest';
import { SwitchableMedia } from '@/lib/switchable-media';

/** A microphone track: `asked` is what it was opened with, `reported` what it delivers. */
function mic(id: string, asked?: boolean, reported?: boolean): MediaStreamTrack {
  return {
    kind: 'audio',
    id,
    enabled: true,
    stop: vi.fn(),
    getSettings: () => ({ deviceId: id, ...(reported === undefined ? {} : { echoCancellation: reported }) }),
    getConstraints: () => (asked === undefined ? {} : { echoCancellation: asked }),
  } as unknown as MediaStreamTrack;
}

function streamOf(track: MediaStreamTrack): MediaStream {
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
    getVideoTracks: () => [],
  } as unknown as MediaStream;
}

/** What the stable path needs; without these SwitchableMedia keeps the raw tracks. */
function installStableGlobals() {
  const destTrack = { kind: 'audio', id: 'stable-audio', enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack;
  const destination = { stream: new MediaStream([destTrack]), channelCount: 0, channelCountMode: '' };
  vi.stubGlobal(
    'AudioContext',
    vi.fn().mockImplementation(() => ({
      state: 'running',
      createMediaStreamDestination: () => destination,
      createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
      close: vi.fn().mockResolvedValue(undefined),
    }))
  );
  vi.stubGlobal(
    'MediaStreamTrackGenerator',
    vi.fn().mockImplementation(() => ({
      kind: 'video',
      id: 'stable-video',
      enabled: true,
      stop: vi.fn(),
      writable: {
        getWriter: () => ({
          write: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
        }),
      },
    }))
  );
  vi.stubGlobal(
    'MediaStreamTrackProcessor',
    vi.fn().mockImplementation(() => ({
      readable: {
        getReader: () => ({
          read: vi.fn().mockResolvedValue({ done: true }),
          cancel: vi.fn().mockResolvedValue(undefined),
        }),
      },
    }))
  );
}

/** Switches the microphone and returns what the new one was asked for. */
async function switchedTo(lobbyMic: MediaStreamTrack, stable: boolean): Promise<MediaTrackConstraints> {
  if (stable) installStableGlobals();
  const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => streamOf(mic('mic-2')));
  vi.stubGlobal('navigator', { userAgent: 'test-desktop', mediaDevices: { getUserMedia } });
  const media = new SwitchableMedia(streamOf(lobbyMic));
  expect(media.isFallback).toBe(!stable);
  await media.switchMic('mic-2');
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  return getUserMedia.mock.calls[0]![0].audio as MediaTrackConstraints;
}

describe('SwitchableMedia: echo cancellation follows the lobby microphone', () => {
  afterEach(() => vi.unstubAllGlobals());

  for (const stable of [true, false]) {
    const path = stable ? 'stable stream' : 'raw tracks';

    it(`asks a switched-to microphone for it when the lobby microphone was asked (${path})`, async () => {
      expect(await switchedTo(mic('mic-1', true), stable)).toMatchObject({
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
        deviceId: { exact: 'mic-2' },
      });
    });

    // Asked for comes before delivered: a device that cancels echo by itself
    // must not turn the browser's on for the next one.
    it(`keeps it off when the lobby microphone was asked without it (${path})`, async () => {
      expect(await switchedTo(mic('mic-1', false, true), stable)).toMatchObject({ echoCancellation: false });
    });
  }

  it('goes by what the lobby microphone reports when the browser gives no constraints back', async () => {
    expect(await switchedTo(mic('mic-1', undefined, true), true)).toMatchObject({ echoCancellation: true });
    vi.unstubAllGlobals();
    expect(await switchedTo(mic('mic-1'), true)).toMatchObject({ echoCancellation: false });
  });
});
