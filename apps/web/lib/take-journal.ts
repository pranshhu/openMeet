import type { Role } from '@openmeet/protocol';
import {
  defaultOpfsRoot,
  getDirEntries,
  isDirectoryHandle,
  type OpfsDir,
  type OpfsFileHandle,
  type OpfsRootGetter,
} from './backup-recorder';

/** One recorded file the journal holds parts for. Names, not bytes, so take.json stays small. */
export interface JournalFileNote {
  /** The file's name in the recording folder; also its directory's name in the journal. */
  file: string;
  kind: 'camera' | 'wav' | 'screen';
  /** Channel-label key for a guest file (stable across a reconnect); absent for the host's own files. */
  key?: string;
  /** Guest slot, 0-based; absent for the host's own files. */
  slot?: number;
  /** Screen stretch number; absent for a camera or WAV file. */
  segment?: number;
  /** The guest's display name when the file opened; absent for the host's own files. */
  who?: string;
  guestStartHostMs?: number | null;
  rttMs?: number | null;
  /** Screen stretch start on the host clock; absent for camera and WAV files. */
  startedAtMs?: number | null;
}

/** What a take cannot read back from its parts: which take it is, and what each file is. */
export interface TakeNotes {
  room: string;
  recordingId: string;
  take: number;
  /** The host's recording start on the host clock; every offset in a report is relative to it. */
  hostStartMs: number;
  files: JournalFileNote[];
  /** This browser's own BackupRecorder directories, one entry per file they hold. */
  backups: { dir: string; file: string; kind: 'camera' | 'wav' | 'screen' }[];
  markers: { atMs: number; label: string; from: Role; name?: string }[];
}

export interface TakeJournalInit {
  room: string;
  recordingId: string;
  take: number;
  hostStartMs: number;
}

/** One file's parts in a journal, and the position they prove. */
export interface JournalFile {
  /** Memory only: no I/O, no copy. Bytes that do not continue the previous run start a new run. */
  append(offset: number, data: ArrayBuffer): void;
  /** Close the runs appended before this call, one closed part per run, in order; a call waits behind a part already being written, so it resolves only once its own bytes are on disk (or the journal gave up). Never rejects. */
  commit(nextIdx: number): Promise<void>;
  /** What the parts on disk prove. Null when nothing usable is committed. */
  position(): Promise<{ nextIdx: number; end: number } | null>;
  /** The committed parts of this file, in seq order: where each one's bytes go and how long it is. */
  parts(): Promise<{ offset: number; size: number }[]>;
  /** A commit failed twice on this file, or anywhere in its journal, so this file takes no more bytes. */
  readonly dead: boolean;
}

export interface TakeJournal {
  /** The directory's name in browser storage, e.g. `openmeet-take-1759824000000-abc-defg-hij`. */
  readonly dirName: string;
  /** The storage root this journal lives in. */
  readonly root: OpfsDir;
  readonly notes: TakeNotes;
  /** False when an on-disk take.json existed but could not be read. */
  readonly notesOk: boolean;
  /** Bytes in every part of this journal, including parts written by an earlier session. */
  readonly bytes: number;
  /** A commit failed twice: no file of this journal takes another byte. */
  readonly dead: boolean;
  /** Change the notes; they are saved with the next commit (crash-safe-d makes this durable). */
  note(change: (n: TakeNotes) => void): void;
  /** The journal file for a folder file name. A name that is not a plain file name gets a dead no-op: `dead` true, `position()` null, `parts()` empty, `commit()` resolves without writing. */
  file(name: string): JournalFile;
  /** Write every committed part of `name`, in order, at its own offset. Resolves with the file's end offset; a part it cannot read ends the walk. Never rejects. */
  replay(name: string, into: { write(position: number, data: Blob): Promise<void> }): Promise<number>;
  /** Mark finished and remove the journal. Never rejects. */
  finish(): Promise<void>;
}

const TAKE_PREFIX = 'openmeet-take';
const ROOM_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
// Anchored: a path, `.` or `..` must never reach a directory name.
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(mp4|wav|webm|m4a)$/;
const PART_RE = /^(\d{6})-(\d+)-(\d+)\.part$/;
const FINISHED_MARK = 'finished';

/** More non-contiguous appends than this in one commit are dropped: a sender must not decide how many files the host creates. */
export const MAX_RUNS_PER_COMMIT = 8;

type TakeDir = OpfsDir & {
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<OpfsDir>;
};

interface Run {
  offset: number;
  size: number;
  buffers: ArrayBuffer[];
}

interface PartRef {
  offset: number;
  nextIdx: number;
  size: number;
  handle: OpfsFileHandle;
}

/** Shared by every file of one journal, so one double failure stops them all. */
interface JournalState {
  dead: boolean;
  bytes: number;
}

function partName(seq: number, offset: number, nextIdx: number): string {
  return `${String(seq).padStart(6, '0')}-${offset}-${nextIdx}.part`;
}

function endOf(parts: PartRef[]): number {
  let end = 0;
  for (const part of parts) {
    if (part.offset + part.size > end) end = part.offset + part.size;
  }
  return end;
}

