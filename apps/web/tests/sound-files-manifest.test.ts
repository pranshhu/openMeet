import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BOARD_SOUNDS } from '@/lib/board-sounds';
import { SOUND_FILES } from '@/lib/sound-files';

const dir = path.resolve(__dirname, '../public/sounds');
// The folder is made by whoever adds the first recording. A file whose name
// starts with a dot is the system's own (.DS_Store), not a recording.
const onDisk = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !f.startsWith('.')) : [];
// The folder is in every deploy of the site, wanted or not.
const MAX_FILE_BYTES = 1024 * 1024;

describe('recordings shipped as ready sounds', () => {
  it('lists every file in public/sounds, and no file that is not there', () => {
    expect(SOUND_FILES.map((s) => s.file).sort()).toEqual([...onDisk].sort());
  });

  it('says for every file what allows shipping it and where it came from', () => {
    for (const s of SOUND_FILES) {
      expect(s.license.trim(), `${s.file}: license`).not.toBe('');
      expect(s.source.trim(), `${s.file}: source`).not.toBe('');
    }
  });

  it('keeps every file at 1 MiB or less', () => {
    for (const f of onDisk) {
      expect(fs.statSync(path.join(dir, f)).size, f).toBeLessThanOrEqual(MAX_FILE_BYTES);
    }
  });

  it('gives every ready sound a name of its own that fits its button on a phone', () => {
    const names = [...BOARD_SOUNDS, ...SOUND_FILES].map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n.length, n).toBeLessThanOrEqual(20);
  });
});
