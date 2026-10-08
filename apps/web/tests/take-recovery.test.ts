import { describe, it, expect, vi } from 'vitest';
import { copyBackupInto, recoverTake, saveRecoveredTake } from '@/lib/take-recovery';
import type { FsDirectoryHandle } from '@/lib/fs-writer';
import { findTakeJournals, openTakeJournal, type TakeJournal, type TakeNotes } from '@/lib/take-journal';
import { WAV_HEADER_BYTES, wavHeader } from '@/lib/wav';
import { FakeDirectoryHandle, FakeFileHandle } from './fake-opfs';

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

/** A recording folder: seeded names, or a created one when `create` is set. A name in `refuse` cannot be opened for writing. */
function fakeFolder(seed: Record<string, SeedFile> = {}, refuse: string[] = []) {
  const files = new Map<string, Required<SeedFile>>(
    Object.entries(seed).map(([name, f]) => [name, { size: f.size, getFile: f.getFile !== false }])
  );
  // One entry per createWritable() call: the folder was opened for writing.
  const opened: { name: string; writable: FakeWritable }[] = [];
  // What each closed writable left in its file, keyed by name: a name that is
  // absent was never closed, so it was never written.
  const written = new Map<string, { data: Uint8Array; closed: boolean }>();
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
    let data: Uint8Array = new Uint8Array(0);
    return {
      name,
      getFile: held.getFile ? async () => ({ size: held.size }) : undefined,
      createWritable: async () => {
        if (refuse.includes(name)) throw new Error('permission denied');
        const writable = fakeWritable();
        opened.push({ name, writable });
        return {
          write: (arg: { position: number; data: unknown }) => {
            data = arg.data as Uint8Array;
            return writable.write(arg);
          },
          close: async () => {
            await writable.close();
            written.set(name, { data, closed: true });
          },
        };
      },
    };
  });
  return { getFileHandle, opened, written };
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
  const finish = vi.fn().mockResolvedValue(undefined);
  // As the real journal: a directory exists only for a file that got a part,
  // and bytes counts every part of every directory.
  const held = Object.entries(files).filter(([, f]) => f.parts.length > 0);
  const fileNames = () => Promise.resolve(held.map(([name]) => name));
  const bytes = held.reduce((n, [, f]) => n + f.parts.reduce((m, p) => m + p.size, 0), 0);
  return { journal: { notes, root, file, replay, finish, fileNames, bytes } as unknown as TakeJournal, file, finish };
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
    // Removal that must fail this test: taking the length from the last part's
    // offset + size, so a completed WAV reads as 44.
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

const HOST_CAM = 'openmeet-backup-host-1-abc-defg-hij';
const HOST_WAV = 'openmeet-backup-host-audio-1-abc-defg-hij';
const INTERRUPTED =
  'This recording was interrupted — the files were rebuilt from the browser’s copy after it closed.';

