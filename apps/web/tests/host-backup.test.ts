import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CHUNK_TIMESLICE_MS } from '@openmeet/protocol';
import { startHostRecording, endHostRecording, bindHostGuestChannel, collectFileChecks } from '@/hooks/recording-controller';
import { BackupRecorder } from '@/lib/backup-recorder';
import { FakeDirectoryHandle, FakeFileHandle } from './fake-opfs';

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

describe('host backup recording', () => {
  beforeEach(() => {
    FakeMediaRecorder.instances = [];
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
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
          { file: 'guest_test-rec-j.mp4', kind: 'camera', slot: 0 },
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
});
