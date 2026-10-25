/**
 * The name typed in the lobby, kept for this tab only. A screen that reloads
 * the page (Try again, Rejoin, Back to the lobby) then does not ask for it again.
 */
const NAME_KEY = 'om_name';

export function recallName(): string {
  try {
    return sessionStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function rememberName(name: string): void {
  try {
    sessionStorage.setItem(NAME_KEY, name);
  } catch {
    /* storage blocked: the name is typed again */
  }
}
