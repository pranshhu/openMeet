import {
  CHUNK_TIMESLICE_MS,
  RECORDING_MIME,
  RECORDING_AUDIO_BPS,
} from '@openmeet/protocol';
import { PcmRecorder, isPcmCaptureSupported, type FrameSource } from './pcm-recorder';
import { presetForTrack } from './quality';

type MrFactory = (stream: MediaStream, opts: MediaRecorderOptions) => MediaRecorder;

// Minimal structural shapes for the OPFS APIs we touch, so we don't depend on
// the full DOM lib declaring them (and so tests can inject fakes).
interface OpfsWritable {
  write(data: Blob | BufferSource): Promise<void>;
  close(): Promise<void>;
}
export interface OpfsFileHandle {
  createWritable(opts?: { keepExistingData?: boolean }): Promise<OpfsWritable>;
  getFile(): Promise<File>;
  name?: string;
  kind?: string;
}
export interface OpfsDir {
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<OpfsFileHandle>;
  getDirectoryHandle?(name: string, opts?: { create?: boolean }): Promise<OpfsDir>;
  removeEntry?(name: string, opts?: { recursive?: boolean }): Promise<void>;
  values?(): AsyncIterable<OpfsFileHandle | OpfsDir>;
  name?: string;
  kind?: string;
}
export type OpfsRootGetter = () => Promise<OpfsDir>;

export const BACKUP_PREFIX = 'openmeet-backup';

// Empty file dropped into a backup's directory once its take finalized
// normally: the complete file is then on the host's disk and the backup is only
// clutter. A crash never writes it, so crash backups are never cleared.
const FINALIZED_MARK = 'finalized';

/** The room a backup was recorded in, or null for older backups that don't say. */
export function backupRoom(name: string): string | null {
  return /^openmeet-backup-(?:host-)?(?:audio-|screen-)?\d+-(.+)\.[^.]+$/.exec(name)?.[1] ?? null;
}

/** Whether a backup is a screen share backup. */
export function isScreenBackup(name: string): boolean {
  return /^openmeet-backup-(?:host-)?screen/.test(name);
}

export interface BackupName {
  kind: 'camera' | 'audio' | 'screen';
  /** When the backup's recorder started, on the clock of the device that made it. */
  startedMs: number;
  room: string;
  ext: 'mp4' | 'wav';
}

/**
 * The parts of a backup's file name, or null for anything else: a host's
 * camera or WAV backup, an older name with no room, a name this app never
 * wrote.
 */
export function parseBackupName(name: string): BackupName | null {
  const m = /^openmeet-backup-(audio-|screen-)?(\d{13})-([a-z]{3}-[a-z]{4}-[a-z]{3})\.(mp4|wav)$/.exec(name);
  if (!m) return null;
  const prefix = m[1];
  const startedMs = Number(m[2]);
  const room = m[3]!;
  const ext = m[4] as 'mp4' | 'wav';
  const kind: BackupName['kind'] = prefix === 'audio-' ? 'audio' : prefix === 'screen-' ? 'screen' : 'camera';
  if (kind === 'audio' && ext !== 'wav') return null;
  if ((kind === 'camera' || kind === 'screen') && ext !== 'mp4') return null;
  return { kind, startedMs, room, ext };
}

function chunkFileName(idx: number): string {
  return `${String(idx).padStart(6, '0')}.part`;
}

let lastBackupTimestamp = 0;

function getUniqueBackupDirName(prefix: string): string {
  let now = Date.now();
  if (now <= lastBackupTimestamp) {
    now = lastBackupTimestamp + 1;
  }
  lastBackupTimestamp = now;
  return `${prefix}-${now}`;
}