class JournalFileImpl implements JournalFile {
  private runs: Run[] = [];
  private seq: number;
  private inFlight: Promise<void> | null = null;
  // At most one commit waits behind the one in flight; later callers share it.
  private waiting: { promise: Promise<void>; resolve: () => void; nextIdx: number } | null = null;

  constructor(
    private readonly journal: TakeJournalImpl,
    private readonly name: string,
    seqStart: number,
  ) {
    this.seq = seqStart;
  }

  get dead(): boolean {
    return this.journal.state.dead;
  }

  append(offset: number, data: ArrayBuffer): void {
    if (this.dead) return;
    if (!(data instanceof ArrayBuffer) || data.byteLength === 0) return;
    if (!Number.isSafeInteger(offset) || offset < 0) return;
    const last = this.runs[this.runs.length - 1];
    if (last && offset === last.offset + last.size) {
      last.buffers.push(data);
      last.size += data.byteLength;
      return;
    }
    if (this.runs.length >= MAX_RUNS_PER_COMMIT) return;
    this.runs.push({ offset, size: data.byteLength, buffers: [data] });
  }

  commit(nextIdx: number): Promise<void> {
    if (this.dead) return Promise.resolve();
    const idx = Number.isSafeInteger(nextIdx) && nextIdx >= 0 ? nextIdx : 0;
    if (!this.inFlight) {
      const started = this.writeRuns(idx);
      this.inFlight = started;
      void started.then(() => this.pump());
      return started;
    }
    if (!this.waiting) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      this.waiting = { promise, resolve, nextIdx: idx };
    } else if (idx > this.waiting.nextIdx) {
      this.waiting.nextIdx = idx;
    }
    return this.waiting.promise;
  }

  async position(): Promise<{ nextIdx: number; end: number } | null> {
    const parts = await this.readParts();
    if (!parts || parts.length === 0) return null;
    return { nextIdx: parts[parts.length - 1]!.nextIdx, end: endOf(parts) };
  }

  async parts(): Promise<{ offset: number; size: number }[]> {
    const parts = await this.readParts();
    return (parts ?? []).map((part) => ({ offset: part.offset, size: part.size }));
  }

  async replayInto(into: { write(position: number, data: Blob): Promise<void> }): Promise<number> {
    const parts = await this.readParts();
    let end = 0;
    for (const part of parts ?? []) {
      let blob: Blob;
      try {
        blob = await part.handle.getFile();
      } catch {
        break;
      }
      try {
        await into.write(part.offset, blob);
      } catch {
        break;
      }
      if (part.offset + blob.size > end) end = part.offset + blob.size;
    }
    return end;
  }

  private pump(): void {
    this.inFlight = null;
    const waiting = this.waiting;
    if (!waiting) return;
    this.waiting = null;
    if (this.dead) {
      this.runs = [];
      waiting.resolve();
      return;
    }
    const started = this.writeRuns(waiting.nextIdx);
    this.inFlight = started;
    void started.then(() => {
      waiting.resolve();
      this.pump();
    });
  }

  private async writeRuns(nextIdx: number): Promise<void> {
    if (this.dead) return;
    const runs = this.runs;
    this.runs = [];
    for (const run of runs) {
      const name = partName(this.seq, run.offset, nextIdx);
      if (!(await this.writePart(name, run))) {
        this.journal.state.dead = true;
        this.runs = [];
        if (this.waiting) {
          this.waiting.resolve();
          this.waiting = null;
        }
        return;
      }
      this.seq += 1;
      this.journal.state.bytes += run.size;
    }
  }

  private async writePart(name: string, run: Run): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const dir = await this.journal.openFileDir(this.name, true);
        if (!dir) return false;
        const handle = await dir.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        await writable.write(new Blob(run.buffers));
        await writable.close();
        return true;
      } catch {
        // A failed step retries once under the same name; a second failure kills the journal.
      }
    }
    return false;
  }

  /** The parts that count, in seq order: the walk stops at the first missing number or unreadable size. */
  private async readParts(): Promise<PartRef[] | null> {
    const dir = await this.journal.openFileDir(this.name, false);
    if (!dir) return null;
    let entries: Array<OpfsFileHandle | OpfsDir>;
    try {
      entries = await getDirEntries(dir);
    } catch {
      return null;
    }

    const bySeq = new Map<number, { offset: number; nextIdx: number; handle: OpfsFileHandle }>();
    for (const entry of entries) {
      if (isDirectoryHandle(entry) || !entry.name) continue;
      const match = PART_RE.exec(entry.name);
      if (!match) continue;
      const offset = Number(match[2]);
      const nextIdx = Number(match[3]);
      if (!Number.isSafeInteger(offset) || offset < 0) continue;
      if (!Number.isSafeInteger(nextIdx) || nextIdx < 0) continue;
      bySeq.set(Number(match[1]), { offset, nextIdx, handle: entry });
    }

    const counted: PartRef[] = [];
    for (let seq = 0; bySeq.has(seq); seq++) {
      const part = bySeq.get(seq)!;
      let size: number;
      try {
        size = (await part.handle.getFile()).size;
      } catch {
        break;
      }
      if (size > 0) counted.push({ offset: part.offset, nextIdx: part.nextIdx, size, handle: part.handle });
    }
    return counted;
  }
}

