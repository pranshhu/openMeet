import { describe, it, expect, afterEach } from 'vitest';
import { ChunkRecorder, mimeForStream } from '@/lib/recorder';
import { BackupRecorder } from '@/lib/backup-recorder';
import { startHostRecording, endHostRecording } from '@/hooks/recording-controller';
import { FakeDirectoryHandle } from './fake-opfs';

const VIDEO_AAC = 'video/mp4;codecs=avc3.42E01F,mp4a.40.2';
const VIDEO_OPUS = 'video/mp4;codecs=avc3.42E01F,opus';
const AUDIO_AAC = 'audio/mp4;codecs=mp4a.40.2';
const AUDIO_OPUS = 'audio/mp4;codecs=opus';

type Supported = (m: string) => boolean;

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported: Supported = () => true;
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  state = 'inactive';
  constructor(
    public stream: unknown,
    public opts: MediaRecorderOptions
  ) {
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.onstop?.();
  }
}

function install(isTypeSupported: Supported) {
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.isTypeSupported = isTypeSupported;
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
}

afterEach(() => {
  delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
});

const mic = { kind: 'audio', enabled: true, getSettings: () => ({ sampleRate: 48000, channelCount: 1 }) };
const cam = { kind: 'video', enabled: true, getSettings: () => ({ width: 1280, height: 720, frameRate: 30 }) };

const micOnly = () =>
  Object.assign(new EventTarget(), {
    getTracks: () => [mic],
    getAudioTracks: () => [mic],
    getVideoTracks: () => [],
  }) as unknown as MediaStream;
const withCamera = () =>
  Object.assign(new EventTarget(), {
    getTracks: () => [mic, cam],
    getAudioTracks: () => [mic],
    getVideoTracks: () => [cam],
  }) as unknown as MediaStream;

const mr = (stream: MediaStream, opts: MediaRecorderOptions) =>
  new FakeMediaRecorder(stream, opts) as unknown as MediaRecorder;

