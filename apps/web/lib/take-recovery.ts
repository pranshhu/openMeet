import { FileWriter, type FsDirectoryHandle } from './fs-writer';
import { assembleBackupFromDir } from './backup-recorder';
import { patchWavHeader, WAV_HEADER_BYTES } from './wav';
import { isJournalFileName, type JournalFileNote, type TakeJournal } from './take-journal';
import { buildSyncReport, type GuestSyncInput, type ScreenSegmentInput } from './sync-report';
import { takeName, writeTakeSidecars } from '../hooks/recording-controller';

export interface RecoveredFile {
  /** The file's name in the recording folder. */
  name: string;
  /** Bytes in that file now, or 0 when nothing usable was written. */
  bytes: number;
  /** journal: rebuilt from parts. backup: copied from this browser's own backup. kept: the folder already had one at least as long. failed: nothing usable. */
  source: 'journal' | 'backup' | 'kept' | 'failed';
  reason?: string;
}

/**
 * The folder's length for a name, or null when it cannot be told. A missing
 * file, a handle with no getFile, or any error means "cannot tell", so the
 * caller rebuilds instead of trusting a length it never read.
 */
async function existingSize(folder: FsDirectoryHandle, name: string): Promise<number | null> {
  try {
    const handle = await folder.getFileHandle(name);
    return typeof handle.getFile === 'function' ? (await handle.getFile()).size : null;
  } catch {
    return null;
  }
}

/** What a header repair needs from a folder file: its bytes, and a writable that starts from them. */
interface RepairableFile {
  getFile?(): Promise<Blob>;
  createWritable(opts: { keepExistingData: true }): Promise<{
    write(data: { type: 'write'; position: number; data: ArrayBufferView }): Promise<void>;
    close(): Promise<void>;
  }>;
}

/**
 * Make the header of a WAV the folder already holds agree with its length. A
 * page that closes commits its files without stopping the recorders, so a WAV
 * it leaves has the placeholder header: no audio declared, all of it present.
 * The file is opened keeping what it holds and only its header is written. A
 * header that is already right, a file that is not a WAV and one that cannot
 * be read are never opened for writing. Never rejects: a repair that fails
 * leaves the file as it was.
 */
export async function repairWavHeader(folder: FsDirectoryHandle, name: string): Promise<void> {
  if (!name.endsWith('.wav')) return;
  try {
    const handle = (await folder.getFileHandle(name)) as unknown as RepairableFile;
    const file = await handle.getFile?.();
    if (!file || typeof file.slice !== 'function' || file.size <= WAV_HEADER_BYTES) return;
    const have = new Uint8Array(await file.slice(0, WAV_HEADER_BYTES).arrayBuffer());
    const magic = new DataView(have.buffer);
    // 'RIFF' and 'WAVE': anything else is not a header this can repair.
    if (magic.getUint32(0) !== 0x52494646 || magic.getUint32(8) !== 0x57415645) return;
    // The header a rebuild would leave: the same two size fields, from the length.
    const want = have.slice();
    await patchWavHeader(
      { write: async (position: number, data: ArrayBuffer) => want.set(new Uint8Array(data), position) },
      file.size - WAV_HEADER_BYTES
    );
    if (want.every((byte, i) => byte === have[i])) return;
    const writable = await handle.createWritable({ keepExistingData: true });
    await writable.write({ type: 'write', position: 0, data: want });
    await writable.close();
  } catch {
    // Nothing was closed, so the file is as it was.
  }
}

/** What a file directory no note names can still say about itself: its name is the folder file's name. */
function noteFromName(file: string): JournalFileNote {
  const kind = file.endsWith('.wav') ? 'wav' : file.includes('_screen_') ? 'screen' : 'camera';
  if (kind === 'screen') return { file, kind };
  // guest_<id>.mp4 is the first guest's file, guest2_<id>.mp4 the second's.
  const nth = Number(/^guest(\d{1,2})_/.exec(file)?.[1] ?? 1);
  return { file, kind, slot: Math.max(0, nth - 1) };
}

/**
 * Every file the crash copy holds: the noted ones, then each file directory no
 * note names. The directories are the truth: a file's note is written after
 * its first part, and one failed write of take.json leaves parts with no note.
 */
async function heldFiles(journal: TakeJournal): Promise<JournalFileNote[]> {
  const noted = new Set(journal.notes.files.map((f) => f.file));
  const unnoted = (await journal.fileNames()).filter((name) => !noted.has(name)).sort();
  return [...journal.notes.files, ...unnoted.map(noteFromName)];
}

interface Rebuilt {
  files: RecoveredFile[];
  /** Bytes of the crash copy's parts that are in the folder. */
  held: number;
  /** Files that are not in the folder in full: a guest file whose parts did not all arrive, a host file whose backup could not be copied. */
  unsaved: string[];
}

