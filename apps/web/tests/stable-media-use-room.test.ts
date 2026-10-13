import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';
import * as recordingController from '@/hooks/recording-controller';
import { BackupRecorder } from '@/lib/backup-recorder';
import { MediaBoard } from '@/lib/media-board';

let signalHandlers: Record<string, ((m: any) => void)[]> = {};
let mockPeers: any[] = [];

vi.mock('@/lib/api', () => ({
  getTurnCred: vi.fn().mockResolvedValue({ urls: [], username: 'u', credential: 'c', ttl: 100 }),
  getRoom: vi.fn().mockResolvedValue({ slug: 'test-room', expires_at: Date.now() + 10000 }),
  patchRecording: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/host-token', () => ({
  getHostToken: vi.fn().mockReturnValue(null),
}));

vi.mock('@/lib/signal', () => ({
  SignalClient: vi.fn().mockImplementation(() => {
    return {
      connect: vi.fn(),
      close: vi.fn(),
      send: vi.fn(),
      reconnect: vi.fn(),
      on: vi.fn((type: string, handler: (m: any) => void) => {
        (signalHandlers[type] ??= []).push(handler);
      }),
    };
  }),
}));

vi.mock('@/lib/peer', () => ({
  PeerConnection: vi.fn().mockImplementation((opts) => {
    const p = {
      opts,
      start: vi.fn(),
      close: vi.fn(),
      setLocalStream: vi.fn(),
      setLocalStreamAfterFirstOffer: vi.fn(),
      replaceAudioTrack: vi.fn(),
      createControlChannel: vi.fn(),
      addTransceiver: vi.fn(),
      restartIce: vi.fn(),
      connectionState: 'connected',
      whenConnected: vi.fn().mockResolvedValue(undefined),
      setPeerCount: vi.fn(),
      createRecordingChannel: vi.fn().mockReturnValue({
        addEventListener: vi.fn(),
        readyState: 'open',
      }),
      createRecordingAudioChannel: vi.fn().mockReturnValue({
        addEventListener: vi.fn(),
        readyState: 'open',
      }),
    };
    mockPeers.push(p);
    return p;
  }),
  ConnectionTimeoutError: class extends Error {},
}));

