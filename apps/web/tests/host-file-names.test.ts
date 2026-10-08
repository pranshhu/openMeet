import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  startHostRecording,
  endHostRecording,
  startScreenRecording,
  stopScreenRecording,
} from '@/hooks/recording-controller';

class FakeMediaRecorder {
  static isTypeSupported = (_m: string) => true;
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  state = 'inactive';
  constructor(public stream: unknown, public opts: unknown) {}
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.onstop?.(); }
}
class FakeTrackProcessor {
  readable = new ReadableStream({ start(controller) { controller.close(); } });
}
function namedDir(opened: string[]) {
  return {
    getFileHandle: async (name: string) => {
      opened.push(name);
      return { name, createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
    },
  };
}
function avStream() {
  const videoTrack = { getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }) };
  const audioTrack = {};
  return {
    getTracks: () => [videoTrack, audioTrack],
    getVideoTracks: () => [videoTrack],
    getAudioTracks: () => [audioTrack],
  } as unknown as MediaStream;
}
const noMedia = { getTracks: () => [], getVideoTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream;

describe('host file names', () => {
  beforeEach(() => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
    (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor = FakeTrackProcessor;
  });
  afterEach(() => {
    delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    delete (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor;
  });

  it("puts the host's cleaned name in the host's MP4 and WAV names", async () => {
    const opened: string[] = [];
    const handles = await startHostRecording({
      recordingId: 'r1',
      localStream: avStream(),
      dir: namedDir(opened) as never,
      hostName: 'Ana / María',
      take: 2,
    });
    expect(opened).toContain('host-ana-maría_r1_take2.mp4');
    expect(opened).toContain('host-ana-maría_r1_take2.wav');
    await endHostRecording(handles);
  });

  it('keeps the plain names when the host has no usable name', async () => {
    const opened: string[] = [];
    const handles = await startHostRecording({
      recordingId: 'r1',
      localStream: avStream(),
      dir: namedDir(opened) as never,
      hostName: '😀',
    });
    expect(opened).toContain('host_r1.mp4');
    expect(opened).toContain('host_r1.wav');
    await endHostRecording(handles);
  });

  it("puts the host's name in each of the host's screen files, from the take's handles", async () => {
    const opened: string[] = [];
    const screen = () => {
      const track = { readyState: 'live', getSettings: () => ({ width: 2560, height: 1440 }) };
      return { getVideoTracks: () => [track], getAudioTracks: () => [], getTracks: () => [track] } as unknown as MediaStream;
    };
    // Real handles, so the name has to travel from startHostRecording to the screen file.
    const handles = await startHostRecording({
      recordingId: 'rec1',
      localStream: noMedia,
      dir: namedDir(opened) as never,
      hostName: 'Ana María',
    });
    opened.length = 0;
    await startScreenRecording(handles, screen(), 'host', null);
    await stopScreenRecording(handles);
    await startScreenRecording(handles, screen(), 'host', null);
    await stopScreenRecording(handles);
    expect(opened).toEqual(['host-ana-maría_screen_rec1.mp4', 'host-ana-maría_screen_rec1_2.mp4']);
    await endHostRecording(handles);
  });

  it('probes the folder with the same name it will open after a resume', async () => {
    const opened: string[] = [];
    const held = new Set(['host-ana_screen_rec1.mp4']);
    const dir = {
      getFileHandle: async (name: string, opts?: { create?: boolean }) => {
        if (opts?.create) {
          if (held.has(name)) throw new Error(`would replace ${name}`);
          opened.push(name);
        } else if (!held.has(name)) {
          throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
        }
        return { name, createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
      },
    };
    const track = { readyState: 'live', getSettings: () => ({ width: 2560, height: 1440 }) };
    const screen = {
      getVideoTracks: () => [track],
      getAudioTracks: () => [],
      getTracks: () => [track],
    } as unknown as MediaStream;
    const handles = { recordingId: 'rec1', dir, hostName: 'Ana', resumed: true } as never;

    await startScreenRecording(handles, screen, 'host', null);
    expect(opened).toEqual(['host-ana_screen_rec1_2.mp4']);
    await stopScreenRecording(handles);
  });
});