export async function getDirEntries(dir: OpfsDir): Promise<Array<OpfsFileHandle | OpfsDir>> {
  const entries: Array<OpfsFileHandle | OpfsDir> = [];
  const iterable = typeof dir.values === 'function'
    ? dir.values()
    : typeof (dir as unknown as AsyncIterable<OpfsFileHandle | OpfsDir>)[Symbol.asyncIterator] === 'function'
      ? (dir as unknown as AsyncIterable<OpfsFileHandle | OpfsDir>)
      : null;

  if (!iterable) return [];

  for await (const entry of iterable) {
    if (Array.isArray(entry)) {
      const [name, handle] = entry;
      if (handle) {
        if (!handle.name) (handle as { name?: string }).name = name;
        entries.push(handle as OpfsFileHandle | OpfsDir);
      }
    } else if (entry) {
      entries.push(entry as OpfsFileHandle | OpfsDir);
    }
  }
  return entries;
}

export function isDirectoryHandle(handle: OpfsFileHandle | OpfsDir): handle is OpfsDir {
  if (handle.kind === 'directory') return true;
  if (handle.kind === 'file') return false;
  return typeof (handle as OpfsDir).getDirectoryHandle === 'function' ||
    (typeof (handle as OpfsDir).getFileHandle === 'function' && typeof (handle as OpfsFileHandle).createWritable !== 'function');
}

async function patchWavHeader(parts: Blob[]): Promise<BlobPart[] | null> {
  if (parts.length === 0 || !parts[0] || parts[0].size < 44) return null;
  try {
    const slice = await parts[0].slice(0, 44).arrayBuffer();
    const view = new DataView(slice);
    if (view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) {
      return null;
    }
    const totalPcmBytes = (parts[0].size - 44) + parts.slice(1).reduce((s, p) => s + p.size, 0);
    const clampedData = totalPcmBytes > 0xffff_ffff ? 0xffff_ffff : totalPcmBytes;
    view.setUint32(4, clampedData + 36 > 0xffff_ffff ? 0xffff_ffff : clampedData + 36, true);
    view.setUint32(40, clampedData, true);

    const patched: BlobPart[] = [slice];
    if (parts[0].size > 44) {
      patched.push(parts[0].slice(44));
    }
    for (let i = 1; i < parts.length; i++) {
      patched.push(parts[i]!);
    }
    return patched;
  } catch {
    return null;
  }
}

export async function assembleBackupFromDir(
  dir: OpfsDir,
  dirName: string,
  preferredExt?: string,
  preferredType?: string,
): Promise<File | null> {
  let entries: Array<OpfsFileHandle | OpfsDir>;
  try {
    entries = await getDirEntries(dir);
  } catch {
    return null;
  }

  const chunkEntries: Array<{ idx: number; handle: OpfsFileHandle }> = [];

  for (const entry of entries) {
    if (isDirectoryHandle(entry)) continue;
    const name = entry.name;
    if (name && /^\d+\.part$/.test(name)) {
      const idx = parseInt(name.slice(0, -5), 10);
      chunkEntries.push({ idx, handle: entry as OpfsFileHandle });
    }
  }

  if (chunkEntries.length === 0) return null;

  chunkEntries.sort((a, b) => a.idx - b.idx);

  const chunkFiles: File[] = [];
  let newestLastModified = 0;

  for (const item of chunkEntries) {
    try {
      const file = await item.handle.getFile();
      if (file && file.size > 0) {
        chunkFiles.push(file);
        if (file.lastModified > newestLastModified) {
          newestLastModified = file.lastModified;
        }
      }
    } catch {
      // Skip unreadable chunk file
    }
  }

  if (chunkFiles.length === 0) return null;

  const patched = await patchWavHeader(chunkFiles);
  if (patched) {
    return new File(patched, `${dirName}.wav`, {
      type: 'audio/wav',
      lastModified: newestLastModified || Date.now(),
    });
  }

  const ext = preferredExt ?? 'mp4';
  const type = preferredType ?? RECORDING_MIME;
  try {
    return new File(chunkFiles, `${dirName}.${ext}`, {
      type,
      lastModified: newestLastModified || Date.now(),
    });
  } catch {
    return null;
  }
}

/**
 * Non-empty leftover backups in OPFS, newest first. [] when OPFS is absent.
 * Backups of takes that finalized normally are deleted here instead of listed.
 */
