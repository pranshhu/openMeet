import { describe, it, expect, vi } from 'vitest';
import { copyBackupInto, recoverTake } from '@/lib/take-recovery';
import type { FsDirectoryHandle } from '@/lib/fs-writer';
import type { TakeJournal, TakeNotes } from '@/lib/take-journal';

function fakeWritable() {
  const calls: { position: number; data: unknown }[] = [];
  const write = vi.fn((arg: { position: number; data: unknown }) => {
    calls.push({ position: arg.position, data: arg.data });
    return Promise.resolve();
  });
  return { write, calls, close: vi.fn().mockResolvedValue(undefined) };
}

type FakeWritable = ReturnType<typeof fakeWritable>;

interface SeedFile {
  size: number;
  /** False stands for a handle the browser cannot read a length from. */
  getFile?: boolean;
}

/** A recording folder: seeded names, or a created one when `create` is set. */
function fakeFolder(seed: Record<string, SeedFile> = {}) {
  const files = new Map<string, Required<SeedFile>>(
    Object.entries(seed).map(([name, f]) => [name, { size: f.size, getFile: f.getFile !== false }])
  );
  // One entry per createWritable() call: the folder was opened for writing.
  const opened: { name: string; writable: FakeWritable }[] = [];
  const getFileHandle = vi.fn(async (name: string, opts?: { create?: boolean }) => {
    let record = files.get(name);
    if (!record) {
      if (!opts?.create) {
        const err = new Error('not found');
        err.name = 'NotFoundError';
        throw err;
      }
      record = { size: 0, getFile: true };
      files.set(name, record);
    }
    const held = record;
    return {
      name,
      getFile: held.getFile ? async () => ({ size: held.size }) : undefined,
      createWritable: async () => {
        const writable = fakeWritable();
        opened.push({ name, writable });
        return writable;
      },
    };
  });
  return { getFileHandle, opened };
}

/** The journal directory the host's own backups live under. */
type FakePartHandle = { name: string; getFile(): Promise<File> };

class FakeDir {
  readonly entries = new Map<string, FakeDir | FakePartHandle>();
  readonly getDirectoryHandle = vi.fn(
    async (name: string, opts?: { create?: boolean }): Promise<FakeDir> => {
      const found = this.entries.get(name);
      if (found instanceof FakeDir) return found;
      if (!found && opts?.create) {
        const dir = new FakeDir(name);
        this.entries.set(name, dir);
        return dir;
      }
      const err = new Error('not found');
      err.name = 'NotFoundError';
      throw err;
    }
  );

  constructor(readonly name: string = '') {}

  async *values() {
    for (const entry of this.entries.values()) yield entry;
  }
}

function backupDir(name: string, chunks: Uint8Array[]): FakeDir {
  const dir = new FakeDir(name);
  chunks.forEach((bytes, i) => {
    const part = `${String(i).padStart(6, '0')}.part`;
    dir.entries.set(part, { name: part, getFile: async () => new File([bytes as BlobPart], part) });
  });
  return dir;
}

interface Part {
  offset: number;
  size: number;
  data: Blob;
}

function part(offset: number, size: number): Part {
  return { offset, size, data: new Blob([new Uint8Array(size)]) };
}

interface FakeFileNote {
  parts: Part[];
  failReplay?: boolean;
}

function fakeJournal(
  notes: TakeNotes,
  files: Record<string, FakeFileNote> = {},
  root: FakeDir = new FakeDir('root')
) {
  const file = vi.fn((name: string) => {
    const held = files[name] ?? { parts: [] };
    return {
      parts: () => Promise.resolve(held.parts.map(({ offset, size }) => ({ offset, size }))),
      // The last part's end, as take-journal.ts reports it: 44 for a WAV whose
      // final write was the header rewrite at offset 0.
      position: () => {
        const last = held.parts[held.parts.length - 1];
        return Promise.resolve(last ? { nextIdx: 0, end: last.offset + last.size } : null);
      },
      replay: async (into: { write(position: number, data: Blob): Promise<void> }) => {
        if (held.failReplay) throw new Error('replay failed');
        let end = 0;
        for (const p of held.parts) {
          await into.write(p.offset, p.data);
          end = Math.max(end, p.offset + p.size);
        }
        return end;
      },
    };
  });
  const replay = vi.fn((name: string, into: { write(position: number, data: Blob): Promise<void> }) =>
    file(name).replay(into)
  );
  return { journal: { notes, root, file, replay } as unknown as TakeJournal, file };
}