async function rebuild(journal: TakeJournal, folder: FsDirectoryHandle, notes: JournalFileNote[]): Promise<Rebuilt> {
  const files: RecoveredFile[] = [];
  const unsaved: string[] = [];
  let held = 0;

  for (const note of notes) {
    let hasParts = false;
    try {
      if (!isJournalFileName(note.file)) {
        files.push({ name: note.file, bytes: 0, source: 'failed', reason: 'bad file name' });
        continue;
      }
      const parts = await journal.file(note.file).parts();
      if (parts.length === 0) {
        files.push({ name: note.file, bytes: 0, source: 'failed', reason: 'nothing was committed' });
        continue;
      }
      hasParts = true;
      const partBytes = parts.reduce((n, p) => n + p.size, 0);
      // A WAV that closed by rewriting its header ends with a part at offset 0,
      // so the last part's end would read 44. The parts' furthest byte is the length.
      const journalEnd = Math.max(...parts.map((p) => p.offset + p.size));
      const existing = await existingSize(folder, note.file);
      if (existing !== null && existing >= journalEnd) {
        await repairWavHeader(folder, note.file);
        files.push({ name: note.file, bytes: existing, source: 'kept' });
        held += partBytes;
        continue;
      }

      const writer = new FileWriter();
      await writer.openIn(folder, note.file);
      // replay stops at the first part it cannot read or write, so fewer
      // writes than parts is a file that ends early or has a hole.
      let written = 0;
      await journal.replay(note.file, {
        write: async (position, data) => {
          await writer.write(position, data);
          written += 1;
        },
      });
      if (written < parts.length) {
        await writer.close();
        files.push({ name: note.file, bytes: writer.size, source: 'failed', reason: 'rebuilt only in part' });
        unsaved.push(note.file);
        continue;
      }
      const last = parts[parts.length - 1];
      // The PCM recorder's final chunk is the real header, at offset 0; when a
      // crash kept that chunk out, the header on disk is the placeholder.
      if (note.kind === 'wav' && last && last.offset !== 0) {
        await patchWavHeader(writer, journalEnd - WAV_HEADER_BYTES);
      }
      await writer.close();
      files.push({ name: note.file, bytes: writer.size, source: 'journal' });
      held += partBytes;
    } catch {
      files.push({ name: note.file, bytes: 0, source: 'failed', reason: 'recovery failed' });
      if (hasParts) unsaved.push(note.file);
    }
  }

  for (const entry of journal.notes.backups) {
    let result: RecoveredFile;
    try {
      result = await copyBackupInto(journal, folder, entry);
    } catch {
      result = { name: entry.file, bytes: 0, source: 'failed', reason: 'backup unavailable' };
    }
    files.push(result);
    if (result.source === 'failed') unsaved.push(entry.file);
  }

  return { files, held, unsaved };
}

/** Rebuild every file this journal holds into `folder`, noted or not. Never rejects; one result per file. */
export async function recoverTake(journal: TakeJournal, folder: FsDirectoryHandle): Promise<RecoveredFile[]> {
  return (await rebuild(journal, folder, await heldFiles(journal))).files;
}

/** Copy one of the host's own backups into `folder` under the file name the notes recorded. Never rejects. */
export async function copyBackupInto(
  journal: TakeJournal,
  folder: FsDirectoryHandle,
  entry: { dir: string; file: string; kind: 'camera' | 'wav' | 'screen' }
): Promise<RecoveredFile> {
  try {
    if (!isJournalFileName(entry.file)) {
      return { name: entry.file, bytes: 0, source: 'failed', reason: 'bad file name' };
    }
    const root = journal.root;
    const getDirectory = root.getDirectoryHandle;
    if (typeof getDirectory !== 'function') {
      return { name: entry.file, bytes: 0, source: 'failed', reason: 'backup unavailable' };
    }
    const dir = await getDirectory.call(root, entry.dir);
    const file = await assembleBackupFromDir(dir, entry.dir, entry.kind === 'wav' ? 'wav' : 'mp4');
    if (!file) return { name: entry.file, bytes: 0, source: 'failed', reason: 'backup unavailable' };

    const existing = await existingSize(folder, entry.file);
    if (existing !== null && existing >= file.size) {
      await repairWavHeader(folder, entry.file);
      return { name: entry.file, bytes: existing, source: 'kept' };
    }

    const writer = new FileWriter();
    await writer.openIn(folder, entry.file);
    await writer.write(0, file);
    await writer.close();
    return { name: entry.file, bytes: file.size, source: 'backup' };
  } catch {
    return { name: entry.file, bytes: 0, source: 'failed', reason: 'backup unavailable' };
  }
}

