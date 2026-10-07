import { FileWriter, type FsDirectoryHandle } from './fs-writer';
import { assembleBackupFromDir } from './backup-recorder';
import { patchWavHeader, WAV_HEADER_BYTES } from './wav';
import { isJournalFileName, type TakeJournal } from './take-journal';
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

/** Rebuild every file this journal holds into `folder`. Never rejects; one result per named file. */
export async function recoverTake(journal: TakeJournal, folder: FsDirectoryHandle): Promise<RecoveredFile[]> {
  const results: RecoveredFile[] = [];

  for (const note of journal.notes.files) {
    try {
      if (!isJournalFileName(note.file)) {
        results.push({ name: note.file, bytes: 0, source: 'failed', reason: 'bad file name' });
        continue;
      }
      const parts = await journal.file(note.file).parts();
      if (parts.length === 0) {
        results.push({ name: note.file, bytes: 0, source: 'failed', reason: 'nothing was committed' });
        continue;
      }
      // A WAV that closed by rewriting its header ends with a part at offset 0,
      // so position().end would read 44. The parts' furthest byte is the length.
      const journalEnd = Math.max(...parts.map((p) => p.offset + p.size));
      const existing = await existingSize(folder, note.file);
      if (existing !== null && existing >= journalEnd) {
        results.push({ name: note.file, bytes: existing, source: 'kept' });
        continue;
      }

      const writer = new FileWriter();
      await writer.openIn(folder, note.file);
      await journal.replay(note.file, { write: (position, data) => writer.write(position, data) });
      const last = parts[parts.length - 1];
      // The PCM recorder's final chunk is the real header, at offset 0; when a
      // crash kept that chunk out, the header on disk is the placeholder.
      if (note.kind === 'wav' && last && last.offset !== 0) {
        await patchWavHeader(writer, journalEnd - WAV_HEADER_BYTES);
      }
      await writer.close();
      results.push({ name: note.file, bytes: writer.size, source: 'journal' });
    } catch {
      results.push({ name: note.file, bytes: 0, source: 'failed', reason: 'recovery failed' });
    }
  }

  for (const entry of journal.notes.backups) {
    try {
      results.push(await copyBackupInto(journal, folder, entry));
    } catch {
      results.push({ name: entry.file, bytes: 0, source: 'failed', reason: 'backup unavailable' });
    }
  }

  return results;
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
}

/** Rebuild a journal into `folder`, write its sidecars, and remove the journal. Never rejects. */
export async function saveRecoveredTake(journal: TakeJournal, folder: FsDirectoryHandle): Promise<SaveResult> {
  const files = await recoverTake(journal, folder);
  try {
    const notes = journal.notes;
    // Every file the journal holds parts for came from a guest; the host's own
    // files are only in notes.backups. A rebuilt file has no sender digest, so
    // only the guests' checks are marked recovered.
    const guestFiles = new Set(notes.files.map((f) => f.file));
    const byName = new Map(files.map((f) => [f.name, f.bytes] as const));
    const checks = new Map(
      [...byName].map(
        ([name, bytes]) => [name, { bytes, ...(guestFiles.has(name) ? { recovered: true } : {}) }] as const
      )
    );

    const guests: GuestSyncInput[] = [];
    for (const note of notes.files) {
      if (note.kind !== 'camera') continue;
      const slot = note.slot ?? 0;
      // The live path names a WAV master only when its receiver wrote bytes; a
      // note whose file got nothing must not claim one was saved.
      const wav = notes.files.find(
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
    const screenSegments: ScreenSegmentInput[] = notes.files
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

    const syncName = takeName('sync', notes.recordingId, notes.take, 'json');
    const chaptersName = takeName('chapters', notes.recordingId, notes.take, 'txt');
    // Two calls: a chapters failure must not be reported as a sync failure.
    const jsonOk = await writeTakeSidecars(folder, [{ name: syncName, content: report.json }]);
    const chaptersOk = await writeTakeSidecars(folder, [{ name: chaptersName, content: report.chapters }]);
    if (jsonOk) {
      try {
        await journal.finish();
      } catch {
        // The row stays; a later save can finish the job.
      }
    }
    return { files, json: jsonOk ? syncName : null, chapters: chaptersOk && Boolean(report.chapters) };
  } catch {
    return { files, json: null, chapters: false };
  }
}
