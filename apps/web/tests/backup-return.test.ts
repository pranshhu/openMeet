import { describe, it, expect } from 'vitest';
import { returnedBackupName, buildBackupNote } from '@/hooks/backup-return';
import type { BackupName } from '@/lib/backup-recorder';

const defaultBackup: BackupName = {
  kind: 'camera',
  startedMs: 1700000000000,
  room: 'abc-defg-hij',
  ext: 'mp4',
};

describe('returnedBackupName', () => {
  it('formats camera backup for Asha K. as expected', () => {
    expect(returnedBackupName(defaultBackup, 'Asha K.')).toBe(
      'backup_asha-k_camera_20231114T221320000Z.mp4'
    );
  });

  it('preserves digits in names', () => {
    expect(returnedBackupName(defaultBackup, 'Guest 2')).toBe(
      'backup_guest-2_camera_20231114T221320000Z.mp4'
    );
  });

  it('collapses runs of separators into a single dash', () => {
    expect(returnedBackupName(defaultBackup, 'Asha -- K')).toBe(
      'backup_asha-k_camera_20231114T221320000Z.mp4'
    );
  });

  it('sanitizes path traversal like ../../etc/passwd into etc-passwd', () => {
    expect(returnedBackupName(defaultBackup, '../../etc/passwd')).toBe(
      'backup_etc-passwd_camera_20231114T221320000Z.mp4'
    );
  });

  it('falls back to guest when from is null, empty, slashes, or only emoji', () => {
    expect(returnedBackupName(defaultBackup, null)).toBe('backup_guest_camera_20231114T221320000Z.mp4');
    expect(returnedBackupName(defaultBackup, '')).toBe('backup_guest_camera_20231114T221320000Z.mp4');
    expect(returnedBackupName(defaultBackup, '///')).toBe('backup_guest_camera_20231114T221320000Z.mp4');
    expect(returnedBackupName(defaultBackup, '🎉🚀✨')).toBe('backup_guest_camera_20231114T221320000Z.mp4');
  });

  it('cuts a 60-letter name to 40', () => {
    const audioBackup: BackupName = {
      ...defaultBackup,
      kind: 'audio',
      ext: 'wav',
    };
    const longName = 'a'.repeat(60);
    const result = returnedBackupName(audioBackup, longName);
    expect(result).toBe(`backup_${'a'.repeat(40)}_audio_20231114T221320000Z.wav`);
  });

  it('cuts 41 astral plane characters to 40 code points without lone surrogates', () => {
    const screenBackup: BackupName = {
      ...defaultBackup,
      kind: 'screen',
    };
    const astral = '𝒜'.repeat(41);
    const result = returnedBackupName(screenBackup, astral);
    expect(() => encodeURIComponent(result)).not.toThrow();
    const who = result.slice('backup_'.length, result.indexOf('_screen_'));
    expect([...who].length).toBe(40);
    expect(who).toBe('𝒜'.repeat(40));
  });
});

