import { describe, it, expect } from 'vitest';
import { SHARED_FILE_ID, sharedFileName } from '@/lib/shared-file';

describe('sharedFileName', () => {
  it('names a picked file after its sender, in letters, digits and hyphens', () => {
    expect(sharedFileName('Ana Headshot (final).JPG', 'Ana María')).toBe(
      'shared_ana-maría_ana-headshot-final.jpg'
    );
    expect(sharedFileName('bio.txt', null)).toBe('shared_guest_bio.txt');
    expect(sharedFileName('....pdf', 'Bo')).toBe('shared_bo_file.pdf');
  });

  it.each([
    'setup.exe',
    'run.bat',
    'page.html',
    'drawing.svg',
    'script.js',
    'link.lnk',
    'archive.zip',
    'macro.docm',
    'photo.jpg.exe',
    'noextension',
    '.png',
    'trailing.',
    'photo.jpg ',
  ])('refuses %s', (name) => {
    expect(sharedFileName(name, 'Ana')).toBeNull();
  });

  it.each([null, undefined, 7, {}, `${'x'.repeat(252)}.png`])(
    'refuses a name that is not a string of at most 255 characters',
    (name) => {
      expect(sharedFileName(name, 'Ana')).toBeNull();
    }
  );

  it('lets nothing of the name through but its cleaned stem and a listed extension', () => {
    // A right-to-left override: "photo<override>gpj.exe" is drawn as "photoexe.jpg".
    // Written as an escape: the character itself must not be in this file.
    expect(sharedFileName('photo\u202egpj.exe', 'Ana')).toBeNull();
    expect(sharedFileName('exe\u202egnp.png', 'Ana')).toBe('shared_ana_exe-gnp.png');
    expect(sharedFileName('../../etc/passwd.txt', '../x')).toBe('shared_x_etc-passwd.txt');
    expect(sharedFileName('CON.txt', 'Ana')).toBe('shared_ana_con.txt');
    expect(sharedFileName(`${'a'.repeat(200)}.PNG`, 'b'.repeat(200))).toBe(
      `shared_${'b'.repeat(32)}_${'a'.repeat(32)}.png`
    );
  });
});

describe('SHARED_FILE_ID', () => {
  it('is file- and a UUID, and nothing else', () => {
    expect(SHARED_FILE_ID.test('file-3f2b8c1e-9a4d-4c6b-8f1e-2d7a9b0c5e4f')).toBe(true);
    expect(SHARED_FILE_ID.test(`file-${crypto.randomUUID()}`)).toBe(true);
    expect(SHARED_FILE_ID.test('file-')).toBe(false);
    expect(SHARED_FILE_ID.test('file-3f2b8c1e')).toBe(false);
    expect(SHARED_FILE_ID.test('file-3f2b8c1e-9a4d-4c6b-8f1e-2d7a9b0c5e4f0')).toBe(false);
    expect(SHARED_FILE_ID.test('xfile-3f2b8c1e-9a4d-4c6b-8f1e-2d7a9b0c5e4f')).toBe(false);
    expect(SHARED_FILE_ID.test('file-../../../../../../../../../../../x')).toBe(false);
    expect(SHARED_FILE_ID.test('openmeet-backup-1700000000000-abc-defg-hij.mp4')).toBe(false);
  });
});
