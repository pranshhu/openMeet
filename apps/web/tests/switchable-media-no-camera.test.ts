import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SwitchableMedia } from '@/lib/switchable-media';

function track(kind: 'audio' | 'video', id: string) {
  return {
    kind,
    id,
    enabled: true,
    stop: vi.fn(),
    getSettings: vi.fn(() => ({ deviceId: id })),
    getCapabilities: vi.fn(() => ({})),
  } as unknown as MediaStreamTrack;
}

class FakeStream {
  private tracks: MediaStreamTrack[];
  constructor(tracks: MediaStreamTrack[] = []) {
    this.tracks = [...tracks];
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  addTrack(t: MediaStreamTrack) {
    this.tracks.push(t);
  }
  removeTrack(t: MediaStreamTrack) {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
}

const lobby = (...tracks: MediaStreamTrack[]) => new FakeStream(tracks) as unknown as MediaStream;

describe('SwitchableMedia for a person who joined without a camera', () => {
  const g = globalThis as Record<string, unknown>;
  const names = ['MediaStream', 'MediaStreamTrackGenerator', 'MediaStreamTrackProcessor', 'AudioContext'];
  let saved: Record<string, unknown>;
  let writer: { write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  let getUserMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    saved = Object.fromEntries(names.map((n) => [n, g[n]]));
    writer = { write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    g.MediaStream = FakeStream;
    g.MediaStreamTrackGenerator = vi
      .fn()
      .mockImplementation(() => Object.assign(track('video', 'stable-video'), { writable: { getWriter: () => writer } }));
    g.MediaStreamTrackProcessor = vi.fn().mockImplementation(() => ({
      readable: {
        getReader: () => ({
          read: vi.fn().mockResolvedValue({ done: true, value: null }),
          cancel: vi.fn().mockResolvedValue(undefined),
        }),
      },
    }));
    g.AudioContext = vi.fn().mockImplementation(() => ({
      sampleRate: 48000,
      state: 'running',
      createMediaStreamDestination: () => ({
        stream: new FakeStream([track('audio', 'stable-audio')]),
        channelCount: 2,
        channelCountMode: 'max',
      }),
      createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
      close: vi.fn().mockResolvedValue(undefined),
    }));
    getUserMedia = vi.fn().mockResolvedValue(new FakeStream([track('video', 'cam-2')]));
    vi.stubGlobal('navigator', { userAgent: 'test-desktop', mediaDevices: { getUserMedia } });
  });

  afterEach(() => {
    for (const n of names) g[n] = saved[n];
    vi.unstubAllGlobals();
  });

  it('builds a stream with the microphone and no video track', () => {
    const sm = new SwitchableMedia(lobby(track('audio', 'mic-1')));
    expect(sm.stream.getVideoTracks()).toHaveLength(0);
    expect(sm.stream.getAudioTracks().map((t) => t.id)).toEqual(['stable-audio']);
  });

  it('keeps the stable video track when the lobby stream has a camera', () => {
    const sm = new SwitchableMedia(lobby(track('audio', 'mic-1'), track('video', 'cam-1')));
    expect(sm.stream.getVideoTracks().map((t) => t.id)).toEqual(['stable-video']);
  });

  it('opens no camera when asked to switch to one', async () => {
    const sm = new SwitchableMedia(lobby(track('audio', 'mic-1')));
    await sm.switchCamera('cam-2');
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(sm.stream.getVideoTracks()).toHaveLength(0);
  });

  it('still switches cameras for a person who joined with one', async () => {
    const sm = new SwitchableMedia(lobby(track('audio', 'mic-1'), track('video', 'cam-1')));
    await sm.switchCamera('cam-2');
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(sm.activeCamId).toBe('cam-2');
  });

  it('still closes its video writer when stopped', () => {
    const sm = new SwitchableMedia(lobby(track('audio', 'mic-1')));
    sm.stop();
    expect(writer.close).toHaveBeenCalledTimes(1);
  });

  it('opens no camera on the path without a track generator either', async () => {
    g.MediaStreamTrackGenerator = undefined;
    const sm = new SwitchableMedia(lobby(track('audio', 'mic-1')));
    expect(sm.isFallback).toBe(true);
    await sm.switchCamera('cam-2');
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(sm.stream.getVideoTracks()).toHaveLength(0);
  });

  it('still switches cameras on that path for a person who joined with one', async () => {
    g.MediaStreamTrackGenerator = undefined;
    const sm = new SwitchableMedia(lobby(track('audio', 'mic-1'), track('video', 'cam-1')));
    expect(sm.isFallback).toBe(true);
    await sm.switchCamera('cam-2');
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(sm.stream.getVideoTracks().map((t) => t.id)).toEqual(['cam-2']);
  });
});
