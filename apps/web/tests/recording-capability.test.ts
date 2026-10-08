import { describe, it, expect, afterEach, vi } from 'vitest';
import { computeRecordingCapability } from '@/hooks/useRoom';
import { recordCapability } from '@/components/RoomView';

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  delete (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor;
});

describe('computeRecordingCapability', () => {
  it('reports both true when an MP4 codec and PCM capture are both available', () => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = { isTypeSupported: () => true };
    (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor = function () {};
    expect(computeRecordingCapability()).toEqual({ mp4: true, wav: true });
  });

  it('reports mp4:false when no codec is encodable here (Firefox/Safari)', () => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = { isTypeSupported: () => false };
    expect(computeRecordingCapability().mp4).toBe(false);
  });

  it('reports wav:false when MediaStreamTrackProcessor is absent', () => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = { isTypeSupported: () => true };
    expect(computeRecordingCapability().wav).toBe(false);
  });
});

describe('recordCapability', () => {
  it('reports watching and not recorded for producer role without claim of being captured', () => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = { isTypeSupported: () => true };
    const res = recordCapability('producer');
    expect(res.canRecord).toBe(false);
    expect(res.blocked).toBe(false);
    expect(res.reason).toMatch(/watching and are not recorded/i);
    expect(res.reason).not.toMatch(/captured/i);
  });

  it('reports watching and not recorded when producer flag is true', () => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = { isTypeSupported: () => true };
    const res = recordCapability(null, true);
    expect(res.canRecord).toBe(false);
    expect(res.blocked).toBe(false);
    expect(res.reason).toMatch(/watching and are not recorded/i);
    expect(res.reason).not.toMatch(/captured/i);
  });

  // Guarded before the codec check: a guest the host left out of the recording
  // has nothing to say about capture, even in a browser that can't record.
  it('says nothing about capture to a guest the host set as not recorded', () => {
    expect(recordCapability('guest', false, true)).toEqual({
      canRecord: false,
      blocked: false,
      reason: null,
    });
  });

  it('still tells a guest that will be captured that the host starts the recording', () => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = { isTypeSupported: () => true };
    expect(recordCapability('guest')).toEqual({
      canRecord: false,
      blocked: false,
      reason: 'The host starts the recording — you’ll be captured automatically.',
    });
  });

  // The flag is about a guest the host left out; it must not turn the host's own
  // path into a silent "nothing to record".
  it('does not let the not-recorded flag short-circuit the host’s own path', () => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = { isTypeSupported: () => true };
    expect(recordCapability('host', false, true).blocked).toBe(true);
  });

  // No phone browser can write to a folder: naming a browser there sent
  // someone already in Chrome to Chrome.
  it('tells a host on a phone to record from a computer', () => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = { isTypeSupported: () => true };
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36'
    );
    expect('showDirectoryPicker' in globalThis).toBe(false);
    const res = recordCapability('host');
    expect(res.canRecord).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.reason).toBe('Phones can’t save recordings. To record, host this room from Chrome, Edge or Arc on a computer.');
  });
});