export async function findBackups(root?: OpfsRootGetter): Promise<File[]> {
  const getRoot = root ?? defaultOpfsRoot();
  if (!getRoot) return [];
  let rootDir: OpfsDir;
  try {
    rootDir = await getRoot();
  } catch {
    return [];
  }

  const files: File[] = [];
  try {
    const entries = await getDirEntries(rootDir);

    for (const entry of entries) {
      if (!isDirectoryHandle(entry)) continue;

      const dirName = entry.name;
      if (!dirName || !dirName.startsWith(BACKUP_PREFIX)) continue;

      if (await entry.getFileHandle(FINALIZED_MARK).then(() => true, () => false)) {
        await rootDir.removeEntry?.(dirName, { recursive: true }).catch(() => {});
        continue;
      }

      try {
        const file = await assembleBackupFromDir(entry, dirName);
        if (file && file.size > 0) {
          files.push(file);
        }
      } catch {
        // Skip unreadable backup directories
      }
    }
  } catch {
    return [];
  }

  files.sort((a, b) => b.lastModified - a.lastModified);
  return files;
}

/** Remove one backup by name. Ignores NotFoundError only. */
export async function deleteBackup(name: string, root?: OpfsRootGetter): Promise<void> {
  const getRoot = root ?? defaultOpfsRoot();
  if (!getRoot) return;
  let dir: OpfsDir;
  try {
    dir = await getRoot();
  } catch {
    return;
  }
  if (typeof dir.removeEntry !== 'function') return;

  const dirName = name.replace(/\.[^.]+$/, '');
  try {
    await dir.removeEntry(dirName, { recursive: true });
    return;
  } catch (err) {
    if ((err as { name?: string })?.name === 'NotFoundError') {
      if (dirName !== name) {
        try {
          await dir.removeEntry(name, { recursive: true });
          return;
        } catch (innerErr) {
          if ((innerErr as { name?: string })?.name === 'NotFoundError') {
            return;
          }
          throw innerErr;
        }
      }
      return;
    }
    throw err;
  }
}

export interface BackupRecorderOpts {
  stream?: MediaStream;
  mrFactory?: MrFactory;
  mimeType?: string;
  audioBitsPerSecond?: number;
  // Injectable for tests; defaults to navigator.storage.getDirectory (OPFS).
  opfsRoot?: OpfsRootGetter;
  fileName?: string;
  /** Room slug, carried in the backup's name so the lobby can say where it came from. */
  room?: string;
  onWarn?: (msg: string) => void;
  frameSource?: FrameSource;
  onError?: (err: unknown) => void;
}

export function defaultOpfsRoot(): OpfsRootGetter | null {
  const storage = (globalThis.navigator as { storage?: { getDirectory?: () => Promise<OpfsDir> } })
    ?.storage;
  return storage?.getDirectory ? () => storage.getDirectory!() : null;
}

/**
 * Safety net: writes committed per-chunk files (NNNNNN.part) into an OPFS directory
 * (<BACKUP_PREFIX>-<Date.now()>), ensuring chunks survive tab crashes. Falls back
 * to the in-RAM path when OPFS is unavailable (older engines / test env).
 *
 * Each recording gets its own directory. A take that finalized normally is
 * marked (markFinalized) and cleared by the next lobby; anything else stays
 * until Lobby Delete.
 */
export class BackupRecorder {
  private readonly opts: BackupRecorderOpts;
  private mr: MediaRecorder | null = null;
  private pcm: PcmRecorder | null = null;
  private parts: Blob[] = []; // RAM fallback sink
  private backupDir: OpfsDir | null = null;
  private backupDirName: string | null = null;
  private chunkIndex = 0;
  private openPromise: Promise<void> | null = null;
  private writeTail: Promise<void> = Promise.resolve();
  private opfsOk = false;
  private opfsWrote = false;
  private warnedStorageFailure = false;
  private stoppedResult: Blob | null | undefined = undefined;
  private stopPromise: Promise<Blob | null> | null = null;

  constructor(opts: BackupRecorderOpts) {
    this.opts = opts;
  }

