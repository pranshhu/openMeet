import { describe, it, expect, vi } from 'vitest';
import { BackupRecorder, BACKUP_PREFIX, backupRoom, isScreenBackup, findBackups, deleteBackup, parseBackupName } from '@/lib/backup-recorder';
import { openTakeJournal } from '@/lib/take-journal';
import { wavHeader } from '@/lib/wav';
import type { FrameSource, PcmFrame } from '@/lib/pcm-recorder';

function fakeFrame(samples: number[], sampleRate = 48000, channels = 1): PcmFrame {
  const data = Float32Array.from(samples);
  return {
    sampleRate,
    numberOfChannels: channels,
    numberOfFrames: samples.length / channels,
    allocationSize: () => data.byteLength,
    copyTo: (dest) => {
      new Float32Array((dest as ArrayBufferView).buffer ?? (dest as ArrayBuffer)).set(data);
    },
    close: () => {},
  };
}

function fakeSourceOf(frames: PcmFrame[]): FrameSource {
  return () =>
    new ReadableStream<PcmFrame>({
      start(c) {
        frames.forEach((f) => c.enqueue(f));
        c.close();
      },
    });
}

if (typeof Blob !== 'undefined' && typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function () {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

class FakeMR {
  static last: FakeMR | null = null;
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  state = 'inactive';
  constructor() {
    FakeMR.last = this;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.onstop?.();
  }
  emit(bytes: number | Uint8Array) {
    const u8 = typeof bytes === 'number' ? new Uint8Array(bytes) : bytes;
    this.ondataavailable?.({ data: new Blob([u8 as BlobPart]) });
  }
}

class FakeFileHandle {
  readonly kind = 'file' as const;
  constructor(
    public name: string,
    public content: Uint8Array = new Uint8Array(),
    public lastModified: number = Date.now(),
  ) {}

  async createWritable() {
    let buffer = new Uint8Array();
    return {
      write: async (data: Blob | BufferSource) => {
        let bytes: Uint8Array;
        if (data && typeof (data as Blob).arrayBuffer === 'function') {
          const ab = await (data as Blob).arrayBuffer();
          bytes = new Uint8Array(ab);
        } else if (data instanceof ArrayBuffer) {
          bytes = new Uint8Array(data);
        } else if (ArrayBuffer.isView(data)) {
          bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        } else {
          bytes = new Uint8Array();
        }
        const next = new Uint8Array(buffer.length + bytes.length);
        next.set(buffer, 0);
        next.set(bytes, buffer.length);
        buffer = next;
      },
      close: async () => {
        this.content = buffer;
        this.lastModified = Date.now();
      },
    };
  }

  async getFile(): Promise<File> {
    return new File([this.content as BlobPart], this.name, { lastModified: this.lastModified });
  }
}

class FakeDirectoryHandle {
  readonly kind = 'directory' as const;
  entries = new Map<string, FakeFileHandle | FakeDirectoryHandle>();

  constructor(public name: string = '') {}

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDirectoryHandle> {
    let existing = this.entries.get(name);
    if (!existing) {
      if (!opts?.create) {
        const err = new Error('not found');
        err.name = 'NotFoundError';
        throw err;
      }
      existing = new FakeDirectoryHandle(name);
      this.entries.set(name, existing);
    }
    if (existing.kind !== 'directory') {
      const err = new Error('TypeMismatchError');
      err.name = 'TypeMismatchError';
      throw err;
    }
    return existing as FakeDirectoryHandle;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFileHandle> {
    let existing = this.entries.get(name);
    if (!existing) {
      if (!opts?.create) {
        const err = new Error('not found');
        err.name = 'NotFoundError';
        throw err;
      }
      existing = new FakeFileHandle(name);
      this.entries.set(name, existing);
    }
    if (existing.kind !== 'file') {
      const err = new Error('TypeMismatchError');
      err.name = 'TypeMismatchError';
      throw err;
    }
    return existing as FakeFileHandle;
  }

  async removeEntry(name: string, _opts?: { recursive?: boolean }): Promise<void> {
    const existing = this.entries.get(name);
    if (!existing) {
      const err = new Error('not found');
      err.name = 'NotFoundError';
      throw err;
    }
    this.entries.delete(name);
  }

  async *values() {
    for (const entry of this.entries.values()) {
      yield entry;
    }
  }

  async *[Symbol.asyncIterator]() {
    for (const entry of this.entries.values()) {
      yield entry;
    }
  }
}

describe('BackupRecorder — RAM fallback', () => {
  it('accumulates blobs and resolves a combined blob on stop (RAM fallback)', async () => {
    const br = new BackupRecorder({
      stream: {} as MediaStream,
      mrFactory: () => new FakeMR() as unknown as MediaRecorder,
      // no opfsRoot -> RAM fallback path
    });
    br.start();
    FakeMR.last!.emit(100);
    FakeMR.last!.emit(200);
    const blob = await br.stop();
    expect(blob).toBeInstanceOf(Blob);
    expect(blob?.size).toBe(300);
  });

  it('requests persistent storage on start if available', () => {
    const persist = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('navigator', {
      storage: { persist },
    });
    const br = new BackupRecorder({
      stream: {} as MediaStream,
      mrFactory: () => new FakeMR() as unknown as MediaRecorder,
    });
    br.start();
    expect(persist).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('returns null rather than an empty Blob when nothing was ever recorded', async () => {
    const br = new BackupRecorder({
      stream: {} as MediaStream,
      mrFactory: () => new FakeMR() as unknown as MediaRecorder,
    });
    br.start();
    expect(await br.stop()).toBeNull();
  });
});

describe('BackupRecorder — OPFS per-chunk files and crash survival', () => {
  it('(1) after 3 consumed chunks and no stop() (a simulated crash), findBackups() returns one file whose size is the sum of the 3 chunks, in order', async () => {
    const root = new FakeDirectoryHandle('root');
    const br = new BackupRecorder({
      stream: {} as MediaStream,
      mrFactory: () => new FakeMR() as unknown as MediaRecorder,
      opfsRoot: async () => root as never,
    });
    br.start();
    await Promise.resolve();

    const chunk1 = new Uint8Array([1, 2, 3]);
    const chunk2 = new Uint8Array([4, 5]);
    const chunk3 = new Uint8Array([6, 7, 8, 9]);

    FakeMR.last!.emit(chunk1);
    await new Promise((r) => setTimeout(r, 10));
    FakeMR.last!.emit(chunk2);
    await new Promise((r) => setTimeout(r, 10));
    FakeMR.last!.emit(chunk3);
    await new Promise((r) => setTimeout(r, 10));

    // Simulated crash: no br.stop() called!

    const backups = await findBackups(async () => root as never);
    expect(backups).toHaveLength(1);
    const file = backups[0]!;
    expect(file.size).toBe(chunk1.byteLength + chunk2.byteLength + chunk3.byteLength);

    const buffer = new Uint8Array(await file.arrayBuffer());
    expect(buffer).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  });

  it('(2) stop() returns the same bytes', async () => {
    const root = new FakeDirectoryHandle('root');
    const br = new BackupRecorder({
      stream: {} as MediaStream,
      mrFactory: () => new FakeMR() as unknown as MediaRecorder,
      opfsRoot: async () => root as never,
    });
    br.start();
    await Promise.resolve();

    const chunk1 = new Uint8Array([1, 2, 3]);
    const chunk2 = new Uint8Array([4, 5]);
    const chunk3 = new Uint8Array([6, 7, 8, 9]);

    FakeMR.last!.emit(chunk1);
    await new Promise((r) => setTimeout(r, 10));
    FakeMR.last!.emit(chunk2);
    await new Promise((r) => setTimeout(r, 10));
    FakeMR.last!.emit(chunk3);
    await new Promise((r) => setTimeout(r, 10));

    const stoppedFile = await br.stop();
    expect(stoppedFile).not.toBeNull();
    expect(stoppedFile?.size).toBe(9);

    const stoppedBuffer = new Uint8Array(await stoppedFile!.arrayBuffer());
    expect(stoppedBuffer).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));

    const backups = await findBackups(async () => root as never);
    expect(backups).toHaveLength(1);
    const foundBuffer = new Uint8Array(await backups[0]!.arrayBuffer());
    expect(foundBuffer).toEqual(stoppedBuffer);
  });

  it('(3) deleteBackup removes the directory', async () => {
    const root = new FakeDirectoryHandle('root');
    const br = new BackupRecorder({
      stream: {} as MediaStream,
      mrFactory: () => new FakeMR() as unknown as MediaRecorder,
      opfsRoot: async () => root as never,
    });
    br.start();
    await Promise.resolve();

    FakeMR.last!.emit(new Uint8Array([1, 2, 3]));
    await new Promise((r) => setTimeout(r, 10));

    const backups = await findBackups(async () => root as never);
    expect(backups).toHaveLength(1);
    const backupName = backups[0]!.name; // <dir>.<ext>

    const dirName = backupName.replace(/\.mp4$/, '');
    expect(root.entries.has(dirName)).toBe(true);

    await deleteBackup(backupName, async () => root as never);

    expect(root.entries.has(dirName)).toBe(false);
    const remaining = await findBackups(async () => root as never);
    expect(remaining).toHaveLength(0);
  });

  it('(4) two recordings produce two directories and neither truncates the other', async () => {
    const root = new FakeDirectoryHandle('root');

    const br1 = new BackupRecorder({
      stream: {} as MediaStream,
      mrFactory: () => new FakeMR() as unknown as MediaRecorder,
      opfsRoot: async () => root as never,
    });
    br1.start();
    await Promise.resolve();
    FakeMR.last!.emit(new Uint8Array([1, 2, 3]));
    await new Promise((r) => setTimeout(r, 10));
    await br1.stop();

    const br2 = new BackupRecorder({
      stream: {} as MediaStream,
      mrFactory: () => new FakeMR() as unknown as MediaRecorder,
      opfsRoot: async () => root as never,
    });
    br2.start();
    await Promise.resolve();
    FakeMR.last!.emit(new Uint8Array([4, 5, 6, 7]));
    await new Promise((r) => setTimeout(r, 10));
    await br2.stop();

    // Two directories should exist in root
    expect(root.entries.size).toBe(2);
    const backups = await findBackups(async () => root as never);
    expect(backups).toHaveLength(2);
    const sizes = backups.map((b) => b.size).sort((a, b) => a - b);
    expect(sizes).toEqual([3, 4]);
  });
});

describe('BackupRecorder — failure handling and memory boundedness', () => {
  it('falls back to RAM when the OPFS chunk cannot be closed', async () => {
    const getDirectoryHandle = vi.fn().mockResolvedValue({
      kind: 'directory',
      name: 'openmeet-backup-test',
      getFileHandle: async () => ({
        kind: 'file',
        createWritable: async () => ({
          write: async () => {},
          close: async () => {
            throw new Error('disk went away');
          },
        }),
        getFile: async () => new File([new Uint8Array(10) as BlobPart], '000000.part'),
      }),
      values: async function* () {},
    });
    const br = new BackupRecorder({
      stream: {} as MediaStream,
      mrFactory: () => new FakeMR() as unknown as MediaRecorder,
      opfsRoot: async () => ({ getDirectoryHandle, getFileHandle: vi.fn() as never }),
    });
    br.start();
    await Promise.resolve();
    FakeMR.last!.emit(100);
    await new Promise((r) => setTimeout(r, 10));
    const backup = await br.stop();
    expect(backup).not.toBeNull();
    expect(backup?.size).toBe(100);
  });

  it('retries storage write on failure, then falls back to RAM with a warning and drops no chunks', async () => {
    const root = new FakeDirectoryHandle('root');
    let chunkCount = 0;
    let writeAttempts = 0;
    const dirHandle = {
      kind: 'directory',
      name: 'openmeet-backup-retry-fail',
      getFileHandle: async (name: string, opts?: { create?: boolean }) => {
        if (name === '.probe') {
          return new FakeFileHandle('.probe');
        }
        chunkCount++;
        if (chunkCount > 1) {
          return {
            kind: 'file',
            name,
            createWritable: async () => ({
              write: async () => {
                writeAttempts++;
                throw new Error('disk full or storage error');
              },
              close: async () => {},
            }),
            getFile: async () => new File([], name),
          };
        }
        const realDir = await root.getDirectoryHandle('openmeet-backup-retry-fail', { create: true });
        return realDir.getFileHandle(name, opts);
      },
      values: async function* () {
        const realDir = await root.getDirectoryHandle('openmeet-backup-retry-fail');
        for await (const val of realDir.values()) {
          yield val;
        }
      },
    };

    const onWarn = vi.fn();
    const br = new BackupRecorder({
      stream: {} as MediaStream,
      mrFactory: () => new FakeMR() as unknown as MediaRecorder,
      opfsRoot: async () => ({
        getDirectoryHandle: async () => dirHandle as never,
        getFileHandle: vi.fn() as never,
      }),
      onWarn,
    });
    br.start();
    await Promise.resolve();

    FakeMR.last!.emit(100); // chunk 1 commits to OPFS
    await new Promise((r) => setTimeout(r, 10));

    FakeMR.last!.emit(200); // chunk 2 fails write and retries, then falls back to RAM
    await new Promise((r) => setTimeout(r, 20));

    expect(writeAttempts).toBeGreaterThanOrEqual(2); // verified retry
    expect(onWarn).toHaveBeenCalledWith(expect.stringMatching(/storage.*memory/i));

    FakeMR.last!.emit(300); // chunk 3 arrives after failure -> goes to RAM
    await new Promise((r) => setTimeout(r, 10));

    const backup = await br.stop();
    expect(backup).not.toBeNull();
    // All 3 chunks are present: 100 from OPFS + 200 from RAM + 300 from RAM = 600 bytes
    expect(backup?.size).toBe(600);
  });

  it('stop() twice resolves both times and returns the same result', async () => {
    const root = new FakeDirectoryHandle('root');
    const mr = new FakeMR();
    const br = new BackupRecorder({
      stream: {} as MediaStream,
      opfsRoot: async () => root as never,
      mrFactory: () => mr as never,
    });
    br.start();
    mr.emit(100);
    const first = await br.stop();
    expect(first).not.toBeNull();
    const second = await br.stop();
    expect(second).toBe(first);
  });

  it('does not return RAM parts alone when bytes reached OPFS but on-disk parts cannot be read', async () => {
    let failRead = false;
    const dirHandle = {
      kind: 'directory',
      name: 'openmeet-backup-unread',
      getFileHandle: async (name: string, _opts?: { create?: boolean }) => {
        if (name === '.probe') return new FakeFileHandle('.probe');
        return {
          kind: 'file',
          name,
          createWritable: async () => ({
            write: async () => {},
            close: async () => {},
          }),
          getFile: async () => {
            if (failRead) throw new Error('cannot read on-disk file');
            return new File([new Uint8Array(100) as BlobPart], name);
          },
        };
      },
      values: async function* () {
        if (failRead) throw new Error('cannot list dir');
        yield {
          kind: 'file',
          name: '000000.part',
          getFile: async () => {
            throw new Error('cannot read chunk');
          },
        };
      },
    };

    const br = new BackupRecorder({
      stream: {} as MediaStream,
      mrFactory: () => new FakeMR() as unknown as MediaRecorder,
      opfsRoot: async () => ({
        getDirectoryHandle: async () => dirHandle as never,
        getFileHandle: vi.fn() as never,
      }),
    });
    br.start();
    await Promise.resolve();

    FakeMR.last!.emit(100); // chunk 1 succeeds to OPFS
    await new Promise((r) => setTimeout(r, 10));

    // Force failure on next chunk so subsequent chunk falls back to RAM
    dirHandle.getFileHandle = async (name: string) => ({
      kind: 'file',
      name,
      createWritable: async () => ({
        write: async () => {
          throw new Error('disk full');
        },
        close: async () => {},
      }),
      getFile: async () => {
        throw new Error('disk error');
      },
    });

    FakeMR.last!.emit(200); // chunk 2 fails write and retries -> falls back to RAM
    await new Promise((r) => setTimeout(r, 20));

    failRead = true; // on-disk part cannot be read back
    const backup = await br.stop();
    expect(backup).toBeNull();
  });
});


describe('findBackups and deleteBackup', () => {
  it('findBackups returns only non-empty openmeet-backup* directories, newest first', async () => {
    const root = new FakeDirectoryHandle('root');

    // Create 3 backup directories with different lastModified timestamps
    const dirOlder = await root.getDirectoryHandle(`${BACKUP_PREFIX}-older`, { create: true });
    const fOlder = await dirOlder.getFileHandle('000000.part', { create: true });
    const wOlder = await fOlder.createWritable();
    await wOlder.write(new Uint8Array(500));
    await wOlder.close();
    fOlder.lastModified = 1000;

    const dirNewest = await root.getDirectoryHandle(`${BACKUP_PREFIX}-newest`, { create: true });
    const fNewest = await dirNewest.getFileHandle('000000.part', { create: true });
    const wNewest = await fNewest.createWritable();
    await wNewest.write(new Uint8Array(1000));
    await wNewest.close();
    fNewest.lastModified = 3000;

    const dirMiddle = await root.getDirectoryHandle(`${BACKUP_PREFIX}-middle`, { create: true });
    const fMiddle = await dirMiddle.getFileHandle('000000.part', { create: true });
    const wMiddle = await fMiddle.createWritable();
    await wMiddle.write(new Uint8Array(200));
    await wMiddle.close();
    fMiddle.lastModified = 2000;

    // Empty backup directory -> should be excluded
    await root.getDirectoryHandle(`${BACKUP_PREFIX}-empty`, { create: true });

    // Non-backup directory -> should be excluded
    const dirOther = await root.getDirectoryHandle('other-dir', { create: true });
    const fOther = await dirOther.getFileHandle('000000.part', { create: true });
    const wOther = await fOther.createWritable();
    await wOther.write(new Uint8Array(800));
    await wOther.close();

    const backups = await findBackups(async () => root as never);
    expect(backups.map((f) => f.name)).toEqual([
      `${BACKUP_PREFIX}-newest.mp4`,
      `${BACKUP_PREFIX}-middle.mp4`,
      `${BACKUP_PREFIX}-older.mp4`,
    ]);
  });

  it('findBackups returns [] when OPFS is absent', async () => {
    expect(await findBackups(() => Promise.reject(new Error('no OPFS')))).toEqual([]);
  });

  it('deleteBackup ignores NotFoundError only', async () => {
    const root = new FakeDirectoryHandle('root');
    await expect(deleteBackup('openmeet-backup-nonexistent.mp4', async () => root as never)).resolves.toBeUndefined();

    const errorRoot = async () => ({
      async removeEntry() {
        const err = new Error('Permission denied');
        err.name = 'SecurityError';
        throw err;
      },
    });
    await expect(deleteBackup('openmeet-backup-1.mp4', errorRoot as never)).rejects.toThrow('Permission denied');
  });
});

describe('backups of takes that finalized normally', () => {
  async function record(root: FakeDirectoryHandle, bytes: number[]) {
    const br = new BackupRecorder({
      stream: {} as MediaStream,
      mrFactory: () => new FakeMR() as unknown as MediaRecorder,
      opfsRoot: async () => root as never,
    });
    br.start();
    await Promise.resolve();
    FakeMR.last!.emit(new Uint8Array(bytes));
    await new Promise((r) => setTimeout(r, 10));
    await br.stop();
    return br;
  }

  it('are deleted instead of listed, while a backup never marked finalized is kept', async () => {
    const root = new FakeDirectoryHandle('root');
    const clean = await record(root, [1, 2, 3]);
    await record(root, [4, 5]); // e.g. a crash: nobody ever marks it
    await clean.markFinalized();

    const backups = await findBackups(async () => root as never);
    expect(backups.map((f) => f.size)).toEqual([2]);
    expect(root.entries.size).toBe(1); // the finalized one's directory is gone
  });

  it('mark nothing when OPFS was never available', async () => {
    const br = new BackupRecorder({
      stream: {} as MediaStream,
      mrFactory: () => new FakeMR() as unknown as MediaRecorder,
    });
    br.start();
    FakeMR.last!.emit(10);
    await br.stop();
    await expect(br.markFinalized()).resolves.toBeUndefined();
  });
});

describe('backup room labels', () => {
  it('carries the room in the backup name so the lobby can say where it came from', async () => {
    const root = new FakeDirectoryHandle('root');
    const br = new BackupRecorder({
      stream: {} as MediaStream,
      mrFactory: () => new FakeMR() as unknown as MediaRecorder,
      opfsRoot: async () => root as never,
      fileName: 'openmeet-backup-host',
      room: 'abc-defg-hij',
    });
    br.start();
    await Promise.resolve();
    FakeMR.last!.emit(new Uint8Array([1]));
    await new Promise((r) => setTimeout(r, 10));
    const [found] = await findBackups(async () => root as never);
    expect(backupRoom(found!.name)).toBe('abc-defg-hij');
  });

  it('reads the room from guest, host, and screen backup names, and nothing from older unlabelled ones', () => {
    expect(backupRoom('openmeet-backup-1790381338441-abc-defg-hij.mp4')).toBe('abc-defg-hij');
    expect(backupRoom('openmeet-backup-host-1790381338441-abc-defg-hij.mp4')).toBe('abc-defg-hij');
    expect(backupRoom('openmeet-backup-screen-1790381338441-abc-defg-hij.mp4')).toBe('abc-defg-hij');
    expect(backupRoom('openmeet-backup-1-abc-defg-wav.mp4')).toBe('abc-defg-wav');
    expect(backupRoom('openmeet-backup-host-audio-1-abc-defg-hij.wav')).toBe('abc-defg-hij');
    expect(backupRoom('openmeet-backup-1790381338441.mp4')).toBeNull();
    expect(backupRoom('openmeet-backup-host-1790381338441.mp4')).toBeNull();
    expect(backupRoom('openmeet-backup-screen-1790381338441.mp4')).toBeNull();
  });

  it('parseBackupName reads kind, start, room and extension from the three name shapes', () => {
    expect(parseBackupName('openmeet-backup-1700000000000-abc-defg-hij.mp4')).toEqual({
      kind: 'camera',
      startedMs: 1700000000000,
      room: 'abc-defg-hij',
      ext: 'mp4',
    });
    expect(parseBackupName('openmeet-backup-audio-1700000000000-abc-defg-hij.wav')).toEqual({
      kind: 'audio',
      startedMs: 1700000000000,
      room: 'abc-defg-hij',
      ext: 'wav',
    });
    expect(parseBackupName('openmeet-backup-screen-1700000000000-abc-defg-hij.mp4')).toEqual({
      kind: 'screen',
      startedMs: 1700000000000,
      room: 'abc-defg-hij',
      ext: 'mp4',
    });
  });

  it('parseBackupName returns null for host backups, missing rooms, malformed timestamps, mismatched kinds/extensions, uppercase, and path traversal', () => {
    // host camera backup
    expect(parseBackupName('openmeet-backup-host-1700000000000-abc-defg-hij.mp4')).toBeNull();
    // name with no room
    expect(parseBackupName('openmeet-backup-1700000000000.mp4')).toBeNull();
    expect(parseBackupName('openmeet-backup-audio-1700000000000.wav')).toBeNull();
    // 12- or 14-digit timestamp
    expect(parseBackupName('openmeet-backup-170000000000-abc-defg-hij.mp4')).toBeNull();
    expect(parseBackupName('openmeet-backup-17000000000000-abc-defg-hij.mp4')).toBeNull();
    // kind and extension disagree
    expect(parseBackupName('openmeet-backup-audio-1700000000000-abc-defg-hij.mp4')).toBeNull();
    expect(parseBackupName('openmeet-backup-1700000000000-abc-defg-hij.wav')).toBeNull();
    expect(parseBackupName('openmeet-backup-screen-1700000000000-abc-defg-hij.wav')).toBeNull();
    // malformed room shape
    expect(parseBackupName('openmeet-backup-1700000000000-abc.mp4')).toBeNull();
    expect(parseBackupName('openmeet-backup-1700000000000-abc-defg-hij-x.mp4')).toBeNull();
    expect(parseBackupName('openmeet-backup-1700000000000-abcd-efg-hij.mp4')).toBeNull();
    expect(parseBackupName('openmeet-backup-1700000000000-../../etc.mp4')).toBeNull();
    // upper case
    expect(parseBackupName('openMeet-backup-1700000000000-abc-defg-hij.mp4')).toBeNull();
    expect(parseBackupName('openmeet-backup-1700000000000-ABC-DEFG-HIJ.mp4')).toBeNull();
    expect(parseBackupName('openmeet-backup-1700000000000-abc-defg-hij.MP4')).toBeNull();
    // path traversal
    expect(parseBackupName('../openmeet-backup-1700000000000-abc-defg-hij.mp4')).toBeNull();
    expect(parseBackupName('openmeet-backup-1700000000000-abc-defg-hij.mp4/../x')).toBeNull();
  });

  it('distinguishes screen backups from camera backups', () => {
    expect(isScreenBackup('openmeet-backup-screen-1790381338441-abc-defg-hij.mp4')).toBe(true);
    expect(isScreenBackup('openmeet-backup-host-1790381338441-abc-defg-hij.mp4')).toBe(false);
    expect(isScreenBackup('openmeet-backup-1790381338441-abc-defg-hij.mp4')).toBe(false);
  });

  it('a camera backup in room xyz-wavy-abc assembles as .mp4', async () => {
    const root = new FakeDirectoryHandle('root');
    const br = new BackupRecorder({
      stream: {} as MediaStream,
      mrFactory: () => new FakeMR() as unknown as MediaRecorder,
      opfsRoot: async () => root as never,
      room: 'xyz-wavy-abc',
    });
    br.start();
    await Promise.resolve();
    FakeMR.last!.emit(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]));
    await new Promise((r) => setTimeout(r, 10));
    const backups = await findBackups(async () => root as never);
    expect(backups).toHaveLength(1);
    expect(backups[0]!.name).toMatch(/\.mp4$/);
    expect(backups[0]!.type).not.toBe('audio/wav');
  });
});


describe('BackupRecorder — up-front fallback detection', () => {
  it('detects missing createWritable up front, warns participant, and uses RAM fallback', async () => {
    const onWarn = vi.fn();
    const fakeDirWithoutCreateWritable = {
      kind: 'directory',
      name: 'openmeet-backup-safari',
      getFileHandle: async (name: string) => ({
        kind: 'file',
        name,
        // createWritable is undefined on Safari 15.2-25
        createWritable: undefined,
        getFile: async () => new File([], name),
      }),
    };
    const br = new BackupRecorder({
      stream: {} as MediaStream,
      mrFactory: () => new FakeMR() as unknown as MediaRecorder,
      opfsRoot: async () => ({
        getDirectoryHandle: async () => fakeDirWithoutCreateWritable as never,
        getFileHandle: vi.fn() as never,
      }),
      onWarn,
    });
    br.start();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));

    expect(onWarn).toHaveBeenCalledWith(expect.stringMatching(/memory only/i));

    FakeMR.last!.emit(150);
    FakeMR.last!.emit(250);
    const backup = await br.stop();
    expect(backup).not.toBeNull();
    expect(backup?.size).toBe(400);
  });

  it('detects rejected getDirectory up front, warns participant, and uses RAM fallback', async () => {
    const onWarn = vi.fn();
    const br = new BackupRecorder({
      stream: {} as MediaStream,
      mrFactory: () => new FakeMR() as unknown as MediaRecorder,
      opfsRoot: async () => {
        throw new Error('SecurityError: Access to OPFS denied in private browsing');
      },
      onWarn,
    });
    br.start();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));

    expect(onWarn).toHaveBeenCalledWith(expect.stringMatching(/memory only/i));

    FakeMR.last!.emit(120);
    const backup = await br.stop();
    expect(backup).not.toBeNull();
    expect(backup?.size).toBe(120);
  });
});

