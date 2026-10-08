import { describe, it, expect } from 'vitest';
import { safeNamePart, roleWithName, downloadNamesFor } from '@/lib/file-names';

describe('safeNamePart', () => {
  it('keeps letters and digits of any script, lowercased and hyphenated', () => {
    expect(safeNamePart('Sam Lee')).toBe('sam-lee');
    expect(safeNamePart('José María 2')).toBe('josé-maría-2');
    expect(safeNamePart('名前 太郎')).toBe('名前-太郎');
  });

  it('keeps combining marks, without which some scripts are unreadable', () => {
    expect(safeNamePart('प्रांशु')).toBe('प्रांशु');
  });

  it('composes a letter and its accent into one character', () => {
    expect(safeNamePart('e\u0301')).toBe('\u00e9');
  });

  it('leaves nothing a file system or a shell could act on', () => {
    expect(safeNamePart('../../etc/passwd')).toBe('etc-passwd');
    expect(safeNamePart('a/b\\c:d*e?f|g<h>i"j')).toBe('a-b-c-d-e-f-g-h-i-j');
    expect(safeNamePart('$(whoami)`x` "q" %PATH% !!')).toBe('whoami-x-q-path');
    expect(safeNamePart('\u202Eevil\u0000\n')).toBe('evil');
    expect(safeNamePart(' .sam_lee. ')).toBe('sam-lee');
  });

  it('keeps at most 32 characters, counting an astral letter as one, and never ends on a hyphen', () => {
    expect(Array.from(safeNamePart('\u{10400}'.repeat(40)))).toHaveLength(32);
    expect(safeNamePart('a'.repeat(31) + ' b')).toBe('a'.repeat(31));
    expect(safeNamePart('x'.repeat(1_000_000))).toBe('x'.repeat(32));
    // Lowercasing can lengthen a string: the cap has to hold after it.
    expect(Array.from(safeNamePart('\u0130'.repeat(40)))).toHaveLength(32);
  });

  it('returns an empty string for anything that is not a usable name', () => {
    for (const v of [null, undefined, 42, {}, [], '', '///', '😀😀', { toString: () => 'sam' }]) {
      expect(safeNamePart(v)).toBe('');
    }
  });

  it('is stable when applied twice', () => {
    for (const s of ['Sam Lee', 'प्रांशु', 'a'.repeat(31) + ' b', '\u0130'.repeat(40), '../x']) {
      expect(safeNamePart(safeNamePart(s))).toBe(safeNamePart(s));
    }
  });
});

describe('roleWithName', () => {
  it('puts the cleaned name after the role', () => {
    expect(roleWithName('guest2', 'Sam Lee')).toBe('guest2-sam-lee');
  });

  it('falls back to the bare role when the name has nothing usable', () => {
    expect(roleWithName('host', '///')).toBe('host');
    expect(roleWithName('host', undefined)).toBe('host');
  });
});

describe('downloadNamesFor', () => {
  it('names a host download for the room, the take and the person', () => {
    expect(downloadNamesFor({ room: 'abc-defg-hij', take: 2, localName: 'Alice', role: 'host' })).toEqual({
      sync: 'openmeet-abc-defg-hij-take2-sync.json',
      chapters: 'openmeet-abc-defg-hij-take2-chapters.txt',
      backup: 'openmeet-abc-defg-hij-take2-backup-alice.mp4',
      wav: 'openmeet-abc-defg-hij-take2-backup-alice.wav',
    });
  });

  it('leaves the take out when it is not known', () => {
    expect(downloadNamesFor({ room: 'abc-defg-hij', localName: 'Sam', role: 'guest' }).backup).toBe(
      'openmeet-abc-defg-hij-backup-sam.mp4'
    );
  });

  it('keeps a name written with combining marks whole', () => {
    expect(downloadNamesFor({ room: 'r', localName: 'प्रांशु', role: 'guest' }).wav).toBe('openmeet-r-backup-प्रांशु.wav');
  });

  it('falls back to the role, then to "you", when the name has nothing usable', () => {
    expect(downloadNamesFor({ room: 'r', localName: '///', role: 'guest' }).backup).toBe('openmeet-r-backup-guest.mp4');
    expect(downloadNamesFor({ room: 'r', localName: '', role: null }).backup).toBe('openmeet-r-backup-you.mp4');
  });

  it('cuts a very long name to 32 characters, like the recording files do', () => {
    expect(downloadNamesFor({ room: 'r', localName: 'a'.repeat(40), role: null }).wav).toBe(
      `openmeet-r-backup-${'a'.repeat(32)}.wav`
    );
  });
});