vi.mock('@/lib/backup-recorder', () => ({
  BackupRecorder: vi.fn().mockImplementation((opts) => ({
    opts,
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

let mediaOptions: any;
let stopCalls = 0;
vi.mock('@/lib/switchable-media', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/switchable-media')>();
  return {
    ...real,
    SwitchableMedia: class extends real.SwitchableMedia {
      constructor(stream: MediaStream, options: any) {
        super(stream, options);
        mediaOptions = options;
      }
      override stop() {
        stopCalls += 1;
        super.stop();
      }
    },
  };
});

// Join only builds the stable audio graph where the insertable-streams globals
// exist; AudioContext stands in for the graph itself so the destination's
// channel count can be read back.
function installStableMediaGlobals() {
  const destTrack = {
    kind: 'audio',
    id: 'stable-audio',
    enabled: true,
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
  const destination = {
    stream: new MediaStream([destTrack]),
    channelCount: 0,
    channelCountMode: '',
  };
  const ctx = {
    state: 'running',
    createMediaStreamDestination: () => destination,
    createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const audioContext = vi.fn().mockImplementation(() => ctx);
  vi.stubGlobal('AudioContext', audioContext);
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
  return { audioContext, destination, destTrack };
}

function twoChannelLobbyStream() {
  const rawAudio = {
    kind: 'audio',
    id: 'raw-audio-id',
    enabled: true,
    stop: vi.fn(),
    getSettings: () => ({ deviceId: 'mic-1', sampleRate: 44100, channelCount: 2 }),
  } as any;
  const rawVideo = { kind: 'video', id: 'raw-video-id', enabled: true, stop: vi.fn() } as any;
  return {
    getTracks: () => [rawAudio, rawVideo],
    getAudioTracks: () => [rawAudio],
    getVideoTracks: () => [rawVideo],
  } as any;
}

describe('useRoom stable media integration', () => {
  beforeEach(() => {
    signalHandlers = {};
    mockPeers = [];
    stopCalls = 0;
    vi.clearAllMocks();
  });

  it('hands peers, recorders, and WAV the stable tracks from switchable media', async () => {
    const rawAudio = { kind: 'audio', id: 'raw-audio-id', enabled: true, stop: vi.fn() } as any;
    const rawVideo = { kind: 'video', id: 'raw-video-id', enabled: true, stop: vi.fn() } as any;
    const lobbyStream = {
      getTracks: () => [rawAudio, rawVideo],
      getAudioTracks: () => [rawAudio],
      getVideoTracks: () => [rawVideo],
    } as any;

    const startGuestRecordingSpy = vi.spyOn(recordingController, 'startGuestRecording').mockReturnValue({
      recordingId: 'rec-1',
    } as any);

    const { result } = renderHook(() => useRoom('test-room'));

    await act(async () => {
      await result.current.join(lobbyStream, 'Guest Alice', false);
    });

    // The stream in state should NOT be the raw lobby stream if stable media is built
    const stateStream = result.current.state.localStream;
    expect(stateStream).toBeDefined();

    // Trigger peer-joined
    await act(async () => {
      const peerJoinedHandler = signalHandlers['peer-joined']?.[0];
      peerJoinedHandler?.({
        type: 'peer-joined',
        peerId: 'host-peer',
        ordinal: 1,
        role: 'host',
        displayName: 'Host Bob',
      });
    });

    expect(mockPeers.length).toBeGreaterThan(0);
    const peer = mockPeers[0];
    // Peer should receive the stable stream
    expect(stateStream).not.toBe(lobbyStream);
    expect(peer.setLocalStreamAfterFirstOffer).toHaveBeenCalledWith(stateStream, null);

    // Trigger host recording-started signal
    await act(async () => {
      const recStartedHandler = signalHandlers['recording-started']?.[0];
      await recStartedHandler?.({
        type: 'recording-started',
        recordingId: 'take-1',
        kind: 'camera',
        filename: 'take1.mp4',
      });
    });

    if (startGuestRecordingSpy.mock.calls.length > 0) {
      const args = startGuestRecordingSpy.mock.calls[0]![0];
      // micStream must be the stable audio track (pre-board), NOT the raw lobby stream
      expect(args.micStream).toBe(stateStream);
    }
  });

  it('updates activeMicId and activeCamId in state on device switch', async () => {
    const rawAudio = {
      kind: 'audio',
      id: 'raw-audio-id',
      enabled: true,
      stop: vi.fn(),
      getSettings: () => ({ deviceId: 'mic-initial', sampleRate: 48000 }),
    } as any;
    const rawVideo = {
      kind: 'video',
      id: 'raw-video-id',
      enabled: true,
      stop: vi.fn(),
      getSettings: () => ({ deviceId: 'cam-initial', width: 1920, height: 1080 }),
    } as any;
    const lobbyStream = {
      getTracks: () => [rawAudio, rawVideo],
      getAudioTracks: () => [rawAudio],
      getVideoTracks: () => [rawVideo],
    } as any;

    const nextMic = {
      kind: 'audio',
      id: 'next-audio-id',
      enabled: true,
      stop: vi.fn(),
      getSettings: () => ({ deviceId: 'mic-usb' }),
    } as any;
    const nextCam = {
      kind: 'video',
      id: 'next-video-id',
      enabled: true,
      stop: vi.fn(),
      getSettings: () => ({ deviceId: 'cam-usb' }),
    } as any;

    const getUserMedia = vi.fn().mockImplementation(async (constraints: MediaStreamConstraints) => {
      if (constraints.audio) return { getTracks: () => [nextMic], getAudioTracks: () => [nextMic] };
      if (constraints.video) return { getTracks: () => [nextCam], getVideoTracks: () => [nextCam] };
      throw new Error('unexpected');
    });

    vi.stubGlobal('navigator', {
      userAgent: 'test',
      mediaDevices: { getUserMedia },
    });

    const { result } = renderHook(() => useRoom('test-room'));

    await act(async () => {
      await result.current.join(lobbyStream, 'Alice', false);
    });

    expect(result.current.state.activeMicId).toBe('mic-initial');
    expect(result.current.state.activeCamId).toBe('cam-initial');

    await act(async () => {
      await result.current.switchMic('mic-usb');
    });
    expect(result.current.state.activeMicId).toBe('mic-usb');

    await act(async () => {
      await result.current.switchCamera('cam-usb');
    });
    expect(result.current.state.activeCamId).toBe('cam-usb');
  });

  it('keeps a microphone switched to while the microphone is off turned off', async () => {
    const track = (id: string, deviceId: string) =>
      ({ kind: 'audio', id, enabled: true, stop: vi.fn(), getSettings: () => ({ deviceId }) }) as any;
    const rawAudio = track('raw-audio-id', 'mic-initial');
    const nextMic = track('next-audio-id', 'mic-usb');
    const lobbyStream = {
      getTracks: () => [rawAudio],
      getAudioTracks: () => [rawAudio],
      getVideoTracks: () => [],
    } as any;
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [nextMic], getAudioTracks: () => [nextMic] }),
      },
    });

    const { result } = renderHook(() => useRoom('test-room'));
    await act(async () => {
      await result.current.join(lobbyStream, 'Alice', false);
    });
    act(() => result.current.setMic(false));
    await act(async () => {
      await result.current.switchMic('mic-usb');
    });
    expect(nextMic.enabled).toBe(false);

    act(() => result.current.setMic(true));
    await act(async () => {
      await result.current.switchMic('mic-usb');
    });
    expect(nextMic.enabled).toBe(true);
  });

  it('mirrors the mic verdict as a note and nothing more', async () => {
    const rawAudio = { kind: 'audio', id: 'raw-audio-id', enabled: true, stop: vi.fn() } as any;
    const rawVideo = { kind: 'video', id: 'raw-video-id', enabled: true, stop: vi.fn() } as any;
    const lobbyStream = {
      getTracks: () => [rawAudio, rawVideo],
      getAudioTracks: () => [rawAudio],
      getVideoTracks: () => [rawVideo],
    } as any;

    const { result } = renderHook(() => useRoom('test-room'));

    expect(result.current.state.micWarning).toBeNull();

    await act(async () => {
      await result.current.join(lobbyStream, 'Guest Alice', false);
    });

    expect(result.current.state.micWarning).toBeNull();

    await act(async () => {
      signalHandlers['peer-joined']?.[0]?.({
        type: 'peer-joined',
        peerId: 'peer-1',
        ordinal: 2,
        role: 'guest',
        displayName: 'Bob',
      });
    });

    const phaseBefore = result.current.state.phase;
    const recordingErrorBefore = result.current.state.recordingError;
    const connectionWarningBefore = result.current.state.connectionWarning;

    act(() => mediaOptions.onMicWarning('silent'));
    expect(result.current.state.micWarning).toBe('silent');
    expect(result.current.state.phase).toBe(phaseBefore);
    expect(result.current.state.recordingError).toBe(recordingErrorBefore);
    expect(result.current.state.connectionWarning).toBe(connectionWarningBefore);

    act(() => {
      result.current.newTake();
    });
    expect(result.current.state.micWarning).toBe('silent');

    await act(async () => {
      await result.current.startRecording();
    });
    expect(result.current.state.micWarning).toBe('silent');

    act(() => mediaOptions.onMicWarning(null));
    expect(result.current.state.micWarning).toBeNull();

    expect(stopCalls).toBe(0);
    await act(async () => {
      await result.current.leave();
    });
    expect(stopCalls).toBeGreaterThan(0);
  });

  it('preserves mic warning when guest recording starts', async () => {
    const rawAudio = { kind: 'audio', id: 'raw-audio-id', enabled: true, stop: vi.fn() } as any;
    const rawVideo = { kind: 'video', id: 'raw-video-id', enabled: true, stop: vi.fn() } as any;
    const lobbyStream = {
      getTracks: () => [rawAudio, rawVideo],
      getAudioTracks: () => [rawAudio],
      getVideoTracks: () => [rawVideo],
    } as any;

    const { result } = renderHook(() => useRoom('test-room'));

    await act(async () => {
      await result.current.join(lobbyStream, 'Guest Alice', false);
    });

    await act(async () => {
      signalHandlers['role-assigned']?.[0]?.({
        type: 'role-assigned',
        role: 'guest',
        peerId: 'guest-peer',
        ordinal: 2,
        peers: [{ peerId: 'host-peer', ordinal: 1, role: 'host' }],
      });
    });

    act(() => mediaOptions.onMicWarning('silent'));
    expect(result.current.state.micWarning).toBe('silent');

    await act(async () => {
      await signalHandlers['recording-started']?.[0]?.({
        type: 'recording-started',
        recordingId: 'take-1',
        from: 'host',
      });
    });
    expect(result.current.state.micWarning).toBe('silent');
  });

  // A producer publishes nothing and joins with no tracks. Wrapping that empty
  // stream would conjure a blank video track, which its self-tile would show as
  // a black "camera on" frame instead of its initial.
  it('keeps a producer’s empty lobby stream as is, with no stable-media wrapper', async () => {
    const lobbyStream = new MediaStream();
    const { result } = renderHook(() => useRoom('test-room'));

    await act(async () => {
      await result.current.join(lobbyStream, 'Producer Pat', true);
    });

    expect(result.current.state.localStream).toBe(lobbyStream);
    expect(result.current.state.isFallbackMedia).toBeUndefined();
  });

  it('records the stable stream in mono by default', async () => {
    const { audioContext, destination, destTrack } = installStableMediaGlobals();
    try {
      const lobbyStream = twoChannelLobbyStream();
      const { result } = renderHook(() => useRoom('test-room'));

      await act(async () => {
        await result.current.join(lobbyStream, 'Alice');
      });

      expect(destination.channelCount).toBe(1);
      expect(audioContext).toHaveBeenCalledWith({ sampleRate: 48000 });
      expect(result.current.state.localStream!.getAudioTracks()[0]).toBe(destTrack);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('records the stable stream in stereo when join was asked for it', async () => {
    const { destination } = installStableMediaGlobals();
    try {
      const lobbyStream = twoChannelLobbyStream();
      const { result } = renderHook(() => useRoom('test-room'));

      await act(async () => {
        await result.current.join(lobbyStream, 'Alice', false, false, undefined, true);
      });

      expect(destination.channelCount).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // The board mix replaces the mic in what the take sends and records, but the
  // uncompressed master stays the microphone alone.
  it('gives the WAV backup the microphone stream, not the board mix', async () => {
    installStableMediaGlobals();
    vi.stubGlobal('MediaRecorder', { isTypeSupported: () => true });
    try {
      const lobbyStream = twoChannelLobbyStream();
      const { result } = renderHook(() => useRoom('test-room'));

      await act(async () => {
        await result.current.join(lobbyStream, 'Alice');
      });
      await act(async () => {
        signalHandlers['role-assigned']?.[0]?.({
          type: 'role-assigned',
          role: 'guest',
          peerId: 'guest-peer',
          ordinal: 2,
          peers: [{ peerId: 'host-peer', ordinal: 1, role: 'host' }],
        });
      });
      act(() => {
        result.current.openMediaBoard();
      });
      await act(async () => {
        await signalHandlers['recording-started']?.[0]?.({
          type: 'recording-started',
          recordingId: 'take-1',
          from: 'host',
        });
      });

      const options = vi.mocked(BackupRecorder).mock.calls.map(([opts]) => opts as any);
      const wav = options.find((o) => o.mimeType === 'audio/wav');
      const mp4 = options.find((o) => o.mimeType !== 'audio/wav');
      expect(wav).toBeDefined();
      expect(mp4).toBeDefined();
      // The master's own stream, carrying the microphone's track.
      expect(wav!.stream.getAudioTracks()).toEqual(result.current.state.localStream!.getAudioTracks());
      expect(mp4!.stream).not.toBe(wav!.stream);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('closes the media board when the call is released', async () => {
    installStableMediaGlobals();
    const close = vi.spyOn(MediaBoard.prototype, 'close');
    try {
      const lobbyStream = twoChannelLobbyStream();
      const { result } = renderHook(() => useRoom('test-room'));

      await act(async () => {
        await result.current.join(lobbyStream, 'Alice');
      });
      act(() => {
        result.current.openMediaBoard();
      });
      expect(close).not.toHaveBeenCalled();

      await act(async () => {
        await result.current.leave();
      });
      expect(close).toHaveBeenCalled();
    } finally {
      close.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

// Noise suppression for the call: a second capture of the microphone that only the
// connections' audio senders receive. The stable stream, the WAV master's stream and
// every recorder keep what they held.
describe('useRoom noise suppression', () => {
  const NOISE_OFF = 'Noise suppression is not available in this browser.';
  const MIC_CHANGED = "Your microphone's settings changed. Leave and join again before recording.";

  function cleanedTrack(id: string, deviceId = 'mic-1') {
    return Object.assign(new EventTarget(), {
      kind: 'audio',
      id,
      enabled: true,
      stop: vi.fn(),
      getSettings: () => ({ deviceId, noiseSuppression: true }),
    }) as unknown as MediaStreamTrack;
  }

  /** A joined guest with one connection to the host, on the stable path. */
  async function joinedGuest(opts: { lobby?: any; getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream> } = {}) {
    const graph = installStableMediaGlobals();
    const cleaned = cleanedTrack('cleaned');
    const queue = [cleaned];
    const getUserMedia = vi.fn(
      opts.getUserMedia ?? (async (c: MediaStreamConstraints) => {
        const audio = c.audio as MediaTrackConstraints;
        return new MediaStream([
          audio.noiseSuppression ? (queue.shift() ?? cleanedTrack('cleaned-next', 'mic-2')) : rawTrack('raw-2', 'mic-2'),
        ]);
      })
    );
    vi.stubGlobal('navigator', { userAgent: 'test', mediaDevices: { getUserMedia } });
    const hook = renderHook(() => useRoom('test-room'));
    await act(async () => {
      await hook.result.current.join(opts.lobby ?? twoChannelLobbyStream(), 'Alice');
    });
    await act(async () => {
      signalHandlers['role-assigned']?.[0]?.({
        type: 'role-assigned',
        role: 'guest',
        peerId: 'guest-peer',
        ordinal: 2,
        peers: [{ peerId: 'host-peer', ordinal: 1, role: 'host' }],
      });
    });
    return { ...hook, ...graph, cleaned, getUserMedia };
  }

  function rawTrack(id: string, deviceId: string) {
    return {
      kind: 'audio',
      id,
      enabled: true,
      stop: vi.fn(),
      getSettings: () => ({ deviceId }),
    } as unknown as MediaStreamTrack;
  }

  const lastAudioOf = (peer: any) => peer.replaceAudioTrack.mock.calls.at(-1)?.[0];

  beforeEach(() => {
    signalHandlers = {};
    mockPeers = [];
    vi.clearAllMocks();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('starts off, and sends the cleaned track to every connection once it is on', async () => {
    const { result, cleaned } = await joinedGuest();
    expect(result.current.state.noiseSuppression).toBe(false);
    expect(result.current.state.noiseUnavailable).toBe(false);

    await act(async () => {
      await signalHandlers['peer-joined']?.[0]?.({ type: 'peer-joined', peerId: 'p2', ordinal: 3, role: 'guest' });
    });
    let line: string | null = 'unset';
    await act(async () => {
      line = await result.current.setNoiseSuppression(true);
    });

    expect(line).toBeNull();
    expect(result.current.state.noiseSuppression).toBe(true);
    expect(mockPeers).toHaveLength(2);
    for (const p of mockPeers) expect(p.replaceAudioTrack).toHaveBeenCalledWith(cleaned);
  });

  it('opens one capture however often it is asked for', async () => {
    const { result, getUserMedia } = await joinedGuest();
    await act(async () => {
      await result.current.setNoiseSuppression(true);
    });
    getUserMedia.mockClear();
    await act(async () => {
      await result.current.setNoiseSuppression(true);
    });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.current.state.noiseSuppression).toBe(true);
  });

  it('puts the stable track back on every connection when it is turned off', async () => {
    const { result, cleaned } = await joinedGuest();
    await act(async () => {
      await result.current.setNoiseSuppression(true);
    });
    await act(async () => {
      await result.current.setNoiseSuppression(false);
    });
    expect(result.current.state.noiseSuppression).toBe(false);
    expect(cleaned.stop).toHaveBeenCalledTimes(1);
    expect(lastAudioOf(mockPeers[0])).toBe(result.current.state.localStream!.getAudioTracks()[0]);
  });

  it('hands a connection that joins later a stream with the cleaned track and the same video', async () => {
    const { result, cleaned } = await joinedGuest();
    await act(async () => {
      await result.current.setNoiseSuppression(true);
    });
    await act(async () => {
      await signalHandlers['peer-joined']?.[0]?.({ type: 'peer-joined', peerId: 'p2', ordinal: 3, role: 'guest' });
    });

    const handed = mockPeers[1].setLocalStreamAfterFirstOffer.mock.calls[0][0] as MediaStream;
    expect(handed.getAudioTracks()).toEqual([cleaned]);
    expect(handed.getVideoTracks()).toEqual(result.current.state.localStream!.getVideoTracks());
  });

  it('hands every connection rebuilt by a second role-assigned the cleaned track', async () => {
    const { result, cleaned } = await joinedGuest();
    await act(async () => {
      await result.current.setNoiseSuppression(true);
    });
    await act(async () => {
      signalHandlers['role-assigned']?.[0]?.({
        type: 'role-assigned',
        role: 'guest',
        peerId: 'guest-peer-2',
        ordinal: 2,
        peers: [{ peerId: 'host-peer', ordinal: 1, role: 'host' }],
      });
    });

    const rebuilt = mockPeers[1].setLocalStream.mock.calls[0][0] as MediaStream;
    expect(rebuilt.getAudioTracks()).toEqual([cleaned]);
    expect(rebuilt.getVideoTracks()).toEqual(result.current.state.localStream!.getVideoTracks());
  });

  it('leaves the cleaned track off when the host mutes this microphone', async () => {
    const { result, cleaned } = await joinedGuest();
    await act(async () => {
      await result.current.setNoiseSuppression(true);
    });
    await act(async () => {
      signalHandlers['peer-mute']?.[0]?.({ type: 'peer-mute' });
    });
    expect(cleaned.enabled).toBe(false);
  });

  it('turns the cleaned track off and on with the microphone switch', async () => {
    const { result, cleaned } = await joinedGuest();
    await act(async () => {
      await result.current.setNoiseSuppression(true);
    });
    act(() => result.current.setMic(false));
    expect(cleaned.enabled).toBe(false);
    act(() => result.current.setMic(true));
    expect(cleaned.enabled).toBe(true);
  });

  it('records from the stable stream and the microphone stream, never the cleaned track', async () => {
    const startGuest = vi.spyOn(recordingController, 'startGuestRecording').mockReturnValue({ recordingId: 'rec-1' } as any);
    vi.stubGlobal('MediaRecorder', { isTypeSupported: () => true });
    const { result, cleaned, destTrack } = await joinedGuest();
    await act(async () => {
      await result.current.setNoiseSuppression(true);
    });
    await act(async () => {
      await signalHandlers['recording-started']?.[0]?.({
        type: 'recording-started',
        recordingId: 'take-1',
        from: 'host',
      });
    });

    const args = startGuest.mock.calls[0]![0];
    expect(args.localStream).toBe(result.current.state.localStream);
    expect(args.localStream.getAudioTracks()).toEqual([destTrack]);
    expect(args.micStream!.getAudioTracks()).toEqual([destTrack]);
    const backups = vi.mocked(BackupRecorder).mock.calls.map(([o]) => o as any);
    expect(backups.length).toBeGreaterThan(0);
    for (const b of backups) expect(b.stream.getAudioTracks()).not.toContain(cleaned);
  });

  it('tells the person when the browser cannot do it and leaves the call as it was', async () => {
    const { result } = await joinedGuest({
      getUserMedia: async () => {
        throw new Error('OverconstrainedError');
      },
    });
    let line: string | null = null;
    await act(async () => {
      line = await result.current.setNoiseSuppression(true);
    });
    expect(line).toBe(NOISE_OFF);
    expect(result.current.state.noiseUnavailable).toBe(true);
    expect(result.current.state.noiseSuppression).toBe(false);
    expect(mockPeers[0].replaceAudioTrack).not.toHaveBeenCalled();
  });

  it('tells the person when opening it moved the raw microphone settings', async () => {
    const lobby = twoChannelLobbyStream();
    let moved = false;
    lobby.getAudioTracks()[0].getSettings = () => ({ deviceId: 'mic-1', noiseSuppression: moved });
    const { result } = await joinedGuest({
      lobby,
      getUserMedia: async () => {
        moved = true;
        return new MediaStream([cleanedTrack('cleaned')]);
      },
    });
    let line: string | null = null;
    await act(async () => {
      line = await result.current.setNoiseSuppression(true);
    });
    expect(line).toBe(MIC_CHANGED);
    expect(result.current.state.noiseUnavailable).toBe(true);
    expect(result.current.state.noiseSuppression).toBe(false);
  });

  it('does nothing for a producer and for a present-only device', async () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal('navigator', { userAgent: 'test', mediaDevices: { getUserMedia } });
    for (const [producer, companion] of [
      [true, false],
      [false, true],
    ] as const) {
      const { result } = renderHook(() => useRoom('test-room'));
      await act(async () => {
        await result.current.join(new MediaStream(), 'Pat', producer, companion);
      });
      let line: string | null = 'unset';
      await act(async () => {
        line = await result.current.setNoiseSuppression(true);
      });
      expect(line).toBeNull();
      expect(result.current.state.noiseSuppression).toBe(false);
      expect(result.current.state.noiseUnavailable).toBe(false);
    }
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('puts the stable track back and shows it off when the device takes the cleaned track away', async () => {
    const { result, cleaned } = await joinedGuest();
    await act(async () => {
      await result.current.setNoiseSuppression(true);
    });
    act(() => {
      cleaned.dispatchEvent(new Event('ended'));
    });
    expect(result.current.state.noiseSuppression).toBe(false);
    expect(lastAudioOf(mockPeers[0])).toBe(result.current.state.localStream!.getAudioTracks()[0]);
  });

  it('opens it again on the new microphone after a switch and sends that track', async () => {
    const { result, getUserMedia } = await joinedGuest();
    await act(async () => {
      await result.current.setNoiseSuppression(true);
    });
    await act(async () => {
      await result.current.switchMic('mic-2');
    });

    const asked = getUserMedia.mock.calls.map(([c]) => c.audio as MediaTrackConstraints);
    expect(asked.at(-1)).toMatchObject({ deviceId: { exact: 'mic-2' }, noiseSuppression: { exact: true } });
    expect(result.current.state.noiseSuppression).toBe(true);
    expect(lastAudioOf(mockPeers[0]).id).toBe('cleaned-next');
  });

  it('sends the stable track, and the switch still succeeds, when the new microphone refuses it', async () => {
    const { result } = await joinedGuest({
      getUserMedia: (() => {
        let first = true;
        return async (c: MediaStreamConstraints) => {
          const audio = c.audio as MediaTrackConstraints;
          if (audio.noiseSuppression) {
            if (first) {
              first = false;
              return new MediaStream([cleanedTrack('cleaned')]);
            }
            throw new Error('OverconstrainedError');
          }
          return new MediaStream([rawTrack('raw-2', 'mic-2')]);
        };
      })(),
    });
    await act(async () => {
      await result.current.setNoiseSuppression(true);
    });
    await act(async () => {
      await result.current.switchMic('mic-2');
    });
    expect(result.current.state.noiseSuppression).toBe(false);
    expect(result.current.state.activeMicId).toBe('mic-2');
    expect(lastAudioOf(mockPeers[0])).toBe(result.current.state.localStream!.getAudioTracks()[0]);
  });

  it('sends the stable track and shows it off when the switch itself fails', async () => {
    const { result } = await joinedGuest({
      getUserMedia: (() => {
        let first = true;
        return async (c: MediaStreamConstraints) => {
          if ((c.audio as MediaTrackConstraints).noiseSuppression && first) {
            first = false;
            return new MediaStream([cleanedTrack('cleaned')]);
          }
          throw new Error('NotReadableError');
        };
      })(),
    });
    await act(async () => {
      await result.current.setNoiseSuppression(true);
    });
    await act(async () => {
      await expect(result.current.switchMic('mic-2')).rejects.toThrow('NotReadableError');
    });
    expect(result.current.state.noiseSuppression).toBe(false);
    expect(lastAudioOf(mockPeers[0])).toBe(result.current.state.localStream!.getAudioTracks()[0]);
  });

  it('leaves nothing open when the call is released', async () => {
    const { result, cleaned } = await joinedGuest();
    await act(async () => {
      await result.current.setNoiseSuppression(true);
    });
    await act(async () => {
      await result.current.leave();
    });
    expect(cleaned.stop).toHaveBeenCalled();
  });
});