export interface SaveResult {
  files: RecoveredFile[];
  /** The folder's sync sidecar name, or null when it could not be written. */
  json: string | null;
  /** True when the chapters sidecar was written. */
  chapters: boolean;
  /** Set when the crash copy was left in browser storage: part of it is not in the folder, or the sync file was not written. */
  kept?: true;
  /** Set when a file is not in the folder in full: the names of those files. A guest file the crash copy holds no parts for is not one. */
  unsaved?: string[];
}

/**
 * Rebuild a journal into `folder` and write its sidecars. The journal is
 * removed only when every byte it holds is in the folder and the sync file was
 * written; otherwise it stays for another save. Never rejects.
 */
export async function saveRecoveredTake(journal: TakeJournal, folder: FsDirectoryHandle): Promise<SaveResult> {
  const noted = await heldFiles(journal);
  const { files, held, unsaved } = await rebuild(journal, folder, noted);
  const problems = unsaved.length > 0 ? { unsaved } : {};
  try {
    const notes = journal.notes;
    // Every file the journal holds parts for came from a guest; the host's own
    // files are only in notes.backups. A rebuilt file has no sender digest, so
    // only the guests' checks are marked recovered.
    const guestFiles = new Set(noted.map((f) => f.file));
    const byName = new Map(files.map((f) => [f.name, f.bytes] as const));
    const short = new Set(unsaved);
    const checks = new Map(
      [...byName].map(([name, bytes]) => {
        if (!guestFiles.has(name)) return [name, { bytes }] as const;
        // A file that stopped short is not a rebuilt one: it reads incomplete,
        // with the guest's own backup named as the place the rest is.
        return short.has(name)
          ? ([name, { bytes, received: { finalized: false, abandoned: false, sha256Written: '' } }] as const)
          : ([name, { bytes, recovered: true }] as const);
      })
    );

    const guests: GuestSyncInput[] = [];
    for (const note of noted) {
      if (note.kind !== 'camera') continue;
      const slot = note.slot ?? 0;
      // The live path names a WAV master only when its receiver wrote bytes; a
      // note whose file got nothing must not claim one was saved.
      const wav = noted.find(
        (f) => f.kind === 'wav' && (f.slot ?? 0) === slot && (byName.get(f.file) ?? 0) > 0
      );
      guests.push({
        slot,
        name: note.who,
        file: note.file,
        ...(wav ? { wavFile: wav.file } : {}),
        noWav: !wav,
        startHostMs: note.guestStartHostMs ?? null,
        rttMs: note.rttMs ?? null,
        // The stream never reached recording-finalized, so the file cannot be
        // known to be whole.
        endedEarly: true,
      });
    }

    const hostCam = notes.backups.find((b) => b.kind === 'camera');
    const hostWav = notes.backups.find((b) => b.kind === 'wav');
    const screenSegments: ScreenSegmentInput[] = noted
      .filter((f) => f.kind === 'screen')
      .map((note) => ({
        file: note.file,
        offsetMs: Math.max(0, (note.startedAtMs ?? notes.hostStartMs) - notes.hostStartMs),
        endedEarly: true,
        ...(note.who ? { sharer: note.who } : {}),
      }));

    const report = buildSyncReport({
      recordingId: notes.recordingId,
      ...(hostCam ? { hostFile: hostCam.file } : {}),
      ...(hostWav ? { hostWavFile: hostWav.file } : {}),
      hostStartMs: notes.hostStartMs,
      markers: notes.markers,
      guests,
      screenSegments,
      checks,
      interrupted: true,
    });

    // A take whose record could not be read has no id: its start time names the sidecars.
    const id = notes.recordingId || String(notes.hostStartMs);
    const syncName = takeName('sync', id, notes.take, 'json');
    const chaptersName = takeName('chapters', id, notes.take, 'txt');
    // Two calls: a chapters failure must not be reported as a sync failure.
    const jsonOk = await writeTakeSidecars(folder, [{ name: syncName, content: report.json }]);
    const chaptersOk = await writeTakeSidecars(folder, [{ name: chaptersName, content: report.chapters }]);
    // journal.bytes counts every part on disk, so a part that could not be
    // read, or a directory this walk never opened, keeps the journal too.
    const whole = jsonOk && held >= journal.bytes;
    if (whole) {
      try {
        await journal.finish();
      } catch {
        // The row stays; a later save can finish the job.
      }
    }
    return {
      files,
      json: jsonOk ? syncName : null,
      chapters: chaptersOk && Boolean(report.chapters),
      ...(whole ? {} : { kept: true as const }),
      ...problems,
    };
  } catch {
    return { files, json: null, chapters: false, kept: true, ...problems };
  }
}
