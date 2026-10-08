'use client';

import { useEffect, useState } from 'react';
import type { LoadSample } from './useRoom';

/** How often the device's load is read during a take. */
const OVERLOAD_SAMPLE_MS = 5_000;
/** Readings kept: six, five seconds apart, so the verdict looks back 25 seconds. */
const OVERLOAD_WINDOW = 6;
/** Audio lost inside one window that counts as not keeping up. */
const AUDIO_DROPPED_MS = 100;
/** Processor-limited readings inside one window that count as not keeping up. */
const CPU_LIMITED_SAMPLES = 3;

/**
 * Whether these readings, oldest first, show a device that is not keeping up.
 *
 * Audio is measured against the oldest reading kept, so whatever was lost
 * before it, such as the stall while the recorders start, never counts.
 * The thresholds are estimates; tune them against real slow machines.
 */
export function isOverloaded(samples: readonly LoadSample[]): boolean {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) return false;
  if (last.audioDroppedMs - first.audioDroppedMs >= AUDIO_DROPPED_MS) return true;
  return samples.filter((s) => s.cpuLimited).length >= CPU_LIMITED_SAMPLES;
}

/**
 * True once the take being recorded has shown this device is not keeping up.
 * It stays true for the rest of that take, so the notice does not come and
 * go, and starts clean with the next take.
 *
 * Changing low-power mode starts the evidence over: what was measured before
 * says nothing about the mode now in use. While the mode is on only lost audio
 * counts: the encoder flag describes the live picture, which is then a quarter
 * size, and the browser goes on reporting a past limit for a while after the
 * load has gone.
 */
export function useOverloadWatch(
  active: boolean,
  read?: () => Promise<LoadSample>,
  lowPower = false
): boolean {
  // The mode the verdict was reached in, or null while there is none. Compared
  // with the mode in use on the way out, so a verdict from before a switch is
  // not shown even for the one render that runs before the effect starts over.
  const [overloadedIn, setOverloadedIn] = useState<boolean | null>(null);
  useEffect(() => {
    setOverloadedIn(null);
    if (!active || !read) return;
    let cancelled = false;
    const samples: LoadSample[] = [];
    const id = setInterval(() => {
      read().then(
        (sample) => {
          if (cancelled) return;
          samples.push(lowPower ? { ...sample, cpuLimited: false } : sample);
          if (samples.length > OVERLOAD_WINDOW) samples.shift();
          if (isOverloaded(samples)) setOverloadedIn(lowPower);
        },
        () => {
          // A reading that failed is no evidence either way.
        }
      );
    }, OVERLOAD_SAMPLE_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active, read, lowPower]);
  return overloadedIn === lowPower;
}
