import { ROOM_TTL_MS } from '@openmeet/protocol';

const COOKIE_PREFIX = 'host_token__';

export function cookieName(slug: string): string {
  return `${COOKIE_PREFIX}${slug}`;
}

export function serializeHostTokenCookie(
  slug: string,
  token: string,
  opts: { secure: boolean }
): string {
  const maxAgeSec = Math.floor(ROOM_TTL_MS / 1000);
  const parts = [
    `${cookieName(slug)}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeSec}`,
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export function parseHostTokenCookie(
  cookieHeader: string | null,
  slug: string
): string | null {
  if (!cookieHeader) return null;
  const target = cookieName(slug);
  const entries = cookieHeader.split(/;\s*/);
  for (const e of entries) {
    const eq = e.indexOf('=');
    if (eq === -1) continue;
    const name = e.slice(0, eq).trim();
    if (name === target) return e.slice(eq + 1).trim();
  }
  return null;
}
