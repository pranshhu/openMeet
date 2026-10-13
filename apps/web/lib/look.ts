/**
 * The look a host gives the show: an accent colour for the name tags and a
 * logo. Kept in this browser, one per room, and sent to the others only while
 * the call runs. No file holds it.
 */
import { LOGO_MAX_PX, isLogo, isLookAccent, type LookAccent } from '@openmeet/protocol';

export interface Look {
  accent?: LookAccent;
  /** A small PNG as `data:` text, always one that isLogo accepted. */
  logo?: string;
}

/** One light tint per code, so it reads on the dark tile. */
export const ACCENT_HEX: Record<LookAccent, string> = {
  blue: '#8ab4f8',
  red: '#f28b82',
  green: '#81c995',
  yellow: '#fdd663',
  purple: '#c58af9',
  pink: '#ff8bcb',
};

const key = (slug: string) => `om_look_${slug}`;

// What this page saved, for a browser that blocks storage.
const held = new Map<string, Look>();

/** The look in `v`: the accent when it is on the list and the logo when isLogo accepts it. */
export function lookFrom(v: unknown): Look {
  const { accent, logo } = typeof v === 'object' && v !== null ? (v as { accent?: unknown; logo?: unknown }) : {};
  return { ...(isLookAccent(accent) ? { accent } : {}), ...(isLogo(logo) ? { logo } : {}) };
}

/**
 * The picture in `file` redrawn as a PNG no larger than LOGO_MAX_PX on a side,
 * never scaled up, or null when it cannot be decoded or the result is not a
 * logo. Only the redrawn picture is kept or sent, never the file's own bytes.
 */
export async function logoFrom(file: File): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, LOGO_MAX_PX / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    ctx?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const url = canvas.toDataURL('image/png');
    return ctx && isLogo(url) ? url : null;
  } catch {
    return null;
  }
}

export function readLook(slug: string): Look {
  try {
    const raw = localStorage.getItem(key(slug));
    if (raw !== null) return lookFrom(JSON.parse(raw));
  } catch {
    /* storage is closed or holds broken JSON: fall back to this page's copy */
  }
  return held.get(slug) ?? {};
}

export function saveLook(slug: string, look: Look): void {
  held.set(slug, look);
  try {
    localStorage.setItem(key(slug), JSON.stringify(look));
  } catch {
    /* private mode — the look lasts for this page */
  }
}