function notesWith(over: Partial<TakeNotes> = {}): TakeNotes {
  return {
    room: 'abc-defg-hij',
    recordingId: 'rec-1',
    take: 1,
    hostStartMs: 1_700_000_000_000,
    files: [],
    backups: [],
    markers: [],
    ...over,
  };
}

const folderOf = (folder: ReturnType<typeof fakeFolder>) => folder as unknown as FsDirectoryHandle;

const BACKUP_DIR = 'openmeet-backup-host-1-abc-defg-hij';

describe('recoverTake', () => {
  it('rebuilds a file from its parts, at their own offsets and by reference', async () => {
    // Removal that must fail this test: skipping the journal.replay call, or the writer.close.
    const first = part(0, 10);
    const second = part(1_310_720, 5);
    const notes = notesWith({ files: [{ file: 'guest_r.mp4', kind: 'camera' }] });
    const { journal } = fakeJournal(notes, { 'guest_r.mp4': { parts: [first, second] } });
    const folder = fakeFolder();

    const results = await recoverTake(journal, folderOf(folder));

    expect(results).toEqual([{ name: 'guest_r.mp4', bytes: 1_310_725, source: 'journal' }]);
    expect(folder.opened.map((o) => o.name)).toEqual(['guest_r.mp4']);
    const calls = folder.opened[0]!.writable.calls;
    expect(calls.map((c) => c.position)).toEqual([0, 1_310_720]);
    expect(calls[0]!.data).toBe(first.data);
    expect(calls[1]!.data).toBe(second.data);
    expect(folder.opened[0]!.writable.close).toHaveBeenCalledOnce();
  });

  it('leaves a folder file that is already at least as long as the journal version', async () => {
    // Removal that must fail this test: the existing-size comparison in recoverTake.
    const notes = notesWith({ files: [{ file: 'guest_r.mp4', kind: 'camera' }] });
    const { journal } = fakeJournal(notes, {
      'guest_r.mp4': { parts: [part(0, 10), part(1_310_720, 5)] },
    });
    const folder = fakeFolder({ 'guest_r.mp4': { size: 1_310_725 } });

    const results = await recoverTake(journal, folderOf(folder));

    expect(results).toEqual([{ name: 'guest_r.mp4', bytes: 1_310_725, source: 'kept' }]);
    // The length is asked for without create: a missing file must stay missing.
    expect(folder.getFileHandle).toHaveBeenCalledWith('guest_r.mp4');
    expect(folder.opened).toEqual([]);
  });

  it('measures the journal version by its furthest part, not its last one', async () => {
    // Removal that must fail this test: taking the length from position().end,
    // or from the last part's offset + size, so a completed WAV reads as 44.
    const notes = notesWith({ files: [{ file: 'host_r.wav', kind: 'wav' }] });
    const { journal } = fakeJournal(notes, {
      'host_r.wav': { parts: [part(100, 10), part(0, 44)] },
    });
    const folder = fakeFolder({ 'host_r.wav': { size: 44 } });

    const results = await recoverTake(journal, folderOf(folder));

    expect(results).toEqual([{ name: 'host_r.wav', bytes: 110, source: 'journal' }]);
  });

  it('rebuilds when the folder cannot say how long its file is', async () => {
    // Removal that must fail this test: treating a failed getFileHandle, or a
    // handle with no getFile, as a reason to keep the folder's file.
    const noFile = fakeFolder();
    const noGetFile = fakeFolder({ 'guest_r.mp4': { size: 999, getFile: false } });

    for (const folder of [noFile, noGetFile]) {
      const notes = notesWith({ files: [{ file: 'guest_r.mp4', kind: 'camera' }] });
      const { journal } = fakeJournal(notes, { 'guest_r.mp4': { parts: [part(0, 4)] } });

      const results = await recoverTake(journal, folderOf(folder));

      expect(results).toEqual([{ name: 'guest_r.mp4', bytes: 4, source: 'journal' }]);
      expect(folder.opened.map((o) => o.name)).toEqual(['guest_r.mp4']);
    }
  });

  it('repairs a WAV whose final header never arrived', async () => {
    // Removal that must fail this test: the patchWavHeader call, or its condition.
    const notes = notesWith({ files: [{ file: 'host_r.wav', kind: 'wav' }] });
    const { journal } = fakeJournal(notes, {
      'host_r.wav': { parts: [part(0, 44), part(44, 1000)] },
    });
    const folder = fakeFolder();

    const results = await recoverTake(journal, folderOf(folder));

    expect(results).toEqual([{ name: 'host_r.wav', bytes: 1044, source: 'journal' }]);
    const calls = folder.opened[0]!.writable.calls;
    expect(calls.map((c) => c.position)).toEqual([0, 44, 4, 40]);
    expect(new DataView(calls[2]!.data as ArrayBuffer).getUint32(0, true)).toBe(1036);
    expect(new DataView(calls[3]!.data as ArrayBuffer).getUint32(0, true)).toBe(1000);
  });

  it('leaves a WAV whose final write already is the real header', async () => {
    // Removal that must fail this test: the last.offset !== 0 condition, so
    // every WAV gets patched.
    const notes = notesWith({ files: [{ file: 'host_r.wav', kind: 'wav' }] });
    const { journal } = fakeJournal(notes, {
      'host_r.wav': { parts: [part(44, 1000), part(0, 44)] },
    });
    const folder = fakeFolder();

    const results = await recoverTake(journal, folderOf(folder));

    expect(results).toEqual([{ name: 'host_r.wav', bytes: 1044, source: 'journal' }]);
    expect(folder.opened[0]!.writable.calls.map((c) => c.position)).toEqual([44, 0]);
  });

  it('copies the host backups the notes name', async () => {
    // Removal that must fail this test: the notes.backups loop.
    const chunks = [new Uint8Array(10), new Uint8Array(5)];
    const root = new FakeDir('root');
    root.entries.set(BACKUP_DIR, backupDir(BACKUP_DIR, chunks));
    const notes = notesWith({ backups: [{ dir: BACKUP_DIR, file: 'host_r.mp4', kind: 'camera' }] });
    const { journal } = fakeJournal(notes, {}, root);
    const folder = fakeFolder();

    const results = await recoverTake(journal, folderOf(folder));

    expect(results).toEqual([{ name: 'host_r.mp4', bytes: 15, source: 'backup' }]);
    const calls = folder.opened[0]!.writable.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.position).toBe(0);
    expect((calls[0]!.data as Blob).size).toBe(15);
    expect(folder.opened[0]!.writable.close).toHaveBeenCalledOnce();
  });

  it('leaves a folder file that is already as long as the backup', async () => {
    // Removal that must fail this test: the existing-size comparison in copyBackupInto.
    const chunks = [new Uint8Array(10), new Uint8Array(5)];
    const root = new FakeDir('root');
    root.entries.set(BACKUP_DIR, backupDir(BACKUP_DIR, chunks));
    const notes = notesWith({ backups: [{ dir: BACKUP_DIR, file: 'host_r.mp4', kind: 'camera' }] });
    const { journal } = fakeJournal(notes, {}, root);
    const folder = fakeFolder({ 'host_r.mp4': { size: 15 } });

    const results = await recoverTake(journal, folderOf(folder));

    expect(results).toEqual([{ name: 'host_r.mp4', bytes: 15, source: 'kept' }]);
    expect(folder.opened).toEqual([]);
  });

  it('reports a backup it cannot assemble as failed, and resolves', async () => {
    // Removal that must fail this test: letting the missing-directory rejection
    // escape copyBackupInto, or dropping the null-file check (the folder would
    // then be asked for a length before anything is written).
    const missing = new FakeDir('root');
    const empty = new FakeDir('root');
    empty.entries.set(BACKUP_DIR, backupDir(BACKUP_DIR, []));

    for (const root of [missing, empty]) {
      const { journal } = fakeJournal(notesWith(), {}, root);
      const folder = fakeFolder();

      const result = await copyBackupInto(journal, folderOf(folder), {
        dir: BACKUP_DIR,
        file: 'host_r.mp4',
        kind: 'camera',
      });

      expect(result).toMatchObject({ name: 'host_r.mp4', bytes: 0, source: 'failed' });
      expect(folder.getFileHandle).not.toHaveBeenCalled();
      expect(folder.opened).toEqual([]);
    }
  });

  it('reports failed when the storage root cannot open a directory', async () => {
    // Removal that must fail this test: none — the outer catch reports the same
    // failed result. It pins the contract the resume path needs: a root without
    // getDirectoryHandle still gets a result instead of a rejection.
    const root = { name: 'root' } as unknown as FakeDir;
    const { journal } = fakeJournal(notesWith(), {}, root);
    const folder = fakeFolder();

    const result = await copyBackupInto(journal, folderOf(folder), {
      dir: BACKUP_DIR,
      file: 'host_r.mp4',
      kind: 'camera',
    });

    expect(result).toMatchObject({ name: 'host_r.mp4', bytes: 0, source: 'failed' });
    expect(folder.opened).toEqual([]);
  });

  it('keeps a backup that cannot be assembled as one failed result', async () => {
    // Removal that must fail this test: the try around each copyBackupInto call.
    const notes = notesWith({ backups: [{ dir: BACKUP_DIR, file: 'host_r.mp4', kind: 'camera' }] });
    const { journal } = fakeJournal(notes, {}, new FakeDir('root'));
    const folder = fakeFolder();

    const results = await recoverTake(journal, folderOf(folder));

    expect(results).toMatchObject([{ name: 'host_r.mp4', bytes: 0, source: 'failed' }]);
    expect(folder.getFileHandle).not.toHaveBeenCalled();
  });

  it('returns the journal files before the backups', async () => {
    // Removal that must fail this test: appending the backups anywhere but
    // after the journal files.
    const root = new FakeDir('root');
    root.entries.set(BACKUP_DIR, backupDir(BACKUP_DIR, [new Uint8Array(5)]));
    const notes = notesWith({
      files: [{ file: 'guest_r.mp4', kind: 'camera' }],
      backups: [{ dir: BACKUP_DIR, file: 'host_r.mp4', kind: 'camera' }],
    });
    const { journal } = fakeJournal(notes, { 'guest_r.mp4': { parts: [part(0, 3)] } }, root);
    const folder = fakeFolder();

    const results = await recoverTake(journal, folderOf(folder));

    expect(results.map((r) => [r.name, r.source])).toEqual([
      ['guest_r.mp4', 'journal'],
      ['host_r.mp4', 'backup'],
    ]);
  });

  it('returns one result per named file, failures included, in order', async () => {
    // Removal that must fail this test: the empty-parts check, or the per-file
    // try that turns a replay throw into a result.
    const notes = notesWith({
      files: [
        { file: 'a.mp4', kind: 'camera' },
        { file: 'b.mp4', kind: 'camera' },
        { file: 'c.mp4', kind: 'camera' },
        { file: 'd.mp4', kind: 'camera' },
      ],
    });
    const { journal } = fakeJournal(notes, {
      'a.mp4': { parts: [part(0, 3)] },
      'b.mp4': { parts: [] },
      'c.mp4': { parts: [part(0, 3)], failReplay: true },
      'd.mp4': { parts: [part(0, 7)] },
    });
    const folder = fakeFolder();

    const results = await recoverTake(journal, folderOf(folder));

    expect(results.map((r) => [r.name, r.source, r.bytes])).toEqual([
      ['a.mp4', 'journal', 3],
      ['b.mp4', 'failed', 0],
      ['c.mp4', 'failed', 0],
      ['d.mp4', 'journal', 7],
    ]);
    expect(results[1]!.reason).toBe('nothing was committed');
  });

  it('refuses a stored name that is not a plain file name, without opening anything', async () => {
    // Removal that must fail this test: the isJournalFileName checks before any
    // path or part is touched.
    const entry = { dir: BACKUP_DIR, file: '../escape.mp4', kind: 'camera' as const };
    const notes = notesWith({
      files: [{ file: '../escape.mp4', kind: 'camera' }],
      backups: [entry],
    });
    const root = new FakeDir('root');
    const { journal, file } = fakeJournal(notes, {}, root);
    const folder = fakeFolder();

    const direct = await copyBackupInto(journal, folderOf(folder), entry);
    const results = await recoverTake(journal, folderOf(folder));

    expect(direct).toMatchObject({
      name: '../escape.mp4',
      bytes: 0,
      source: 'failed',
      reason: 'bad file name',
    });
    expect(results[0]).toMatchObject({
      name: '../escape.mp4',
      bytes: 0,
      source: 'failed',
      reason: 'bad file name',
    });
    expect(results[1]).toMatchObject({
      name: '../escape.mp4',
      source: 'failed',
      reason: 'bad file name',
    });
    expect(file).not.toHaveBeenCalled();
    expect(root.getDirectoryHandle).not.toHaveBeenCalled();
    expect(folder.getFileHandle).not.toHaveBeenCalled();
    expect(folder.opened).toEqual([]);
  });
});
