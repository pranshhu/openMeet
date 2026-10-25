interface FsWritable {
  write(data: { type: 'write'; position: number; data: ArrayBuffer | ArrayBufferView | Blob }): Promise<void>;
  close(): Promise<void>;
}
interface FsFileHandle {
  name: string;
  createWritable(opts?: { keepExistingData?: boolean }): Promise<FsWritable>;
  /** The browser's own handle has one; absent on a handle a test hands in. */
  getFile?(): Promise<{ size: number }>;
}
type SaveFilePicker = (opts: { suggestedName?: string }) => Promise<FsFileHandle>;

export interface FsDirectoryHandle {
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsFileHandle>;
  removeEntry?(name: string): Promise<void>;
}
export type DirectoryPicker = (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FsDirectoryHandle>;

/**
 * One folder prompt for the whole recording.
 *
 * The host writes TWO files. Opening them with two showSaveFilePicker() calls
 * consumes the single transient user activation the File System Access spec
 * grants per click, so the second prompt is rejected with a SecurityError — and
 * two save dialogs per recording is a hostile first-run experience regardless.
 * One directory prompt costs one activation and asks the user once.
 */
export async function pickRecordingDirectory(picker?: DirectoryPicker): Promise<FsDirectoryHandle> {
  const p =
    picker ?? (globalThis as unknown as { showDirectoryPicker: DirectoryPicker }).showDirectoryPicker;
  if (typeof p !== 'function') throw new Error('showDirectoryPicker is unavailable in this browser');
  // Write access is asked for with the folder. The first file can be created
  // long after this click, and by then the browser will not let the page ask.
  return p({ mode: 'readwrite' });
}

export class DiskFullError extends Error {
  constructor(message = 'Disk full while writing recording') {
    super(message);
    this.name = 'DiskFullError';
  }
}

/**
 * Whether the host can write recordings to disk. Checks showDirectoryPicker
 * specifically — that is the entry point the host path uses (one prompt, two
 * files); showSaveFilePicker alone is not enough.
 */
export function isFsAccessSupported(): boolean {
  return typeof globalThis !== 'undefined' && 'showDirectoryPicker' in globalThis;
}

export class FileWriter {
  private readonly picker: SaveFilePicker;
  private writable: FsWritable | null = null;
  private handle: FsFileHandle | null = null;
  private handleName = '';
  private _size = 0;
  // A FileSystemWritableFileStream serializes its own ops, but overlapping
  // write() calls (e.g. the host's own-track recorder fires writes without
  // awaiting) can interleave and corrupt the file. Chain every write so they
  // run strictly in call order.
  private writeTail: Promise<void> = Promise.resolve();
  private closing: Promise<void> | null = null;

  constructor(opts?: { picker?: SaveFilePicker }) {
    this.picker =
      opts?.picker ??
      ((o) => (globalThis as unknown as { showSaveFilePicker: SaveFilePicker }).showSaveFilePicker(o));
  }

  get fileName(): string {
    return this.handleName;
  }

  /** True once close() has been called: the file is committed and takes no more. */
  get isClosed(): boolean {
    return this.closing !== null;
  }

  /** The file's length: the furthest byte any completed write has reached. */
  get size(): number {
    return this._size;
  }

  /** Prompts for a save location. Costs one transient user activation. */
  async openFile(suggestedName: string): Promise<void> {
    const handle = await this.picker({ suggestedName });
    this.handle = handle;
    this.handleName = handle.name;
    this.writable = await handle.createWritable();
  }

  /**
   * Opens a file inside an already-chosen directory. No prompt, so several
   * writers can be opened from a single pickRecordingDirectory() call.
   */
  async openIn(dir: FsDirectoryHandle, name: string): Promise<void> {
    const handle = await dir.getFileHandle(name, { create: true });
    this.handle = handle;
    this.handleName = handle.name;
    this.writable = await handle.createWritable();
  }

  write(position: number, data: ArrayBuffer | ArrayBufferView | Blob): Promise<void> {
    if (!this.writable) return Promise.reject(new Error('FileWriter: write before openFile'));
    const opened = this.writable;
    // A Blob reaches the file by reference, so its length comes from size().
    const end = position + (data instanceof Blob ? data.size : data.byteLength);
    // Read when the write runs: a checkpoint ahead of it in the queue has
    // reopened the stream by then.
    const result = this.writeTail.then(() =>
      (this.writable ?? opened).write({ type: 'write', position, data }).then(
        () => {
          this._size = Math.max(this._size, end);
        },
        (e: unknown) => {
          if ((e as { name?: string }).name === 'QuotaExceededError') throw new DiskFullError();
          throw e;
        }
      )
    );
    // The sequencing chain must never hold a rejection. Previously writeTail
    // itself was the rejected promise, so ONE failed write poisoned every
    // subsequent write for the life of the FileWriter — a single transient
    // error silently ended the recording while the UI kept saying "Recording".
    // The caller still receives the real rejection via `result`.
    this.writeTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /**
   * Commits what has been written so far and carries on in the same file. A
   * stream reaches its file only on close(), so a browser that is killed leaves
   * the file as it was at the last checkpoint. The copy of the file made on
   * reopening costs its length, so only a small file that nothing else can
   * rebuild is worth it.
   */
  checkpoint(): Promise<void> {
    if (!this.writable || !this.handle || this.closing) return Promise.resolve();
    const handle = this.handle;
    const done = this.writeTail.then(async () => {
      if (this.closing || !this.writable) return;
      await this.writable.close();
      this.writable = await handle.createWritable({ keepExistingData: true });
    });
    this.writeTail = done.then(
      () => undefined,
      () => undefined
    );
    return done;
  }

  /**
   * Closes the stream once. Two callers can reach this at the same moment (the
   * host's end of a take and a channel's close), and a stream refuses a second
   * close while the first is still running, so every call gets the result of
   * the one close.
   */
  close(): Promise<void> {
    if (!this.writable) return Promise.resolve();
    return (this.closing ??= (async () => {
      // Let all queued writes finish before closing.
      await this.writeTail.catch(() => {});
      await this.writable!.close();
      this.writable = null;
    })());
  }
}
