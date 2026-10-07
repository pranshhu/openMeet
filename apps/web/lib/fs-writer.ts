interface FsWritable {
  write(data: { type: 'write'; position: number; data: ArrayBuffer | ArrayBufferView | Blob }): Promise<void>;
  close(): Promise<void>;
}
interface FsFileHandle {
  name: string;
  createWritable(): Promise<FsWritable>;
  /** The browser's own handle has one; absent on a handle a test hands in. */
  getFile?(): Promise<{ size: number }>;
}
type SaveFilePicker = (opts: { suggestedName?: string }) => Promise<FsFileHandle>;

export interface FsDirectoryHandle {
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsFileHandle>;
  removeEntry?(name: string): Promise<void>;
}
export type DirectoryPicker = () => Promise<FsDirectoryHandle>;

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
  return p();
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
  private handleName = '';
  private _size = 0;
  // A FileSystemWritableFileStream serializes its own ops, but overlapping
  // write() calls (e.g. the host's own-track recorder fires writes without
  // awaiting) can interleave and corrupt the file. Chain every write so they
  // run strictly in call order.
  private writeTail: Promise<void> = Promise.resolve();

  constructor(opts?: { picker?: SaveFilePicker }) {
    this.picker =
      opts?.picker ??
      ((o) => (globalThis as unknown as { showSaveFilePicker: SaveFilePicker }).showSaveFilePicker(o));
  }

  get fileName(): string {
    return this.handleName;
  }

  /** The file's length: the furthest byte any completed write has reached. */
  get size(): number {
    return this._size;
  }

  /** Prompts for a save location. Costs one transient user activation. */
  async openFile(suggestedName: string): Promise<void> {
    const handle = await this.picker({ suggestedName });
    this.handleName = handle.name;
    this.writable = await handle.createWritable();
  }

  /**
   * Opens a file inside an already-chosen directory. No prompt, so several
   * writers can be opened from a single pickRecordingDirectory() call.
   */
  async openIn(dir: FsDirectoryHandle, name: string): Promise<void> {
    const handle = await dir.getFileHandle(name, { create: true });
    this.handleName = handle.name;
    this.writable = await handle.createWritable();
  }

  write(position: number, data: ArrayBuffer | ArrayBufferView | Blob): Promise<void> {
    if (!this.writable) return Promise.reject(new Error('FileWriter: write before openFile'));
    const writable = this.writable;
    // A Blob reaches the file by reference, so its length comes from size().
    const end = position + (data instanceof Blob ? data.size : data.byteLength);
    const result = this.writeTail.then(() =>
      writable.write({ type: 'write', position, data }).then(
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

  async close(): Promise<void> {
    if (!this.writable) return;
    // Let all queued writes finish before closing.
    await this.writeTail.catch(() => {});
    await this.writable.close();
    this.writable = null;
  }
}
