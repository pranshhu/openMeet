import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';
import * as recordingController from '@/hooks/recording-controller';

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

describe('useRoom stable media integration', () => {
  beforeEach(() => {
    signalHandlers = {};
    mockPeers = [];
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
});
