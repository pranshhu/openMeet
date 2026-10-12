import { describe, it, expect } from 'vitest';
import { MAX_BACKUP_OFFERS_PER_PEER, takeBackupFiles } from '@/hooks/backup-return';

const ROOM = 'abc-defg-hij';
const CAMERA = `openmeet-backup-1700000000000-${ROOM}.mp4`;
const WAV = `openmeet-backup-audio-1700000000001-${ROOM}.wav`;
const screenName = (n: number) => `openmeet-backup-screen-${1700000000100 + n}-${ROOM}.mp4`;
const file = (name: string, bytes = 4) => new File([new Uint8Array(bytes)], name);

describe('takeBackupFiles', () => {
  it('answers the camera backup, the WAV backup and each screen backup, in that order', async () => {
    const screens = [1, 2].map((n) => ({ stop: async () => file(screenName(n)) }));
    const out = await takeBackupFiles(file(CAMERA), file(WAV), screens);
    expect(out.map((f) => f.name)).toEqual([CAMERA, WAV, screenName(1), screenName(2)]);
  });

  it('leaves out a backup kept in memory, an empty one, a missing one and a file that is no backup', async () => {
    const screens = [
      { stop: async () => new Blob(['x']) },
      { stop: async () => file(screenName(1), 0) },
      { stop: async () => null },
      { stop: async () => file('holiday.mp4') },
    ];
    expect(await takeBackupFiles(new Blob(['x']), null, screens)).toEqual([]);
  });

  it('leaves out a screen backup that fails to stop and keeps the rest', async () => {
    const screens = [
      {
        stop: async (): Promise<Blob | null> => {
          throw new Error('storage');
        },
      },
      { stop: async () => file(screenName(2)) },
    ];
    const out = await takeBackupFiles(file(CAMERA), undefined, screens);
    expect(out.map((f) => f.name)).toEqual([CAMERA, screenName(2)]);
  });

  it('answers no more than one sender may have waiting, the camera and the WAV first', async () => {
    const screens = Array.from({ length: 10 }, (_, n) => ({ stop: async () => file(screenName(n)) }));
    const out = await takeBackupFiles(file(CAMERA), file(WAV), screens);
    expect(out).toHaveLength(MAX_BACKUP_OFFERS_PER_PEER);
    expect(out.slice(0, 2).map((f) => f.name)).toEqual([CAMERA, WAV]);
  });
});
