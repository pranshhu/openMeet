/** Longest name kept in a file name, in code points. */
const NAME_PART_MAX = 32;

/**
 * A display name cut down to what every file system and shell accepts:
 * letters, combining marks and digits of any script, lowercased, with each run
 * of anything else collapsed to one hyphen. Marks stay because Devanagari, Thai
 * and Arabic names are unreadable without them. Names come from other
 * participants, so the input may be any value at all; the result is '' when
 * nothing usable is left.
 */
export function safeNamePart(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // Cut before any Unicode work: the Room trims names to 64, but nothing here
  // should depend on a server having done so. Lowercased before the cut to
  // NAME_PART_MAX because lowercasing can lengthen a string ('İ' becomes two
  // code points).
  const cleaned = raw
    .slice(0, 256)
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-');
  return Array.from(cleaned).slice(0, NAME_PART_MAX).join('').replace(/^-+|-+$/g, '');
}

/**
 * download= names for the copies a participant saves from the tab. They carry
 * the room, the take and whose copy it is: three guests' backups all arriving
 * as backup.mp4 can't be told apart, and a second take's sync.json has to
 * visibly match its _take2 files. A guest isn't told the take number, so its
 * names go without one rather than guess.
 */
export function downloadNamesFor(o: {
  room: string;
  take?: number | undefined;
  localName: string;
  role: string | null;
}): { sync: string; chapters: string; backup: string; wav: string } {
  const tag = `openmeet-${o.room}${o.take ? `-take${o.take}` : ''}`;
  const who = safeNamePart(o.localName) || o.role || 'you';
  return {
    sync: `${tag}-sync.json`,
    chapters: `${tag}-chapters.txt`,
    backup: `${tag}-backup-${who}.mp4`,
    wav: `${tag}-backup-${who}.wav`,
  };
}

/** `guest2-sam-lee`, or the bare role when the name has nothing usable in it. */
export function roleWithName(role: string, name: unknown): string {
  const safe = safeNamePart(name);
  return safe ? `${role}-${safe}` : role;
}
