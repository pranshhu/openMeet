import type { BrowserNote } from '@openmeet/protocol';

/**
 * Detection and user guidance for non-Chromium and mobile browsers.
 */

export interface BrowserDeviceInfo {
  isIOS: boolean;
  isAndroid: boolean;
  isMobile: boolean;
  isSafari: boolean;
  isFirefox: boolean;
  isChromium: boolean;
}

export function detectBrowserDevice(
  customUa?: string,
  customTouchPoints?: number
): BrowserDeviceInfo {
  const ua =
    customUa ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const touchPoints =
    customTouchPoints ??
    (typeof navigator !== 'undefined' ? (navigator.maxTouchPoints ?? 0) : 0);

  // iPadOS on desktop Safari mode reports as Macintosh with maxTouchPoints > 1
  const isIOS =
    /iPad|iPhone|iPod/i.test(ua) ||
    (/Macintosh/i.test(ua) && touchPoints > 1);

  const isAndroid = /Android/i.test(ua);
  const isMobile = isIOS || isAndroid || /Mobile/i.test(ua);

  // Firefox
  const isFirefox = /Firefox|FxiOS/i.test(ua);

  // Safari (excluding Chrome/Chromium/Edge/Opera/Brave/Android and Firefox)
  const isSafari =
    !isMobile &&
    /Safari/i.test(ua) &&
    !/Chrome|Chromium|Edg|OPR|Brave|Android/i.test(ua) &&
    !isFirefox;

  // Chromium (Chrome, Edge, Brave, Opera, Arc) on desktop
  const isChromium =
    !isMobile &&
    !isFirefox &&
    !isSafari &&
    /Chrome|Chromium|Edg|OPR|Brave/i.test(ua);

  return { isIOS, isAndroid, isMobile, isSafari, isFirefox, isChromium };
}

/**
 * Explains to a guest on a non-Chromium or mobile browser exactly what will and
 * won't be recorded for them before they join.
 */
export function guestRecordingGuidance(
  customUa?: string,
  customTouchPoints?: number
): string | null {
  const info = detectBrowserDevice(customUa, customTouchPoints);
  if (info.isIOS) {
    return 'iPhone/iPad: keep the tab in front, recording stops in the background';
  }
  if (info.isSafari) {
    return 'Safari: video only, no uncompressed WAV';
  }
  if (info.isFirefox) {
    return 'Firefox: cannot record MP4 (you won’t be recorded)';
  }
  if (info.isAndroid) {
    return 'Android: keep the tab in front, recording stops in the background';
  }
  if (info.isMobile) {
    return 'Mobile: keep the tab in front, recording stops in the background';
  }
  return null;
}

/** The host's wording for each note a guest's browser reports. */
export const BROWSER_NOTE_TEXT: Record<BrowserNote, string> = {
  safari: 'Safari: video only',
  ios: 'iPhone/iPad: recording stops in background',
  android: 'Android: recording stops in background',
  mobile: 'mobile: recording stops in background',
};

/**
 * What to flag on this participant's name tag for the host, as a code.
 */
export function hostTagNote(
  customUa?: string,
  customTouchPoints?: number
): BrowserNote | null {
  const info = detectBrowserDevice(customUa, customTouchPoints);
  if (info.isIOS) return 'ios';
  if (info.isSafari) return 'safari';
  if (info.isAndroid) return 'android';
  if (info.isMobile) return 'mobile';
  return null;
}
