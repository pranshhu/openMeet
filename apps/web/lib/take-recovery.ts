import { FileWriter, type FsDirectoryHandle } from './fs-writer';
import { assembleBackupFromDir } from './backup-recorder';
import { patchWavHeader, WAV_HEADER_BYTES } from './wav';
import { isJournalFileName, type TakeJournal } from './take-journal';

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
