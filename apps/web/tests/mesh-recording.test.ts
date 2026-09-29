import { describe, it, expect } from 'vitest';
import { guestSlot, guestName, type RecordingHandles } from '@/hooks/recording-controller';

/**
 * A mesh room can hold up to three guests. Each needs its own file set, and the
 * FIRST guest must keep the original names so the verified two-person path is
 * byte-identical to what shipped before mesh.
 */
describe('guest slots in a mesh room', () => {
  it('assigns a stable slot per source peer', () => {
    const h: RecordingHandles = { recordingId: 'r' };
    expect(guestSlot(h, 'peer-a')).toBe(0);
    expect(guestSlot(h, 'peer-b')).toBe(1);
    expect(guestSlot(h, 'peer-a')).toBe(0); // stable across reconnects
    expect(guestSlot(h, 'peer-c')).toBe(2);
  });

  it('leaves the first guest with the original filenames', () => {
    expect(guestName(0, 'rec', 1, 'mp4')).toBe('guest_rec.mp4');
    expect(guestName(0, 'rec', 1, 'wav')).toBe('guest_rec.wav');
  });

  it('numbers additional guests so nothing collides', () => {
    expect(guestName(1, 'rec', 1, 'mp4')).toBe('guest2_rec.mp4');
    expect(guestName(2, 'rec', 1, 'wav')).toBe('guest3_rec.wav');
  });

  it('composes with take numbering', () => {
    expect(guestName(1, 'rec', 3, 'mp4')).toBe('guest2_rec_take3.mp4');
  });

  it('produces a distinct name for every guest, take and format', () => {
    const names = new Set<string>();
    for (const slot of [0, 1, 2]) {
      for (const take of [1, 2]) {
        for (const ext of ['mp4', 'wav']) names.add(guestName(slot, 'id', take, ext));
      }
    }
    expect(names.size).toBe(12);
  });
});
