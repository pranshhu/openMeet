import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getScreenStream, isScreenShareSupported, presentFile, presentRearCamera } from '@/lib/screen';

describe('screen', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: vi.fn().mockResolvedValue({ id: 'screen' }),
        getUserMedia: vi.fn().mockResolvedValue({ id: 'rear-cam' }),
      },
    });
  });

  it('isScreenShareSupported true when getDisplayMedia exists', () => {
    expect(isScreenShareSupported()).toBe(true);
  });

  it('getScreenStream requests video and audio', async () => {
    await getScreenStream();
    expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: true });
  });

  it('presentRearCamera requests rear camera with facingMode environment and video only', async () => {
    const stream = await presentRearCamera();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: 'environment' },
      audio: false,
    });
    expect(stream).toEqual({ id: 'rear-cam' });
  });

  describe('presentFile', () => {
    let originalCreateObjectURL: any;
    let originalRevokeObjectURL: any;
    let originalAudioContext: any;
    let mockVideoTrack: any;
    let mockCaptureStream: any;
    let mockGetContext: any;
    let mockFillRect: any;
    let mockDrawImage: any;

    beforeEach(() => {
      originalCreateObjectURL = globalThis.URL.createObjectURL;
      originalRevokeObjectURL = globalThis.URL.revokeObjectURL;
      originalAudioContext = globalThis.AudioContext;

      globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock-file');
      globalThis.URL.revokeObjectURL = vi.fn();

      mockVideoTrack = { kind: 'video', stop: vi.fn() };
      mockCaptureStream = vi.fn(() => {
        const tracks = [mockVideoTrack];
        return {
          getTracks: () => tracks,
          getVideoTracks: () => tracks.filter((t: any) => t.kind === 'video'),
          getAudioTracks: () => tracks.filter((t: any) => t.kind === 'audio'),
          addTrack: vi.fn((t: any) => tracks.push(t)),
          removeTrack: vi.fn((t: any) => {
            const idx = tracks.indexOf(t);
            if (idx !== -1) tracks.splice(idx, 1);
          }),
        };
      });
      HTMLCanvasElement.prototype.captureStream = mockCaptureStream;

      mockFillRect = vi.fn();
      mockDrawImage = vi.fn();
      mockGetContext = vi.fn(() => ({
        fillStyle: '',
        fillRect: mockFillRect,
        drawImage: mockDrawImage,
      }));
      HTMLCanvasElement.prototype.getContext = mockGetContext as any;
    });

    afterEach(() => {
      globalThis.URL.createObjectURL = originalCreateObjectURL;
      globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
      globalThis.AudioContext = originalAudioContext;
      vi.restoreAllMocks();
    });

    it('presents an image in fixed 1920x1080 canvas letterboxed and captures stream', async () => {
      const origImage = globalThis.Image;
      class MockImage {
        naturalWidth = 800;
        naturalHeight = 600;
        complete = false;
        onload: (() => void) | null = null;
        set src(_v: string) {
          setTimeout(() => {
            this.complete = true;
            this.onload?.();
          }, 0);
        }
      }
      globalThis.Image = MockImage as any;

      try {
        const file = new File(['fake-image-bytes'], 'photo.png', { type: 'image/png' });
        const { stream, stop } = await presentFile(file);

        expect(mockCaptureStream).toHaveBeenCalledWith(30);
        expect(stream.getVideoTracks().length).toBe(1);
        // A picture is text and detail: it carries no hint and is sent as a screen.
        expect(mockVideoTrack.contentHint).toBeUndefined();
        expect(mockFillRect).toHaveBeenCalledWith(0, 0, 1920, 1080);
        expect(mockDrawImage).toHaveBeenCalled();

        stop();
        expect(mockVideoTrack.stop).toHaveBeenCalled();
        expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-file');
      } finally {
        globalThis.Image = origImage;
      }
    });

    it('repaints an image on a timer so captureStream emits frames continuously, and clears timer on stop', async () => {
      vi.useFakeTimers();
      const origImage = globalThis.Image;
      class MockImage {
        naturalWidth = 800;
        naturalHeight = 600;
        complete = false;
        onload: (() => void) | null = null;
        set src(_v: string) {
          this.complete = true;
          this.onload?.();
        }
      }
      globalThis.Image = MockImage as any;

      try {
        const file = new File(['fake-image-bytes'], 'photo.png', { type: 'image/png' });
        const { stop } = await presentFile(file);

        expect(mockDrawImage).toHaveBeenCalledTimes(1);

        // Advance by 1 second (~5 frames at 5 fps / 200 ms interval)
        vi.advanceTimersByTime(1000);
        expect(mockDrawImage.mock.calls.length).toBeGreaterThanOrEqual(5);

        const callCountBeforeStop = mockDrawImage.mock.calls.length;
        stop();

        // Advancing time further should not trigger any more drawImage calls
        vi.advanceTimersByTime(1000);
        expect(mockDrawImage.mock.calls.length).toBe(callCountBeforeStop);
      } finally {
        globalThis.Image = origImage;
        vi.useRealTimers();
      }
    });

    it('presents a video in fixed 1920x1080 canvas, loops, plays muted locally, and adds audio track', async () => {
      const mockAudioTrack = { kind: 'audio', id: 'video-audio', stop: vi.fn() };
      const mockDest = {
        stream: {
          getAudioTracks: () => [mockAudioTrack],
          getTracks: () => [mockAudioTrack],
        },
      };
      const mockSource = { connect: vi.fn() };
      const mockSpeakers = { id: 'speakers' };
      const mockCloseAudio = vi.fn().mockResolvedValue(undefined);
      class MockAudioContext {
        createMediaElementSource = vi.fn(() => mockSource);
        createMediaStreamDestination = vi.fn(() => mockDest);
        destination = mockSpeakers;
        close = mockCloseAudio;
      }
      globalThis.AudioContext = MockAudioContext as any;

      const origPlay = HTMLMediaElement.prototype.play;
      const origPause = HTMLMediaElement.prototype.pause;
      HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
      HTMLMediaElement.prototype.pause = vi.fn();

      try {
        const file = new File(['fake-video-bytes'], 'clip.mp4', { type: 'video/mp4' });
        const { stream, stop } = await presentFile(file);

        expect(mockCaptureStream).toHaveBeenCalledWith(30);
        expect(mockSource.connect).toHaveBeenCalledWith(mockDest);
        expect(mockSource.connect).not.toHaveBeenCalledWith(mockSpeakers);
        // Video audio track must be added to the presented stream
        expect(stream.getAudioTracks()).toContain(mockAudioTrack);
        // A video is motion: marked here so it is not sent at a screen's frame rate.
        expect(mockVideoTrack.contentHint).toBe('motion');

        stop();
        expect(mockVideoTrack.stop).toHaveBeenCalled();
        expect(mockAudioTrack.stop).toHaveBeenCalled();
        expect(mockCloseAudio).toHaveBeenCalled();
      } finally {
        HTMLMediaElement.prototype.play = origPlay;
        HTMLMediaElement.prototype.pause = origPause;
      }
    });

    it('plays a video on this device too when asked to monitor it', async () => {
      const mockAudioTrack = { kind: 'audio', id: 'video-audio', stop: vi.fn() };
      const mockDest = {
        stream: {
          getAudioTracks: () => [mockAudioTrack],
          getTracks: () => [mockAudioTrack],
        },
      };
      const mockSource = { connect: vi.fn() };
      const mockSpeakers = { id: 'speakers' };
      class MockAudioContext {
        createMediaElementSource = vi.fn(() => mockSource);
        createMediaStreamDestination = vi.fn(() => mockDest);
        destination = mockSpeakers;
        close = vi.fn().mockResolvedValue(undefined);
      }
      globalThis.AudioContext = MockAudioContext as any;

      const origPlay = HTMLMediaElement.prototype.play;
      const origPause = HTMLMediaElement.prototype.pause;
      HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
      HTMLMediaElement.prototype.pause = vi.fn();

      try {
        const file = new File(['fake-video-bytes'], 'clip.mp4', { type: 'video/mp4' });
        const { stream, stop } = await presentFile(file, true);

        expect(mockSource.connect).toHaveBeenCalledWith(mockSpeakers);
        // The call still gets the sound.
        expect(mockSource.connect).toHaveBeenCalledWith(mockDest);
        expect(stream.getAudioTracks()).toContain(mockAudioTrack);
        stop();
      } finally {
        HTMLMediaElement.prototype.play = origPlay;
        HTMLMediaElement.prototype.pause = origPause;
      }
    });
  });
});
