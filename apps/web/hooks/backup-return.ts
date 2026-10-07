import { integrityVerdict, sanitizeText } from '@/lib/sync-report';
import type { BackupName } from '@/lib/backup-recorder';

/** One backup on its way from a guest to the host, as either side shows it. */
export interface BackupTransfer {
  /** The backup's file name on the sender's device: unique per backup. */
  id: string;
  kind: BackupName['kind'];
  size: number;
  /** offered: waiting for the host. stalled: the connection dropped part-way. */
  status: 'offered' | 'active' | 'stalled' | 'saved' | 'failed';
  /** A whole number, so progress is at most a hundred renders per file. */
  percent: number;
  /** Host only: who is sending it. */
  from?: string;
  /** Host only: it failed because the disk filled up. */
  diskFull?: boolean;
}

/** The name a returned backup gets in the host's recording folder. */
export function returnedBackupName(backup: BackupName, from: string | null): string {
  let who = (from ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  who = [...who].slice(0, 40).join('');
  if (!who) who = 'guest';
  const stamp = new Date(backup.startedMs).toISOString().replace(/[-:.]/g, '');
  return `backup_${who}_${backup.kind}_${stamp}.${backup.ext}`;
}

/** The JSON note written beside a verified returned backup. */
export function buildBackupNote(note: {
  file: string; // its name in the host's folder
  backupOf: string; // its name on the sender's device
  backup: BackupName;
  from: string;
  sizeBytes: number;
  sha256Sent: string;
  sha256Written: string;
}): string {
  const fromClean = [...sanitizeText(note.from).trim()].slice(0, 64).join('');
  const alignment =
    note.backup.kind === 'screen'
      ? "This is the sharer's backup of one screen segment. It holds the same recording as the live segment, so that segment's offset in the take's sync file applies when the segment is listed there."
      : "This is the participant's own backup copy, from a separate recorder that started at its own instant. The offsets in the take's sync file do not apply to it: align it by audio waveform.";

  const obj = {
    file: note.file,
    backupOf: note.backupOf,
    kind: note.backup.kind,
    room: note.backup.room,
    from: fromClean,
    sizeBytes: note.sizeBytes,
    sha256: note.sha256Written,
    integrity: integrityVerdict(note.sha256Sent, note.sha256Written).text,
    startedUnixMs: note.backup.startedMs,
    startedUnixMsNote:
      "Read from the sender's device clock, not measured against the host's. Compare it with timeline.hostStartUnixMs in a take's sync file to tell which take this belongs to.",
    alignment,
    generatedBy: 'openMeet',
  };

  return JSON.stringify(obj, null, 2);
}
