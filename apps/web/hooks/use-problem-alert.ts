'use client';

import { useEffect, useRef } from 'react';

/**
 * Requests browser permission for problem notifications if Notification exists
 * and permission is still in the 'default' state. Never called on mount.
 */
export function requestProblemNotifications(): void {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission().catch(() => {});
    }
  } catch {
    // Alert failures must never break the call.
  }
}

/**
 * Alerts the user with a sound and, when the tab is hidden, a system notification
 * whenever a recording problem appears during an active take.
 */
export function useProblemAlert(opts: { active: boolean; message: string | null }): void {
  const { active, message } = opts;
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    return () => {
      const ctx = audioCtxRef.current;
      if (ctx) {
        try {
          void ctx.close().catch(() => {});
        } catch {
          // Alert failures must never break the call.
        }
        audioCtxRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!active || !message) {
      return;
    }

    playAlertBeeps(audioCtxRef);
    showProblemNotification(message);
  }, [active, message]);
}

function playAlertBeeps(audioCtxRef: React.MutableRefObject<AudioContext | null>): void {
  try {
    if (typeof AudioContext === 'undefined') {
      return;
    }

    let ctx = audioCtxRef.current;
    if (!ctx) {
      ctx = new AudioContext();
      audioCtxRef.current = ctx;
    }

    void ctx.resume().then(() => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.value = 0.15;

      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.setValueAtTime(0, now + 0.12);
      gain.gain.setValueAtTime(0.15, now + 0.22);
      gain.gain.setValueAtTime(0, now + 0.34);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.35);
    }).catch(() => {});
  } catch {
    // Alert failures must never break the call.
  }
}

function showProblemNotification(message: string): void {
  try {
    if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const notification = new Notification('openMeet: recording needs attention', {
        body: message,
        tag: 'openmeet-recording',
      });
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
    }
  } catch {
    // Alert failures must never break the call.
  }
}
