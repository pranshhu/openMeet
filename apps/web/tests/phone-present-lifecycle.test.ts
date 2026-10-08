import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';
import { SwitchableMedia } from '@/lib/switchable-media';

let signalHandlers: Record<string, ((m: any) => void)[]> = {};
let mockPeers: any[] = [];

vi.mock('@/lib/api', () => ({
  getTurnCred: vi.fn(() => Promise.resolve({ urls: [], username: 'u', credential: 'c', ttl: 100 })),
  getRoom: vi.fn(() => Promise.resolve({ slug: 'test-room', expires_at: Date.now() + 10000 })),
  patchRecording: vi.fn(() => Promise.resolve({})),
}));

vi.mock('@/lib/host-token', () => ({
  getHostToken: vi.fn().mockReturnValue(null),
}));

let mockSignalClient: any = null;

vi.mock('@/lib/signal', () => ({
  SignalClient: vi.fn().mockImplementation(() => {
    mockSignalClient = {
      connect: vi.fn(),
      close: vi.fn(),
      send: vi.fn(),
      reconnect: vi.fn(),
      on: vi.fn((type: string, handler: (m: any) => void) => {
        (signalHandlers[type] ??= []).push(handler);
      }),
    };
    return mockSignalClient;
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
      addTrack: vi.fn(),
      removeTrack: vi.fn(),
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

describe('present presentation lifecycle with useRoom', () => {
  let originalCreateObjectURL: any;
  let originalRevokeObjectURL: any;
  let originalAudioContext: any;
  let mockCanvasStreamTracks: any[];
  let mockCaptureStream: any;
  let mockGetDisplayMedia: any;
  let mockGetUserMedia: any;

  beforeEach(() => {
    mockSignalClient = null;
    signalHandlers = {};
    mockPeers = [];

    originalCreateObjectURL = globalThis.URL.createObjectURL;
    originalRevokeObjectURL = globalThis.URL.revokeObjectURL;
    originalAudioContext = globalThis.AudioContext;

    globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock-file');
    globalThis.URL.revokeObjectURL = vi.fn();

    const canvasVideoTrack = {
      kind: 'video',
      id: 'canvas-video-track',
      stop: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    mockCanvasStreamTracks = [canvasVideoTrack];

    mockCaptureStream = vi.fn(() => ({
      getTracks: () => mockCanvasStreamTracks,
      getVideoTracks: () => mockCanvasStreamTracks.filter((t) => t.kind === 'video'),
      getAudioTracks: () => mockCanvasStreamTracks.filter((t) => t.kind === 'audio'),
      addTrack: vi.fn((t) => mockCanvasStreamTracks.push(t)),
      removeTrack: vi.fn((t) => {
        const i = mockCanvasStreamTracks.indexOf(t);
        if (i !== -1) mockCanvasStreamTracks.splice(i, 1);
      }),
    }));
    HTMLCanvasElement.prototype.captureStream = mockCaptureStream;
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      fillStyle: '',
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    })) as any;

    mockGetDisplayMedia = vi.fn().mockResolvedValue({
      getTracks: () => [
        {
          kind: 'video',
          id: 'desktop-screen-track',
          stop: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        },
      ],
      getVideoTracks: () => [
        {
          kind: 'video',
          id: 'desktop-screen-track',
          stop: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        },
      ],
    });

    const rearCamTrack = {
      kind: 'video',
      id: 'rear-cam-track',
      stop: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    mockGetUserMedia = vi.fn().mockImplementation(async (constraints: MediaStreamConstraints) => {
      if (constraints.video) {
        return {
          getTracks: () => [rearCamTrack],
          getVideoTracks: () => [rearCamTrack],
          getAudioTracks: () => [],
        };
      }
      return { getTracks: () => [], getVideoTracks: () => [], getAudioTracks: () => [] };
    });

    vi.stubGlobal('navigator', {
      userAgent: 'test-agent',
      mediaDevices: {
        getDisplayMedia: mockGetDisplayMedia,
        getUserMedia: mockGetUserMedia,
      },
    });
  });

  afterEach(() => {
    globalThis.URL.createObjectURL = originalCreateObjectURL;
    globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
    globalThis.AudioContext = originalAudioContext;
  });

  async function setupConnectedRoom(userAgent = 'test-desktop') {
    Object.defineProperty(navigator, 'userAgent', {
      value: userAgent,
      configurable: true,
    });

    const rawAudio = { kind: 'audio', id: 'raw-mic', enabled: true, stop: vi.fn() } as any;
    const rawVideo = {
      kind: 'video',
      id: 'raw-cam',
      enabled: true,
      stop: vi.fn(),
      getSettings: () => ({ deviceId: 'face-cam-id' }),
    } as any;
    const lobbyStream = {
      getTracks: () => [rawAudio, rawVideo],
      getAudioTracks: () => [rawAudio],
      getVideoTracks: () => [rawVideo],
    } as any;

    const { result } = renderHook(() => useRoom('test-room'));

    await act(async () => {
      await result.current.join(lobbyStream, 'Alice', false);
    });

    // Simulate peer joined
    await act(async () => {
      const peerJoinedHandler = signalHandlers['peer-joined']?.[0];
      peerJoinedHandler?.({
        type: 'peer-joined',
        peerId: 'peer-bob',
        ordinal: 1,
        role: 'host',
        displayName: 'Bob',
      });
    });

    return { result, rawVideo, rawAudio };
  }

  it('picking an image yields a 1920x1080 canvas stream through toggleScreenShare path', async () => {
    class MockImage {
      naturalWidth = 1200;
      naturalHeight = 800;
      complete = false;
      onload: (() => void) | null = null;
      set src(_v: string) {
        setTimeout(() => {
          this.complete = true;
          this.onload?.();
        }, 0);
      }
    }
    const origImage = globalThis.Image;
    globalThis.Image = MockImage as any;

    try {
      const { result } = await setupConnectedRoom();
      const peer = mockPeers[0];

      const imageFile = new File(['image-bytes'], 'presentation.png', { type: 'image/png' });
      await act(async () => {
        await result.current.toggleScreenShare(imageFile);
      });

      expect(mockCaptureStream).toHaveBeenCalledWith(30);
      expect(result.current.state.screenSharing).toBe(true);
      // The presenter sees the picture they are showing.
      expect(result.current.state.localScreenStream).not.toBeNull();
      // Added canvas track to peer
      expect(peer.addTrack).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'canvas-video-track' }),
        expect.anything()
      );

      // Stopping stops canvas stream
      await act(async () => {
        await result.current.toggleScreenShare();
      });
      expect(result.current.state.screenSharing).toBe(false);
      expect(mockCanvasStreamTracks[0].stop).toHaveBeenCalled();
    } finally {
      globalThis.Image = origImage;
    }
  });

  it('a video adds its audio track through toggleScreenShare path', async () => {
    const mockAudioTrack = { kind: 'audio', id: 'video-sound', stop: vi.fn() };
    const mockDest = {
      stream: {
        getAudioTracks: () => [mockAudioTrack],
        getTracks: () => [mockAudioTrack],
      },
    };
    const mockSource = { connect: vi.fn() };
    class MockAudioContext {
      createMediaElementSource = vi.fn(() => mockSource);
      createMediaStreamDestination = vi.fn(() => mockDest);
      close = vi.fn().mockResolvedValue(undefined);
    }
    globalThis.AudioContext = MockAudioContext as any;

    const origPlay = HTMLMediaElement.prototype.play;
    const origPause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();

    try {
      const { result } = await setupConnectedRoom();
      const peer = mockPeers[0];

      const videoFile = new File(['video-bytes'], 'demo.mp4', { type: 'video/mp4' });
      await act(async () => {
        await result.current.toggleScreenShare(videoFile);
      });

      expect(mockCaptureStream).toHaveBeenCalledWith(30);
      expect(mockSource.connect).toHaveBeenCalledWith(mockDest);
      // Both video track and video audio track added to peer
      expect(peer.addTrack).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'canvas-video-track' }),
        expect.anything()
      );
      expect(peer.addTrack).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'video-sound' }),
        expect.anything()
      );

      // Stop
      await act(async () => {
        await result.current.toggleScreenShare();
      });
      expect(mockAudioTrack.stop).toHaveBeenCalled();
      expect(mockCanvasStreamTracks[0].stop).toHaveBeenCalled();
    } finally {
      HTMLMediaElement.prototype.play = origPlay;
      HTMLMediaElement.prototype.pause = origPause;
    }
  });

  // A presenter has to hear the clip to talk over it; a phone on its loudspeaker,
  // or a present-only device beside the one with the microphone, would put the
  // sound back into the call.
  describe('hearing a presented video on the device that presents it', () => {
    const speakers = { id: 'speakers' };
    let mockSource: { connect: ReturnType<typeof vi.fn> };
    let origPlay: typeof HTMLMediaElement.prototype.play;
    let origPause: typeof HTMLMediaElement.prototype.pause;
    const videoFile = new File(['video-bytes'], 'demo.mp4', { type: 'video/mp4' });

    beforeEach(() => {
      const track = { kind: 'audio', id: 'video-sound', stop: vi.fn() };
      const dest = { stream: { getAudioTracks: () => [track], getTracks: () => [track] } };
      mockSource = { connect: vi.fn() };
      const source = mockSource;
      class MockAudioContext {
        createMediaElementSource = vi.fn(() => source);
        createMediaStreamDestination = vi.fn(() => dest);
        destination = speakers;
        close = vi.fn().mockResolvedValue(undefined);
      }
      globalThis.AudioContext = MockAudioContext as any;
      origPlay = HTMLMediaElement.prototype.play;
      origPause = HTMLMediaElement.prototype.pause;
      HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
      HTMLMediaElement.prototype.pause = vi.fn();
    });

    afterEach(() => {
      HTMLMediaElement.prototype.play = origPlay;
      HTMLMediaElement.prototype.pause = origPause;
    });

    it('a computer hears it', async () => {
      const { result } = await setupConnectedRoom();
      await act(async () => {
        await result.current.toggleScreenShare(videoFile);
      });
      expect(result.current.state.screenSharing).toBe(true);
      expect(mockSource.connect).toHaveBeenCalledWith(speakers);
      await act(async () => {
        await result.current.toggleScreenShare();
      });
    });

    it('a phone does not', async () => {
      const { result } = await setupConnectedRoom('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile');
      await act(async () => {
        await result.current.toggleScreenShare(videoFile);
      });
      expect(result.current.state.screenSharing).toBe(true);
      expect(mockSource.connect).not.toHaveBeenCalledWith(speakers);
      await act(async () => {
        await result.current.toggleScreenShare();
      });
    });

    it('a present-only device does not', async () => {
      Object.defineProperty(navigator, 'userAgent', { value: 'test-desktop', configurable: true });
      const empty = { getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] } as any;
      const { result } = renderHook(() => useRoom('test-room'));
      await act(async () => {
        await result.current.join(empty, 'Alice', false, true);
      });
      await act(async () => {
        signalHandlers['peer-joined']?.[0]?.({
          type: 'peer-joined',
          peerId: 'peer-bob',
          ordinal: 1,
          role: 'host',
          displayName: 'Bob',
        });
      });
      await act(async () => {
        await result.current.toggleScreenShare(videoFile);
      });
      expect(result.current.state.screenSharing).toBe(true);
      expect(mockSource.connect).not.toHaveBeenCalledWith(speakers);
      await act(async () => {
        await result.current.toggleScreenShare();
      });
    });
  });

  it('rear camera presentation restores the face camera on stop', async () => {
    const phoneUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)';
    const switchCameraSpy = vi.spyOn(SwitchableMedia.prototype, 'switchCamera');
    const { result } = await setupConnectedRoom(phoneUA);
    const peer = mockPeers[0];

    // Present rear camera
    await act(async () => {
      await result.current.toggleScreenShare('rear-camera');
    });

    expect(mockGetUserMedia).toHaveBeenCalledWith({
      video: { facingMode: 'environment' },
      audio: false,
    });
    expect(result.current.state.screenSharing).toBe(true);
    expect(result.current.state.presentingRearCamera).toBe(true);
    // A viewfinder, so the presenter can aim the camera everyone is watching.
    expect(result.current.state.localScreenStream?.getVideoTracks()[0]).toEqual(
      expect.objectContaining({ id: 'rear-cam-track' })
    );
    expect(peer.addTrack).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'rear-cam-track' }),
      expect.anything()
    );

    // Stop presentation
    await act(async () => {
      await result.current.toggleScreenShare();
    });

    expect(result.current.state.screenSharing).toBe(false);
    expect(result.current.state.presentingRearCamera).toBe(false);
    expect(result.current.state.localScreenStream).toBeNull();
    // switchCamera called on SwitchableMedia to restore face camera
    expect(switchCameraSpy).toHaveBeenCalledWith(expect.stringMatching(/user|face-cam-id/));
  });

  it('rear camera presentation on phone turns camera off and restores previous camera state on stop', async () => {
    const phoneUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)';
    const setVideoEnabledSpy = vi.spyOn(SwitchableMedia.prototype, 'setVideoEnabled');
    const { result } = await setupConnectedRoom(phoneUA);

    // Initial state: camera is ON
    expect(mockSignalClient.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'presence', camOn: true })
    );

    // Present rear camera
    await act(async () => {
      await result.current.toggleScreenShare('rear-camera');
    });

    // Turns camera off the normal way (setVideoEnabled(false), presence camOn: false)
    expect(setVideoEnabledSpy).toHaveBeenCalledWith(false);
    expect(mockSignalClient.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'presence', camOn: false, screenSharing: true })
    );

    // Stop presentation
    await act(async () => {
      await result.current.toggleScreenShare();
    });

    // Restores previous camera on state
    expect(setVideoEnabledSpy).toHaveBeenCalledWith(true);
    expect(mockSignalClient.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'presence', camOn: true, screenSharing: false })
    );
  });

  it('rear camera presentation on phone preserves camera-off state when presentation stops if camera was already off', async () => {
    const phoneUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)';
    const { result } = await setupConnectedRoom(phoneUA);

    // Turn camera off prior to presenting
    await act(async () => {
      result.current.setCam(false);
    });
    mockSignalClient.send.mockClear();

    // Present rear camera
    await act(async () => {
      await result.current.toggleScreenShare('rear-camera');
    });

    expect(mockSignalClient.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'presence', camOn: false, screenSharing: true })
    );
    mockSignalClient.send.mockClear();

    // Stop presentation
    await act(async () => {
      await result.current.toggleScreenShare();
    });

    // Camera was off before, so camera must remain off
    expect(mockSignalClient.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'presence', camOn: false, screenSharing: false })
    );
    expect(mockSignalClient.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'presence', camOn: true })
    );
  });

  it('with getDisplayMedia present and no custom source, behaviour is unchanged', async () => {
    const { result } = await setupConnectedRoom();
    const peer = mockPeers[0];

    await act(async () => {
      await result.current.toggleScreenShare();
    });

    expect(mockGetDisplayMedia).toHaveBeenCalledWith({ video: true, audio: true });
    // A desktop screen is never mirrored back to its sharer (a hall of mirrors).
    expect(result.current.state.screenSharing).toBe(true);
    expect(result.current.state.localScreenStream).toBeNull();
    expect(peer.addTrack).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'desktop-screen-track' }),
      expect.anything()
    );

    await act(async () => {
      await result.current.toggleScreenShare();
    });

    expect(peer.removeTrack).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'desktop-screen-track' })
    );
  });
});
