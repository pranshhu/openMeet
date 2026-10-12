import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionSummary } from '@/components/SessionSummary';
import { buildSyncReport, type SyncReportInput } from '@/lib/sync-report';

const take: SyncReportInput = {
  recordingId: 'r',
  hostFile: 'host_r.mp4',
  hostWavFile: 'host_r.wav',
  hostStartMs: 1_000_000,
  guests: [
    { slot: 0, name: 'Bob', file: 'guest_r.mp4', wavFile: 'guest_r.wav', startHostMs: 1_001_500, rttMs: 20 },
    { slot: 1, name: 'Carol', file: 'guest2_r.mp4', startHostMs: 1_000_000, rttMs: 20 },
  ],
  screenSegments: [{ file: 'host_screen_r.mp4', offsetMs: 0 }],
  callCopies: [{ file: 'call1_r.m4a', offsetMs: 500, name: 'Bob' }],
};

const HOST_ENCODE = 'ffmpeg -i "host_r.wav" -c:a flac "host_r.flac"';
const HOST_CHECK =
  'ffmpeg -v error -i "host_r.wav" -i "host_r.flac" -map 0:a -c:a pcm_s24le -f md5 - -map 1:a -c:a pcm_s24le -f md5 -';
/** The same command for another file. */
const forFile = (cmd: string, stem: string) => cmd.replace(/host_r/g, stem);
const copyLabel = (file: string) => `${file}: FLAC copy, lossless and smaller`;
const checkLabel = (file: string) =>
  `${file}: check the FLAC copy, and delete the WAV only if its two MD5 lines match`;

interface Flac {
  note: string;
  files: { file: string; encode: string; check: string }[];
}
const flacOf = (input: SyncReportInput) =>
  (JSON.parse(buildSyncReport(input).json) as { flac?: Flac }).flac;

describe('buildSyncReport: FLAC copies of the audio masters', () => {
  it('gives every WAV master, and no other file, an encode and a check command', () => {
    expect(flacOf(take)?.files).toEqual([
      { file: 'host_r.wav', encode: HOST_ENCODE, check: HOST_CHECK },
      { file: 'guest_r.wav', encode: forFile(HOST_ENCODE, 'guest_r'), check: forFile(HOST_CHECK, 'guest_r') },
    ]);
  });

  it('lists both commands of each master in the summary, after every other command', () => {
    const commands = buildSyncReport(take).data.commands;
    expect(commands.slice(-4)).toEqual([
      { label: copyLabel('host_r.wav'), cmd: HOST_ENCODE },
      { label: checkLabel('host_r.wav'), cmd: HOST_CHECK },
      { label: copyLabel('guest_r.wav'), cmd: forFile(HOST_ENCODE, 'guest_r') },
      { label: checkLabel('guest_r.wav'), cmd: forFile(HOST_CHECK, 'guest_r') },
    ]);
    expect(commands.filter((c) => c.cmd.includes('.flac'))).toHaveLength(4);
  });

  it("covers both of the host's audio files after a reload, under labels that differ", () => {
    const resumed: SyncReportInput = {
      ...take,
      hostFile: 'host_r_resumed.mp4',
      hostWavFile: 'host_r_resumed.wav',
      resumed: true,
      hostParts: [
        { name: 'host-ana_r.mp4', offsetMs: 0, kind: 'camera' },
        { name: 'host-ana_r.wav', offsetMs: 0, kind: 'wav' },
        { name: 'host_r_resumed.mp4', offsetMs: 90_000, kind: 'camera' },
        { name: 'host_r_resumed.wav', offsetMs: 90_000, kind: 'wav' },
      ],
    };
    expect(flacOf(resumed)?.files.map((f) => f.file)).toEqual([
      'host_r_resumed.wav',
      'guest_r.wav',
      'host-ana_r.wav',
    ]);
    const labels = buildSyncReport(resumed).data.commands.map((c) => c.label);
    expect(labels).toContain(copyLabel('host-ana_r.wav'));
    expect(labels).toContain(checkLabel('host_r_resumed.wav'));
    // The summary keys each row by its label.
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('writes no section and no row for a take with no audio master', () => {
    const r = buildSyncReport({ ...take, hostWavFile: undefined, guests: take.guests.slice(1) });
    expect('flac' in (JSON.parse(r.json) as object)).toBe(false);
    expect(r.data.commands.some((c) => c.cmd.includes('flac'))).toBe(false);
  });

  it('says that a WAV may be deleted only after its check, and what to do when the check fails', () => {
    const note = flacOf(take)?.note ?? '';
    expect(note).toContain('only then is it safe to delete the WAV');
    expect(note).toContain('keep the WAV and encode again');
    expect(note).toContain('run them before deleting it');
  });

  it('says what a copy and its check show: the same samples in a smaller file, and two MD5 lines', () => {
    const note = flacOf(take)?.note ?? '';
    expect(note).toContain('Optional. openMeet records WAV.');
    expect(note).toContain('the same samples in a smaller file, with the depth, the rate and the channels the WAV has');
    expect(note).toContain('Each check command decodes the WAV and its FLAC and prints two MD5 lines.');
  });

  it('says that equal MD5 lines mean every sample is in the copy, and that a difference keeps the WAV', () => {
    const note = flacOf(take)?.note ?? '';
    expect(note).toContain('When the two lines are the same the FLAC holds every sample of the WAV');
    expect(note).toContain('when they differ, or ffmpeg prints an error');
  });

  it('still gives a WAV that reads as Empty its two rows', () => {
    const checks = new Map([['host_r.wav', { bytes: 0 }]]);
    expect(flacOf({ ...take, checks })?.files[0]).toEqual({
      file: 'host_r.wav',
      encode: HOST_ENCODE,
      check: HOST_CHECK,
    });
  });
});

describe('SessionSummary: FLAC commands from a real report', () => {
  it('shows each command with a copy button of its own, under a label that can wrap', () => {
    const r = buildSyncReport(take);
    render(
      <SessionSummary
        files={r.data.fileList}
        markers={[]}
        warnings={[]}
        integrity={null}
        alignment={null}
        commands={r.data.commands}
        syncReportUrl={null}
        chaptersUrl={null}
        backupUrl={null}
        wavBackupUrl={null}
        downloadNames={{ sync: 'sync.json', chapters: 'chapters.txt', backup: 'backup.mp4', wav: 'backup.wav' }}
        takes={[]}
        onNewTake={vi.fn()}
        onDiscardTake={vi.fn()}
      />
    );
    expect(screen.getByText(HOST_ENCODE)).toBeInTheDocument();
    expect(screen.getByText(forFile(HOST_CHECK, 'guest_r'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Copy: ${copyLabel('host_r.wav')}` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Copy: ${checkLabel('guest_r.wav')}` })).toBeInTheDocument();
    // A file name can be one unbroken run that is wider than the summary's column.
    expect(screen.getByText(copyLabel('host_r.wav')).className).toMatch(/\bbreak-words\b/);
  });
});

describe('the FLAC check and the bit depth', () => {
  it("hashes both files at the masters' bit depth", async () => {
    vi.resetModules();
    vi.doMock('@openmeet/protocol', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@openmeet/protocol')>()),
      WAV_BIT_DEPTH: 32,
    }));
    const { buildSyncReport: build } = await import('@/lib/sync-report');
    const check = (JSON.parse(build(take).json) as { flac: Flac }).flac.files[0]?.check;
    vi.doUnmock('@openmeet/protocol');
    vi.resetModules();
    expect(check).toBe(HOST_CHECK.replace(/pcm_s24le/g, 'pcm_s32le'));
  });
});