/** The no-op a refused file name gets: no I/O, no path, no throw. */
const DEAD_FILE: JournalFile = {
  append: () => {},
  commit: () => Promise.resolve(),
  position: () => Promise.resolve(null),
  parts: () => Promise.resolve([]),
  dead: true,
};

class TakeJournalImpl implements TakeJournal {
  readonly notesOk = true;
  readonly state: JournalState;
  private readonly files = new Map<string, JournalFileImpl>();

  constructor(
    readonly dirName: string,
    readonly root: OpfsDir,
    private readonly dir: TakeDir,
    state: JournalState,
    private readonly seqByName: Map<string, number>,
    readonly notes: TakeNotes,
  ) {
    this.state = state;
  }

  get bytes(): number {
    return this.state.bytes;
  }

  get dead(): boolean {
    return this.state.dead;
  }

  note(change: (n: TakeNotes) => void): void {
    change(this.notes);
  }

  file(name: string): JournalFile {
    if (!FILE_NAME_RE.test(name)) return DEAD_FILE;
    const existing = this.files.get(name);
    if (existing) return existing;
    const file = new JournalFileImpl(this, name, this.seqByName.get(name) ?? 0);
    this.files.set(name, file);
    return file;
  }

  async replay(name: string, into: { write(position: number, data: Blob): Promise<void> }): Promise<number> {
    const file = this.file(name);
    return file instanceof JournalFileImpl ? file.replayInto(into) : 0;
  }

  async finish(): Promise<void> {
    try {
      await this.dir.getFileHandle(FINISHED_MARK, { create: true });
    } catch {
      // A marker that cannot be written leaves removal as the only cleanup.
    }
    try {
      await this.root.removeEntry?.(this.dirName, { recursive: true });
    } catch {
      // The marker stays for the next listing to drop the directory.
    }
  }

  /** The take directory's subdirectory for one file, created only when a part is written. */
  async openFileDir(name: string, create: boolean): Promise<OpfsDir | null> {
    try {
      return await this.dir.getDirectoryHandle(name, { create });
    } catch {
      return null;
    }
  }
}

/** Null means no usable storage, never a rejection. */
export async function openTakeJournal(
  init: TakeJournalInit,
  root?: OpfsRootGetter,
): Promise<TakeJournal | null> {
  if (typeof navigator !== 'undefined') {
    void (navigator as { storage?: { persist?: () => Promise<boolean> } }).storage?.persist?.();
  }

  // The take directory's name has to stay listable, so anything the listing
  // could not recognise gets no journal at all.
  if (!Number.isFinite(init.hostStartMs) || init.hostStartMs < 0) return null;
  if (typeof init.room !== 'string' || !ROOM_RE.test(init.room)) return null;

  const getRoot = root ?? defaultOpfsRoot();
  if (!getRoot) return null;
  let rootDir: OpfsDir;
  try {
    rootDir = await getRoot();
  } catch {
    return null;
  }
  if (!rootDir || typeof rootDir.getDirectoryHandle !== 'function') return null;

  const dirName = `${TAKE_PREFIX}-${init.hostStartMs}-${init.room}`;
  try {
    const dir = (await rootDir.getDirectoryHandle(dirName, { create: true })) as TakeDir;

    // Probe createWritable up front (detect Safari 15.2-25 where OPFS exists but createWritable is missing)
    const probe = await dir.getFileHandle('.probe', { create: true });
    if (typeof probe.createWritable !== 'function') {
      await dir.removeEntry?.('.probe').catch(() => {});
      await rootDir.removeEntry?.(dirName, { recursive: true }).catch(() => {});
      return null;
    }
    await dir.removeEntry?.('.probe').catch(() => {});

    // A continued journal starts where the last session stopped: its bytes and
    // the next seq of every file directory are read back once, here.
    const state: JournalState = { dead: false, bytes: 0 };
    const seqByName = new Map<string, number>();
    try {
      for (const entry of await getDirEntries(dir)) {
        if (!isDirectoryHandle(entry) || !entry.name) continue;
        let nextSeq = 0;
        for (const part of await getDirEntries(entry)) {
          if (isDirectoryHandle(part) || !part.name) continue;
          const match = PART_RE.exec(part.name);
          if (!match) continue;
          const seq = Number(match[1]);
          if (seq >= nextSeq) nextSeq = seq + 1;
          try {
            state.bytes += (await part.getFile()).size;
          } catch {
            // A part whose size cannot be read contributes nothing.
          }
        }
        seqByName.set(entry.name, nextSeq);
      }
    } catch {
      // An unreadable listing leaves an empty journal rather than no journal.
    }

    return new TakeJournalImpl(dirName, rootDir, dir, state, seqByName, {
      room: init.room,
      recordingId: init.recordingId,
      take: init.take,
      hostStartMs: init.hostStartMs,
      files: [],
      backups: [],
      markers: [],
    });
  } catch {
    return null;
  }
}
