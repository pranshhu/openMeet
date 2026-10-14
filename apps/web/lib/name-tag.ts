import { titleFrom } from '@openmeet/protocol';

// The title this tab joined with, '' when none was given. Held here like the
// answer in lib/listening.ts, so the call sends what the lobby asked for. It
// is typed per visit and kept nowhere else.
let joinedTitleText = '';

/** Keeps the lobby's text for this page; anything that is not a usable title is kept as none. */
export function chooseTitle(text: string): void {
  joinedTitleText = titleFrom(text);
}

/** The title as a `presence` field: nothing when the person gave none. */
export function titleField(): { title?: string } {
  return joinedTitleText ? { title: joinedTitleText } : {};
}

/** The title this tab joined with, for its own tile. */
export function joinedTitle(): string {
  return joinedTitleText;
}
