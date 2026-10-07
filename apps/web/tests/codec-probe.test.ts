import { describe, it, expect, afterEach } from 'vitest';
import { pickRecordingMime, pickCallAudioMime, isRecordingSupported, UnsupportedCodecError } from '@/lib/recorder';
import { RECORDING_MIME, RECORDING_MIME_CANDIDATES } from '@openmeet/protocol';

/**
 * Regression cover for the bug where a single hardcoded codec string was assumed
 * to work everywhere. It does not: Chrome 151 on Linux (both the official .deb and
 * the Chromium snap) has NO AAC-LC encoder, so the app's own RECORDING_MIME is
 * unsupported there while H.264 itself is fine.
 *
 * Measured, and encoded as the `LINUX_CHROME` fixture below:
 *   video/mp4;codecs=avc1.42E01F,mp4a.40.2 -> false
 *   video/mp4;codecs=avc1.42E01F,opus      -> true
 */

type Supported = (m: string) => boolean;

function installMediaRecorder(isTypeSupported: Supported) {
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = { isTypeSupported };
}

afterEach(() => {
  delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
});

/** macOS/Windows Chrome: system AAC encoder present, everything supported. */
const FULL: Supported = () => true;

/**
 * Linux Chrome: H.264 yes, AAC no. Any candidate naming mp4a is unsupported.
 * avc1 and avc3 name the same H.264 bytestream (only the parameter-set signalling
 * differs), so a real Chrome reports the same support for both.
 */
const LINUX_CHROME: Supported = (m) => !m.includes('mp4a');

/** A browser that understands avc1 but not the in-band-parameter-set avc3 variant. */
const NO_AVC3: Supported = (m) => !m.includes('avc3');

/** Firefox/Safari: no MP4 recording at all. */
const NO_MP4: Supported = (m) => !m.includes('mp4');

describe('pickRecordingMime', () => {
  it('prefers AAC when the platform has it (macOS/Windows)', () => {
    installMediaRecorder(FULL);
    expect(pickRecordingMime()).toBe(RECORDING_MIME);
    expect(pickRecordingMime()).toContain('mp4a.40.2');
  });

  it('picks the avc3 twin when supported — in-band parameter sets survive a mid-recording resolution change', () => {
    installMediaRecorder(FULL);
    expect(pickRecordingMime()).toBe('video/mp4;codecs=avc3.42E01F,mp4a.40.2');
  });

  it('falls back to avc1 when only avc1 is supported', () => {
    installMediaRecorder(NO_AVC3);
    expect(pickRecordingMime()).toBe('video/mp4;codecs=avc1.42E01F,mp4a.40.2');
  });

  it('falls back to H.264+Opus on Linux Chrome, where AAC is absent', () => {
    installMediaRecorder(LINUX_CHROME);
    const picked = pickRecordingMime();
    expect(picked).toBe('video/mp4;codecs=avc3.42E01F,opus');
    // The whole point: the previously-hardcoded default does NOT work here.
    expect(LINUX_CHROME(RECORDING_MIME)).toBe(false);
  });

  it('returns null when no candidate is encodable (Firefox/Safari)', () => {
    installMediaRecorder(NO_MP4);
    expect(pickRecordingMime()).toBeNull();
  });

  it('returns null when MediaRecorder is absent entirely', () => {
    expect(pickRecordingMime()).toBeNull();
  });

  it('returns the FIRST supported candidate, preserving the preference order', () => {
    // Only the last two candidates supported -> must pick the earlier of them.
    const onlyTail: Supported = (m) => m === 'video/mp4' || m === 'video/mp4;codecs=avc1.640028,opus';
    installMediaRecorder(onlyTail);
    expect(pickRecordingMime()).toBe('video/mp4;codecs=avc1.640028,opus');
  });
});

describe('RECORDING_MIME_CANDIDATES', () => {
  it('every candidate stays in the MP4 container', () => {
    // The host opens `guest_<id>.mp4` before the guest picks a codec. A WebM
    // fallback would put WebM bytes behind an .mp4 extension.
    for (const m of RECORDING_MIME_CANDIDATES) expect(m.startsWith('video/mp4')).toBe(true);
  });

  it('orders AAC ahead of Opus for editor compatibility', () => {
    const firstOpus = RECORDING_MIME_CANDIDATES.findIndex((m) => m.includes('opus'));
    const lastAac = RECORDING_MIME_CANDIDATES.map((m) => m.includes('mp4a')).lastIndexOf(true);
    expect(lastAac).toBeLessThan(firstOpus);
  });
});

describe('isRecordingSupported', () => {
  it('with no argument, asks whether ANY candidate works — not one fixed string', () => {
    installMediaRecorder(LINUX_CHROME);
    // The old behaviour tested RECORDING_MIME and would have said false here,
    // disabling recording on a machine that can record perfectly well.
    expect(isRecordingSupported()).toBe(true);
    expect(isRecordingSupported(RECORDING_MIME)).toBe(false);
  });

  it('is false when nothing is encodable', () => {
    installMediaRecorder(NO_MP4);
    expect(isRecordingSupported()).toBe(false);
  });
});

describe('UnsupportedCodecError', () => {
  it('names itself so callers can branch on it, and explains what to do', () => {
    const e = new UnsupportedCodecError();
    expect(e.name).toBe('UnsupportedCodecError');
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toMatch(/Chrome/i);
  });
});

describe('pickCallAudioMime', () => {
  it('returns AAC in MP4 under FULL', () => {
    installMediaRecorder(FULL);
    expect(pickCallAudioMime()).toBe('audio/mp4;codecs=mp4a.40.2');
  });

  it('returns Opus in MP4 under LINUX_CHROME', () => {
    installMediaRecorder(LINUX_CHROME);
    expect(pickCallAudioMime()).toBe('audio/mp4;codecs=opus');
  });

  it('returns Opus in WebM under NO_MP4', () => {
    installMediaRecorder(NO_MP4);
    expect(pickCallAudioMime()).toBe('audio/webm;codecs=opus');
  });

  it('returns null with no MediaRecorder', () => {
    expect(pickCallAudioMime()).toBeNull();
  });

  it('returns null when MediaRecorder has no supported candidate', () => {
    installMediaRecorder(() => false);
    expect(pickCallAudioMime()).toBeNull();
  });

  it('returns null when MediaRecorder has no isTypeSupported method', () => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = {};
    expect(pickCallAudioMime()).toBeNull();
  });
});