function fakeFolder(opened: string[] = []) {
  return {
    getFileHandle: async (name: string) => {
      opened.push(name);
      return { name, createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
    },
  };
}

describe('mimeForStream', () => {
  it('names no video codec for a stream with no camera, and keeps the container', () => {
    install(() => true);
    expect(mimeForStream(micOnly(), VIDEO_AAC)).toBe(AUDIO_AAC);
  });

  it('uses Opus in MP4 where there is no AAC encoder', () => {
    install((m) => !m.includes('mp4a'));
    expect(mimeForStream(micOnly(), VIDEO_OPUS)).toBe(AUDIO_OPUS);
  });

  it('never puts WebM behind an .mp4 name', () => {
    install((m) => m.startsWith('video/mp4') || m === 'audio/webm;codecs=opus');
    expect(mimeForStream(micOnly(), VIDEO_AAC)).toBe(VIDEO_AAC);
  });

  it('hands back any other mime, and the mime of a stream with a camera', () => {
    install(() => true);
    expect(mimeForStream(withCamera(), VIDEO_AAC)).toBe(VIDEO_AAC);
    expect(mimeForStream(micOnly(), 'audio/webm;codecs=opus')).toBe('audio/webm;codecs=opus');
    expect(mimeForStream(micOnly(), 'audio/wav')).toBe('audio/wav');
    // A call-audio copy is already audio in MP4: its mime is kept.
    expect(mimeForStream(micOnly(), AUDIO_OPUS)).toBe(AUDIO_OPUS);
    // A stream that cannot say is taken to have a camera.
    expect(mimeForStream(new EventTarget() as unknown as MediaStream, VIDEO_AAC)).toBe(VIDEO_AAC);
  });

  it('leaves the mime alone where nothing can be asked', () => {
    expect(mimeForStream(micOnly(), VIDEO_AAC)).toBe(VIDEO_AAC);
  });

  it('keeps the video mime for a camera that is only turned off', () => {
    install(() => true);
    const off = { ...cam, enabled: false };
    const stream = Object.assign(new EventTarget(), {
      getTracks: () => [mic, off],
      getAudioTracks: () => [mic],
      getVideoTracks: () => [off],
    }) as unknown as MediaStream;
    expect(mimeForStream(stream, VIDEO_OPUS)).toBe(VIDEO_OPUS);
  });
});

describe('recorders started on a stream with no camera', () => {
  it('ChunkRecorder asks for audio in MP4', () => {
    install(() => true);
    const rec = new ChunkRecorder({ stream: micOnly(), mimeType: VIDEO_AAC, mrFactory: mr, onChunk: () => {} });
    rec.start();
    expect(FakeMediaRecorder.instances.at(-1)!.opts.mimeType).toBe(AUDIO_AAC);
  });

  it('ChunkRecorder keeps the video mime for a stream with a camera', () => {
    install(() => true);
    const rec = new ChunkRecorder({ stream: withCamera(), mimeType: VIDEO_AAC, mrFactory: mr, onChunk: () => {} });
    rec.start();
    expect(FakeMediaRecorder.instances.at(-1)!.opts.mimeType).toBe(VIDEO_AAC);
  });

  it('BackupRecorder asks for audio in MP4, and for video when there is a camera', () => {
    install(() => true);
    new BackupRecorder({ stream: micOnly(), mimeType: VIDEO_AAC, mrFactory: mr }).start();
    expect(FakeMediaRecorder.instances.at(-1)!.opts.mimeType).toBe(AUDIO_AAC);
    new BackupRecorder({ stream: withCamera(), mimeType: VIDEO_AAC, mrFactory: mr }).start();
    expect(FakeMediaRecorder.instances.at(-1)!.opts.mimeType).toBe(VIDEO_AAC);
  });

  // Platforms lowercase the type of a Blob or File.
  it('a backup of a stream with no camera keeps the mime it was asked for, in memory', async () => {
    install(() => true);
    const backup = new BackupRecorder({ stream: micOnly(), mimeType: VIDEO_AAC, mrFactory: mr });
    backup.start();
    FakeMediaRecorder.instances.at(-1)!.ondataavailable!({ data: new Blob([new Uint8Array([1, 2, 3])]) });
    const blob = await backup.stop();
    expect(blob?.type).toBe(VIDEO_AAC.toLowerCase());
  });

  it('a backup of a stream with no camera is saved as an .mp4 file under the usual name', async () => {
    install(() => true);
    const root = new FakeDirectoryHandle('root');
    const backup = new BackupRecorder({
      stream: micOnly(),
      mimeType: VIDEO_AAC,
      mrFactory: mr,
      opfsRoot: async () => root as never,
      room: 'abc-defg-hij',
    });
    backup.start();
    await Promise.resolve();
    FakeMediaRecorder.instances.at(-1)!.ondataavailable!({ data: new Blob([new Uint8Array([1, 2, 3])]) });
    await new Promise((r) => setTimeout(r, 10));
    const file = (await backup.stop()) as File | null;
    expect(file?.name).toMatch(/^openmeet-backup-\d+-abc-defg-hij\.mp4$/);
    expect(file?.type).toBe(VIDEO_AAC.toLowerCase());
  });
});

describe('a host with a microphone and no camera', () => {
  it('records the same file names with no video codec, in the take and in its backup', async () => {
    install(() => true);
    const opened: string[] = [];
    const handles = await startHostRecording({
      recordingId: 'r1',
      localStream: micOnly(),
      dir: fakeFolder(opened) as never,
      journal: false,
    });
    try {
      expect(opened).toContain('host_r1.mp4');
      expect(opened).toContain('guest_r1.mp4');
      // The take's recorder and its backup: one MediaRecorder each.
      expect(FakeMediaRecorder.instances.map((r) => r.opts.mimeType)).toEqual([AUDIO_AAC, AUDIO_AAC]);
    } finally {
      await endHostRecording(handles);
    }
  });
});

describe('a host with a camera', () => {
  it('records the video mime in the take and in its backup', async () => {
    install(() => true);
    const handles = await startHostRecording({
      recordingId: 'r2',
      localStream: withCamera(),
      dir: fakeFolder() as never,
      journal: false,
    });
    try {
      expect(FakeMediaRecorder.instances.map((r) => r.opts.mimeType)).toEqual([VIDEO_AAC, VIDEO_AAC]);
    } finally {
      await endHostRecording(handles);
    }
  });
});