  /** The OPFS directory this backup writes its parts into, or null before the open finished or when storage was unusable. */
  get dirName(): string | null {
    return this.backupDirName;
  }

  /** Resolves when the storage probe finished, whether or not storage was usable. */
  whenOpen(): Promise<void> {
    return (this.openPromise ?? Promise.resolve()).catch(() => {});
  }

  isWav(): boolean {
    return (this.opts.mimeType ?? '').includes('wav');
  }

  writeChunk(chunk: Blob | ArrayBuffer): void {
    if (chunk instanceof Blob && chunk.size === 0) return;
    if (chunk instanceof ArrayBuffer && chunk.byteLength === 0) return;
    this.writeTail = this.writeTail.then(() => this.consume(chunk));
  }

  start(): void {
    if (typeof navigator !== 'undefined') {
      void (navigator as { storage?: { persist?: () => Promise<boolean> } }).storage?.persist?.();
    }
    this.openPromise = this.tryOpenOpfs();

    if (this.isWav()) {
      if (this.opts.stream && (isPcmCaptureSupported() || this.opts.frameSource) && this.opts.stream.getAudioTracks().length > 0) {
        let seenFirst = false;
        this.pcm = new PcmRecorder({
          stream: this.opts.stream,
          onChunk: (c) => {
            if (c.header.offset === 0) {
              if (seenFirst) return;
              seenFirst = true;
            }
            this.writeChunk(c.payload);
          },
          ...(this.opts.frameSource ? { frameSource: this.opts.frameSource } : {}),
          ...(this.opts.onError ? { onError: this.opts.onError } : {}),
        });
        this.pcm.start();
      }
      return;
    }

    if (!this.opts.stream) return;
    const factory = this.opts.mrFactory ?? ((s, o) => new MediaRecorder(s, o));
    const mr = factory(this.opts.stream, {
      mimeType: this.opts.mimeType ?? RECORDING_MIME,
      // Sized like the file this backs up: the preset for the camera's real
      // resolution. A backup at another bitrate is not a stand-in for the take,
      // and the lobby's storage estimate assumes the two match.
      videoBitsPerSecond: presetForTrack(this.opts.stream.getVideoTracks?.()[0]).videoBps,
      audioBitsPerSecond: this.opts.audioBitsPerSecond ?? RECORDING_AUDIO_BPS,
    });
    this.mr = mr;
    mr.ondataavailable = (ev: BlobEvent) => {
      if (!ev.data || ev.data.size === 0) return;
      this.writeChunk(ev.data);
    };
    mr.start(CHUNK_TIMESLICE_MS);
  }

