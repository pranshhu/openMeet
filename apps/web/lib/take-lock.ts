/**
 * "A host tab in this browser is recording this room", held as a Web Lock.
 *
 * The host token exists only in the browser that created the room (a cookie and
 * localStorage), so a connection able to take the host seat from under a live
 * take is always another tab of this origin in this profile, and those are the
 * tabs that share a lock manager. The browser drops the lock by itself when the
 * holding tab closes, reloads or crashes, so a dead tab never locks the room.
 * Where Web Locks are missing nothing is held and nothing is found.
 */
const lockName = (slug: string) => `openmeet-take:${slug}`;

/** Hold the room's take lock until the returned function is called. */
export function holdTakeLock(slug: string): () => void {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    void navigator.locks?.request(lockName(slug), () => released).catch(() => {});
  } catch {
    // No usable lock manager: the take runs unguarded rather than not at all.
  }
  return release;
}

/** Whether a tab in this browser holds the room's take lock. */
export async function isTakeLockHeld(slug: string): Promise<boolean> {
  try {
    // A shared request that does not wait: it is refused only while a
    // recording tab holds the lock.
    return await navigator.locks.request(
      lockName(slug),
      { mode: 'shared', ifAvailable: true },
      (lock) => lock === null
    );
  } catch {
    return false;
  }
}
