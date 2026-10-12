import { describe, it, expect } from 'vitest';
import { BackupIntake, buildBackupNote, type BackupTransfer } from '@/hooks/backup-return';
import type { BackupName } from '@/lib/backup-recorder';
import { fakeChannel, fakeFolder, flush, framesFor } from './backup-fakes';

const ROOM = 'abc-defg-hij';
const WAV = 'backup_alice_audio_20231114T221320000Z.wav';
const ENCODE = `ffmpeg -i "${WAV}" -c:a flac "backup_alice_audio_20231114T221320000Z.flac"`;
const CHECK =
  `ffmpeg -v error -i "${WAV}" -i "backup_alice_audio_20231114T221320000Z.flac" ` +
  '-map 0:a -c:a pcm_s24le -f md5 - -map 1:a -c:a pcm_s24le -f md5 -';

interface Note {
  file: string;
  flac?: { note: string; encode: string; check: string };
}

function noteFor(kind: BackupName['kind'], file: string): Note {
  const ext = kind === 'audio' ? 'wav' : 'mp4';
  return JSON.parse(
    buildBackupNote({
      file,
      backupOf: `openmeet-backup-1700000000000-${ROOM}.${ext}`,
      backup: { kind, startedMs: 1700000000000, room: ROOM, ext },
      from: 'Alice',
      sizeBytes: 2000,
      sha256Sent: 'same',
      sha256Written: 'same',
    })
  ) as Note;
}

describe('the note beside a returned WAV backup', () => {
  it("holds the two FLAC commands for the file's name in the host's folder", () => {
    const note = noteFor('audio', WAV);
    expect(note.flac?.encode).toBe(ENCODE);
    expect(note.flac?.check).toBe(CHECK);
    expect(note.flac?.note).toContain('only then is it safe to delete the WAV');
    // A name the folder numbered is the name the commands must read.
    expect(noteFor('audio', WAV.replace('.wav', '_2.wav')).flac?.encode).toBe(
      ENCODE.replace(/Z\./g, 'Z_2.')
    );
  });

  it('names the numbered copy in the check command too', () => {
    expect(noteFor('audio', WAV.replace('.wav', '_2.wav')).flac?.check).toBe(
      CHECK.replace(/Z\./g, 'Z_2.')
    );
  });

  it('tells the host what each command does and when the WAV may be deleted', () => {
    expect(noteFor('audio', WAV).flac?.note).toBe(
      'Optional. encode writes a FLAC beside this WAV: the same samples in a smaller file. check decodes both ' +
        'and prints two MD5 lines. When the two lines are the same the FLAC holds every sample of the WAV, and ' +
        'only then is it safe to delete the WAV; when they differ, or ffmpeg prints an error, keep the WAV and ' +
        'encode again.'
    );
  });

  it('keeps the note keys in order, with flac between alignment and generatedBy', () => {
    expect(Object.keys(noteFor('audio', WAV))).toEqual([
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
      'flac',
      'generatedBy',
    ]);
  });

  it('gives a camera or a screen backup none', () => {
    expect('flac' in noteFor('camera', 'backup_alice_camera_20231114T221320000Z.mp4')).toBe(false);
    expect('flac' in noteFor('screen', 'backup_alice_screen_20231114T221320000Z.mp4')).toBe(false);
  });

  it('is written with the commands when the host saves a verified WAV backup', async () => {
    const state: { items: BackupTransfer[] } = { items: [] };
    const intake = new BackupIntake({
      room: ROOM,
      onChange: (next) => {
        state.items = next;
      },
    });
    const ch = fakeChannel(`backup#openmeet-backup-audio-1700000000000-${ROOM}.wav`);
    const payload = Uint8Array.from({ length: 200_000 }, (_, i) => (i * 3 + 7) & 0xff);
    const { frames, sha256 } = await framesFor(payload);

    intake.offer(ch, { peerId: 'p1', name: 'Alice' });
    ch.deliver(JSON.stringify({ type: 'backup_offer', size: payload.byteLength, key: 'key-a' }));
    await flush();
    const folder = fakeFolder();
    await intake.accept(folder, state.items);
    for (const f of frames) ch.deliver(f);
    ch.deliver(
      JSON.stringify({ type: 'recording-finalized', recordingId: 'x', totalBytes: payload.byteLength, sha256 })
    );
    for (let i = 0; i < 12; i++) await flush();

    expect(state.items.map((i) => i.status)).toEqual(['saved']);
    const note = JSON.parse(
      new TextDecoder().decode(folder.files.get(WAV.replace(/\.wav$/, '.json'))!.bytes)
    ) as Note;
    expect(note.file).toBe(WAV);
    expect(note.flac?.encode).toBe(ENCODE);
    expect(note.flac?.check).toBe(CHECK);
  });
});
