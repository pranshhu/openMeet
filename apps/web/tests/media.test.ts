import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MediaManager, MediaPermissionError, RECORDING_CONSTRAINTS } from '@/lib/media';

function fakeStream(): MediaStream {
  const tracks = [
    { kind: 'audio', enabled: true, stop: vi.fn() },
    { kind: 'video', enabled: true, stop: vi.fn() },
  ];
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  } as unknown as MediaStream;
}

describe('MediaManager', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(fakeStream()),
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: 'audioinput', deviceId: 'mic1', label: 'Mic 1' },
          { kind: 'videoinput', deviceId: 'cam1', label: 'Cam 1' },
        ]),
      },
    });
  });

  it('acquires a stream with audio + video', async () => {
    const mm = new MediaManager();
    const stream = await mm.acquire();
    expect(stream.getTracks().length).toBe(2);
  });

  it('forwards capture constraints to getUserMedia', async () => {
    const mm = new MediaManager();
    await mm.acquire(RECORDING_CONSTRAINTS);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(RECORDING_CONSTRAINTS);
    const v = RECORDING_CONSTRAINTS.video as MediaTrackConstraints;
    expect(v.height).toEqual({ ideal: 1080 });
  });

  it('throws MediaPermissionError on NotAllowedError', async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    );
    const mm = new MediaManager();
    await expect(mm.acquire()).rejects.toBeInstanceOf(MediaPermissionError);
  });

  it('lists input devices split by kind', async () => {
    const mm = new MediaManager();
    const devices = await mm.listDevices();
    expect(devices.audioInputs).toEqual([{ deviceId: 'mic1', label: 'Mic 1' }]);
    expect(devices.videoInputs).toEqual([{ deviceId: 'cam1', label: 'Cam 1' }]);
  });

  it('toggles audio/video track enabled state', async () => {
    const mm = new MediaManager();
    const stream = await mm.acquire();
    mm.setAudioEnabled(false);
    expect(stream.getAudioTracks()[0]!.enabled).toBe(false);
    mm.setVideoEnabled(false);
    expect(stream.getVideoTracks()[0]!.enabled).toBe(false);
  });
});
