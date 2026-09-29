/**
 * The host's host_token, returned by POST /api/rooms.
 *
 * localStorage, not sessionStorage. Rooms are reusable, so "host" has to survive
 * closing the tab — with sessionStorage the creator silently became a guest in
 * their own room the moment they reopened the link, and since politeness used to
 * be derived from role that also broke negotiation outright.
 *
 * Not a cookie: cross-origin deploys (*.pages.dev + *.workers.dev) can't share
 * them. Scope is origin + browser, which is exactly "this person's machine".
 */
const key = (slug: string) => `om_host_${slug}`;

export function storeHostToken(slug: string, token: string): void {
  try {
    localStorage.setItem(key(slug), token);
  } catch {
    /* storage unavailable (private mode etc.) — host auth degrades to none */
  }
}

export function getHostToken(slug: string): string | null {
  try {
    const found = localStorage.getItem(key(slug));
    if (found) return found;
    // Migration: tokens written before rooms became reusable live in
    // sessionStorage. Promote rather than demoting an existing host to guest.
    const legacy = sessionStorage.getItem(key(slug));
    if (legacy) {
      storeHostToken(slug, legacy);
      return legacy;
    }
    return null;
  } catch {
    return null;
  }
}

export function clearHostToken(slug: string): void {
  try {
    localStorage.removeItem(key(slug));
    sessionStorage.removeItem(key(slug));
  } catch {
    /* nothing to clear */
  }
}
