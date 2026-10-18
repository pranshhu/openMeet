import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  guestName,
  bindHostScreenChannel,
  startHostRecording,
  endHostRecording,
  startScreenRecording,
  stopScreenRecording,
  type RecordingHandles,
} from '@/hooks/recording-controller';
import { FakeDirectoryHandle } from './fake-opfs';

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

  it("ends each of the host's screen files of a later take in _take<n>", async () => {
    const screen = () => {
      const track = { readyState: 'live', getSettings: () => ({ width: 2560, height: 1440 }) };
      return { getVideoTracks: () => [track], getAudioTracks: () => [], getTracks: () => [track] } as unknown as MediaStream;
    };
    for (const [take, tail] of [[2, '_take2'], [3, '_take3']] as const) {
      const opened: string[] = [];
      const handles = await startHostRecording({
        recordingId: 'rec1',
        localStream: noMedia,
        dir: namedDir(opened) as never,
        hostName: 'Ana',
        take,
      });
      opened.length = 0;
      await startScreenRecording(handles, screen(), 'host', null);
      await stopScreenRecording(handles);
      await startScreenRecording(handles, screen(), 'host', null);
      await stopScreenRecording(handles);
      expect(opened).toEqual([`host-ana_screen_rec1${tail}.mp4`, `host-ana_screen_rec1_2${tail}.mp4`]);
      await endHostRecording(handles);
    }
  });

  it('probes a resumed later take with the name it will open', async () => {
    const opened: string[] = [];
    const held = new Set(['host-ana_screen_rec1_take2.mp4']);
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
    const handles = { recordingId: 'rec1', dir, hostName: 'Ana', resumed: true, take: 2 } as never;

    await startScreenRecording(handles, screen, 'host', null);
    expect(opened).toEqual(['host-ana_screen_rec1_2_take2.mp4']);
    await stopScreenRecording(handles);
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

describe('guest file names', () => {
  beforeEach(() => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
    (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor = FakeTrackProcessor;
  });
  afterEach(() => {
    delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    delete (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor;
  });

  it("puts the guest's cleaned name after the slot's role", () => {
    expect(guestName(0, 'r', 1, 'mp4', 'Bob')).toBe('guest-bob_r.mp4');
    expect(guestName(1, 'r', 2, 'wav', 'Sam Lee')).toBe('guest2-sam-lee_r_take2.wav');
    expect(guestName(2, 'r', 1, 'mp4', 'Ana / María')).toBe('guest3-ana-maría_r.mp4');
  });

  it('keeps the plain name when the name has nothing usable in it', () => {
    expect(guestName(0, 'r', 1, 'mp4', '🙂')).toBe('guest_r.mp4');
    expect(guestName(0, 'r', 1, 'mp4', '!!!')).toBe('guest_r.mp4');
    expect(guestName(0, 'r', 1, 'mp4', null as never)).toBe('guest_r.mp4');
    expect(guestName(1, 'r', 1, 'wav', 42 as never)).toBe('guest2_r.wav');
    expect(guestName(0, 'r', 1, 'mp4')).toBe('guest_r.mp4');
  });

  it('keeps a name from leaving the folder or hiding the extension', () => {
    expect(guestName(0, 'r', 1, 'mp4', '../../x\u202e')).toBe('guest-x_r.mp4');
    expect(guestName(0, 'r', 1, 'mp4', 'a.mp4')).toBe('guest-a-mp4_r.mp4');
  });

  it('opens no guest file and holds no guest note when the take starts', async () => {
    const opened: string[] = [];
    const handles = await startHostRecording({
      recordingId: 'r',
      localStream: avStream(),
      dir: namedDir(opened) as never,
      hostName: 'Ana',
      room: 'abc-defg-hij',
      journalRoot: async () => new FakeDirectoryHandle() as never,
    });
    expect(opened.filter((n) => n.startsWith('guest'))).toEqual([]);
    expect(opened).toContain('host-ana_r.mp4');
    expect(handles.receiver).toBeUndefined();
    expect(handles.guestWriter).toBeUndefined();
    expect(handles.channelRef).toBeUndefined();
    expect(handles.journal?.notes.files).toEqual([]);
    await endHostRecording(handles);
    expect(opened.filter((n) => n.startsWith('guest'))).toEqual([]);
  });
});

describe('guest screen file names', () => {
  /** A folder that holds `held` and records the names it is asked about and the names it opens. */
  function heldDir(held: string[] = []) {
    const opened: string[] = [];
    const probed: string[] = [];
    const dir = {
      getFileHandle: async (name: string, opts?: { create?: boolean }) => {
        if (opts?.create) {
          if (held.includes(name)) throw new Error(`would replace ${name}`);
          opened.push(name);
        } else {
          probed.push(name);
          if (!held.includes(name)) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
        }
        return { name, createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
      },
    };
    return { dir: dir as never, opened, probed };
  }
  const channel = () =>
    Object.assign(new EventTarget(), { label: 'recording-screen-1', readyState: 'open', send: () => {} }) as unknown as RTCDataChannel;

  it("puts the sharer's name in each guest screen file, shares counted across guests", async () => {
    const { dir, opened } = heldDir();
    const h = { recordingId: 'r', dir } as RecordingHandles;
    await bindHostScreenChannel(channel(), h, undefined, 'p-bob', 'Bob');
    await bindHostScreenChannel(channel(), h, undefined, 'p-ana', 'Ana');
    expect(opened).toEqual(['guest-bob_screen_r.mp4', 'guest-ana_screen_r_2.mp4']);
  });

  it('ends a later take\'s guest screen file in _take<n>', async () => {
    const { dir, opened } = heldDir();
    await bindHostScreenChannel(channel(), { recordingId: 'r', take: 2, dir } as RecordingHandles, undefined, 'p-bob', 'Bob');
    expect(opened).toEqual(['guest-bob_screen_r_take2.mp4']);
  });

  it('keeps the plain name for a sharer with nothing usable in the name', async () => {
    const { dir, opened } = heldDir();
    await bindHostScreenChannel(channel(), { recordingId: 'r', dir } as RecordingHandles, undefined, 'p-x', '🙂');
    expect(opened).toEqual(['guest_screen_r.mp4']);
  });

  it("names a sharer the page does not list after the name of the peer's slot", async () => {
    const { dir, opened } = heldDir();
    const h = {
      recordingId: 'r',
      dir,
      slotPeerIds: new Map([[0, 'p-cam']]),
      slotNames: new Map([[0, 'Cam']]),
    } as RecordingHandles;
    await bindHostScreenChannel(channel(), h, undefined, 'p-cam');
    expect(opened).toEqual(['guest-cam_screen_r.mp4']);
  });

  it('asks the folder about the named file after a resume, so it is not opened over', async () => {
    const { dir, opened, probed } = heldDir(['guest-bob_screen_r.mp4']);
    const h = { recordingId: 'r', dir, resumed: true } as RecordingHandles;
    await bindHostScreenChannel(channel(), h, undefined, 'p-bob', 'Bob');
    expect(probed).toEqual(['guest-bob_screen_r.mp4', 'guest-bob_screen_r_2.mp4']);
    expect(opened).toEqual(['guest-bob_screen_r_2.mp4']);
  });
});