describe('saveRecoveredTake', () => {
  /** The file a closed writable left in the folder, parsed as JSON. */
  const savedJson = (folder: ReturnType<typeof fakeFolder>, name: string) =>
    JSON.parse(new TextDecoder().decode(folder.written.get(name)!.data));

  it('writes the sync sidecar, names the host files from the notes, and removes the journal', async () => {
    // Removal that must fail this test: the sync writeTakeSidecars call, the
    // journal.finish call, the hostFile or hostWavFile spread, or the screen mapping.
    const start = 1_700_000_000_000;
    const notes = notesWith({
      hostStartMs: start,
      files: [
        { file: 'guest_r.mp4', kind: 'camera', slot: 0 },
        { file: 'guest_screen_r.mp4', kind: 'screen', segment: 1, startedAtMs: start + 4000, who: 'Bob' },
      ],
      backups: [
        { dir: HOST_CAM, file: 'host_r.mp4', kind: 'camera' },
        { dir: HOST_WAV, file: 'host_r.wav', kind: 'wav' },
      ],
    });
    // The root holds no backup directory: the report must name the host's files
    // from the notes, not from a copy it could assemble.
    const { journal, finish } = fakeJournal(notes, { 'guest_r.mp4': { parts: [part(0, 3)] } });
    const folder = fakeFolder();

    const result = await saveRecoveredTake(journal, folderOf(folder));

    const json = savedJson(folder, 'sync_rec-1.json');
    expect(json.warnings[0]).toBe(INTERRUPTED);
    expect(json.files.host).toBe('host_r.mp4');
    expect(json.audioMasters.host).toBe('host_r.wav');
    expect(json.timeline.screenSegments[0]).toEqual({
      file: 'guest_screen_r.mp4',
      offsetMs: 4000,
      endedEarly: true,
      sharer: 'Bob',
    });
    expect(finish).toHaveBeenCalledOnce();
    expect(result.json).toBe('sync_rec-1.json');
  });

  it('writes no chapters file when nothing was marked, and says so', async () => {
    // Removal that must fail this test: dropping && Boolean(report.chapters)
    // from the result, or writing the chapters content regardless of empty,
    // past the skip writeTakeSidecars does.
    const notes = notesWith({ files: [{ file: 'guest_r.mp4', kind: 'camera', slot: 0 }] });
    const { journal } = fakeJournal(notes, { 'guest_r.mp4': { parts: [part(0, 3)] } });
    const folder = fakeFolder();

    const result = await saveRecoveredTake(journal, folderOf(folder));

    expect(folder.getFileHandle).not.toHaveBeenCalledWith('chapters_rec-1.txt', { create: true });
    expect(folder.written.has('chapters_rec-1.txt')).toBe(false);
    expect(result.chapters).toBe(false);
  });

  it('writes the chapters file and keeps the markers when something was marked', async () => {
    // Removal that must fail this test: the chapters writeTakeSidecars call, or
    // handing the notes' markers to the report.
    const notes = notesWith({
      files: [{ file: 'guest_r.mp4', kind: 'camera', slot: 0 }],
      markers: [{ atMs: 5000, label: 'Intro', from: 'host' }],
    });
    const { journal } = fakeJournal(notes, { 'guest_r.mp4': { parts: [part(0, 3)] } });
    const folder = fakeFolder();

    const result = await saveRecoveredTake(journal, folderOf(folder));

    expect(new TextDecoder().decode(folder.written.get('chapters_rec-1.txt')!.data)).toBe(
      '0:00 Start\n0:05 Intro\n'
    );
    expect(result.chapters).toBe(true);
    expect(savedJson(folder, 'sync_rec-1.json').markers[0]).toMatchObject({
      atMs: 5000,
      label: 'Intro',
      from: 'host',
    });
  });

  it('keeps the sync file when only the chapters write fails', async () => {
    // Removal that must fail this test: merging the two writeTakeSidecars calls
    // into one, so a chapters failure nulls the sync file.
    const notes = notesWith({
      files: [{ file: 'guest_r.mp4', kind: 'camera', slot: 0 }],
      markers: [{ atMs: 5000, label: 'Intro', from: 'host' }],
    });
    const { journal, finish } = fakeJournal(notes, { 'guest_r.mp4': { parts: [part(0, 3)] } });
    const folder = fakeFolder({}, ['chapters_rec-1.txt']);

    const result = await saveRecoveredTake(journal, folderOf(folder));

    expect(result.json).toBe('sync_rec-1.json');
    expect(result.chapters).toBe(false);
    expect(folder.written.has('sync_rec-1.json')).toBe(true);
    expect(finish).toHaveBeenCalledOnce();
  });

  it('maps the journal notes to guests without inventing a digest', async () => {
    // Removal that must fail this test: sha256Sent on the guest mapping (the
    // integrity text becomes a mismatch), recovered: true in checks (the row
    // becomes complete), endedEarly: true, or taking the WAV note without
    // checking what its file got.
    const start = 1_700_000_000_000;
    const notes = notesWith({
      hostStartMs: start,
      files: [
        { file: 'guest_r.mp4', kind: 'camera', slot: 0, who: 'Bob', guestStartHostMs: start + 1500, rttMs: 42 },
        { file: 'guest_r.wav', kind: 'wav', slot: 0 },
      ],
    });
    const { journal } = fakeJournal(notes, {
      'guest_r.mp4': { parts: [part(0, 3)] },
      'guest_r.wav': { parts: [part(0, 44)] },
    });
    const folder = fakeFolder();

    await saveRecoveredTake(journal, folderOf(folder));

    const json = savedJson(folder, 'sync_rec-1.json');
    expect(json.guests[0]).toMatchObject({
      slot: 0,
      name: 'Bob',
      file: 'guest_r.mp4',
      wavFile: 'guest_r.wav',
      offsetMs: 1500,
      endedEarly: true,
    });
    expect(json.guests[0].integrity.text).toContain('Not verified');
    expect(json.timeline.clockSyncRttMs).toBe(42);
    expect(json.verification).toContainEqual(
      expect.objectContaining({ file: 'guest_r.mp4', status: 'unverified', bytes: 3 })
    );
  });

  it('leaves out a WAV note whose file got no bytes, and warns', async () => {
    // Removal that must fail this test: taking the WAV note without asking
    // byName what its file got.
    const start = 1_700_000_000_000;
    const notes = notesWith({
      hostStartMs: start,
      files: [
        { file: 'guest_r.mp4', kind: 'camera', slot: 0, who: 'Bob', guestStartHostMs: start + 1500, rttMs: 42 },
        { file: 'guest_r.wav', kind: 'wav', slot: 0 },
      ],
    });
    const { journal } = fakeJournal(notes, {
      'guest_r.mp4': { parts: [part(0, 3)] },
      'guest_r.wav': { parts: [] },
    });
    const folder = fakeFolder();

    await saveRecoveredTake(journal, folderOf(folder));

    const json = savedJson(folder, 'sync_rec-1.json');
    expect(json.guests[0].wavFile).toBeNull();
    expect(json.warnings).toContain('no WAV master for Bob');
  });

  it('keeps the journal when the sync file cannot be written, and never rejects', async () => {
    // Removal that must fail this test: the if (jsonOk) guard around finish.
    const notes = notesWith({ files: [{ file: 'guest_r.mp4', kind: 'camera', slot: 0 }] });
    const { journal, finish } = fakeJournal(notes, { 'guest_r.mp4': { parts: [part(0, 3)] } });
    const folder = fakeFolder({}, ['sync_rec-1.json']);

    const result = await saveRecoveredTake(journal, folderOf(folder));

    expect(result).toEqual({
      files: [{ name: 'guest_r.mp4', bytes: 3, source: 'journal' }],
      json: null,
      chapters: false,
      kept: true,
    });
    expect(finish).not.toHaveBeenCalled();
  });

  it('resolves when building the report throws', async () => {
    // Removal that must fail this test: the try around the report and the
    // sidecar writes, which turns a throw into a result.
    const buildSpy = vi
      .spyOn(await import('@/lib/sync-report'), 'buildSyncReport')
      .mockImplementationOnce(() => {
        throw new Error('boom');
      });
    const notes = notesWith({ files: [{ file: 'guest_r.mp4', kind: 'camera', slot: 0 }] });
    const { journal, finish } = fakeJournal(notes, { 'guest_r.mp4': { parts: [part(0, 3)] } });
    const folder = fakeFolder();
    try {
      const result = await saveRecoveredTake(journal, folderOf(folder));

      expect(result).toEqual({
        files: [{ name: 'guest_r.mp4', bytes: 3, source: 'journal' }],
        json: null,
        chapters: false,
        kept: true,
      });
      expect(finish).not.toHaveBeenCalled();
    } finally {
      buildSpy.mockRestore();
    }
  });

  it('never gives a screen segment a negative offset', async () => {
    // Removal that must fail this test: dropping Math.max(0, …) from the offset.
    const start = 1_700_000_000_000;
    const notes = notesWith({
      hostStartMs: start,
      files: [
        { file: 'guest_r.mp4', kind: 'camera', slot: 0 },
        { file: 'guest_screen_r.mp4', kind: 'screen', segment: 1, startedAtMs: start - 5000, who: 'Bob' },
      ],
    });
    const { journal } = fakeJournal(notes, {
      'guest_r.mp4': { parts: [part(0, 3)] },
      'guest_screen_r.mp4': { parts: [part(0, 3)] },
    });
    const folder = fakeFolder();

    await saveRecoveredTake(journal, folderOf(folder));

    const json = savedJson(folder, 'sync_rec-1.json');
    expect(json.timeline.screenSegments[0].offsetMs).toBe(0);
  });

  it('gives a guest note with no slot the first slot', async () => {
    // Removal that must fail this test: dropping the ?? 0 default on the slot.
    const notes = notesWith({ files: [{ file: 'guest_r.mp4', kind: 'camera', who: 'Bob' }] });
    const { journal } = fakeJournal(notes, { 'guest_r.mp4': { parts: [part(0, 3)] } });
    const folder = fakeFolder();

    await saveRecoveredTake(journal, folderOf(folder));

    expect(savedJson(folder, 'sync_rec-1.json').guests[0].slot).toBe(0);
  });

  it('keeps the host files copied from the backups out of the rebuilt verdict', async () => {
    // Removal that must fail this test: marking every check recovered instead
    // of only the guests' files.
    const notes = notesWith({
      files: [{ file: 'guest_r.mp4', kind: 'camera', slot: 0, who: 'Bob' }],
      backups: [{ dir: HOST_CAM, file: 'host_r.mp4', kind: 'camera' }],
    });
    const root = new FakeDir('root');
    root.entries.set(HOST_CAM, backupDir(HOST_CAM, [new Uint8Array(10)]));
    const { journal } = fakeJournal(notes, { 'guest_r.mp4': { parts: [part(0, 3)] } }, root);
    const folder = fakeFolder();

    await saveRecoveredTake(journal, folderOf(folder));

    const json = savedJson(folder, 'sync_rec-1.json');
    expect(json.verification).toContainEqual(
      expect.objectContaining({
        file: 'host_r.mp4',
        status: 'complete',
        detail: 'Complete. Recorded on this computer.',
      })
    );
    expect(json.verification).toContainEqual(expect.objectContaining({ file: 'guest_r.mp4', status: 'unverified' }));
  });
});

