import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CHUNK_TIMESLICE_MS } from '@openmeet/protocol';
import {
  startHostRecording,
  endHostRecording,
  bindHostGuestChannel,
  collectFileChecks,
  resumeHostRecording,
} from '@/hooks/recording-controller';
import { BackupRecorder } from '@/lib/backup-recorder';
import type { RecoveredFile } from '@/lib/take-recovery';
import type { TakeJournal, TakeNotes } from '@/lib/take-journal';
import { FakeDirectoryHandle, FakeFileHandle } from './fake-opfs';

/**
 * `copyBackupInto` replaced by a plain function, not a spy: vitest's spies keep
 * a handle on the promises a mock returns, so a rejection that escaped the
 * resume would never surface as an unhandled rejection through one.
 */
const recovery = vi.hoisted(() => ({
  copy: undefined as undefined | ((...args: unknown[]) => Promise<RecoveredFile>),
  calls: [] as unknown[][],
}));

vi.mock('@/lib/take-recovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/take-recovery')>();
  return {
    ...actual,
    copyBackupInto: (...args: unknown[]) => {
      recovery.calls.push(args);
      if (recovery.copy) return recovery.copy(...args);
      return (actual.copyBackupInto as (...a: unknown[]) => Promise<RecoveredFile>)(...args);
    },
  };
});

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = (_m: string) => true;

  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  state = 'inactive';

  constructor(public stream: unknown, public opts: unknown) {
    FakeMediaRecorder.instances.push(this);
  }

  start(_timeslice?: number) {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
    this.onstop?.();
  }

  emit(bytes: number = 64) {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) });
  }
}

function fakeDir() {
  return {
    getFileHandle: async (name: string) => ({
      name,
      createWritable: async () => ({
        write: async () => {},
        close: async () => {},
      }),
    }),
  };
}

function fakeStream() {
  const track = {
    getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }),
  };
  return {
    getTracks: () => [track],
    getVideoTracks: () => [track],
    getAudioTracks: () => [],
  } as unknown as MediaStream;
}

/**
 * A journal as a resumed take reads it: the take's id, its original start 90 s
 * ago and the backups this browser wrote before the crash. No real storage.
 */
function resumeJournal(backups: TakeNotes['backups'] = []) {
  const finish = vi.fn().mockResolvedValue(undefined);
  const notes: TakeNotes = {
    room: 'abc-defg-hij',
    recordingId: 'rec',
    take: 1,
    hostStartMs: Date.now() - 90_000,
    files: [],
    backups,
    markers: [],
  };
  const journal = {
    dirName: 'openmeet-take-1-abc-defg-hij',
    notes,
    finish,
    note: (change: (n: TakeNotes) => void) => change(notes),
    file: () => ({ append: () => {}, commit: async () => {}, dead: false }),
  } as unknown as TakeJournal;
  return { journal, finish };
}

/** A folder that records the names it opened (with create) and the names it closed. */
function trackingDir(opened: string[], closed: string[], seeded: string[] = []) {
  const holds = new Set(seeded);
  return {
    getFileHandle: async (name: string, opts?: { create?: boolean }) => {
      if (opts?.create) {
        opened.push(name);
        holds.add(name);
      } else if (!holds.has(name)) {
        throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
      }
      return {
        name,
        createWritable: async () => ({
          write: async () => {},
          close: async () => {
            closed.push(name);
          },
        }),
      };
    },
  };
}