describe('buildBackupNote', () => {
  it('parses valid JSON with exact keys in order', () => {
    const raw = buildBackupNote({
      file: 'backup_asha-k_camera_20231114T221320000Z.mp4',
      backupOf: 'openmeet-backup-1700000000000-abc-defg-hij.mp4',
      backup: defaultBackup,
      from: 'Asha K.',
      sizeBytes: 123456,
      sha256Sent: 'abcd1234abcd1234',
      sha256Written: 'abcd1234abcd1234',
    });
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed)).toEqual([
      'file',
      'backupOf',
      'kind',
      'room',
      'from',
      'sizeBytes',
      'sha256',
      'integrity',
      'startedUnixMs',
      'startedUnixMsNote',
      'alignment',
      'generatedBy',
    ]);
    expect(parsed.file).toBe('backup_asha-k_camera_20231114T221320000Z.mp4');
    expect(parsed.backupOf).toBe('openmeet-backup-1700000000000-abc-defg-hij.mp4');
    expect(parsed.kind).toBe('camera');
    expect(parsed.room).toBe('abc-defg-hij');
    expect(parsed.from).toBe('Asha K.');
    expect(parsed.sizeBytes).toBe(123456);
    expect(parsed.sha256).toBe('abcd1234abcd1234');
    expect(parsed.integrity).toBe('Integrity verified — bytes written match bytes sent (sha256).');
    expect(parsed.startedUnixMs).toBe(1700000000000);
    expect(parsed.startedUnixMsNote).toBe(
      "Read from the sender's device clock, not measured against the host's. Compare it with timeline.hostStartUnixMs in a take's sync file to tell which take this belongs to."
    );
    expect(parsed.alignment).toBe(
      "This is the participant's own backup copy, from a separate recorder that started at its own instant. The offsets in the take's sync file do not apply to it: align it by audio waveform."
    );
    expect(parsed.generatedBy).toBe('openMeet');
  });

  it('sets screen alignment for screen backups and audio alignment for audio backups', () => {
    const screenBackup: BackupName = {
      ...defaultBackup,
      kind: 'screen',
    };
    const screenRaw = buildBackupNote({
      file: 'backup_asha-k_screen_20231114T221320000Z.mp4',
      backupOf: 'openmeet-backup-screen-1700000000000-abc-defg-hij.mp4',
      backup: screenBackup,
      from: 'Asha K.',
      sizeBytes: 1000,
      sha256Sent: 'same',
      sha256Written: 'same',
    });
    const parsedScreen = JSON.parse(screenRaw);
    expect(parsedScreen.alignment).toBe(
      "This is the sharer's backup of one screen segment. It holds the same recording as the live segment, so that segment's offset in the take's sync file applies when the segment is listed there."
    );

    const audioBackup: BackupName = {
      ...defaultBackup,
      kind: 'audio',
      ext: 'wav',
    };
    const audioRaw = buildBackupNote({
      file: 'backup_asha-k_audio_20231114T221320000Z.wav',
      backupOf: 'openmeet-backup-audio-1700000000000-abc-defg-hij.wav',
      backup: audioBackup,
      from: 'Asha K.',
      sizeBytes: 2000,
      sha256Sent: 'same',
      sha256Written: 'same',
    });
    const parsedAudio = JSON.parse(audioRaw);
    expect(parsedAudio.alignment).toBe(
      "This is the participant's own backup copy, from a separate recorder that started at its own instant. The offsets in the take's sync file do not apply to it: align it by audio waveform."
    );
  });

  it('sanitizes newlines and right-to-left overrides in from and caps at 64 code points', () => {
    const maliciousFrom = 'Hello\n\u202Ereversed\u202C ' + 'x'.repeat(100);
    const raw = buildBackupNote({
      file: 'file.mp4',
      backupOf: 'backup.mp4',
      backup: defaultBackup,
      from: maliciousFrom,
      sizeBytes: 10,
      sha256Sent: 'claimed-by-sender',
      sha256Written: 'hashed-by-host',
    });
    const parsed = JSON.parse(raw);
    expect(parsed.from).not.toContain('\n');
    expect(parsed.from).not.toContain('\u202E');
    expect([...parsed.from].length).toBe(64);
    expect(parsed.sha256).toBe('hashed-by-host');
    expect(raw).not.toContain('claimed-by-sender');
    expect(parsed.integrity).toBe(
      'INTEGRITY MISMATCH — the received file differs from what was sent. Keep the guest backup.'
    );

    // Verify astral plane code points cut without splitting surrogate pairs
    const astralRaw = buildBackupNote({
      file: 'file.mp4',
      backupOf: 'backup.mp4',
      backup: defaultBackup,
      from: '𝒜'.repeat(70),
      sizeBytes: 10,
      sha256Sent: 's',
      sha256Written: 's',
    });
    const parsedAstral = JSON.parse(astralRaw);
    expect([...parsedAstral.from].length).toBe(64);
    expect(() => encodeURIComponent(parsedAstral.from)).not.toThrow();

    // Verify trimming of leading and trailing whitespace in from
    const trimmedRaw = buildBackupNote({
      file: 'file.mp4',
      backupOf: 'backup.mp4',
      backup: defaultBackup,
      from: '   Asha K.   ',
      sizeBytes: 10,
      sha256Sent: 's',
      sha256Written: 's',
    });
    expect(JSON.parse(trimmedRaw).from).toBe('Asha K.');
  });
});