/**
 * A recording folder that keeps bytes at their positions. A file is in the
 * folder only once its writable closed, as in the browser, and a writable
 * starts empty unless it was opened keeping what the file holds.
 */
class DiskFolder {
  readonly files = new Map<string, Uint8Array>();
  /** One entry per file opened for writing, in order. */
  readonly opened: string[] = [];
  /** name -> the most bytes that file may reach; a write past it rejects like a full disk. */
  readonly room = new Map<string, number>();
  /** Names that cannot be opened for writing: held open by another program, or read-only. */
  readonly locked = new Set<string>();
  /** As Chrome: once a write was refused, closing the file fails and nothing of it is kept. */
  failedWriteLosesFile = false;

  async getFileHandle(name: string, opts?: { create?: boolean }) {
    if (!this.files.has(name)) {
      if (!opts?.create) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
      this.files.set(name, new Uint8Array(0));
    }
    return {
      name,
      getFile: async () => new Blob([this.files.get(name)! as BlobPart]),
      createWritable: async (opts?: { keepExistingData?: boolean }) => {
        if (this.locked.has(name)) throw Object.assign(new Error('locked'), { name: 'NoModificationAllowedError' });
        this.opened.push(name);
        let buf = opts?.keepExistingData ? this.files.get(name)!.slice() : new Uint8Array(0);
        let refused = false;
        return {
          write: async (arg: { position: number; data: ArrayBuffer | ArrayBufferView | Blob }) => {
            const d = arg.data;
            const bytes =
              d instanceof Blob
                ? new Uint8Array(await d.arrayBuffer())
                : d instanceof ArrayBuffer
                  ? new Uint8Array(d)
                  : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
            const end = arg.position + bytes.length;
            const cap = this.room.get(name);
            if (cap !== undefined && end > cap) {
              refused = true;
              throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
            }
            if (end > buf.length) {
              const next = new Uint8Array(end);
              next.set(buf);
              buf = next;
            }
            buf.set(bytes, arg.position);
          },
          close: async () => {
            if (refused && this.failedWriteLosesFile) throw new Error('the stream is in an errored state');
            this.files.set(name, buf);
          },
        };
      },
    };
  }
}