describe('BackupRecorder — WAV backup and crash safety', () => {
  it('assembles a valid WAV with a correct header after simulated crash (no stop())', async () => {
    const root = new FakeDirectoryHandle('root');
    const br = new BackupRecorder({
      stream: {} as MediaStream,
      mimeType: 'audio/wav',
      fileName: 'openmeet-backup-audio',
      opfsRoot: async () => root as never,
    });
    br.start();
    await Promise.resolve();

    const fmt = { sampleRate: 48000, channels: 1, bitDepth: 24 };
    const placeholderHeader = wavHeader(fmt, 0); // dataBytes = 0 placeholder
    const pcm1 = new Uint8Array(144);
    pcm1.fill(1);
    const pcm2 = new Uint8Array(288);
    pcm2.fill(2);

    br.writeChunk(placeholderHeader);
    await new Promise((r) => setTimeout(r, 10));
    br.writeChunk(pcm1.buffer as ArrayBuffer);
    await new Promise((r) => setTimeout(r, 10));
    br.writeChunk(pcm2.buffer as ArrayBuffer);
    await new Promise((r) => setTimeout(r, 10));

    // Simulated crash: br.stop() was never called!
    const backups = await findBackups(async () => root as never);
    expect(backups).toHaveLength(1);
    const wavFile = backups[0]!;
    expect(wavFile.name).toMatch(/\.wav$/);
    expect(wavFile.type).toBe('audio/wav');
    expect(wavFile.size).toBe(44 + 144 + 288);

    const buf = await wavFile.arrayBuffer();
    const view = new DataView(buf);
    // RIFF header
    expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + 144 + 288);
    expect(String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11))).toBe('WAVE');
    // data chunk
    expect(String.fromCharCode(view.getUint8(36), view.getUint8(37), view.getUint8(38), view.getUint8(39))).toBe('data');
    expect(view.getUint32(40, true)).toBe(144 + 288);
  });

  it('a WAV BackupRecorder over a fake frameSource, stopped cleanly, assembles to exactly 44 + pcmBytes with correct size fields', async () => {
    const root = new FakeDirectoryHandle('root');
    const pcmBytes = 30; // 10 samples * 3 bytes
    const samples = [0.1, 0.2, 0.3, 0.4, 0.5, -0.1, -0.2, -0.3, -0.4, -0.5];
    const br = new BackupRecorder({
      stream: { getAudioTracks: () => [{} as MediaStreamTrack] } as unknown as MediaStream,
      mimeType: 'audio/wav',
      opfsRoot: async () => root as never,
      frameSource: fakeSourceOf([fakeFrame(samples)]),
    });
    br.start();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 20));

    const file = await br.stop();
    expect(file).not.toBeNull();
    expect(file?.size).toBe(44 + pcmBytes);

    const buf = await file!.arrayBuffer();
    const view = new DataView(buf);
    expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + pcmBytes);
    expect(String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11))).toBe('WAVE');
    expect(String.fromCharCode(view.getUint8(36), view.getUint8(37), view.getUint8(38), view.getUint8(39))).toBe('data');
    expect(view.getUint32(40, true)).toBe(pcmBytes);
  });
});

