'use client';

import { useSyncExternalStore } from 'react';

/**
 * Whether the call's single-key shortcuts (A, V, C, T, M, N and ?) are on: one
 * choice per browser, kept in localStorage. Speech input types letters, and a
 * letter typed outside a field is a key press, so a person who dictates has to
 * be able to turn these keys off. Alt+R and Alt+S are chords and are not part
 * of the choice.
 */

const KEY = 'om_single_keys';

let current: boolean | null = null;
const listeners = new Set<() => void>();

/**
 * On unless this browser stored '0'. A key listener asks as the key arrives,
 * so a change is in force for the very next key.
 */
export function singleKeysOn(): boolean {
  if (current === null) {
    try {
      current = localStorage.getItem(KEY) !== '0';
    } catch {
      current = true; // storage is closed: the choice lasts for this page
    }
  }
  return current;
}

export function setSingleKeys(on: boolean): void {
  if (on === singleKeysOn()) return;
  current = on;
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* storage is closed: the choice lasts for this page */
  }
  for (const listener of [...listeners]) listener();
}

/** Calls `listener` after every change of the choice. Returns an unsubscribe. */
export function onSingleKeysChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The choice as state, for what shows it. */
export function useSingleKeys(): boolean {
  return useSyncExternalStore(onSingleKeysChange, singleKeysOn, () => true);
}
