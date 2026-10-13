/**
 * The look a host gives the show: for now one accent colour for the name tags.
 * Kept in this browser, one per room, and sent to the others only while the
 * call runs. No file holds it.
 */
import { isLookAccent, type LookAccent } from '@openmeet/protocol';

export interface Look {
  accent?: LookAccent;
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

/** The look in `v`: the accent when it is on the list, else the plain look. */
export function lookFrom(v: unknown): Look {
  const accent = typeof v === 'object' && v !== null ? (v as { accent?: unknown }).accent : undefined;
  return isLookAccent(accent) ? { accent } : {};
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