describe('take journal — small closed parts in browser storage', () => {
  const INIT = { room: 'abc-defg-hij', recordingId: 'r1', take: 1, hostStartMs: 1759824000000 };
  const TAKE_DIR = 'openmeet-take-1759824000000-abc-defg-hij';

  function ab(n: number, fill = 7): ArrayBuffer {
    return new Uint8Array(n).fill(fill).buffer;
  }

  function takeDirOf(root: FakeDirectoryHandle): FakeDirectoryHandle {
    return root.entries.get(TAKE_DIR) as FakeDirectoryHandle;
  }

  function fileDirOf(root: FakeDirectoryHandle, name: string): FakeDirectoryHandle {
    return takeDirOf(root).entries.get(name) as FakeDirectoryHandle;
  }

  function open(root: FakeDirectoryHandle) {
    return openTakeJournal(INIT, async () => root as never);
  }

  async function putPart(dir: FakeDirectoryHandle, name: string, bytes: Uint8Array<ArrayBuffer>) {
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    if (bytes.length > 0) await writable.write(bytes);
    await writable.close();
    return handle;
  }

  it('a part survives a dropped journal and the next session continues it', async () => {
    const root = new FakeDirectoryHandle('root');
    const first = await open(root);
    expect(first).not.toBeNull();
    expect(first!.dirName).toBe(TAKE_DIR);
    expect(first!.root).toBe(root);

    const file = first!.file('guest_r.mp4');
    file.append(0, ab(4));
    await file.commit(1);

    const second = await open(root);
    expect(await second!.file('guest_r.mp4').position()).toEqual({ nextIdx: 1, end: 4 });
    expect(second!.bytes).toBe(4);

    second!.file('guest_r.mp4').append(4, ab(4));
    await second!.file('guest_r.mp4').commit(2);

    expect([...fileDirOf(root, 'guest_r.mp4').entries.keys()]).toEqual([
      '000000-0-1.part',
      '000001-4-2.part',
    ]);
  });

  it('bytes appended but never committed are gone, and the journal is no backup', async () => {
    const root = new FakeDirectoryHandle('root');
    const first = await open(root);
    first!.file('guest_r.mp4').append(0, ab(4));
    await first!.file('guest_r.mp4').commit(1);
    first!.file('guest_r.mp4').append(4, ab(4));
    await first!.file('guest_r.mp4').commit(2);
    first!.file('guest_r.mp4').append(8, ab(4)); // never committed

    const second = await open(root);
    expect(await second!.file('guest_r.mp4').position()).toEqual({ nextIdx: 2, end: 8 });
    expect(second!.bytes).toBe(8);

    expect(await findBackups(async () => root as never)).toEqual([]);
    expect(root.entries.has(TAKE_DIR)).toBe(true);
  });

  it('an empty part changes nothing', async () => {
    const root = new FakeDirectoryHandle('root');
    const journal = (await open(root))!;
    const file = journal.file('guest_r.mp4');
    file.append(0, ab(4));
    await file.commit(1);
    await putPart(fileDirOf(root, 'guest_r.mp4'), '000001-4-2.part', new Uint8Array());
    await putPart(fileDirOf(root, 'guest_r.mp4'), '000002-99999999999999999999-3.part', new Uint8Array(4));

    expect(await file.position()).toEqual({ nextIdx: 1, end: 4 });
    expect(await file.parts()).toEqual([{ offset: 0, size: 4 }]);
  });

  it('a missing seq or an unreadable part ends the file', async () => {
    const root = new FakeDirectoryHandle('root');
    const journal = (await open(root))!;
    const dir = await takeDirOf(root).getDirectoryHandle('guest_r.mp4', { create: true });
    await putPart(dir, '000000-0-1.part', new Uint8Array(4));
    await putPart(dir, '000002-4-3.part', new Uint8Array(8));

    expect(await journal.file('guest_r.mp4').position()).toEqual({ nextIdx: 1, end: 4 });

    const unreadable = await takeDirOf(root).getDirectoryHandle('guest_u.mp4', { create: true });
    await putPart(unreadable, '000000-0-1.part', new Uint8Array(4));
    const gone = await putPart(unreadable, '000001-4-2.part', new Uint8Array(8));
    gone.getFile = async () => {
      throw new Error('gone');
    };
    await putPart(unreadable, '000002-12-3.part', new Uint8Array(8));

    expect(await journal.file('guest_u.mp4').position()).toEqual({ nextIdx: 1, end: 4 });
  });

  it('a refused append and a commit with no runs write nothing', async () => {
    const root = new FakeDirectoryHandle('root');
    const journal = (await open(root))!;
    const file = journal.file('guest_r.mp4');
    file.append(-1, ab(4));
    file.append(1.5, ab(4));
    file.append(0, new ArrayBuffer(0));
    await expect(file.commit(1)).resolves.toBeUndefined();

    expect(await file.position()).toBeNull();
    expect(file.dead).toBe(false);
    expect(takeDirOf(root).entries.has('guest_r.mp4')).toBe(false);

    await expect(journal.file('guest_c.mp4').commit(1)).resolves.toBeUndefined();
    expect(takeDirOf(root).entries.has('guest_c.mp4')).toBe(false);
  });

  it('a write that does not continue the last one starts a new part, and replay walks them', async () => {
    const root = new FakeDirectoryHandle('root');
    const journal = (await open(root))!;
    const file = journal.file('guest_r.mp4');
    file.append(0, ab(4, 1));
    file.append(1000, ab(44, 2));
    await file.commit(2);

    expect([...fileDirOf(root, 'guest_r.mp4').entries.keys()]).toEqual([
      '000000-0-2.part',
      '000001-1000-2.part',
    ]);
    expect(await file.position()).toEqual({ nextIdx: 2, end: 1044 });
    expect(await file.parts()).toEqual([
      { offset: 0, size: 4 },
      { offset: 1000, size: 44 },
    ]);

    const written: { position: number; first: number; size: number }[] = [];
    const end = await journal.replay('guest_r.mp4', {
      write: async (position, data) => {
        const bytes = new Uint8Array(await data.arrayBuffer());
        written.push({ position, first: bytes[0]!, size: bytes.byteLength });
      },
    });
    expect(end).toBe(1044);
    expect(written).toEqual([
      { position: 0, first: 1, size: 4 },
      { position: 1000, first: 2, size: 44 },
    ]);
  });

  it('a failed part is retried once, and a part that fails twice kills the whole journal', async () => {
    const root = new FakeDirectoryHandle('root');
    const journal = (await open(root))!;
    const dir = await takeDirOf(root).getDirectoryHandle('guest_r.mp4', { create: true });
    const part = await dir.getFileHandle('000000-0-1.part', { create: true });
    const realCreate = part.createWritable.bind(part);
    let attempts = 0;
    part.createWritable = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient disk error');
      return realCreate();
    };

    const file = journal.file('guest_r.mp4');
    file.append(0, ab(4));
    await file.commit(1);
    expect(attempts).toBe(2);
    expect(await file.position()).toEqual({ nextIdx: 1, end: 4 });
    expect(file.dead).toBe(false);

    const brokenRoot = new FakeDirectoryHandle('root');
    const broken = (await open(brokenRoot))!;
    const brokenDir = await takeDirOf(brokenRoot).getDirectoryHandle('guest_r.mp4', { create: true });
    brokenDir.getFileHandle = async (name) =>
      ({
        kind: 'file',
        name,
        createWritable: async () => {
          throw new Error('disk full');
        },
        getFile: async () => {
          throw new Error('unreadable');
        },
      }) as never;

    const dead = broken.file('guest_r.mp4');
    dead.append(0, ab(4));
    await expect(dead.commit(1)).resolves.toBeUndefined();
    expect(broken.bytes).toBe(0);
    expect(dead.dead).toBe(true);
    expect(broken.dead).toBe(true);
    expect(await dead.position()).toBeNull();

    dead.append(0, ab(4));
    await expect(dead.commit(1)).resolves.toBeUndefined();
    const other = broken.file('guest_c.mp4');
    other.append(0, ab(4));
    await expect(other.commit(1)).resolves.toBeUndefined();
    expect(broken.bytes).toBe(0);
    expect(takeDirOf(brokenRoot).entries.has('guest_c.mp4')).toBe(false);
  });

  it('a double failure drops the waiting commit without writing its runs', async () => {
    const root = new FakeDirectoryHandle('root');
    const journal = (await open(root))!;
    const dir = await takeDirOf(root).getDirectoryHandle('guest_r.mp4', { create: true });
    const realGetFile = dir.getFileHandle.bind(dir);
    dir.getFileHandle = async (name, opts) => {
      if (name === '000000-0-1.part') {
        return {
          kind: 'file',
          name,
          createWritable: async () => {
            throw new Error('disk full');
          },
        } as never;
      }
      return realGetFile(name, opts);
    };

    const file = journal.file('guest_r.mp4');
    file.append(0, ab(4));
    const first = file.commit(1);
    file.append(4, ab(4));
    const second = file.commit(2);

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();

    expect(journal.dead).toBe(true);
    expect(file.dead).toBe(true);
    expect(journal.bytes).toBe(0);
    expect([...dir.entries.keys()]).toEqual([]);
    expect(await file.position()).toBeNull();
  });

  it('a run flood is bounded to eight parts and the journal stays alive', async () => {
    const root = new FakeDirectoryHandle('root');
    const journal = (await open(root))!;
    const file = journal.file('guest_r.mp4');
    for (let i = 0; i < 9; i++) file.append(i * 100, ab(4));

    await file.commit(1);
    expect(file.dead).toBe(false);
    expect(fileDirOf(root, 'guest_r.mp4').entries.size).toBe(8);

    file.append(900, ab(4));
    await file.commit(2);
    expect(fileDirOf(root, 'guest_r.mp4').entries.size).toBe(9);
  });

  it('a commit in flight is not shared', async () => {
    const root = new FakeDirectoryHandle('root');
    const journal = (await open(root))!;
    const file = journal.file('guest_r.mp4');
    file.append(0, ab(4));
    const first = file.commit(1);
    file.append(4, ab(4));
    const second = file.commit(2);

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect([...fileDirOf(root, 'guest_r.mp4').entries.keys()]).toEqual([
      '000000-0-1.part',
      '000001-4-2.part',
    ]);
    expect(await file.position()).toEqual({ nextIdx: 2, end: 8 });
  });

  it('openTakeJournal returns null and never rejects on unusable input', async () => {
    await expect(
      openTakeJournal(INIT, async () => {
        throw new Error('no storage');
      }),
    ).resolves.toBeNull();
    await expect(openTakeJournal(INIT, async () => ({}) as never)).resolves.toBeNull();

    const noWritable = {
      kind: 'directory',
      name: 'root',
      getDirectoryHandle: async () => noWritable,
      getFileHandle: async (name: string) => ({ kind: 'file', name }),
      removeEntry: async () => {},
    };
    await expect(openTakeJournal(INIT, async () => noWritable as never)).resolves.toBeNull();

    const root = new FakeDirectoryHandle('root');
    await expect(openTakeJournal({ ...INIT, room: '' }, async () => root as never)).resolves.toBeNull();
    await expect(openTakeJournal({ ...INIT, hostStartMs: NaN }, async () => root as never)).resolves.toBeNull();
    expect(root.entries.size).toBe(0);
  });

  it('openTakeJournal asks for persistent storage', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('navigator', { storage: { persist } });
    try {
      const root = new FakeDirectoryHandle('root');
      const journal = await open(root);
      expect(journal).not.toBeNull();
      expect(persist).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('note() changes the notes object in place', async () => {
    const root = new FakeDirectoryHandle('root');
    const journal = (await open(root))!;
    const notes = journal.notes;
    journal.note((n) => n.files.push({ file: 'guest_r.mp4', kind: 'camera' }));

    expect(journal.notes).toBe(notes);
    expect(notes.files).toEqual([{ file: 'guest_r.mp4', kind: 'camera' }]);
  });

  it('file() is memoised and refuses anything that is not a plain file name', async () => {
    const root = new FakeDirectoryHandle('root');
    const journal = (await open(root))!;
    expect(journal.file('guest_r.mp4')).toBe(journal.file('guest_r.mp4'));
    expect(journal.file('guest_r.mp4').dead).toBe(false);

    const escaped = journal.file('../guest_r.mp4');
    expect(escaped.dead).toBe(true);
    expect(await escaped.position()).toBeNull();
    expect(await escaped.parts()).toEqual([]);
    await expect(escaped.commit(1)).resolves.toBeUndefined();

    const dotdot = journal.file('..');
    expect(dotdot.dead).toBe(true);
    expect(await dotdot.position()).toBeNull();
    await expect(dotdot.commit(1)).resolves.toBeUndefined();
    expect(takeDirOf(root).entries.has('../guest_r.mp4')).toBe(false);
    expect(takeDirOf(root).entries.has('..')).toBe(false);
  });

  it('finish() removes the directory, and a failed removal leaves the finished marker', async () => {
    const root = new FakeDirectoryHandle('root');
    const journal = (await open(root))!;
    journal.file('guest_r.mp4').append(0, ab(4));
    await journal.file('guest_r.mp4').commit(1);

    await expect(journal.finish()).resolves.toBeUndefined();
    expect(root.entries.has(TAKE_DIR)).toBe(false);

    const reopen = (await open(root))!;
    expect(reopen.bytes).toBe(0);
    expect(await reopen.file('guest_r.mp4').position()).toBeNull();

    const locked = new FakeDirectoryHandle('root');
    const lockedJournal = (await open(locked))!;
    locked.removeEntry = async () => {
      throw new Error('locked');
    };
    await expect(lockedJournal.finish()).resolves.toBeUndefined();
    expect(takeDirOf(locked).entries.has('finished')).toBe(true);
  });

  it('hostile input does not throw or break later steps', async () => {
    const root = new FakeDirectoryHandle('root');
    const journal = (await open(root))!;
    const file = journal.file('guest_r.mp4');

    const hostileValues = [
      'wrong',
      1e25,
      Infinity,
      -1e25,
      NaN,
      -5,
      '',
      null,
      undefined,
      {},
      [],
      'text\nwith\nnewlines',
      'text"with\'quotes',
      '../traversal',
    ];

    for (const val of hostileValues) {
      // commit(nextIdx)
      await expect(file.commit(val as never)).resolves.toBeUndefined();
      // append(offset, data)
      expect(() => file.append(val as never, val as never)).not.toThrow();
      expect(() => file.append(val as never, ab(4))).not.toThrow();
      expect(() => file.append(0, val as never)).not.toThrow();
      // file(name)
      const f = journal.file(val as never);
      expect(f.dead).toBe(true);
      await expect(f.commit(1)).resolves.toBeUndefined();
      await expect(f.position()).resolves.toBeNull();
      await expect(f.parts()).resolves.toEqual([]);
    }
  });

  it('a waiting commit is named with the largest nextIdx among the calls it resolves', async () => {
    const root = new FakeDirectoryHandle('root');
    const journal = (await open(root))!;
    const file = journal.file('guest_r.mp4');

    file.append(0, ab(4));
    const first = file.commit(1);

    file.append(4, ab(4));
    const second = file.commit(5);
    const third = file.commit(10);
    const fourth = file.commit(3);

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    await expect(third).resolves.toBeUndefined();
    await expect(fourth).resolves.toBeUndefined();

    expect([...fileDirOf(root, 'guest_r.mp4').entries.keys()]).toEqual([
      '000000-0-1.part',
      '000001-4-10.part',
    ]);
    expect(await file.position()).toEqual({ nextIdx: 10, end: 8 });
  });

  it('contiguous appends in one commit coalesce into a single part', async () => {
    const root = new FakeDirectoryHandle('root');
    const journal = (await open(root))!;
    const file = journal.file('guest_r.mp4');
    file.append(0, ab(4, 1));
    file.append(4, ab(4, 2));
    await file.commit(1);

    expect([...fileDirOf(root, 'guest_r.mp4').entries.keys()]).toEqual(['000000-0-1.part']);
    expect(await file.position()).toEqual({ nextIdx: 1, end: 8 });
    expect(await file.parts()).toEqual([{ offset: 0, size: 8 }]);
  });

  it('a later part rewriting an earlier offset does not shrink position().end', async () => {
    const root = new FakeDirectoryHandle('root');
    const journal = (await open(root))!;
    const file = journal.file('guest_r.mp4');
    file.append(1000, ab(50));
    await file.commit(1);
    file.append(0, ab(44));
    await file.commit(2);

    expect(await file.position()).toEqual({ nextIdx: 2, end: 1050 });
  });

  it('replay stops at an unreadable part or failed write and resolves without rejecting', async () => {
    const root = new FakeDirectoryHandle('root');
    const journal = (await open(root))!;
    const file = journal.file('guest_r.mp4');
    file.append(0, ab(4));
    await file.commit(1);
    file.append(4, ab(4));
    await file.commit(2);

    const dir = fileDirOf(root, 'guest_r.mp4');
    const part2 = (await dir.getFileHandle('000001-4-2.part')) as FakeFileHandle;
    const realGetFile = part2.getFile.bind(part2);
    let calls = 0;
    part2.getFile = async () => {
      calls += 1;
      if (calls > 1) throw new Error('corrupt part during replay');
      return realGetFile();
    };

    const written: number[] = [];
    const end = await journal.replay('guest_r.mp4', {
      write: async (pos) => {
        written.push(pos);
      },
    });
    expect(end).toBe(4);
    expect(written).toEqual([0]);

    // Also test into.write throwing
    file.append(8, ab(4));
    await file.commit(3);
    const end2 = await journal.replay('guest_r.mp4', {
      write: async (pos) => {
        if (pos > 0) throw new Error('write failed');
      },
    });
    expect(end2).toBe(4);
  });
});