describe('host backup recording', () => {
  beforeEach(() => {
    FakeMediaRecorder.instances = [];
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
    recovery.copy = undefined;
    recovery.calls.length = 0;
  });

  afterEach(() => {
    delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  });

  it('startHostRecording gives handles carrying a started backup and endHostRecording returns its blob', async () => {
    const stream = fakeStream();
    const dir = fakeDir();

    const handles = await startHostRecording({
      recordingId: 'test-rec-1',
      localStream: stream,
      dir: dir as never,
    });

    expect(handles.backup).toBeDefined();
    expect(handles.backup).toBeInstanceOf(BackupRecorder);
    expect((handles.backup as unknown as { opts: { fileName?: string } }).opts.fileName).toBe(
      'openmeet-backup-host'
    );

    for (const mr of FakeMediaRecorder.instances) {
      if (mr.state === 'recording') {
        mr.emit(128);
      }
    }

    const result = await endHostRecording(handles);
    expect(result.backup).toBeDefined();
    expect(result.backup).toBeInstanceOf(Blob);
    expect(result.backup?.size).toBeGreaterThan(0);
  });

  it('names the host backup after its room, so the lobby can label it', async () => {
    const handles = await startHostRecording({
      recordingId: 'test-rec-room',
      localStream: fakeStream(),
      dir: fakeDir() as never,
      room: 'abc-defg-hij',
    });
    expect((handles.backup as unknown as { opts: { room?: string } }).opts.room).toBe('abc-defg-hij');
    await endHostRecording(handles);
  });

  it('endHostRecording returns backup: null when handles has no backup', async () => {
    const result = await endHostRecording({ recordingId: 'test-rec-2' });
    expect(result.backup).toBeNull();
  });

  // A writer errored by a full disk rejects close(). Closed in series, that
  // skipped committing every guest and screen file after it.
  it('closes every writer even when one close fails, then reports the failure', async () => {
    const host = { close: vi.fn().mockRejectedValue(new Error('disk full')) };
    const guest = { close: vi.fn().mockResolvedValue(undefined) };
    const screen = { close: vi.fn().mockResolvedValue(undefined) };
    await expect(
      endHostRecording({ recordingId: 'test-rec-3', hostWriter: host, guestWriter: guest, screenWriters: [screen] } as never)
    ).rejects.toThrow('disk full');
    expect(guest.close).toHaveBeenCalled();
    expect(screen.close).toHaveBeenCalled();
  });

  it('starts a WAV backup for host when PCM capture is supported and audio is present', async () => {
    class FakeTrackProcessor {
      readable = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
    }
    (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor = FakeTrackProcessor;

    try {
      const videoTrack = { getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }) };
      const audioTrack = {};
      const stream = {
        getTracks: () => [videoTrack, audioTrack],
        getVideoTracks: () => [videoTrack],
        getAudioTracks: () => [audioTrack],
      } as unknown as MediaStream;

      const handles = await startHostRecording({
        recordingId: 'test-rec-wav',
        localStream: stream,
        dir: fakeDir() as never,
        room: 'my-room',
      });

      expect(handles.wavBackup).toBeDefined();
      expect(handles.wavBackup).toBeInstanceOf(BackupRecorder);
      expect((handles.wavBackup as unknown as { opts: { fileName?: string; room?: string } }).opts.fileName).toBe(
        'openmeet-backup-host-audio'
      );
      expect((handles.wavBackup as unknown as { opts: { room?: string } }).opts.room).toBe('my-room');

      const result = await endHostRecording(handles);
      expect(result.wavBackup).toBeDefined();
    } finally {
      delete (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor;
    }
  });

  it('startHostRecording with an empty stream opens no host_*.mp4/.wav and throws nothing', async () => {
    const openedFiles: string[] = [];
    const dir = {
      getFileHandle: async (name: string) => {
        openedFiles.push(name);
        return {
          name,
          createWritable: async () => ({
            write: async () => {},
            close: async () => {},
          }),
        };
      },
    };
    const emptyStream = {
      getTracks: () => [],
      getVideoTracks: () => [],
      getAudioTracks: () => [],
    } as unknown as MediaStream;

    const handles = await startHostRecording({
      recordingId: 'test-rec-empty',
      localStream: emptyStream,
      dir: dir as never,
    });

    expect(handles.hostWriter).toBeUndefined();
    expect(handles.hostRecorder).toBeUndefined();
    expect(handles.backup).toBeUndefined();
    expect(handles.hostWavWriter).toBeUndefined();
    expect(handles.hostPcm).toBeUndefined();
    expect(handles.wavBackup).toBeUndefined();
    expect(openedFiles.some((f) => f.startsWith('host_'))).toBe(false);
    expect(openedFiles).toContain('guest_test-rec-empty.mp4');

    const result = await endHostRecording(handles);
    expect(result.backup).toBeNull();
  });

  it('keeps the frame rate the camera reported when the take started', async () => {
    let reported = 25;
    const trackWithFps = {
      getSettings: () => ({ width: 1280, height: 720, frameRate: reported }),
    };
    const streamWithFps = {
      getTracks: () => [trackWithFps],
      getVideoTracks: () => [trackWithFps],
      getAudioTracks: () => [],
    } as unknown as MediaStream;

    const handles1 = await startHostRecording({
      recordingId: 'test-rec-fps-1',
      localStream: streamWithFps,
      dir: fakeDir() as never,
    });
    reported = 30;
    expect(handles1.videoFps).toBe(25);
    await endHostRecording(handles1);

    const trackWithoutFps = {
      getSettings: () => ({ width: 1280, height: 720 }),
    };
    const streamWithoutFps = {
      getTracks: () => [trackWithoutFps],
      getVideoTracks: () => [trackWithoutFps],
      getAudioTracks: () => [],
    } as unknown as MediaStream;

    const handles2 = await startHostRecording({
      recordingId: 'test-rec-fps-2',
      localStream: streamWithoutFps,
      dir: fakeDir() as never,
    });
    expect(handles2.videoFps).toBeUndefined();
    await endHostRecording(handles2);

    const trackWithoutSettings = {};
    const streamWithoutSettings = {
      getTracks: () => [trackWithoutSettings],
      getVideoTracks: () => [trackWithoutSettings],
      getAudioTracks: () => [],
    } as unknown as MediaStream;

    const handles3 = await startHostRecording({
      recordingId: 'test-rec-fps-3',
      localStream: streamWithoutSettings,
      dir: fakeDir() as never,
    });
    expect(handles3.videoFps).toBeUndefined();
    await endHostRecording(handles3);
  });

  it('slot 0 camera file carries sender facts and host file carries none', async () => {
    const handles = await startHostRecording({
      recordingId: 'test-rec-facts',
      localStream: fakeStream(),
      dir: fakeDir() as never,
    });
    const ch = {
      label: '',
      binaryType: '',
      readyState: 'open',
      onmessage: null as ((ev: { data: unknown }) => void) | null,
      send() {},
    };
    await bindHostGuestChannel(ch as unknown as RTCDataChannel, handles, 'peer-a');
    ch.onmessage?.({ data: JSON.stringify({ idx: 0, offset: 0, size: 4, ts: 0 }) });
    ch.onmessage?.({ data: new ArrayBuffer(4) });
    ch.onmessage?.({
      data: JSON.stringify({
        type: 'recording-finalized',
        recordingId: 'test-rec-facts',
        totalBytes: 4,
        sha256: 'abc',
      }),
    });
    await endHostRecording(handles);
    const checks = await collectFileChecks(handles);
    expect(checks.get('host_test-rec-facts.mp4')).toBeDefined();
    expect(checks.get('host_test-rec-facts.mp4')?.received).toBeUndefined();
    expect(checks.get('guest_test-rec-facts.mp4')).toMatchObject({
      bytes: 4,
      received: { finalized: true, sha256Sent: 'abc' },
    });
  });

  it('opens a take journal for slot 0 and commits parts into it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const root = new FakeDirectoryHandle();
      const warn = vi.fn();
      const handles = await startHostRecording({
        recordingId: 'test-rec-j',
        localStream: fakeStream(),
        dir: fakeDir() as never,
        room: 'abc-defg-hij',
        journalRoot: async () => root as never,
        onWarn: warn,
      });

      expect(handles.journal).toBeDefined();
      expect(handles.unprotected).toBeUndefined();
      expect(handles.onWarn).toBe(warn);

      const takeDir = `openmeet-take-${handles.hostStartMs}-abc-defg-hij`;
      expect(root.entries.has(takeDir)).toBe(true);

      await handles.receiver!.handleMessage(JSON.stringify({ idx: 0, offset: 0, size: 4, ts: 0 }));
      await handles.receiver!.handleMessage(new ArrayBuffer(4));
      vi.setSystemTime(Date.now() + CHUNK_TIMESLICE_MS);
      await handles.receiver!.handleMessage(JSON.stringify({ idx: 1, offset: 4, size: 4, ts: 0 }));
      await handles.receiver!.handleMessage(new ArrayBuffer(4));
      await new Promise((r) => setTimeout(r, 0));

      const take = root.entries.get(takeDir) as FakeDirectoryHandle;
      const fileDir = take.entries.get('guest_test-rec-j.mp4') as FakeDirectoryHandle;
      await vi.waitFor(() => {
        expect([...fileDir.entries.keys()]).toEqual(['000000-0-2.part']);
        expect((fileDir.entries.get('000000-0-2.part') as FakeFileHandle).content.byteLength).toBe(8);
      });
      const notesFile = take.entries.get('take.json') as FakeFileHandle;
      await vi.waitFor(() => {
        expect(JSON.parse(new TextDecoder().decode(notesFile.content)).files).toEqual([
          {
            file: 'guest_test-rec-j.mp4',
            kind: 'camera',
            slot: 0,
            // The 8 bytes of the part, and the hash state that covers them.
            sha256State: {
              nextIdx: 2,
              words: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
              ],
              remainder: [0, 0, 0, 0, 0, 0, 0, 0],
              length: 8,
            },
          },
        ]);
      });

      await endHostRecording(handles);
    } finally {
      vi.useRealTimers();
    }
  });

  it('journal: false is an unprotected take that still records', async () => {
    const handles = await startHostRecording({
      recordingId: 'test-rec-off',
      localStream: fakeStream(),
      dir: fakeDir() as never,
      room: 'abc-defg-hij',
      journal: false,
      journalRoot: async () => new FakeDirectoryHandle() as never,
    });

    expect(handles.journal).toBeUndefined();
    expect(handles.unprotected).toBe(true);
    expect(handles.guestWriter?.fileName).toBe('guest_test-rec-off.mp4');
    await expect(endHostRecording(handles)).resolves.toBeDefined();
  });

  it('no storage means an unprotected take that still records', async () => {
    const handles = await startHostRecording({
      recordingId: 'test-rec-nostore',
      localStream: fakeStream(),
      dir: fakeDir() as never,
      room: 'abc-defg-hij',
      journalRoot: async () => {
        throw new Error('no storage');
      },
    });

    expect(handles.journal).toBeUndefined();
    expect(handles.unprotected).toBe(true);
    expect(handles.guestWriter?.fileName).toBe('guest_test-rec-nostore.mp4');
    await expect(endHostRecording(handles)).resolves.toBeDefined();
  });

  it('a cancelled folder prompt touches no journal', async () => {
    const root = new FakeDirectoryHandle();
    const getDirectoryHandle = vi.spyOn(root, 'getDirectoryHandle');
    const abort = new Error('The user aborted a request.');
    abort.name = 'AbortError';

    const started = startHostRecording({
      recordingId: 'test-rec-abort',
      localStream: fakeStream(),
      directoryPicker: async () => {
        throw abort;
      },
      room: 'abc-defg-hij',
      journalRoot: async () => root as never,
    });

    await expect(started).rejects.toBe(abort);
    expect(getDirectoryHandle).not.toHaveBeenCalled();
  });

  it("the notes name the host's own backups, in the background", async () => {
    const whenOpen = vi.spyOn(BackupRecorder.prototype, 'whenOpen').mockResolvedValue(undefined);
    class FakeTrackProcessor {
      readable = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
    }
    (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor = FakeTrackProcessor;
    const dirName = vi
      .spyOn(BackupRecorder.prototype, 'dirName', 'get')
      .mockReturnValue('openmeet-backup-host-1-abc-defg-hij');
    try {
      const videoTrack = { getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }) };
      const audioTrack = {};
      const stream = {
        getTracks: () => [videoTrack, audioTrack],
        getVideoTracks: () => [videoTrack],
        getAudioTracks: () => [audioTrack],
      } as unknown as MediaStream;

      const handles = await startHostRecording({
        recordingId: 'test-rec-bg',
        localStream: stream,
        dir: fakeDir() as never,
        room: 'abc-defg-hij',
        journalRoot: async () => new FakeDirectoryHandle() as never,
      });
      await Promise.resolve();

      expect(handles.journal?.notes.backups).toContainEqual({
        dir: 'openmeet-backup-host-1-abc-defg-hij',
        file: handles.hostWriter?.fileName,
        kind: 'camera',
      });
      expect(handles.journal?.notes.backups).toContainEqual({
        dir: 'openmeet-backup-host-1-abc-defg-hij',
        file: handles.hostWavWriter?.fileName,
        kind: 'wav',
      });
      await endHostRecording(handles);
    } finally {
      delete (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor;
      whenOpen.mockRestore();
      dirName.mockRestore();
    }

    const stuck = vi.spyOn(BackupRecorder.prototype, 'whenOpen').mockReturnValue(new Promise(() => {}));
    try {
      const handles = await startHostRecording({
        recordingId: 'test-rec-bg2',
        localStream: fakeStream(),
        dir: fakeDir() as never,
        room: 'abc-defg-hij',
        journalRoot: async () => new FakeDirectoryHandle() as never,
      });
      await Promise.resolve();

      expect(handles.journal?.notes.backups).toEqual([]);
      await endHostRecording(handles);
    } finally {
      stuck.mockRestore();
    }
  });

  it("records the host's own track into a second file after a resume", async () => {
    const entry = { dir: 'openmeet-backup-host-1-abc-defg-hij', file: 'host_rec.mp4', kind: 'camera' as const };
    const opened: string[] = [];
    const { journal } = resumeJournal([entry]);

    const handles = await resumeHostRecording({
      journal,
      dir: trackingDir(opened, []) as never,
      localStream: fakeStream(),
      channels: [],
    });

    expect(handles.resumed).toBe(true);
    expect(opened).toEqual(['host_rec_resumed.mp4']);
    expect(handles.hostWriter?.fileName).toBe('host_rec_resumed.mp4');
    expect(handles.hostRecorder).toBeDefined();
    expect(handles.backup).toBeDefined();
    const cameraParts = (handles.hostParts ?? []).filter((p) => p.kind === 'camera');
    expect(cameraParts.map((p) => p.name)).toEqual(['host_rec.mp4', 'host_rec_resumed.mp4']);
    expect(cameraParts[0]!.offsetMs).toBe(0);
    // The second part starts where the crash cut the take: 90 s after the start.
    expect(cameraParts[1]!.offsetMs).toBeGreaterThanOrEqual(90_000);
    expect(cameraParts[1]!.offsetMs).toBeLessThan(91_000);
    await endHostRecording(handles);
  });

  it('copies the pre-crash host part into the folder in the background', async () => {
    const entry = { dir: 'openmeet-backup-host-1-abc-defg-hij', file: 'host_rec.mp4', kind: 'camera' as const };
    const folder = trackingDir([], []);
    const { journal } = resumeJournal([entry]);
    recovery.calls.length = 0;
    recovery.copy = () => new Promise<never>(() => {});

    const handles = await resumeHostRecording({
      journal,
      dir: folder as never,
      localStream: fakeStream(),
      channels: [],
    });

    expect(handles.hostWriter?.fileName).toBe('host_rec_resumed.mp4');
    expect(recovery.calls).toEqual([[journal, folder, entry]]);
    await endHostRecording(handles);
  });

  it('a backup that cannot be copied does not fail the resume', async () => {
    const entry = { dir: 'openmeet-backup-host-1-abc-defg-hij', file: 'host_rec.mp4', kind: 'wav' as const };
    const { journal } = resumeJournal([entry]);
    recovery.calls.length = 0;
    // A rejection the resume does not swallow surfaces as an unhandled
    // rejection, which the listener below would catch.
    let rejectCopy: (reason: unknown) => void = () => {};
    recovery.copy = () =>
      new Promise<never>((_resolve, reject) => {
        rejectCopy = reject;
      });
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      await expect(
        resumeHostRecording({
          journal,
          dir: trackingDir([], []) as never,
          localStream: fakeStream(),
          channels: [],
        })
      ).resolves.toBeDefined();
      rejectCopy(new Error('backup unavailable'));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it("records host camera and WAV into second files and copies only camera and wav backups", async () => {
    class FakeTrackProcessor {
      readable = new ReadableStream({
        start(c) {
          c.close();
        },
      });
    }
    (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor = FakeTrackProcessor;

    try {
      const cameraEntry = { dir: 'openmeet-backup-host-1-cam', file: 'host_rec.mp4', kind: 'camera' as const };
      const wavEntry = { dir: 'openmeet-backup-host-2-wav', file: 'host_rec.wav', kind: 'wav' as const };
      const screenEntry = { dir: 'openmeet-backup-host-3-screen', file: 'host_screen_rec.mp4', kind: 'screen' as const };
      const opened: string[] = [];
      const { journal } = resumeJournal([cameraEntry, wavEntry, screenEntry]);
      recovery.calls.length = 0;
      recovery.copy = () => new Promise<never>(() => {});

      const videoTrack = { getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }) };
      const audioTrack = {};
      const stream = {
        getTracks: () => [videoTrack, audioTrack],
        getVideoTracks: () => [videoTrack],
        getAudioTracks: () => [audioTrack],
      } as unknown as MediaStream;

      const handles = await resumeHostRecording({
        journal,
        dir: trackingDir(opened, []) as never,
        localStream: stream,
        channels: [],
      });

      expect(opened).toEqual(['host_rec_resumed.mp4', 'host_rec_resumed.wav']);
      expect(handles.hostWriter?.fileName).toBe('host_rec_resumed.mp4');
      expect(handles.hostWavWriter?.fileName).toBe('host_rec_resumed.wav');
      expect(handles.hostPcm).toBeDefined();
      expect(handles.wavBackup).toBeDefined();

      // Screen backups must not be copied or in hostParts
      expect(recovery.calls).toEqual([
        [journal, expect.anything(), cameraEntry],
        [journal, expect.anything(), wavEntry],
      ]);
      expect(handles.hostParts).toEqual([
        { name: 'host_rec.mp4', offsetMs: 0, kind: 'camera' },
        { name: 'host_rec.wav', offsetMs: 0, kind: 'wav' },
        { name: 'host_rec_resumed.mp4', offsetMs: expect.any(Number), kind: 'camera' },
        { name: 'host_rec_resumed.wav', offsetMs: expect.any(Number), kind: 'wav' },
      ]);
      await endHostRecording(handles);
    } finally {
      delete (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor;
    }
  });

  it("a host setup that fails costs only the host's part of the resume", async () => {
    const warn = vi.fn();
    const { journal } = resumeJournal();
    FakeMediaRecorder.isTypeSupported = () => false;
    try {
      const handles = await resumeHostRecording({
        journal,
        dir: fakeDir() as never,
        localStream: fakeStream(),
        channels: [],
        onWarn: warn,
      });

      expect(handles.hostWriter).toBeUndefined();
      expect(handles.hostRecorder).toBeUndefined();
      expect(handles.backup).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(typeof warn.mock.calls[0]![0]).toBe('string');
    } finally {
      FakeMediaRecorder.isTypeSupported = () => true;
    }
  });

  it('asks for the folder once and opens no fresh-take name after a resume', async () => {
    const opened: string[] = [];
    const prompts: string[] = [];
    const folder = trackingDir(opened, []);
    const { journal } = resumeJournal();

    const handles = await resumeHostRecording({
      journal,
      directoryPicker: async () => {
        prompts.push('ask');
        return folder as never;
      },
      localStream: fakeStream(),
      channels: [],
    });

    expect(prompts).toHaveLength(1);
    expect(handles.dir).toBe(folder);
    // A fresh take's host_rec.mp4/guest_rec.mp4 must not be opened over the
    // files the crashed session left: only the resumed name is new here.
    expect(opened).toEqual(['host_rec_resumed.mp4']);
    await endHostRecording(handles);
  });

  it('starts no more recorders than a fresh take does for the same stream', async () => {
    const stream = fakeStream();
    FakeMediaRecorder.instances = [];
    const fresh = await startHostRecording({ recordingId: 'fresh', localStream: stream, dir: fakeDir() as never });
    const freshRecorders = FakeMediaRecorder.instances.length;
    await endHostRecording(fresh);

    const { journal } = resumeJournal();
    FakeMediaRecorder.instances = [];
    const resumed = await resumeHostRecording({
      journal,
      dir: fakeDir() as never,
      localStream: stream,
      channels: [],
    });
    expect(FakeMediaRecorder.instances).toHaveLength(freshRecorders);
    await endHostRecording(resumed);
  });

  it('endHostRecording closes the resumed host file and marks nothing', async () => {
    const opened: string[] = [];
    const closed: string[] = [];
    const markFinalized = vi.spyOn(BackupRecorder.prototype, 'markFinalized');
    const { journal, finish } = resumeJournal();
    try {
      const handles = await resumeHostRecording({
        journal,
        dir: trackingDir(opened, closed) as never,
        localStream: fakeStream(),
        channels: [],
      });
      for (const mr of FakeMediaRecorder.instances) {
        if (mr.state === 'recording') mr.emit(64);
      }

      const { backup } = await endHostRecording(handles);

      expect(backup).toBeInstanceOf(Blob);
      expect(backup?.size).toBeGreaterThan(0);
      expect(closed).toContain('host_rec_resumed.mp4');
      // Ending a take is the caller's to mark: closing the file is all this does.
      expect(finish).not.toHaveBeenCalled();
      expect(markFinalized).not.toHaveBeenCalled();
    } finally {
      markFinalized.mockRestore();
    }
  });

  it('a fresh take is still named from the id it is given', async () => {
    const opened: string[] = [];
    // A leftover name from an earlier resumed take must not divert a new one.
    const dir = trackingDir(opened, [], ['host_rec_resumed.mp4']);

    const handles = await startHostRecording({ recordingId: 'new-id', localStream: fakeStream(), dir: dir as never });

    expect(opened).toEqual(['host_new-id.mp4', 'guest_new-id.mp4']);
    expect(handles.hostWriter?.fileName).toBe('host_new-id.mp4');
    expect(opened.some((name) => name.includes('_resumed'))).toBe(false);
    await endHostRecording(handles);
  });
});
