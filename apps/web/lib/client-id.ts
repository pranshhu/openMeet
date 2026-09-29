/**
 * Stable per-tab identifier kept in sessionStorage.
 *
 * Scoped to the tab so reconnects from the same tab present the same ID, allowing
 * the Room DO to close any stale socket from this tab before counting capacity.
 */
const CLIENT_ID_KEY = 'om_tab_id';

export function getOrCreateClientId(): string {
  try {
    const existing = sessionStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const generated = crypto.randomUUID();
    sessionStorage.setItem(CLIENT_ID_KEY, generated);
    return generated;
  } catch {
    return crypto.randomUUID();
  }
}
