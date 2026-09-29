import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SwitchableMedia,
  isTrackGeneratorSupported,
} from '@/lib/switchable-media';

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
        channelCountMode: 'explicit',
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
  });

  describe('fallback mode when MediaStreamTrackGenerator is missing', () => {
    beforeEach(() => {
      delete (globalThis as any).MediaStreamTrackGenerator;
      delete (globalThis as any).MediaStreamTrackProcessor;
    });

    it('chooses the fallback path when MSTG is missing', () => {
      expect(isTrackGeneratorSupported()).toBe(false);
      const cam = createMockTrack('video', 'cam-1');
      const mic = createMockTrack('audio', 'mic-1');
      const lobbyStream = createMockStream(mic, cam);

      const sm = new SwitchableMedia(lobbyStream);
      expect(sm.isFallback).toBe(true);
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