  /**
   * The finished backup, or **null** when there isn't a usable one.
   *
   * Built from the committed chunk Files in index order by reference.
   * Returns null if no chunk was committed.
   */
  async stop(): Promise<Blob | null> {
    if (this.stoppedResult !== undefined) {
      return this.stoppedResult;
    }
    if (this.stopPromise) {
      return this.stopPromise;
    }
    this.stopPromise = (async () => {
      const mr = this.mr;
      if (mr && mr.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          mr.onstop = () => resolve();
          mr.stop();
        });
      }
      if (this.pcm) {
        await this.pcm.stopAndFlush();
      }
      // The final ondataavailable fires before onstop; awaiting writeTail captures it.
      await this.openPromise?.catch(() => {});
      await this.writeTail.catch(() => {});

      let onDiskFile: File | null = null;
      if (this.backupDir && this.backupDirName) {
        onDiskFile = await assembleBackupFromDir(this.backupDir, this.backupDirName, this.ext(), this.opts.mimeType ?? RECORDING_MIME);
      }

      // Whether any bytes ever reached OPFS. If they did, the RAM `parts` array can
      // only ever hold POST-failure fragments — an MP4 with no init segment, which
      // no player opens. It must never be handed over as if it were the backup.
      if (this.opfsWrote && !onDiskFile) {
        this.stoppedResult = null;
        return null;
      }

      const allParts: Blob[] = onDiskFile ? [onDiskFile, ...this.parts] : this.parts;
      if (allParts.length === 0) {
        this.stoppedResult = null;
        return null;
      }

      const patched = await patchWavHeader(allParts);
      let result: Blob;
      if (patched) {
        result = onDiskFile
          ? new File(patched, onDiskFile.name, { type: 'audio/wav', lastModified: onDiskFile.lastModified })
          : new Blob(patched, { type: 'audio/wav' });
      } else {
        result = onDiskFile
          ? (this.parts.length > 0 ? new File([onDiskFile, ...this.parts], onDiskFile.name, { type: onDiskFile.type, lastModified: Date.now() }) : onDiskFile)
          : new Blob(this.parts, { type: this.opts.mimeType ?? RECORDING_MIME });
      }

      this.stoppedResult = result;
      return result;
    })();
    return this.stopPromise;
  }

  /**
   * Record that this take finalized normally, so the next lobby deletes the
   * backup instead of listing it. Call ONLY when the take's file is known to be
   * complete: the backup may otherwise be the only whole copy.
   */
  async markFinalized(): Promise<void> {
    await this.backupDir?.getFileHandle(FINALIZED_MARK, { create: true }).catch(() => {});
  }

  private async tryOpenOpfs(): Promise<void> {
    const getRoot = this.opts.opfsRoot ?? defaultOpfsRoot();
    if (!getRoot) {
      this.opfsOk = false;
      this.backupDir = null;
      this.backupDirName = null;
      this.opts.onWarn?.('Local storage is unavailable — backup lives in memory only.');
      return;
    }
    try {
      const root = await getRoot();
      if (typeof root.getDirectoryHandle !== 'function') {
        throw new Error('getDirectoryHandle is not a function');
      }
      const prefix = this.opts.fileName
        ? this.opts.fileName.replace(/\.(mp4|webm|wav)$/, '')
        : (this.isWav() ? `${BACKUP_PREFIX}-audio` : BACKUP_PREFIX);
      const dirName = getUniqueBackupDirName(prefix) + (this.opts.room ? `-${this.opts.room}` : '');
      const dir = await root.getDirectoryHandle(dirName, { create: true });

      // Probe createWritable up front (detect Safari 15.2-25 where OPFS exists but createWritable is missing)
      const probe = await dir.getFileHandle('.probe', { create: true });
      if (typeof probe.createWritable !== 'function') {
        await dir.removeEntry?.('.probe').catch(() => {});
        await root.removeEntry?.(dirName, { recursive: true }).catch(() => {});
        throw new Error('createWritable is not supported');
      }
      await dir.removeEntry?.('.probe').catch(() => {});

      this.backupDir = dir;
      this.backupDirName = dirName;
      this.opfsOk = true;
    } catch {
      this.opfsOk = false;
      this.backupDir = null;
      this.backupDirName = null;
      this.opts.onWarn?.('Local storage is unavailable — backup lives in memory only.');
    }
  }

  private async consume(chunk: Blob | ArrayBuffer): Promise<void> {
    await this.openPromise?.catch(() => {});
    if (this.opfsOk && this.backupDir) {
      const chunkName = chunkFileName(this.chunkIndex);
      const writeOnce = async () => {
        const fileHandle = await this.backupDir!.getFileHandle(chunkName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(chunk);
        await writable.close();
      };
      try {
        await writeOnce();
        this.opfsWrote = true;
        this.chunkIndex++;
        return;
      } catch {
        // Retry once on storage write failure
        try {
          await writeOnce();
          this.opfsWrote = true;
          this.chunkIndex++;
          return;
        } catch {
          this.opfsOk = false;
          if (!this.warnedStorageFailure) {
            this.warnedStorageFailure = true;
            this.opts.onWarn?.('Storage write failed — backup is continuing in memory only.');
          }
        }
      }
    }

    const blob = chunk instanceof Blob ? chunk : new Blob([chunk]);
    this.parts.push(blob);
  }

  private ext(): string {
    if (this.isWav()) return 'wav';
    return (this.opts.mimeType ?? RECORDING_MIME).includes('mp4') ? 'mp4' : 'webm';
  }
}
