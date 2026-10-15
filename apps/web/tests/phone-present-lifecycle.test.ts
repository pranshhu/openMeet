import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';
import { SwitchableMedia } from '@/lib/switchable-media';
import { presentSlides } from '@/lib/slides';

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

// Real unless a test makes the next deck fail.
vi.mock('@/lib/slides', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/slides')>();
  return { ...real, presentSlides: vi.fn(real.presentSlides) };
});

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

    const { result, unmount } = renderHook(() => useRoom('test-room'));

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

    return { result, rawVideo, rawAudio, unmount };
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
      // A monitor an earlier test left behind must not count here.
      document.querySelectorAll('audio').forEach((a) => a.remove());
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
      // Through an element, so it goes to the chosen speaker; never the graph's own output.
      expect(mockSource.connect).not.toHaveBeenCalledWith(speakers);
      expect(document.querySelector('audio')).not.toBeNull();
      await act(async () => {
        await result.current.toggleScreenShare();
      });
      expect(document.querySelector('audio')).toBeNull();
    });

    it('a phone does not', async () => {
      const { result } = await setupConnectedRoom('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile');
      await act(async () => {
        await result.current.toggleScreenShare(videoFile);
      });
      expect(result.current.state.screenSharing).toBe(true);
      expect(document.querySelector('audio')).toBeNull();
      await act(async () => {
        await result.current.toggleScreenShare();
      });
    });

    it('a present-only device does not', async () => {
      Object.defineProperty(navigator, 'userAgent', { value: 'test-desktop', configurable: true });
      const empty = { getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] } as any;
      const { result, unmount } = renderHook(() => useRoom('test-room'));
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
      expect(document.querySelector('audio')).toBeNull();
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
  describe('presenting a deck of slides', () => {
    class MockImage {
      naturalWidth = 1200;
      naturalHeight = 800;
      onload: (() => void) | null = null;
      set src(_v: string) {
        setTimeout(() => this.onload?.(), 0);
      }
    }
    let origImage: typeof Image;
    const slide = (name: string) => new File(['image-bytes'], name, { type: 'image/png' });

    beforeEach(() => {
      origImage = globalThis.Image;
      globalThis.Image = MockImage as unknown as typeof Image;
    });

    afterEach(() => {
      globalThis.Image = origImage;
    });

    it('sends one video track, shows the presenter the deck, and ends it with the share', async () => {
      const { result } = await setupConnectedRoom();
      const peer = mockPeers[0];

      await act(async () => {
        await result.current.toggleScreenShare([slide('a.png'), slide('b.png')]);
      });

      expect(result.current.state.screenSharing).toBe(true);
      expect(result.current.state.slides?.count).toBe(2);
      expect(result.current.state.localScreenStream).not.toBeNull();
      expect(mockCaptureStream).toHaveBeenCalledTimes(1);
      expect(peer.addTrack).toHaveBeenCalledTimes(1);
      expect(peer.addTrack).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'canvas-video-track' }),
        expect.anything()
      );

      await act(async () => {
        await result.current.toggleScreenShare();
      });

      expect(result.current.state.screenSharing).toBe(false);
      expect(result.current.state.slides).toBeNull();
      expect(mockCanvasStreamTracks[0].stop).toHaveBeenCalled();
    });

    it('presents nothing when no file is a picture', async () => {
      const { result } = await setupConnectedRoom();
      const peer = mockPeers[0];

      await act(async () => {
        await result.current.toggleScreenShare([new File(['text'], 'notes.txt', { type: 'text/plain' })]);
      });

      expect(result.current.state.screenSharing).toBe(false);
      expect(result.current.state.slides).toBeNull();
      expect(peer.addTrack).not.toHaveBeenCalled();
    });

    it('lets go of the deck when the presenter leaves', async () => {
      const { result } = await setupConnectedRoom();

      await act(async () => {
        await result.current.toggleScreenShare([slide('a.png')]);
      });
      expect(result.current.state.slides).not.toBeNull();

      await act(async () => {
        await result.current.leave();
      });

      expect(result.current.state.slides).toBeNull();
      expect(mockCanvasStreamTracks[0].stop).toHaveBeenCalled();
    });
  });

  describe('a source that is ready after the presenter has left', () => {
    const track = () => ({ kind: 'video', id: 'late-track', stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const streamOf = (t: ReturnType<typeof track>) =>
      Object.assign(new EventTarget(), {
        getTracks: () => [t],
        getVideoTracks: () => [t],
        getAudioTracks: () => [],
      }) as unknown as MediaStream;
    const lateDeck = () => {
      const t = track();
      const deck = { stream: streamOf(t), stop: vi.fn(), count: 1, index: 0, show: vi.fn() };
      let ready!: () => void;
      vi.mocked(presentSlides).mockImplementationOnce(
        () => new Promise((resolve) => (ready = () => resolve(deck as never)))
      );
      return { deck, ready: () => ready() };
    };
    const pictures = [new File(['image-bytes'], 'a.png', { type: 'image/png' })];

    it('stops a deck that opens after leave, and presents nothing', async () => {
      const { result } = await setupConnectedRoom();
      const { deck, ready } = lateDeck();
      let pending!: Promise<string | null>;
      await act(async () => {
        pending = result.current.toggleScreenShare(pictures);
        await result.current.leave();
      });

      let reason: string | null = 'unset';
      await act(async () => {
        ready();
        reason = await pending;
      });

      expect(reason).toBeNull();
      expect(deck.stop).toHaveBeenCalledTimes(1);
      expect(result.current.state.slides).toBeNull();
      expect(result.current.state.screenSharing).toBe(false);
      expect(result.current.state.localScreenStream).toBeNull();
    });

    it('resolves with null even when stopping the late deck throws', async () => {
      const { result } = await setupConnectedRoom();
      const { deck, ready } = lateDeck();
      deck.stop.mockImplementation(() => {
        throw new Error('already gone');
      });
      let pending!: Promise<string | null>;
      await act(async () => {
        pending = result.current.toggleScreenShare(pictures);
        await result.current.leave();
      });

      await act(async () => {
        ready();
      });

      await expect(pending).resolves.toBeNull();
    });

    it('stops a deck that opens after the page was closed', async () => {
      const { result, unmount } = await setupConnectedRoom();
      const { deck, ready } = lateDeck();
      let pending!: Promise<string | null>;
      await act(async () => {
        pending = result.current.toggleScreenShare(pictures);
      });
      unmount();

      await act(async () => {
        ready();
        await pending;
      });

      expect(deck.stop).toHaveBeenCalledTimes(1);
      expect(result.current.state.slides).toBeNull();
    });

    it('presents again once the room is joined again', async () => {
      const { result } = await setupConnectedRoom();
      await act(async () => {
        await result.current.leave();
      });
      const t = track();
      await act(async () => {
        await result.current.join(streamOf(t), 'Alice', false);
      });
      await act(async () => {
        signalHandlers['peer-joined']?.at(-1)?.({
          type: 'peer-joined',
          peerId: 'peer-bob',
          ordinal: 1,
          role: 'host',
          displayName: 'Bob',
        });
      });
      const { deck, ready } = lateDeck();
      let pending!: Promise<string | null>;
      await act(async () => {
        pending = result.current.toggleScreenShare(pictures);
        ready();
        await pending;
      });

      expect(deck.stop).not.toHaveBeenCalled();
      expect(result.current.state.screenSharing).toBe(true);
    });

    it('stops every track of a screen that is picked after leave', async () => {
      const { result } = await setupConnectedRoom();
      const t = track();
      let picked!: () => void;
      mockGetDisplayMedia.mockImplementationOnce(() => new Promise((resolve) => (picked = () => resolve(streamOf(t)))));
      let pending!: Promise<string | null>;
      await act(async () => {
        pending = result.current.toggleScreenShare();
        await result.current.leave();
      });

      await act(async () => {
        picked();
        await pending;
      });

      expect(t.stop).toHaveBeenCalledTimes(1);
      expect(result.current.state.screenSharing).toBe(false);
    });
  });

  describe('a second present while the first is waiting for its picture', () => {
    let loads: (() => void)[];
    let failures: (() => void)[];
    let origImage: typeof Image;

    class WaitingImage {
      naturalWidth = 1200;
      naturalHeight = 800;
      complete = false;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        loads.push(() => {
          this.complete = true;
          this.onload?.();
        });
        failures.push(() => this.onerror?.());
      }
    }
    const photo = (name: string) => new File(['image-bytes'], name, { type: 'image/png' });

    beforeEach(() => {
      loads = [];
      failures = [];
      origImage = globalThis.Image;
      globalThis.Image = WaitingImage as unknown as typeof Image;
    });

    afterEach(() => {
      globalThis.Image = origImage;
    });

    it('does nothing, so one presentation and one track are made', async () => {
      const { result } = await setupConnectedRoom();
      const peer = mockPeers[0];

      let pictures = 0;
      await act(async () => {
        const first = result.current.toggleScreenShare(photo('a.png'));
        const second = result.current.toggleScreenShare(photo('b.png'));
        pictures = loads.length;
        loads.forEach((load) => load());
        await Promise.all([first, second]);
      });

      expect(pictures).toBe(1);
      expect(mockCaptureStream).toHaveBeenCalledTimes(1);
      expect(result.current.state.screenSharing).toBe(true);
      expect(peer.addTrack).toHaveBeenCalledTimes(1);

      await act(async () => {
        await result.current.toggleScreenShare();
      });
      expect(result.current.state.screenSharing).toBe(false);
      expect(peer.removeTrack).toHaveBeenCalledTimes(1);
    });

    it('lets the next present start once the first has failed to get its source', async () => {
      const { result } = await setupConnectedRoom();
      const peer = mockPeers[0];

      await act(async () => {
        const first = result.current.toggleScreenShare(photo('broken.png'));
        failures.forEach((fail) => fail());
        await first;
      });
      expect(result.current.state.screenSharing).toBe(false);

      await act(async () => {
        const next = result.current.toggleScreenShare(photo('a.png'));
        loads.at(-1)!();
        await next;
      });
      expect(result.current.state.screenSharing).toBe(true);
      expect(peer.addTrack).toHaveBeenCalledTimes(1);
    });
  });

  describe('a choice of files that cannot be presented', () => {
    it('resolves with the reason and presents nothing', async () => {
      const { result } = await setupConnectedRoom();
      const peer = mockPeers[0];
      vi.mocked(presentSlides).mockRejectedValueOnce(new Error('Could not open this PDF.'));

      let reason: string | null = null;
      await act(async () => {
        reason = await result.current.toggleScreenShare([new File(['%PDF'], 'deck.pdf', { type: 'application/pdf' })]);
      });

      expect(reason).toBe('Could not open this PDF.');
      expect(result.current.state.screenSharing).toBe(false);
      expect(result.current.state.slides).toBeNull();
      expect(peer.addTrack).not.toHaveBeenCalled();
    });

    it('resolves with null when the screen picker is dismissed', async () => {
      const { result } = await setupConnectedRoom();
      mockGetDisplayMedia.mockRejectedValueOnce(new DOMException('dismissed', 'NotAllowedError'));

      let reason: string | null = 'unset';
      await act(async () => {
        reason = await result.current.toggleScreenShare();
      });

      expect(reason).toBeNull();
      expect(result.current.state.screenSharing).toBe(false);
    });

    it('resolves with null when another source fails, however it fails', async () => {
      const { result } = await setupConnectedRoom();
      mockGetUserMedia.mockRejectedValueOnce(new Error('Permission denied'));

      let reason: string | null = 'unset';
      await act(async () => {
        reason = await result.current.toggleScreenShare('rear-camera');
      });

      expect(reason).toBeNull();
      expect(result.current.state.screenSharing).toBe(false);
    });

    it('resolves with null when a deck starts and when it stops', async () => {
      const { result } = await setupConnectedRoom();
      const pictures = [new File(['image-bytes'], 'a.png', { type: 'image/png' })];
      const origImage = globalThis.Image;
      globalThis.Image = class {
        naturalWidth = 1200;
        naturalHeight = 800;
        onload: (() => void) | null = null;
        set src(_v: string) {
          setTimeout(() => this.onload?.(), 0);
        }
      } as unknown as typeof Image;

      let started: string | null = 'unset';
      let stopped: string | null = 'unset';
      try {
        await act(async () => {
          started = await result.current.toggleScreenShare(pictures);
        });
        expect(result.current.state.screenSharing).toBe(true);
        await act(async () => {
          stopped = await result.current.toggleScreenShare();
        });
      } finally {
        globalThis.Image = origImage;
      }

      expect([started, stopped]).toEqual([null, null]);
    });
  });
});
