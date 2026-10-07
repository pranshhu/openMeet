import { describe, it, expect } from 'vitest';
import { sendEncoding, totalUploadBps } from '@/lib/send-quality';

/**
 * In a full mesh each peer sends N-1 copies of its stream, so the upload cost
 * grows with the room. Recording quality was being sent over the wire, which at
 * four people meant ~16.5 Mbps up and six concurrent encodes — jitter, lag, and
 * a screen share that would not start.
 */
describe('sendEncoding — the total budget stays flat as the room grows', () => {
  it('halves and thirds the per-peer camera bitrate as peers join', () => {
    const one = sendEncoding(2, 'camera').maxBitrate!;
    const two = sendEncoding(3, 'camera').maxBitrate!;
    const three = sendEncoding(4, 'camera').maxBitrate!;
    expect(one).toBeGreaterThan(two);
    expect(two).toBeGreaterThan(three);
  });

  it('keeps total camera upload roughly constant at 2, 3 and 4 people', () => {
    const totals = [2, 3, 4].map((n) => totalUploadBps(n, false));
    for (const t of totals) {
      expect(t).toBeLessThanOrEqual(2_600_000);
      expect(t).toBeGreaterThan(1_000_000);
    }
  });

  // The specific failure reported: four people, screen share won't start.
  it('keeps a four-person call WITH screen share inside a normal uplink', () => {
    const withScreen = totalUploadBps(4, true);
    expect(withScreen, 'four-way + screen still exceeds a typical home uplink')
      .toBeLessThan(6_000_000);
  });

  it('never divides below a floor that would be worse than useless', () => {
    expect(sendEncoding(50, 'camera').maxBitrate).toBeGreaterThanOrEqual(250_000);
    expect(sendEncoding(50, 'screen').maxBitrate).toBeGreaterThanOrEqual(300_000);
  });

  it('drops camera resolution alongside bitrate, so bits per pixel hold up', () => {
    expect(sendEncoding(2, 'camera').scaleResolutionDownBy).toBe(1);
    expect(sendEncoding(4, 'camera').scaleResolutionDownBy).toBe(2);
  });

  // Text is the payload on a shared screen: keep the pixels, drop the frames.
  it('never scales a screen share down, and caps its frame rate instead', () => {
    const s = sendEncoding(4, 'screen');
    expect(s.scaleResolutionDownBy).toBeUndefined();
    expect(s.maxFramerate).toBeLessThanOrEqual(10);
  });

  it('is a no-op when nobody else is in the room', () => {
    expect(totalUploadBps(1, true)).toBe(0);
  });
});

describe('sendEncoding in low-power mode', () => {
  it('sends the camera at a quarter size and the floor bitrate, whatever the room size', () => {
    expect(sendEncoding(2, 'camera', true)).toEqual({
      maxBitrate: 250_000,
      scaleResolutionDownBy: 4,
    });
    expect(sendEncoding(4, 'camera', true)).toEqual({
      maxBitrate: 250_000,
      scaleResolutionDownBy: 4,
    });
  });

  it('keeps a shared screen at full size and halves its frame rate', () => {
    const low = sendEncoding(4, 'screen', true);
    const normal = sendEncoding(4, 'screen');
    expect(low.maxFramerate).toBe(4);
    expect(low.scaleResolutionDownBy).toBeUndefined();
    expect(low.maxBitrate).toBe(normal.maxBitrate);
  });

  it('returns the same keys in both modes, so turning it off leaves nothing behind', () => {
    for (const kind of ['camera', 'screen'] as const) {
      expect(Object.keys(sendEncoding(3, kind, true)).sort()).toEqual(
        Object.keys(sendEncoding(3, kind)).sort()
      );
    }
  });
});
