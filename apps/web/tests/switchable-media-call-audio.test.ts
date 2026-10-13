import { describe, it, expect, vi, afterEach } from 'vitest';
import { SwitchableMedia, type SwitchableMediaOptions } from '@/lib/switchable-media';

interface RawSettings {
  deviceId: string;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
}

/** The microphone the lobby opened. `settings` can be changed to make the browser move it. */
function rawMic(settings: Partial<RawSettings> = {}) {
  const current: RawSettings = {
    deviceId: 'mic-1',
    noiseSuppression: false,
    echoCancellation: true,
    autoGainControl: false,
    ...settings,
  };
  const track = {
    kind: 'audio',
    id: 'raw-mic',
    enabled: true,
    stop: vi.fn(),
    getSettings: () => ({ ...current }),
    getConstraints: () => ({ echoCancellation: true }),
  } as unknown as MediaStreamTrack;
  return { track, current };
}

/** A track as the browser hands it out: an event target. */
function audioTrack(id: string, noiseSuppression = true, deviceId = 'mic-1') {
  return Object.assign(new EventTarget(), {
    kind: 'audio',
    id,
    enabled: true,
    stop: vi.fn(),
    getSettings: () => ({ deviceId, noiseSuppression }),
  }) as unknown as MediaStreamTrack;
}

function streamOf(...tracks: MediaStreamTrack[]): MediaStream {
  return Object.assign(new EventTarget(), {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  }) as unknown as MediaStream;
}

