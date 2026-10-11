/**
 * A show's rundown: its segments in order, one per line of text the host
 * writes. Kept in this browser, one per room, like the teleprompter script,
 * and never sent anywhere.
 */

export interface Segment {
  name: string;
  /** Its planned length; null when the line names none. */
  plannedMs: number | null;
}

/** The longest text the editor takes, and the most that is read back from storage. */
export const MAX_RUNDOWN_LENGTH = 4000;

const key = (slug: string) => `om_rundown_${slug}`;

/**
 * One segment per line that has text; a blank line is only spacing. A line may
 * end in its planned length, minutes and seconds: "Interview 20:00".
 */
export function parseRundown(text: string): Segment[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /\s(\d{1,3}):([0-5]\d)$/.exec(line);
      if (!m) return { name: line, plannedMs: null };
      const ms = (Number(m[1]) * 60 + Number(m[2])) * 1000;
      // 0:00 plans nothing: the segment just counts up.
      return { name: line.slice(0, m.index).trimEnd(), plannedMs: ms || null };
    });
}

export function loadRundown(slug: string): string {
  try {
    return (localStorage.getItem(key(slug)) ?? '').slice(0, MAX_RUNDOWN_LENGTH);
  } catch {
    return ''; // storage is closed: the rundown lasts for this page
  }
}

export function saveRundown(slug: string, text: string): void {
  try {
    localStorage.setItem(key(slug), text);
  } catch {
    /* private mode — the rundown just doesn't persist */
  }
}
