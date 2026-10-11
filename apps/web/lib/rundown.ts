/**
 * A show's rundown: its segments in order, one per line of text the host
 * writes. Kept in this browser, one per room, like the teleprompter script,
 * and never sent anywhere.
 */

export interface Segment {
  name: string;
}

/** The longest text the editor takes, and the most that is read back from storage. */
export const MAX_RUNDOWN_LENGTH = 4000;

const key = (slug: string) => `om_rundown_${slug}`;

/** One segment per line that has text; a blank line is only spacing. */
export function parseRundown(text: string): Segment[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((name) => ({ name }));
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