/** The stable path: two destinations with a track each, and a count of the sources made. */
function installGraph() {
  const sources = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
  const stableTrack = { kind: 'audio', id: 'stable-audio', enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack;
  const masterTrack = { kind: 'audio', id: 'master-audio', enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack;
  const tracks = [stableTrack, masterTrack];
  vi.stubGlobal(
    'AudioContext',
    vi.fn().mockImplementation(() => ({
      state: 'running',
      createMediaStreamDestination: () => ({
        stream: new MediaStream([tracks.shift()!]),
        channelCount: 0,
        channelCountMode: '',
      }),
      createMediaStreamSource: sources,
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
      writable: { getWriter: () => ({ write: vi.fn(), close: vi.fn() }) },
    }))
  );
  vi.stubGlobal(
    'MediaStreamTrackProcessor',
    vi.fn().mockImplementation(() => ({
      readable: { getReader: () => ({ read: vi.fn().mockResolvedValue({ done: true }), cancel: vi.fn() }) },
    }))
  );
  return { sources, stableTrack, masterTrack };
}

type GetUserMedia = (constraints: MediaStreamConstraints) => Promise<MediaStream>;

function rig(options: SwitchableMediaOptions = {}, lobby = rawMic(), getUserMedia?: GetUserMedia) {
  const graph = installGraph();
  const cleaned = audioTrack('cleaned');
  const gum = vi.fn<GetUserMedia>(getUserMedia ?? (async () => streamOf(cleaned)));
  vi.stubGlobal('navigator', { userAgent: 'test-desktop', mediaDevices: { getUserMedia: gum } });
  const media = new SwitchableMedia(streamOf(lobby.track), options);
  return { media, gum, cleaned, ...lobby, ...graph };
}

describe('SwitchableMedia: the microphone again with noise suppression, for the call only', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks for the current microphone with noise suppression required and nothing else changed', async () => {
    const { media, gum } = rig();
    await media.openCallAudio();
    expect(gum).toHaveBeenCalledWith({
      video: false,
      audio: {
        channelCount: { ideal: 2 },
        sampleRate: { ideal: 48000 },
        echoCancellation: true,
        noiseSuppression: { exact: true },
        autoGainControl: false,
        deviceId: { exact: 'mic-1' },
      },
    });
  });

  it('hands the new track out through callAudioTrack and puts it in neither stream nor the graph', async () => {
    const { media, cleaned, sources, stableTrack, masterTrack } = rig();
    const sourcesBefore = sources.mock.calls.length;
    expect(media.callAudioTrack).toBeNull();

    expect(await media.openCallAudio()).toBe('on');

    expect(media.callAudioTrack).toBe(cleaned);
    expect(media.stream.getAudioTracks()).toEqual([stableTrack]);
    expect(media.micStream.getAudioTracks()).toEqual([masterTrack]);
    expect(sources.mock.calls.length).toBe(sourcesBefore);
  });

  it('answers unavailable where there is no audio graph and opens nothing', async () => {
    const gum = vi.fn();
    vi.stubGlobal('navigator', { userAgent: 'test-desktop', mediaDevices: { getUserMedia: gum } });
    const media = new SwitchableMedia(streamOf(rawMic().track));
    expect(media.isFallback).toBe(true);
    expect(await media.openCallAudio()).toBe('unavailable');
    expect(gum).not.toHaveBeenCalled();
  });

  it('answers unavailable where there is no microphone and opens nothing', async () => {
    installGraph();
    const gum = vi.fn();
    vi.stubGlobal('navigator', { userAgent: 'test-desktop', mediaDevices: { getUserMedia: gum } });
    const media = new SwitchableMedia(streamOf());
    expect(media.isFallback).toBe(false);
    expect(await media.openCallAudio()).toBe('unavailable');
    expect(gum).not.toHaveBeenCalled();
  });

  it('answers unavailable once the media is stopped', async () => {
    const { media, gum } = rig();
    media.stop();
    expect(await media.openCallAudio()).toBe('unavailable');
    expect(gum).not.toHaveBeenCalled();
  });

  it('answers unavailable and stops the track when the browser did not process it separately', async () => {
    const unprocessed = audioTrack('cleaned', false);
    const { media } = rig({}, rawMic(), async () => streamOf(unprocessed));
    expect(await media.openCallAudio()).toBe('unavailable');
    expect(unprocessed.stop).toHaveBeenCalledTimes(1);
    expect(media.callAudioTrack).toBeNull();
  });

  it('answers unavailable and stops the track when the browser gave the raw track itself', async () => {
    const lobby = rawMic();
    const same = audioTrack('raw-mic');
    const { media } = rig({}, lobby, async () => streamOf(same));
    expect(await media.openCallAudio()).toBe('unavailable');
    expect(same.stop).toHaveBeenCalledTimes(1);
    expect(media.callAudioTrack).toBeNull();
  });

  it('answers unavailable when the browser refuses', async () => {
    const { media } = rig({}, rawMic(), async () => {
      throw new Error('OverconstrainedError');
    });
    expect(await media.openCallAudio()).toBe('unavailable');
    expect(media.callAudioTrack).toBeNull();
  });

  it('answers unavailable when the browser gives a stream with no audio', async () => {
    const { media } = rig({}, rawMic(), async () => streamOf());
    expect(await media.openCallAudio()).toBe('unavailable');
  });

  for (const key of ['noiseSuppression', 'echoCancellation', 'autoGainControl'] as const) {
    it(`answers unavailable when the raw microphone's ${key} moved and came back with the stop`, async () => {
      const lobby = rawMic();
      const track = audioTrack('cleaned');
      const original = lobby.current[key];
      track.stop = vi.fn(() => {
        lobby.current[key] = original;
      });
      const { media } = rig({}, lobby, async () => {
        lobby.current[key] = !original;
        return streamOf(track);
      });
      expect(await media.openCallAudio()).toBe('unavailable');
      expect(track.stop).toHaveBeenCalledTimes(1);
      expect(media.callAudioTrack).toBeNull();
    });

    it(`answers mic-changed when the raw microphone's ${key} moved and stayed`, async () => {
      const lobby = rawMic();
      const track = audioTrack('cleaned');
      const { media } = rig({}, lobby, async () => {
        lobby.current[key] = !lobby.current[key];
        return streamOf(track);
      });
      expect(await media.openCallAudio()).toBe('mic-changed');
      expect(track.stop).toHaveBeenCalledTimes(1);
      expect(media.callAudioTrack).toBeNull();
    });
  }

  it('answers unavailable without asking while a take records', async () => {
    const { media, gum } = rig({ isRecording: () => true });
    expect(await media.openCallAudio()).toBe('unavailable');
    expect(gum).not.toHaveBeenCalled();
  });

  it('answers unavailable and stops the track when a take began during the request', async () => {
    let recording = false;
    const track = audioTrack('cleaned');
    const { media } = rig({ isRecording: () => recording }, rawMic(), async () => {
      recording = true;
      return streamOf(track);
    });
    expect(await media.openCallAudio()).toBe('unavailable');
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(media.callAudioTrack).toBeNull();
  });

  it('answers unavailable and stops the track when the microphone was switched during the request', async () => {
    const track = audioTrack('cleaned');
    let switching: Promise<void> | undefined;
    const { media, gum } = rig({}, rawMic(), undefined);
    gum.mockImplementationOnce(async () => {
      gum.mockImplementationOnce(async () => streamOf(audioTrack('mic-2', false, 'mic-2')));
      switching = media.switchMic('mic-2');
      await switching;
      return streamOf(track);
    });
    expect(await media.openCallAudio()).toBe('unavailable');
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(media.callAudioTrack).toBeNull();
  });

  it('answers unavailable and stops the track when the media was stopped during the request', async () => {
    const track = audioTrack('cleaned');
    const holder: { media?: SwitchableMedia } = {};
    const { media } = rig({}, rawMic(), async () => {
      holder.media?.stop();
      return streamOf(track);
    });
    holder.media = media;
    expect(await media.openCallAudio()).toBe('unavailable');
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('stops the earlier track when it is opened again', async () => {
    const first = audioTrack('first');
    const second = audioTrack('second');
    const queue = [first, second];
    const { media } = rig({}, rawMic(), async () => streamOf(queue.shift()!));
    await media.openCallAudio();
    await media.openCallAudio();
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(media.callAudioTrack).toBe(second);
  });

  it('turns the track off with the microphone and on again', async () => {
    const { media, cleaned, track } = rig();
    await media.openCallAudio();
    media.setAudioEnabled(false);
    expect(cleaned.enabled).toBe(false);
    expect(track.enabled).toBe(false);
    media.setAudioEnabled(true);
    expect(cleaned.enabled).toBe(true);
  });

  it('opens it off when the microphone is off', async () => {
    const { media, cleaned } = rig();
    media.setAudioEnabled(false);
    await media.openCallAudio();
    expect(cleaned.enabled).toBe(false);
  });

  it('stops it and lets go of it when told to, without a word to the page', async () => {
    const onCallAudioEnded = vi.fn();
    const { media, cleaned } = rig({ onCallAudioEnded });
    await media.openCallAudio();
    media.closeCallAudio();
    cleaned.dispatchEvent(new Event('ended'));
    expect(cleaned.stop).toHaveBeenCalledTimes(1);
    expect(media.callAudioTrack).toBeNull();
    expect(onCallAudioEnded).not.toHaveBeenCalled();
    expect(() => media.closeCallAudio()).not.toThrow();
  });

  it('drops it and tells the page once when the device takes it away', async () => {
    const onCallAudioEnded = vi.fn();
    const { media, cleaned } = rig({ onCallAudioEnded });
    await media.openCallAudio();
    cleaned.dispatchEvent(new Event('ended'));
    cleaned.dispatchEvent(new Event('ended'));
    expect(media.callAudioTrack).toBeNull();
    expect(onCallAudioEnded).toHaveBeenCalledTimes(1);
  });

  it('stops it before it asks for the new microphone', async () => {
    const { media, gum, cleaned } = rig();
    await media.openCallAudio();
    gum.mockClear();
    let stoppedWhenAsked: boolean | undefined;
    gum.mockImplementationOnce(async () => {
      stoppedWhenAsked = vi.mocked(cleaned.stop).mock.calls.length === 1;
      return streamOf(audioTrack('mic-2', false, 'mic-2'));
    });
    await media.switchMic('mic-2');
    expect(stoppedWhenAsked).toBe(true);
    expect(media.callAudioTrack).toBeNull();
  });

  it('stops it with the media', async () => {
    const { media, cleaned } = rig();
    await media.openCallAudio();
    media.stop();
    expect(cleaned.stop).toHaveBeenCalledTimes(1);
    expect(media.callAudioTrack).toBeNull();
  });
});
