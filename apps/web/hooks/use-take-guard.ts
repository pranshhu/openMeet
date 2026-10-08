'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Format hidden duration in ms into a concise string like "12 s" or "1 min 20 s".
 */
export function formatHiddenDuration(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds} s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds > 0) {
    return `${minutes} min ${seconds} s`;
  }
  return `${minutes} min`;
}

/**
 * Warn when the battery is low (<= 10%) and not charging.
 */
export function batteryNoteFor(b: { charging: boolean; level: number }): string | null {
  if (b.charging) return null;
  const percent = Math.round(b.level * 100);
  if (percent > 10) return null;
  return `Battery at ${percent}% and not charging. Plug in, or end the take soon.`;
}

export function useTakeGuard(active: boolean): {
  backgroundNote: string | null;
  dismissBackgroundNote: () => void;
  batteryNote: string | null;
} {
  const [backgroundNote, setBackgroundNote] = useState<string | null>(null);
  const [batteryNote, setBatteryNote] = useState<string | null>(null);

  const accumulatedMsRef = useRef<number>(0);
  const hiddenStartRef = useRef<number | null>(null);
  const prevActiveRef = useRef<boolean>(active);
  const activeRef = useRef<boolean>(active);
  activeRef.current = active;

  // Reset when a new take starts (active false to true).
  useEffect(() => {
    if (active && !prevActiveRef.current) {
      accumulatedMsRef.current = 0;
      hiddenStartRef.current = document.hidden ? Date.now() : null;
      setBackgroundNote(null);
    } else if (!active && prevActiveRef.current) {
      hiddenStartRef.current = null;
    }
    prevActiveRef.current = active;
  }, [active]);

  // Track hidden background time during an active take.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) {
        if (activeRef.current) {
          hiddenStartRef.current = Date.now();
        }
      } else {
        if (hiddenStartRef.current !== null) {
          const elapsed = Date.now() - hiddenStartRef.current;
          hiddenStartRef.current = null;
          if (activeRef.current) {
            accumulatedMsRef.current += elapsed;
            if (accumulatedMsRef.current >= 5000) {
              const formatted = formatHiddenDuration(accumulatedMsRef.current);
              setBackgroundNote(
                `This tab was in the background for ${formatted} during the take. Keep it in front while recording.`
              );
            }
          }
        }
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  // Screen wake lock: hold while active, re-request on visible, release on inactive or unmount.
  useEffect(() => {
    if (!active) return;
    if (!navigator.wakeLock) return;

    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    async function acquireLock() {
      if (document.hidden || cancelled) return;
      if (sentinel && !sentinel.released) return;
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (cancelled) {
          void lock.release().catch(() => {});
        } else {
          sentinel = lock;
        }
      } catch {
        // Rejections (e.g. page not visible) are expected and swallowed.
      }
    }

    void acquireLock();

    const onVisibilityChange = () => {
      if (!document.hidden && active) {
        void acquireLock();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (sentinel) {
        void sentinel.release().catch(() => {});
        sentinel = null;
      }
    };
  }, [active]);

  // Battery status: monitor while active, clear and remove listeners on inactive or unmount.
  useEffect(() => {
    if (!active) {
      setBatteryNote(null);
      return;
    }
    type BatteryManagerLike = EventTarget & {
      charging: boolean;
      level: number;
    };
    type NavigatorWithBattery = Navigator & {
      getBattery?: () => Promise<BatteryManagerLike>;
    };

    const nav = typeof navigator !== 'undefined' ? (navigator as NavigatorWithBattery) : undefined;
    if (!nav || typeof nav.getBattery !== 'function') {
      return;
    }

    let cancelled = false;
    let batteryInstance: BatteryManagerLike | null = null;
    let onUpdate: (() => void) | null = null;

    nav
      .getBattery()
      .then((battery) => {
        if (cancelled) return;
        batteryInstance = battery;
        onUpdate = () => {
          setBatteryNote(batteryNoteFor(battery));
        };
        onUpdate();
        battery.addEventListener('levelchange', onUpdate);
        battery.addEventListener('chargingchange', onUpdate);
      })
      .catch(() => {
        // Permission or environment rejection swallowed
      });

    return () => {
      cancelled = true;
      if (batteryInstance && onUpdate) {
        batteryInstance.removeEventListener('levelchange', onUpdate);
        batteryInstance.removeEventListener('chargingchange', onUpdate);
      }
      setBatteryNote(null);
    };
  }, [active]);

  const dismissBackgroundNote = useCallback(() => {
    setBackgroundNote(null);
    accumulatedMsRef.current = 0;
    hiddenStartRef.current = null;
  }, []);

  return {
    backgroundNote,
    dismissBackgroundNote,
    batteryNote,
  };
}
