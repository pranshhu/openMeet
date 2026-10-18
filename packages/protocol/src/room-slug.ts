/** Unanchored, so a directory or file name that carries a slug is matched with the same rule. */
export const ROOM_SLUG_PATTERN = '[a-z0-9][a-z0-9-]{1,30}[a-z0-9]';
export const MAX_ROOM_NAME_LENGTH = 32;

const SLUG_RE = new RegExp(`^${ROOM_SLUG_PATTERN}$`);
const RANDOM_SLUG_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/** A room's slug: a random one the Worker made, or a name a host chose. */
export function isRoomSlug(s: unknown): s is string {
  return typeof s === 'string' && SLUG_RE.test(s);
}

/** A slug a host may choose: any slug except the shape the Worker makes up (abc-defg-hij). */
export function isRoomName(s: unknown): s is string {
  return isRoomSlug(s) && !RANDOM_SLUG_RE.test(s);
}
