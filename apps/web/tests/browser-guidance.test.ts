import { describe, it, expect, vi, afterEach } from 'vitest';
import { recordCapability } from '@/components/RoomView';
import {
  guestRecordingGuidance,
  hostTagNote,
  detectBrowserDevice,
} from '@/lib/browser-guidance';
import { computeRecordingCapability } from '@/hooks/useRoom';

describe('host-block copy for Brave', () => {
  afterEach(() => {
    delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    delete (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });

  it('informs the host that Brave requires enabling brave://flags/#file-system-access-api and does not list Brave as a plain working host', () => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = { isTypeSupported: () => true };
    delete (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker;

    const res = recordCapability('host');
    expect(res.canRecord).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.reason).toMatch(/brave:\/\/flags\/#file-system-access-api/);
    expect(res.reason).not.toMatch(/Chrome, Edge, Brave, or Arc/);
    expect(res.reason).toMatch(/Brave works as host only after enabling/i);
  });
});

describe('detectBrowserDevice and guestRecordingGuidance', () => {
  const SAFARI_MACOS_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
  const IPHONE_UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
  const IPAD_UA =
    'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
  const ANDROID_UA =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36';
  const FIREFOX_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:124.0) Gecko/20100101 Firefox/124.0';
  const CHROME_MACOS_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

  it('identifies Safari on desktop and shows "Safari: video only, no uncompressed WAV"', () => {
    const info = detectBrowserDevice(SAFARI_MACOS_UA);
    expect(info.isSafari).toBe(true);
    expect(info.isMobile).toBe(false);
    expect(guestRecordingGuidance(SAFARI_MACOS_UA)).toBe('Safari: video only, no uncompressed WAV');
  });

  it('identifies iPhone and shows "iPhone/iPad: keep the tab in front, recording stops in the background"', () => {
    const info = detectBrowserDevice(IPHONE_UA);
    expect(info.isIOS).toBe(true);
    expect(info.isMobile).toBe(true);
    expect(guestRecordingGuidance(IPHONE_UA)).toBe(
      'iPhone/iPad: keep the tab in front, recording stops in the background'
    );
  });

  it('identifies iPad and shows "iPhone/iPad: keep the tab in front, recording stops in the background"', () => {
    const info = detectBrowserDevice(IPAD_UA);
    expect(info.isIOS).toBe(true);
    expect(info.isMobile).toBe(true);
    expect(guestRecordingGuidance(IPAD_UA)).toBe(
      'iPhone/iPad: keep the tab in front, recording stops in the background'
    );
  });

  it('identifies iPad with MacIntel touch platform and shows iPhone/iPad guidance', () => {
    const info = detectBrowserDevice(SAFARI_MACOS_UA, 5);
    expect(info.isIOS).toBe(true);
    expect(guestRecordingGuidance(SAFARI_MACOS_UA, 5)).toBe(
      'iPhone/iPad: keep the tab in front, recording stops in the background'
    );
  });

  it('identifies Firefox on desktop and tells guest MP4 cannot be recorded', () => {
    const info = detectBrowserDevice(FIREFOX_UA);
    expect(info.isFirefox).toBe(true);
    expect(guestRecordingGuidance(FIREFOX_UA)).toMatch(/Firefox.*cannot record MP4.*won’t be recorded/i);
  });

  it('identifies Android mobile and reminds guest to keep tab in front', () => {
    const info = detectBrowserDevice(ANDROID_UA);
    expect(info.isAndroid).toBe(true);
    expect(guestRecordingGuidance(ANDROID_UA)).toBe(
      'Android: keep the tab in front, recording stops in the background'
    );
  });

  it('returns null guidance for standard desktop Chromium', () => {
    const info = detectBrowserDevice(CHROME_MACOS_UA);
    expect(info.isChromium).toBe(true);
    expect(info.isMobile).toBe(false);
    expect(guestRecordingGuidance(CHROME_MACOS_UA)).toBeNull();
  });
});

describe('hostTagNote', () => {
  it('returns short note for Safari guest', () => {
    expect(hostTagNote('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15')).toBe('safari');
  });

  it('returns short note for iPhone/iPad guest', () => {
    expect(hostTagNote('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1')).toBe('ios');
  });

  it('returns short note for Android guest', () => {
    expect(hostTagNote('Mozilla/5.0 (Linux; Android 14; Mobile) Chrome/123.0 Safari/537.36')).toBe('android');
  });

  it('returns null for desktop Chromium guest', () => {
    expect(hostTagNote('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/123.0 Safari/537.36')).toBeNull();
  });
});

describe('computeRecordingCapability with note', () => {
  afterEach(() => {
    delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    delete (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor;
  });

  it('includes note for Safari guest', () => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = { isTypeSupported: () => true };
    const safariUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15';
    const cap = computeRecordingCapability(safariUa);
    expect(cap).toEqual({
      mp4: true,
      wav: false,
      note: 'safari',
    });
  });

  it('includes note for iPhone guest', () => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = { isTypeSupported: () => true };
    const iphoneUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
    const cap = computeRecordingCapability(iphoneUa);
    expect(cap).toEqual({
      mp4: true,
      wav: false,
      note: 'ios',
    });
  });
});
