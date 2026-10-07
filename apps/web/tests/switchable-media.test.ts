import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SwitchableMedia,
  isTrackGeneratorSupported,
} from '@/lib/switchable-media';
import { MIC_POLL_MS, MIC_SILENT_AFTER_MS } from '@/lib/mic-watch';

function createMockTrack(kind: 'audio' | 'video', id: string, settings: Record<string, unknown> = {}) {
  return {
    kind,
    id,
    enabled: true,
    stop: vi.fn(),
    getSettings: vi.fn(() => ({ deviceId: id, ...settings })),
    getCapabilities: vi.fn(() => ({})),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaStreamTrack;
}

function createMockStream(audioTrack?: MediaStreamTrack, videoTrack?: MediaStreamTrack) {
  const tracks: MediaStreamTrack[] = [];
  if (audioTrack) tracks.push(audioTrack);
  if (videoTrack) tracks.push(videoTrack);
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    addTrack: vi.fn((t: MediaStreamTrack) => tracks.push(t)),
    removeTrack: vi.fn((t: MediaStreamTrack) => {
      const idx = tracks.indexOf(t);
      if (idx !== -1) tracks.splice(idx, 1);
    }),
  } as unknown as MediaStream;
}

describe('SwitchableMedia', () => {
  let originalAudioContext: unknown;
  let originalMSTG: unknown;
  let originalMSTP: unknown;
  let originalMediaStream: unknown;

  beforeEach(() => {
    originalAudioContext = (globalThis as any).AudioContext;
    originalMSTG = (globalThis as any).MediaStreamTrackGenerator;
    originalMSTP = (globalThis as any).MediaStreamTrackProcessor;
    originalMediaStream = (globalThis as any).MediaStream;

    (globalThis as any).MediaStream = class MockMediaStream {
      private _tracks: MediaStreamTrack[];
      constructor(tracks: MediaStreamTrack[] = []) {
        this._tracks = [...tracks];
      }
      getTracks() {
        return this._tracks;
      }
      getAudioTracks() {
        return this._tracks.filter((t) => t.kind === 'audio');
      }
      getVideoTracks() {
        return this._tracks.filter((t) => t.kind === 'video');
      }
      addTrack(t: MediaStreamTrack) {
        this._tracks.push(t);
      }
      removeTrack(t: MediaStreamTrack) {
        const i = this._tracks.indexOf(t);
        if (i !== -1) this._tracks.splice(i, 1);
      }
    };
  });

  afterEach(() => {
    (globalThis as any).AudioContext = originalAudioContext;
    (globalThis as any).MediaStreamTrackGenerator = originalMSTG;
    (globalThis as any).MediaStreamTrackProcessor = originalMSTP;
    (globalThis as any).MediaStream = originalMediaStream;
    vi.restoreAllMocks();
  });

  describe('when MediaStreamTrackGenerator is supported', () => {
    let mockWriter: { write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
    let mockGeneratorTrack: MediaStreamTrack;
    let mockReader: { read: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
    let mockDestTrack: MediaStreamTrack;
    let mockAudioCtx: any;
    let mockSourceNode: any;
    let mockDestinationNode: any;

    beforeEach(() => {
      mockWriter = {
        write: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      mockGeneratorTrack = {
        kind: 'video',
        id: 'stable-gen-track-id',
        enabled: true,
        stop: vi.fn(),
        getSettings: vi.fn(() => ({})),
        getCapabilities: vi.fn(() => ({})),
      } as unknown as MediaStreamTrack;

      (globalThis as any).MediaStreamTrackGenerator = vi.fn().mockImplementation(() => {
        return Object.assign(mockGeneratorTrack, {
          writable: {
            getWriter: () => mockWriter,
          },
        });
      });

      mockReader = {
        read: vi.fn().mockResolvedValue({ done: true, value: null }),
        cancel: vi.fn().mockResolvedValue(undefined),
      };

      (globalThis as any).MediaStreamTrackProcessor = vi.fn().mockImplementation(() => {
        return {
          readable: {
            getReader: () => mockReader,
          },
        };
      });

      mockDestTrack = {
        kind: 'audio',
        id: 'stable-dest-audio-id',
        enabled: true,
        stop: vi.fn(),
        getSettings: vi.fn(() => ({ sampleRate: 48000, channelCount: 2 })),
      } as unknown as MediaStreamTrack;

      mockSourceNode = {
        connect: vi.fn(),
        disconnect: vi.fn(),
      };

      mockDestinationNode = {
        stream: new (globalThis as any).MediaStream([mockDestTrack]),
        channelCount: 2,
        channelCountMode: 'max',
      };

      mockAudioCtx = {
        sampleRate: 48000,
        state: 'running',
        createMediaStreamDestination: vi.fn(() => mockDestinationNode),
        createMediaStreamSource: vi.fn(() => mockSourceNode),
        close: vi.fn().mockResolvedValue(undefined),
      };

      (globalThis as any).AudioContext = vi.fn().mockImplementation(() => mockAudioCtx);
    });

    it('detects track generator support', () => {
      expect(isTrackGeneratorSupported()).toBe(true);
    });

    it('builds the audio graph at 48 kHz for a microphone at another rate', () => {
      const mic = createMockTrack('audio', 'mic-1', { sampleRate: 44100, channelCount: 1 });
      const lobbyStream = createMockStream(mic);
      new SwitchableMedia(lobbyStream);
      expect((globalThis as any).AudioContext).toHaveBeenCalledWith({ sampleRate: 48000 });
      expect(mockDestinationNode.channelCount).toBe(1);
      expect(mockDestinationNode.channelCountMode).toBe('explicit');
    });

    it('defaults destination channelCount to 1 when mic reports no channelCount', () => {
      const mic = createMockTrack('audio', 'mic-1', { sampleRate: 44100 });
      const lobbyStream = createMockStream(mic);
      new SwitchableMedia(lobbyStream);
      expect(mockDestinationNode.channelCount).toBe(1);
    });

    it('resumes suspended AudioContext on construction', () => {
      const resume = vi.fn().mockResolvedValue(undefined);
      (globalThis as any).AudioContext = vi.fn().mockImplementation(() => ({
        ...mockAudioCtx,
        state: 'suspended',
        resume,
      }));
      const mic = createMockTrack('audio', 'mic-1');
      new SwitchableMedia(createMockStream(mic));
      expect(resume).toHaveBeenCalled();
    });

    it('initializes stable audio track enabled state from mic track', () => {
      const mic = createMockTrack('audio', 'mic-1', { sampleRate: 48000, channelCount: 1 });
      mic.enabled = false;
      const sm = new SwitchableMedia(createMockStream(mic));
      expect(sm.stream.getAudioTracks()[0]?.enabled).toBe(false);
    });

    it('closes the audio context on stop', () => {
      const mic = createMockTrack('audio', 'mic-1');
      const sm = new SwitchableMedia(createMockStream(mic));
      sm.stop();
      expect(mockAudioCtx.close).toHaveBeenCalled();
    });

    it('swaps camera and mic sources without changing stable track IDs, and stops the old devices', async () => {
      const initialCam = createMockTrack('video', 'cam-1', { width: 1280, height: 720 });
      const initialMic = createMockTrack('audio', 'mic-1', { sampleRate: 48000, channelCount: 1 });
      const lobbyStream = createMockStream(initialMic, initialCam);

      const nextCam = createMockTrack('video', 'cam-2', { width: 1920, height: 1080 });
      const nextMic = createMockTrack('audio', 'mic-2', { sampleRate: 44100, channelCount: 2 });

      const getUserMedia = vi.fn().mockImplementation(async (constraints: MediaStreamConstraints) => {
        if (constraints.video) {
          return createMockStream(undefined, nextCam);
        }
        if (constraints.audio) {
          return createMockStream(nextMic, undefined);
        }
        throw new Error('invalid request');
      });

      vi.stubGlobal('navigator', {
        userAgent: 'test-desktop',
        mediaDevices: { getUserMedia },
      });

      const sm = new SwitchableMedia(lobbyStream);

      expect(sm.stream.getVideoTracks()[0]?.id).toBe('stable-gen-track-id');
      expect(sm.stream.getAudioTracks()[0]?.id).toBe('stable-dest-audio-id');
      expect(sm.isFallback).toBe(false);

      // Real settings come from the real track
      expect(sm.stream.getVideoTracks()[0]?.getSettings().deviceId).toBe('cam-1');
      expect(sm.stream.getVideoTracks()[0]?.getSettings().width).toBe(1280);

      // Switch camera
      await sm.switchCamera('cam-2');

      // The stable video track id MUST NOT change
      expect(sm.stream.getVideoTracks()[0]?.id).toBe('stable-gen-track-id');
      // But real settings now reflect the new device
      expect(sm.stream.getVideoTracks()[0]?.getSettings().deviceId).toBe('cam-2');
      expect(sm.stream.getVideoTracks()[0]?.getSettings().width).toBe(1920);

      // The old camera track was stopped
      expect(initialCam.stop).toHaveBeenCalled();
      // Reader on old track was cancelled
      expect(mockReader.cancel).toHaveBeenCalled();

      // Switch mic
      await sm.switchMic('mic-2');

      // The stable audio track id MUST NOT change
      expect(sm.stream.getAudioTracks()[0]?.id).toBe('stable-dest-audio-id');
      // Fixed AudioContext is kept; no second context is created
      expect((globalThis as any).AudioContext).toHaveBeenCalledTimes(1);
      // The old mic was disconnected and stopped
      expect(mockSourceNode.disconnect).toHaveBeenCalled();
      expect(initialMic.stop).toHaveBeenCalled();

      // Constraints re-applied with DSP off
      const audioCall = getUserMedia.mock.calls.find((call) => call[0].audio);
      expect(audioCall).toBeDefined();
      const audioConstraints = audioCall![0].audio;
      expect(audioConstraints.echoCancellation).toBe(false);
      expect(audioConstraints.noiseSuppression).toBe(false);
      expect(audioConstraints.autoGainControl).toBe(false);
      expect(audioConstraints.deviceId).toEqual({ exact: 'mic-2' });
    });

    it('preserves the active camera quality preset when switching cameras', async () => {
      // Camera started in 4K (height 2160)
      const initialCam = createMockTrack('video', 'cam-1', { width: 3840, height: 2160 });
      const initialMic = createMockTrack('audio', 'mic-1', { sampleRate: 48000, channelCount: 1 });
      const lobbyStream = createMockStream(initialMic, initialCam);

      const nextCam = createMockTrack('video', 'cam-2', { width: 3840, height: 2160 });
      const getUserMedia = vi.fn().mockImplementation(async (constraints: MediaStreamConstraints) => {
        if (constraints.video) {
          return createMockStream(undefined, nextCam);
        }
        throw new Error('unexpected call');
      });

      vi.stubGlobal('navigator', {
        userAgent: 'test-desktop',
        mediaDevices: { getUserMedia },
      });

      // No qualityId passed in options, matching useRoom.join
      const sm = new SwitchableMedia(lobbyStream);
      await sm.switchCamera('cam-2');

      const videoCall = getUserMedia.mock.calls.find((call) => call[0].video);
      expect(videoCall).toBeDefined();
      const videoConstraints = videoCall![0].video as MediaTrackConstraints;
      expect(videoConstraints.height).toEqual({ ideal: 2160 });
      expect(videoConstraints.width).toEqual({ ideal: 3840 });
    });

    it('exposes real active mic and camera device IDs across switches', async () => {
      const initialCam = createMockTrack('video', 'cam-1', { width: 1280, height: 720 });
      const initialMic = createMockTrack('audio', 'mic-1', { sampleRate: 48000, channelCount: 1 });
      const lobbyStream = createMockStream(initialMic, initialCam);

      const nextCam = createMockTrack('video', 'cam-2');
      const nextMic = createMockTrack('audio', 'mic-2');

      const getUserMedia = vi.fn().mockImplementation(async (constraints: MediaStreamConstraints) => {
        if (constraints.video) return createMockStream(undefined, nextCam);
        if (constraints.audio) return createMockStream(nextMic, undefined);
        throw new Error('unexpected');
      });

      vi.stubGlobal('navigator', {
        userAgent: 'test-desktop',
        mediaDevices: { getUserMedia },
      });

      const sm = new SwitchableMedia(lobbyStream);
      expect(sm.activeMicId).toBe('mic-1');
      expect(sm.activeCamId).toBe('cam-1');

      await sm.switchMic('mic-2');
      expect(sm.activeMicId).toBe('mic-2');

      await sm.switchCamera('cam-2');
      expect(sm.activeCamId).toBe('cam-2');
    });

    describe('mic level watch', () => {
      let mockSplitter: { connect: ReturnType<typeof vi.fn> };
      let analysers: unknown[];
      let level: number;

      beforeEach(() => {
        vi.useFakeTimers();
        mockSplitter = { connect: vi.fn() };
        analysers = [];
        level = 0;
        mockAudioCtx.createChannelSplitter = vi.fn(() => mockSplitter);
        mockAudioCtx.createAnalyser = vi.fn(() => {
          const analyser = {
            fftSize: 2048,
            context: mockAudioCtx,
            getFloatTimeDomainData: (into: Float32Array) => {
              into.fill(level);
            },
          };
          analysers.push(analyser);
          return analyser;
        });
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      it('reports a dead mic with the tap beside the recorded path', () => {
        const initialCam = createMockTrack('video', 'cam-1');
        const initialMic = createMockTrack('audio', 'mic-1', { sampleRate: 48000, channelCount: 1 });
        const lobbyStream = createMockStream(initialMic, initialCam);

        level = 0;
        const onMicWarning = vi.fn();
        const sm = new SwitchableMedia(lobbyStream, { onMicWarning });

        expect(mockSourceNode.connect).toHaveBeenCalledWith(mockDestinationNode);
        expect(mockSourceNode.connect).toHaveBeenCalledWith(mockSplitter);
        expect(mockSplitter.connect).toHaveBeenCalledWith(analysers[0], 0);
        expect(mockSplitter.connect).toHaveBeenCalledWith(analysers[1], 1);
        expect(mockSplitter.connect).toHaveBeenCalledTimes(2);
        expect(mockAudioCtx.createChannelSplitter).toHaveBeenCalledWith(2);

        vi.advanceTimersByTime(MIC_SILENT_AFTER_MS + 2 * MIC_POLL_MS);
        expect(onMicWarning).toHaveBeenCalledTimes(1);
        expect(onMicWarning).toHaveBeenCalledWith('silent');

        sm.stop();
      });

      it('does not report silent when off in the app on purpose', () => {
        const initialCam = createMockTrack('video', 'cam-1');
        const initialMic = createMockTrack('audio', 'mic-1', { sampleRate: 48000, channelCount: 1 });
        const lobbyStream = createMockStream(initialMic, initialCam);

        level = 0;
        const onMicWarning = vi.fn();
        const sm = new SwitchableMedia(lobbyStream, { onMicWarning });

        sm.setAudioEnabled(false);
        vi.advanceTimersByTime(6 * MIC_SILENT_AFTER_MS);
        expect(onMicWarning).not.toHaveBeenCalled();

        sm.setAudioEnabled(true);
        vi.advanceTimersByTime(MIC_SILENT_AFTER_MS + 2 * MIC_POLL_MS);
        expect(onMicWarning).toHaveBeenCalledWith('silent');

        sm.setAudioEnabled(false);
        vi.advanceTimersByTime(MIC_POLL_MS);
        expect(onMicWarning).toHaveBeenLastCalledWith(null);

        sm.stop();
      });

      it('watches a switched mic and judges it by its own on/off', async () => {
        const nextMic = createMockTrack('audio', 'mic-2');
        const getUserMedia = vi.fn().mockImplementation(async (constraints: MediaStreamConstraints) => {
          if (constraints.audio) return createMockStream(nextMic, undefined);
          throw new Error('unexpected');
        });

        vi.stubGlobal('navigator', {
          userAgent: 'test-desktop',
          mediaDevices: { getUserMedia },
        });

        const initialCam = createMockTrack('video', 'cam-1');
        const initialMic = createMockTrack('audio', 'mic-1', { sampleRate: 48000, channelCount: 1 });
        const lobbyStream = createMockStream(initialMic, initialCam);

        level = 0;
        const onMicWarning = vi.fn();
        const sm = new SwitchableMedia(lobbyStream, { onMicWarning });

        const second = { connect: vi.fn(), disconnect: vi.fn() };
        mockAudioCtx.createMediaStreamSource.mockReturnValueOnce(second);

        await sm.switchMic('mic-2');
        expect(second.connect).toHaveBeenCalledWith(mockDestinationNode);
        expect(second.connect).toHaveBeenCalledWith(mockSplitter);

        sm.setAudioEnabled(false);
        vi.advanceTimersByTime(6 * MIC_SILENT_AFTER_MS);
        expect(onMicWarning).not.toHaveBeenCalled();

        sm.stop();
      });

      it('ends the watch on stop and does not throw on second stop', () => {
        const initialCam = createMockTrack('video', 'cam-1');
        const initialMic = createMockTrack('audio', 'mic-1', { sampleRate: 48000, channelCount: 1 });
        const lobbyStream = createMockStream(initialMic, initialCam);

        level = 0;
        const onMicWarning = vi.fn();
        const sm = new SwitchableMedia(lobbyStream, { onMicWarning });

        sm.stop();
        vi.advanceTimersByTime(6 * MIC_SILENT_AFTER_MS);
        expect(onMicWarning).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);

        expect(() => sm.stop()).not.toThrow();
      });

      it('never stands in the way of joining or recording', () => {
        const initialCam = createMockTrack('video', 'cam-1');
        const initialMic = createMockTrack('audio', 'mic-1', { sampleRate: 48000, channelCount: 1 });
        const lobbyStream = createMockStream(initialMic, initialCam);

        // Without onMicWarning
        const sm1 = new SwitchableMedia(lobbyStream);
        expect(mockAudioCtx.createAnalyser).not.toHaveBeenCalled();
        expect(mockAudioCtx.createChannelSplitter).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        sm1.stop();

        // With onMicWarning and throwing createAnalyser
        mockAudioCtx.createAnalyser = vi.fn(() => {
          throw new Error('analyser not supported');
        });
        const onMicWarning = vi.fn();
        const sm2 = new SwitchableMedia(lobbyStream, { onMicWarning });
        expect(sm2.stream.getAudioTracks()[0]?.id).toBe('stable-dest-audio-id');
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(6 * MIC_SILENT_AFTER_MS);
        expect(onMicWarning).not.toHaveBeenCalled();
        sm2.stop();
      });
    });
  });

  describe('fallback mode when MediaStreamTrackGenerator is missing', () => {
    let audioCtxSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      delete (globalThis as any).MediaStreamTrackGenerator;
      delete (globalThis as any).MediaStreamTrackProcessor;
      audioCtxSpy = vi.fn();
      (globalThis as any).AudioContext = audioCtxSpy;
    });

    it('chooses the fallback path when MSTG is missing', () => {
      expect(isTrackGeneratorSupported()).toBe(false);
      const cam = createMockTrack('video', 'cam-1');
      const mic = createMockTrack('audio', 'mic-1');
      const lobbyStream = createMockStream(mic, cam);

      const sm = new SwitchableMedia(lobbyStream);
      expect(sm.isFallback).toBe(true);
      expect(audioCtxSpy).not.toHaveBeenCalled();
      // Keeps the raw tracks directly
      expect(sm.stream.getVideoTracks()[0]?.id).toBe('cam-1');
      expect(sm.stream.getAudioTracks()[0]?.id).toBe('mic-1');
    });

    it('uses replaceTrack on peer senders and refuses switching during a take', async () => {
      const initialCam = createMockTrack('video', 'cam-1');
      const initialMic = createMockTrack('audio', 'mic-1');
      const lobbyStream = createMockStream(initialMic, initialCam);

      const nextCam = createMockTrack('video', 'cam-2');
      const getUserMedia = vi.fn().mockResolvedValue(createMockStream(undefined, nextCam));

      vi.stubGlobal('navigator', {
        userAgent: 'test-safari',
        mediaDevices: { getUserMedia },
      });

      let recording = false;
      const onTrackReplaced = vi.fn();

      const sm = new SwitchableMedia(lobbyStream, {
        isRecording: () => recording,
        onTrackReplaced,
      });

      // While NOT recording, switching succeeds and notifies peer replacement
      await sm.switchCamera('cam-2');
      expect(onTrackReplaced).toHaveBeenCalledWith('video', nextCam, initialCam);
      expect(initialCam.stop).toHaveBeenCalled();
      expect(sm.stream.getVideoTracks()[0]?.id).toBe('cam-2');

      // Now start a take
      recording = true;

      // During a take, switching is refused
      await expect(sm.switchCamera('cam-1')).rejects.toThrow(/after this take/i);
    });
  });
});