describe('saving a take from its crash copy', () => {
  const ROOM = 'xyz-abcd-pqr';
  const START = 1_760_000_000_000;
  const TAKE_DIR = `openmeet-take-${START}-${ROOM}`;
  const asFolder = (f: DiskFolder) => f as unknown as FsDirectoryHandle;
  const fill = (n: number, v: number) => new Uint8Array(n).fill(v).buffer;

  /** A take's crash copy as a crash leaves it: `parts` committed parts of 1000 bytes for each named file. */
  async function crashedTake(files: Record<string, number>, noted = Object.keys(files)) {
    const root = new FakeDirectoryHandle('root');
    const getRoot = async () => root as never;
    const live = (await openTakeJournal({ room: ROOM, recordingId: 'rec1', take: 1, hostStartMs: START }, getRoot))!;
    noted.forEach((file, slot) => live.note((n) => n.files.push({ file, kind: 'camera', slot, who: `Guest ${slot + 1}` })));
    for (const [name, parts] of Object.entries(files)) {
      const file = live.file(name);
      for (let i = 0; i < parts; i++) {
        file.append(i * 1000, fill(1000, i + 1));
        await file.commit(i + 1);
      }
    }
    const takeDir = root.entries.get(TAKE_DIR) as FakeDirectoryHandle;
    // The next page load lists what storage holds.
    const listed = async () => (await findTakeJournals(getRoot))[0]!;
    return { root, takeDir, listed };
  }

  const reportIn = (folder: DiskFolder, name: string) => JSON.parse(new TextDecoder().decode(folder.files.get(name)!));

  it('puts every committed byte in the folder and then removes the crash copy', async () => {
    const take = await crashedTake({ 'guest_rec1.mp4': 2 });
    const folder = new DiskFolder();

    const result = await saveRecoveredTake(await take.listed(), asFolder(folder));

    expect(result).toEqual({
      files: [{ name: 'guest_rec1.mp4', bytes: 2000, source: 'journal' }],
      json: 'sync_rec1.json',
      chapters: false,
    });
    expect([...folder.files.get('guest_rec1.mp4')!.slice(998, 1002)]).toEqual([1, 1, 2, 2]);
    expect(take.root.entries.has(TAKE_DIR)).toBe(false);
  });

  it('keeps the crash copy when the folder runs out of room part way through a file', async () => {
    const take = await crashedTake({ 'guest_rec1.mp4': 4 });
    const full = new DiskFolder();
    full.room.set('guest_rec1.mp4', 2500);

    const result = await saveRecoveredTake(await take.listed(), asFolder(full));

    expect(result.files).toEqual([
      { name: 'guest_rec1.mp4', bytes: 2000, source: 'failed', reason: 'rebuilt only in part' },
    ]);
    expect(result.unsaved).toEqual(['guest_rec1.mp4']);
    expect(result.kept).toBe(true);
    expect(take.root.entries.has(TAKE_DIR)).toBe(true);
    // The sync file describes the folder as it is: a file that stops early.
    expect(reportIn(full, 'sync_rec1.json').verification).toContainEqual(
      expect.objectContaining({ file: 'guest_rec1.mp4', bytes: 2000, status: 'incomplete' })
    );

    // Nothing was lost: a folder with room takes all of it, and only then does the copy go.
    const roomy = new DiskFolder();
    const again = await saveRecoveredTake(await take.listed(), asFolder(roomy));
    expect(again.files).toEqual([{ name: 'guest_rec1.mp4', bytes: 4000, source: 'journal' }]);
    expect(again.kept).toBeUndefined();
    expect(again.unsaved).toBeUndefined();
    expect(take.root.entries.has(TAKE_DIR)).toBe(false);
  });

  it('keeps the crash copy when a refused write costs the whole file, as Chrome does', async () => {
    const take = await crashedTake({ 'guest_rec1.mp4': 3 });
    const full = new DiskFolder();
    full.room.set('guest_rec1.mp4', 1500);
    full.failedWriteLosesFile = true;

    const result = await saveRecoveredTake(await take.listed(), asFolder(full));

    expect(result.files).toEqual([{ name: 'guest_rec1.mp4', bytes: 0, source: 'failed', reason: 'recovery failed' }]);
    expect(result.unsaved).toEqual(['guest_rec1.mp4']);
    expect(result.json).toBe('sync_rec1.json');
    expect(result.kept).toBe(true);
    expect(take.root.entries.has(TAKE_DIR)).toBe(true);
  });

  it('keeps the crash copy when the folder refuses one of two files', async () => {
    const take = await crashedTake({ 'guest_rec1.mp4': 1, 'guest2_rec1.mp4': 3 });
    const folder = new DiskFolder();
    folder.locked.add('guest2_rec1.mp4');

    const result = await saveRecoveredTake(await take.listed(), asFolder(folder));

    expect(result.files.map((f) => [f.name, f.source, f.bytes])).toEqual([
      ['guest_rec1.mp4', 'journal', 1000],
      ['guest2_rec1.mp4', 'failed', 0],
    ]);
    expect(result.unsaved).toEqual(['guest2_rec1.mp4']);
    expect(result.kept).toBe(true);
    expect(take.root.entries.has(TAKE_DIR)).toBe(true);
  });

  it('keeps the crash copy when one of its parts cannot be read', async () => {
    const take = await crashedTake({ 'guest_rec1.mp4': 4 });
    const fileDir = take.takeDir.entries.get('guest_rec1.mp4') as FakeDirectoryHandle;
    const second = fileDir.entries.get([...fileDir.entries.keys()].sort()[1]!) as FakeFileHandle;
    second.getFile = async () => {
      throw Object.assign(new Error('gone'), { name: 'NotReadableError' });
    };
    const folder = new DiskFolder();

    const result = await saveRecoveredTake(await take.listed(), asFolder(folder));

    // What can be read is saved, and the parts behind the unreadable one stay in storage.
    expect(folder.files.get('guest_rec1.mp4')!.length).toBe(1000);
    expect(result.kept).toBe(true);
    expect(take.root.entries.has(TAKE_DIR)).toBe(true);
  });

  it('rebuilds a file whose note never reached storage', async () => {
    // The second guest's parts are committed; the record on disk was written before its note.
    const take = await crashedTake({ 'guest_rec1.mp4': 1, 'guest2_rec1.mp4': 2 }, ['guest_rec1.mp4']);
    const folder = new DiskFolder();

    const result = await saveRecoveredTake(await take.listed(), asFolder(folder));

    expect(result.files).toEqual([
      { name: 'guest_rec1.mp4', bytes: 1000, source: 'journal' },
      { name: 'guest2_rec1.mp4', bytes: 2000, source: 'journal' },
    ]);
    expect(folder.files.get('guest2_rec1.mp4')!.length).toBe(2000);
    const report = reportIn(folder, 'sync_rec1.json');
    expect(report.guests.map((g: { slot: number; file: string }) => [g.slot, g.file])).toEqual([
      [0, 'guest_rec1.mp4'],
      [1, 'guest2_rec1.mp4'],
    ]);
    expect(result.kept).toBeUndefined();
    expect(take.root.entries.has(TAKE_DIR)).toBe(false);
  });

  it('rebuilds every file when the record is missing or damaged, and names the sync file by the start time', async () => {
    for (const damage of ['missing', 'damaged'] as const) {
      const take = await crashedTake({ 'guest_rec1.mp4': 2, 'guest_rec1.wav': 1, 'guest_screen_rec1.mp4': 1 });
      if (damage === 'missing') take.takeDir.entries.delete('take.json');
      else (take.takeDir.entries.get('take.json') as FakeFileHandle).content = new TextEncoder().encode('{"room":"xyz-ab');
      const folder = new DiskFolder();

      const result = await saveRecoveredTake(await take.listed(), asFolder(folder));

      expect(result.files.map((f) => [f.name, f.source, f.bytes])).toEqual([
        ['guest_rec1.mp4', 'journal', 2000],
        ['guest_rec1.wav', 'journal', 1000],
        ['guest_screen_rec1.mp4', 'journal', 1000],
      ]);
      expect(result.json).toBe(`sync_${START}.json`);
      const report = reportIn(folder, `sync_${START}.json`);
      expect(report.guests).toHaveLength(1);
      expect(report.guests[0]).toMatchObject({ slot: 0, file: 'guest_rec1.mp4', wavFile: 'guest_rec1.wav' });
      expect(report.timeline.screenSegments).toEqual([{ file: 'guest_screen_rec1.mp4', offsetMs: 0, endedEarly: true }]);
      expect(result.kept).toBeUndefined();
      expect(take.root.entries.has(TAKE_DIR)).toBe(false);
    }
  });
  it('rebuilds the directories no note names in name order', async () => {
    // Both are un-noted, and the crash copy made guest_rec1 first while its name sorts last.
    const take = await crashedTake({ 'guest_rec1.mp4': 1, 'guest2_rec1.mp4': 1 }, []);
    const folder = new DiskFolder();

    const result = await saveRecoveredTake(await take.listed(), asFolder(folder));

    expect(result.files.map((f) => f.name)).toEqual(['guest2_rec1.mp4', 'guest_rec1.mp4']);
  });

  it('marks an un-noted directory as a guest file the crash copy rebuilt', async () => {
    // guest2 has parts and no note: the checks must not fall back to "recorded here".
    const take = await crashedTake({ 'guest_rec1.mp4': 1, 'guest2_rec1.mp4': 2 }, ['guest_rec1.mp4']);
    const folder = new DiskFolder();

    await saveRecoveredTake(await take.listed(), asFolder(folder));

    const report = reportIn(folder, 'sync_rec1.json');
    expect(report.verification).toContainEqual(
      expect.objectContaining({ file: 'guest2_rec1.mp4', bytes: 2000, status: 'unverified' })
    );
  });

  it('names the host file whose backup could not be copied', async () => {
    const take = await crashedTake({ 'guest_rec1.mp4': 1 });
    const journal = await take.listed();
    // The backup directory is not in storage, so the copy cannot be made.
    journal.notes.backups.push({
      dir: 'openmeet-backup-host-camera-1760000000000-xyz-abcd-pqr',
      file: 'host_rec1.mp4',
      kind: 'camera',
    });
    const folder = new DiskFolder();

    const result = await saveRecoveredTake(journal, asFolder(folder));

    expect(result.files).toContainEqual({
      name: 'host_rec1.mp4',
      bytes: 0,
      source: 'failed',
      reason: 'backup unavailable',
    });
    expect(result.unsaved).toEqual(['host_rec1.mp4']);
  });

  const FMT = { sampleRate: 48000, channels: 1, bitDepth: 24 };
  /** A WAV as it sits in the folder: `audio` bytes of sound behind a header that declares `declared` of them. */
  function wavBytes(audio: number, declared: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(WAV_HEADER_BYTES + audio);
    bytes.set(new Uint8Array(wavHeader(FMT, declared)));
    for (let i = 0; i < audio; i++) bytes[WAV_HEADER_BYTES + i] = (i * 7 + 3) & 0xff;
    return bytes;
  }

  it('gives a kept guest WAV whose header declares no audio the header its length calls for', async () => {
    // The closing page committed the folder's file whole, with the placeholder header.
    const take = await crashedTake({ 'guest_rec1.wav': 2 });
    const folder = new DiskFolder();
    folder.files.set('guest_rec1.wav', wavBytes(2456, 0));

    const result = await saveRecoveredTake(await take.listed(), asFolder(folder));

    expect(result.files).toEqual([{ name: 'guest_rec1.wav', bytes: 2500, source: 'kept' }]);
    expect(folder.files.get('guest_rec1.wav')).toEqual(wavBytes(2456, 2456));
    expect(result.kept).toBeUndefined();
  });

  it('gives a kept host WAV the same repair, on the save path and when called for a resume', async () => {
    const backup = 'openmeet-backup-host-audio-1760000000000-xyz-abcd-pqr';
    const take = await crashedTake({ 'guest_rec1.mp4': 1 });
    const stored = await take.root.getDirectoryHandle(backup, { create: true });
    const chunk = await (await stored.getFileHandle('000000.part', { create: true })).createWritable();
    await chunk.write(wavBytes(956, 0));
    await chunk.close();
    const entry = { dir: backup, file: 'host_rec1.wav', kind: 'wav' as const };
    const journal = await take.listed();
    journal.notes.backups.push(entry);

    // The resume path copies the host's backups with this call alone.
    const resumed = new DiskFolder();
    resumed.files.set('host_rec1.wav', wavBytes(2456, 0));
    expect(await copyBackupInto(journal, asFolder(resumed), entry)).toEqual({
      name: 'host_rec1.wav',
      bytes: 2500,
      source: 'kept',
    });
    expect(resumed.files.get('host_rec1.wav')).toEqual(wavBytes(2456, 2456));

    const saved = new DiskFolder();
    saved.files.set('host_rec1.wav', wavBytes(2456, 0));
    const result = await saveRecoveredTake(journal, asFolder(saved));
    expect(result.files).toContainEqual({ name: 'host_rec1.wav', bytes: 2500, source: 'kept' });
    expect(saved.files.get('host_rec1.wav')).toEqual(wavBytes(2456, 2456));
    // Kept, as before the repair: the verdict of a file recorded on this computer.
    expect(reportIn(saved, 'sync_rec1.json').verification).toContainEqual(
      expect.objectContaining({ file: 'host_rec1.wav', bytes: 2500, status: 'complete' })
    );
  });

  it('leaves alone a kept WAV whose header is right, a kept .wav with no WAV header, and a kept .mp4', async () => {
    const take = await crashedTake({ 'guest_rec1.wav': 2, 'guest2_rec1.wav': 2, 'guest_rec1.mp4': 2 });
    const folder = new DiskFolder();
    const right = wavBytes(2456, 2456);
    // The header's bytes never landed: there is no format here to declare a length for.
    const headless = wavBytes(2456, 0).fill(0, 0, WAV_HEADER_BYTES);
    // An MP4 never starts like this; the name alone must keep the repair away from it.
    const video = wavBytes(2456, 0);
    folder.files.set('guest_rec1.wav', right);
    folder.files.set('guest2_rec1.wav', headless);
    folder.files.set('guest_rec1.mp4', video);

    const result = await saveRecoveredTake(await take.listed(), asFolder(folder));

    expect(result.files.map((f) => [f.name, f.source])).toEqual([
      ['guest_rec1.wav', 'kept'],
      ['guest2_rec1.wav', 'kept'],
      ['guest_rec1.mp4', 'kept'],
    ]);
    // The sync file is the only thing the folder was opened to write.
    expect(folder.opened).toEqual(['sync_rec1.json']);
    expect(folder.files.get('guest_rec1.wav')).toBe(right);
    expect(folder.files.get('guest2_rec1.wav')).toBe(headless);
    expect(folder.files.get('guest_rec1.mp4')).toBe(video);
  });

  it('keeps a WAV as it is when the repair cannot be written', async () => {
    const cannotOpen = new DiskFolder();
    cannotOpen.locked.add('guest_rec1.wav');
    const cannotWrite = new DiskFolder();
    // No room for a single byte: the header write is refused.
    cannotWrite.room.set('guest_rec1.wav', 0);

    for (const folder of [cannotOpen, cannotWrite]) {
      const take = await crashedTake({ 'guest_rec1.wav': 2 });
      folder.files.set('guest_rec1.wav', wavBytes(2456, 0));

      const result = await saveRecoveredTake(await take.listed(), asFolder(folder));

      expect(result.files).toEqual([{ name: 'guest_rec1.wav', bytes: 2500, source: 'kept' }]);
      expect(folder.files.get('guest_rec1.wav')).toEqual(wavBytes(2456, 0));
    }
  });
});
