import { safeNamePart } from './file-names';

/** The largest file a participant may send the host: 100 MB in the decimal units sizes are shown in. */
export const MAX_SHARED_FILE_BYTES = 100 * 1000 * 1000;

/**
 * The id a picked file travels under: `file-` and a UUID its sender made. It
 * is the key of the file's `backup#<id>` channel, and what tells the host a
 * picked file from a returned backup, whose key is the backup's own name.
 */
export const SHARED_FILE_ID = /^file-[0-9a-f-]{36}$/;

// Pictures, documents, slides, sound and video. The host's folder is on a
// computer where a double click runs a program, a script or a web page, so a
// type that is not listed here is neither offered nor written. The type is
// read from the name alone; the bytes are not inspected.
const SHARED_FILE_TYPES = [
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'avif', 'tif', 'tiff',
  'pdf', 'txt', 'md', 'docx', 'odt', 'pages',
  'pptx', 'key', 'odp',
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg',
  'mp4', 'mov', 'webm',
];

/**
 * The name a file from a participant gets in the host's recording folder, or
 * null when it is not a file this app passes on. `raw` is the name its sender
 * gave and `from` the sender's display name: both come from another
 * participant and may be any value at all. Nothing of either reaches the
 * folder but letters, digits and hyphens (`safeNamePart`) and an extension
 * from the list above, and the `shared_` prefix keeps the result apart from
 * every recording file and from the names an operating system reserves.
 */
export function sharedFileName(raw: unknown, from: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 255) return null;
  const dot = raw.lastIndexOf('.');
  const ext = raw.slice(dot + 1).toLowerCase();
  if (dot < 1 || !SHARED_FILE_TYPES.includes(ext)) return null;
  const stem = safeNamePart(raw.slice(0, dot)) || 'file';
  return `shared_${safeNamePart(from) || 'guest'}_${stem}.${ext}`;
}

/** The `accept` of the input that picks a file, so the system's picker offers these types. */
export const SHARED_FILE_ACCEPT = SHARED_FILE_TYPES.map((t) => `.${t}`).join(',');

/**
 * Why this page will not offer a file, in words for the person who picked it;
 * null when it can go. The host's page decides for itself when the offer
 * arrives, so this only spares an offer that would be turned away.
 */
export function sharedFileProblem(file: { name: string; size: number }): string | null {
  if (sharedFileName(file.name, null) === null) {
    return 'Only photos, documents, slides, audio and video can be sent.';
  }
  if (file.size <= 0) return 'That file is empty.';
  if (file.size > MAX_SHARED_FILE_BYTES) return 'That file is over 100 MB, the most that can be sent.';
  return null;
}
