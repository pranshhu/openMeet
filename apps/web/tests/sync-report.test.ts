import { describe, it, expect, vi } from 'vitest';
import { RECORDING_FRAME_RATE } from '@openmeet/protocol';
import { buildSyncReport, formatTimecode, buildChapters, integrityVerdict, buildChatLog, sanitizeText, formatBytes, fileVerdict, type FileCheck, type FileVerdict, type SummaryFile } from '@/lib/sync-report';

describe('buildSyncReport', () => {
  const base = {
    recordingId: 'rec1',
    hostFile: 'host_rec1.mp4',
    hostStartMs: 1_000_000,
  };
  const guests = (startHostMs: number | null, rttMs: number | null) => [
    { slot: 0, file: 'guest_rec1.mp4', startHostMs, rttMs },
  ];

  it('computes a positive guest-after-host offset', () => {
    const r = buildSyncReport({ ...base, guests: guests(1_002_500, 30) });
    expect(r.guestMinusHostMs).toBe(2500);
    expect(r.summary).toContain('+2500 ms');
    const parsed = JSON.parse(r.json);
    expect(parsed.timeline.guestMinusHostMs).toBe(2500);
    expect(parsed.alignment).toContain('AFTER host');
    // #3 seekability: lossless remux command for both files.
    expect(parsed.seekability.remuxHost).toContain('-c copy');
    expect(parsed.seekability.remuxHost).toContain('-movflags +faststart');
    expect(parsed.seekability.remuxHost).toContain('host_rec1.mp4');
    expect(parsed.seekability.remuxGuest).toContain('guest_rec1_seekable.mp4');
    // Re-tag to avc1 for editors regardless of which codec (avc1 or avc3) was recorded.
    expect(parsed.seekability.remuxHost).toContain('-tag:v avc1');
    expect(parsed.seekability.remuxGuest).toContain('-tag:v avc1');
  });

  it('computes a negative guest-before-host offset', () => {
    const r = buildSyncReport({ ...base, guests: guests(999_600, 12) });
    expect(r.guestMinusHostMs).toBe(-400);
    expect(JSON.parse(r.json).alignment).toContain('BEFORE host');
  });

  it('degrades when clock sync was unavailable', () => {
    const r = buildSyncReport({ ...base, guests: guests(null, null) });
    expect(r.guestMinusHostMs).toBeNull();
    expect(r.summary.toLowerCase()).toContain('waveform');
    expect(JSON.parse(r.json).timeline.guestStartUnixMs).toBeNull();
  });

  it('includes backupNote explaining that offset does not apply to guest backup', () => {
    const r = buildSyncReport({ ...base, guests: guests(1_002_500, 30) });
    const parsed = JSON.parse(r.json);
    expect(parsed.backupNote).toBe(
      "The offset applies to guest_* files written by the host, not to a participant's own backup copy, which started at a different instant."
    );
    expect(r.data.backupNote).toBe(
      "The offset applies to guest_* files written by the host, not to a participant's own backup copy, which started at a different instant."
    );
  });
});

describe('chapter markers', () => {
  const m = (atMs: number, label: string, from: 'host' | 'guest' = 'host') => ({ atMs, label, from });

  it('formats timecodes the way YouTube parses them', () => {
    expect(formatTimecode(0)).toBe('0:00');
    expect(formatTimecode(9_000)).toBe('0:09');
    expect(formatTimecode(83_000)).toBe('1:23');
    expect(formatTimecode(3_723_000)).toBe('1:02:03'); // hours only appear past 1h
  });

  it('sorts markers by time regardless of arrival order', () => {
    expect(buildChapters([m(60_000, 'Second'), m(5_000, 'First')]))
      .toBe('0:00 Start\n0:05 First\n1:00 Second\n');
  });

  // YouTube silently ignores the entire chapter list unless it starts at 0:00,
  // and this output is meant to be pasted without editing.
  it('synthesises a 0:00 entry when the first marker is later', () => {
    expect(buildChapters([m(45_000, 'Intro ends')])).toBe('0:00 Start\n0:45 Intro ends\n');
  });

  it('does not synthesise one when a marker is already at the start', () => {
    expect(buildChapters([m(0, 'Cold open')])).toBe('0:00 Cold open\n');
  });

  it('falls back to a generic label rather than emitting a bare timecode', () => {
    expect(buildChapters([m(0, '')])).toBe('0:00 Marker\n');
  });

  it('falls back to Marker when a label is made only of control characters', () => {
    expect(buildChapters([m(0, '\n')])).toBe('0:00 Marker\n');
  });

  it('sanitises line breaks in marker labels to yield exactly one chapter line', () => {
    const chapters = buildChapters([m(0, 'Intro\n45:00 Host admits everything')]);
    expect(chapters).toBe('0:00 Intro 45:00 Host admits everything\n');
    expect(chapters.trim().split('\n')).toHaveLength(1);
  });

  it('returns empty for no markers', () => {
    expect(buildChapters([])).toBe('');
  });

  it('includes markers in the sync sidecar', () => {
    const r = buildSyncReport({
      recordingId: 'r1', hostFile: 'h.mp4', hostStartMs: 1000,
      guests: [{ slot: 0, file: 'g.mp4', startHostMs: 1200, rttMs: 20 }],
      markers: [m(90_000, 'Topic two', 'guest')],
    });
    const parsed = JSON.parse(r.json) as { markers: { at: string; label: string; from: string }[] };
    expect(parsed.markers).toEqual([{ at: '1:30', atMs: 90_000, label: 'Topic two', from: 'guest' }]);
    expect(r.chapters).toContain('1:30 Topic two');
  });
});

describe('post-session report', () => {
  const base = { recordingId: 'r', hostFile: 'host_r.mp4', hostStartMs: 0 };
  const guest = { slot: 0, file: 'guest_r.mp4', startHostMs: 0, rttMs: 10 };

  it('confirms integrity when the two digests agree', () => {
    expect(integrityVerdict('abc', 'abc')).toEqual({
      ok: true,
      text: 'Integrity verified — bytes written match bytes sent (sha256).',
    });
  });

  it('shouts when they disagree and points at the backup', () => {
    const v = integrityVerdict('abc', 'def');
    expect(v.ok).toBe(false);
    expect(v.text).toContain('MISMATCH');
    expect(v.text).toMatch(/backup/i);
  });

  it('does not claim verification when a digest is missing', () => {
    expect(integrityVerdict('abc', undefined).ok).toBe(false);
    expect(integrityVerdict(undefined, undefined).ok).toBe(false);
  });

  // MP4 cannot carry linear PCM, so muxing into .mp4 would silently re-encode
  // and destroy exactly what the WAV exists to preserve.
  it('combines audio into .mov, losslessly', () => {
    const r = buildSyncReport({
      ...base, hostWavFile: 'host_r.wav', guests: [guest],
    });
    const j = JSON.parse(r.json) as { combine: { host: string } };
    expect(j.combine.host).toContain('_master.mov');
    expect(j.combine.host).toContain('-c:a copy');
    expect(j.combine.host).not.toContain('aac');
    expect(j.combine.host).toContain('-tag:v avc1');
  });

  it('lists screen segments and gives each a remux command', () => {
    const r = buildSyncReport({
      ...base, guests: [guest],
      screenSegments: [{ file: 'host_screen_r.mp4', offsetMs: 0 }, { file: 'host_screen_r_2.mp4', offsetMs: 0 }],
    });
    const j = JSON.parse(r.json) as { screenFiles: string[]; seekability: { remuxScreen: string[] } };
    expect(j.screenFiles).toHaveLength(2);
    expect(j.seekability.remuxScreen).toHaveLength(2);
  });

  it('collects the things that could have gone wrong into one warnings list', () => {
    const r = buildSyncReport({
      ...base,
      guests: [{ ...guest, startHostMs: null, drained: false }],
    });
    const j = JSON.parse(r.json) as { warnings: string[] };
    expect(j.warnings).toHaveLength(3); // roll-up + undrained + no clock sync
    expect(j.warnings.join(' ')).toMatch(/Not every file is complete/);
    expect(j.warnings.join(' ')).toMatch(/drain window/);
  });

  it('has no warnings on a clean session', () => {
    const r = buildSyncReport({
      ...base,
      guests: [{ ...guest, drained: true }],
      checks: new Map<string, FileCheck>([
        ['host_r.mp4', { bytes: 10 }],
        [
          'guest_r.mp4',
          {
            bytes: 10,
            received: { finalized: true, abandoned: false, sha256Sent: 'a', sha256Written: 'a' },
          },
        ],
      ]),
    });
    const parsed = JSON.parse(r.json) as { integrity: string; warnings: string[] };
    expect(r.data.integrity).toEqual({ ok: true, text: 'Every file is complete.' });
    expect(parsed.integrity).toBe('Every file is complete.');
    expect(parsed.warnings).toEqual([]);
  });

  it('warns once with the counts when one file is not complete', () => {
    const r = buildSyncReport({
      ...base,
      hostWavFile: 'host_r.wav',
      guests: [{ ...guest, wavFile: 'guest_r.wav' }],
      checks: new Map<string, FileCheck>([
        ['host_r.mp4', { bytes: 10 }],
        [
          'guest_r.mp4',
          {
            bytes: 10,
            received: { finalized: true, abandoned: false, sha256Sent: 'a', sha256Written: 'a' },
          },
        ],
        ['host_r.wav', { bytes: 10 }],
        ['guest_r.wav', { bytes: 10, received: { finalized: false, abandoned: false, sha256Written: 'a' } }],
      ]),
    });
    const rollUp = "Not every file is complete and verified (1 of 4). Each file's verdict says why.";
    const parsed = JSON.parse(r.json) as { integrity: string; warnings: string[] };
    expect(r.data.warnings).toEqual([rollUp]);
    expect(parsed.warnings).toEqual([rollUp]);
    expect(r.data.integrity.ok).toBe(false);
    expect(parsed.integrity).toBe(rollUp);
  });

  it('writes the camera file’s verdict as the guest’s integrity', () => {
    const camera = (received: NonNullable<FileCheck['received']>) =>
      buildSyncReport({
        ...base,
        guests: [{ ...guest, name: 'Bob' }],
        checks: new Map<string, FileCheck>([['guest_r.mp4', { bytes: 10, received }]]),
      });
    const matched = camera({ finalized: true, abandoned: false, sha256Sent: 'a', sha256Written: 'a' });
    expect((JSON.parse(matched.json) as { guests: { integrity: unknown }[] }).guests[0]?.integrity).toEqual({
      ok: true,
      text: 'Complete. Matches what Bob sent (SHA-256).',
    });

    const behind = camera({ finalized: true, abandoned: true, sha256Written: 'a' });
    const integrity = (JSON.parse(behind.json) as { guests: { integrity: { ok: boolean; text: string } }[] })
      .guests[0]?.integrity;
    expect(integrity?.ok).toBe(false);
    expect(integrity?.text).toContain('fell too far behind');
  });

  it('does not call a camera file ok when it was not verified', () => {
    const integrityOf = (checks?: Map<string, FileCheck>) =>
      (JSON.parse(buildSyncReport({ ...base, guests: [{ ...guest, name: 'Bob' }], ...(checks ? { checks } : {}) }).json) as {
        guests: { integrity: { ok: boolean; text: string } }[];
      }).guests[0]?.integrity;
    expect(integrityOf()).toEqual({ ok: false, text: 'Not verified. This file was not checked.' });
    expect(
      integrityOf(new Map([['guest_r.mp4', { bytes: 10, received: { finalized: true, abandoned: false, sha256Written: 'a' } }]]))
    ).toEqual({ ok: false, text: 'Complete, not verified. No checksum arrived from Bob to compare.' });
  });

  it('safely handles hostile participant names in guest camera integrity', () => {
    const hostileNames = [
      42 as never,
      1e20 as never,
      NaN as never,
      -42 as never,
      '',
      {} as never,
      '  ',
      '\n\r\t"evil\'\n',
    ];
    for (const name of hostileNames) {
      const r = buildSyncReport({
        ...base,
        guests: [{ ...guest, name }],
        checks: new Map<string, FileCheck>([
          ['guest_r.mp4', { bytes: 10, received: { finalized: true, abandoned: false, sha256Sent: 'a', sha256Written: 'a' } }],
        ]),
      });
      const parsed = JSON.parse(r.json) as { guests: { integrity: { ok: boolean; text: string } }[] };
      expect(parsed.guests[0]?.integrity.ok).toBe(true);
      expect(typeof parsed.guests[0]?.integrity.text).toBe('string');
      expect(parsed.guests[0]?.integrity.text).not.toContain('\n');
    }
  });

  it('covers multiple guests (2 guests) with files, alignment, integrity, and commands', () => {
    const r = buildSyncReport({
      recordingId: 'r_multi',
      hostFile: 'host_r.mp4',
      hostStartMs: 1_000_000,
      hostWavFile: 'host_r.wav',
      guests: [
        {
          slot: 0,
          name: 'Bob',
          file: 'guest_r.mp4',
          wavFile: 'guest_r.wav',
          startHostMs: 1_001_500,
          rttMs: 20,
        },
        {
          slot: 1,
          name: 'Carol',
          file: 'guest2_r.mp4',
          wavFile: 'guest2_r.wav',
          startHostMs: 1_003_200,
          rttMs: 24,
        },
      ],
    });

    const parsed = JSON.parse(r.json) as {
      files: Record<string, string>;
      audioMasters: Record<string, string | null>;
      seekability: { remuxHost: string; remuxGuest: string; remuxGuest2?: string };
      combine: { host?: string; guest?: string; guest2?: string };
      guests: { slot: number; name?: string; file: string; wavFile?: string | null; offsetMs: number | null; integrity: { ok: boolean } }[];
    };

    expect(parsed.files.host).toBe('host_r.mp4');
    expect(parsed.files.guest).toBe('guest_r.mp4');
    expect(parsed.files.guest2).toBe('guest2_r.mp4');
    expect(parsed.audioMasters.host).toBe('host_r.wav');
    expect(parsed.audioMasters.guest).toBe('guest_r.wav');
    expect(parsed.audioMasters.guest2).toBe('guest2_r.wav');

    expect(parsed.guests).toHaveLength(2);
    expect(parsed.guests[0]).toMatchObject({ name: 'Bob', file: 'guest_r.mp4', offsetMs: 1500 });
    expect(parsed.guests[1]).toMatchObject({ name: 'Carol', file: 'guest2_r.mp4', offsetMs: 3200 });

    expect(parsed.seekability.remuxGuest2).toContain('guest2_r_seekable.mp4');
    expect(parsed.combine.guest2).toContain('guest2_r');

    expect(r.data.fileList.map((f) => f.name)).toEqual([
      'host_r.mp4',
      'guest_r.mp4',
      'guest2_r.mp4',
      'host_r.wav',
      'guest_r.wav',
      'guest2_r.wav',
    ]);
  });

  // "No WAV master" is for a guest whose browser never opened a WAV at all
  // (Safari). One that was opened is a file in the folder, empty or not.
  it('omits the audio master for a guest with no WAV writer and notes "no WAV master for <name>"', () => {
    const r = buildSyncReport({
      recordingId: 'r_nowav',
      hostFile: 'host_r.mp4',
      hostStartMs: 1_000_000,
      hostWavFile: 'host_r.wav',
      guests: [
        {
          slot: 0,
          name: 'Bob',
          file: 'guest_r.mp4',
          noWav: true,
          startHostMs: 1_001_000,
          rttMs: null,
        },
      ],
    });

    const parsed = JSON.parse(r.json) as {
      audioMasters: { host: string | null; guest: string | null };
      combine: { host?: string; guest?: string };
      warnings: string[];
    };

    expect(parsed.audioMasters.guest).toBeNull();
    expect(parsed.combine.guest).toBeUndefined();
    expect(r.data.commands.some((c) => c.label.includes('Bob') && c.label.includes('audio master'))).toBe(false);
    expect(parsed.warnings.some((w) => w.includes('no WAV master for Bob'))).toBe(true);
    expect(r.data.warnings.some((w) => w.includes('no WAV master for Bob'))).toBe(true);
    expect(r.data.fileList.some((f) => f.name.includes('.wav') && f.name.includes('guest'))).toBe(false);
  });

  it('lists a guest WAV writer that received nothing with its size, verdict and verification entry', () => {
    const r = buildSyncReport({
      recordingId: 'r_emptywav',
      hostFile: 'host_r.mp4',
      hostStartMs: 1_000_000,
      guests: [
        {
          slot: 0,
          name: 'Bob',
          file: 'guest_r.mp4',
          wavFile: 'guest_r.wav',
          startHostMs: 1_001_000,
          rttMs: null,
        },
      ],
      checks: new Map<string, FileCheck>([
        ['guest_r.wav', { bytes: 0, received: { finalized: false, abandoned: false, sha256Written: 'a' } }],
      ]),
    });

    const parsed = JSON.parse(r.json) as {
      audioMasters: { guest: string | null };
      verification: { file: string; bytes: number | null; status?: string }[];
      warnings: string[];
    };

    expect(parsed.audioMasters.guest).toBe('guest_r.wav');
    expect(parsed.warnings.some((w) => w.includes('no WAV master'))).toBe(false);
    expect(r.data.fileList.find((f) => f.name === 'guest_r.wav')).toMatchObject({
      kind: 'audio',
      bytes: 0,
      verdict: {
        status: 'incomplete',
        text: 'Empty. Nothing arrived from Bob. If they were recording, ask them for the backup their browser kept; it is listed in the lobby on their device.',
      },
    });
    expect(parsed.verification).toContainEqual(
      expect.objectContaining({ file: 'guest_r.wav', bytes: 0, status: 'incomplete' })
    );
  });

  it('records start offset for screen segments relative to host recording start', () => {
    const r = buildSyncReport({
      recordingId: 'r_screen',
      hostFile: 'host_r.mp4',
      hostStartMs: 1_000_000,
      guests: [{ slot: 0, file: 'guest_r.mp4', startHostMs: null, rttMs: null }],
      screenSegments: [
        { file: 'host_screen_r.mp4', offsetMs: 5000 },
        { file: 'guest_screen_r_2.mp4', offsetMs: 27000 },
      ],
    });

    const parsed = JSON.parse(r.json) as {
      screenFiles: string[];
      screenSegments: { file: string; offsetMs: number }[];
    };

    expect(parsed.screenFiles).toEqual(['host_screen_r.mp4', 'guest_screen_r_2.mp4']);
    expect(parsed.screenSegments).toEqual([
      { file: 'host_screen_r.mp4', offsetMs: 5000 },
      { file: 'guest_screen_r_2.mp4', offsetMs: 27000 },
    ]);

    const screenFiles = r.data.fileList.filter((f) => f.kind === 'screen');
    expect(screenFiles).toHaveLength(2);
    expect(screenFiles[0]).toMatchObject({ name: 'host_screen_r.mp4', detail: '+5000ms' });
    expect(screenFiles[1]).toMatchObject({ name: 'guest_screen_r_2.mp4', detail: '+27000ms' });
  });

  it('names the sharer in screen segments and summary file detail', () => {
    const r = buildSyncReport({
      recordingId: 'r_sharer',
      hostFile: 'host_r.mp4',
      hostStartMs: 1_000_000,
      guests: [{ slot: 0, name: 'Alice', file: 'guest_r.mp4', startHostMs: null, rttMs: null }],
      screenSegments: [
        { file: 'host_screen_r.mp4', offsetMs: 5000, sharer: 'Host' },
        { file: 'guest_screen_r_2.mp4', offsetMs: 27000, sharer: 'Alice' },
      ],
    });

    const parsed = JSON.parse(r.json) as {
      screenSegments: { file: string; offsetMs: number; sharer?: string }[];
      timeline: { screenSegments: { file: string; offsetMs: number; sharer?: string }[] };
    };

    expect(parsed.screenSegments[0]?.sharer).toBe('Host');
    expect(parsed.screenSegments[1]?.sharer).toBe('Alice');
    expect(parsed.timeline.screenSegments[0]?.sharer).toBe('Host');
    expect(parsed.timeline.screenSegments[1]?.sharer).toBe('Alice');

    const screenFiles = r.data.fileList.filter((f) => f.kind === 'screen');
    expect(screenFiles[0]?.detail).toContain('Host');
    expect(screenFiles[0]?.detail).toContain('+5000ms');
    expect(screenFiles[1]?.detail).toContain('Alice');
    expect(screenFiles[1]?.detail).toContain('+27000ms');
  });

  it('omits host file from files and fileList when hostFile is not provided', () => {
    const r = buildSyncReport({
      recordingId: 'r_nohost',
      hostStartMs: 1_000_000,
      guests: [{ slot: 0, name: 'Alice', file: 'guest_r.mp4', startHostMs: null, rttMs: null }],
      screenSegments: [
        { file: 'guest_screen_r.mp4', offsetMs: 1000, sharer: 'Alice' },
      ],
    });

    const parsed = JSON.parse(r.json) as {
      files: Record<string, string>;
      seekability: Record<string, unknown>;
    };

    expect(parsed.files.host).toBeUndefined();
    expect(parsed.seekability.remuxHost).toBeUndefined();
    expect(r.data.fileList.some((f) => f.name.startsWith('host_'))).toBe(false);
  });

  // Slots are sparse when a guest's channel never arrived: the timeline must
  // read each guest's own clock data, not whatever sits at that array index.
  it('reads each guest start and RTT from that guest when slots are not dense', () => {
    const r = buildSyncReport({
      ...base,
      guests: [
        { slot: 0, file: 'guest_r.mp4', startHostMs: 1_000, rttMs: 5 },
        { slot: 2, name: 'Dan', file: 'guest3_r.mp4', startHostMs: 3_000, rttMs: 7 },
      ],
    });
    const j = JSON.parse(r.json) as { timeline: { guests: { file: string; startUnixMs: number | null; rttMs: number | null }[] } };
    expect(j.timeline.guests[1]).toMatchObject({ file: 'guest3_r.mp4', startUnixMs: 3_000, rttMs: 7 });
  });

  it('keeps the two-person keys editors and scripts already read', () => {
    const r = buildSyncReport({
      ...base, hostWavFile: 'host_r.wav',
      guests: [{ ...guest, wavFile: 'guest_r.wav' }],
    });
    const j = JSON.parse(r.json);
    expect(j.files).toEqual({ host: 'host_r.mp4', guest: 'guest_r.mp4' });
    expect(Object.keys(j.timeline)).toEqual(['hostStartUnixMs', 'guestStartUnixMs', 'guestMinusHostMs', 'clockSyncRttMs']);
    expect(j.audioMasters).toMatchObject({ host: 'host_r.wav', guest: 'guest_r.wav' });
    expect(Object.keys(j.seekability)).toEqual(['note', 'remuxHost', 'remuxGuest']);
    expect(Object.keys(j.combine)).toEqual(['note', 'host', 'guest']);
  });

  it('marks an abandoned or timed out guest file and says so in its verdict', () => {
    const r = buildSyncReport({
      ...base,
      guests: [
        { slot: 0, name: 'Bob', file: 'guest_r.mp4', startHostMs: 1_000, rttMs: 5, abandoned: true },
      ],
      checks: new Map<string, FileCheck>([
        ['host_r.mp4', { bytes: 10 }],
        ['guest_r.mp4', { bytes: 10, received: { finalized: true, abandoned: true, sha256Written: 'x' } }],
      ]),
    });
    const parsed = JSON.parse(r.json);
    expect(parsed.guests[0].abandoned).toBe(true);
    expect(parsed.guests[0].endedEarly).toBe(true);

    const guestFile = r.data.fileList.find((f) => f.name === 'guest_r.mp4');
    expect(guestFile?.verdict?.status).toBe('incomplete');
    expect(guestFile?.verdict?.text).toMatch(/backup/);
    expect(guestFile?.detail).toBeUndefined();
    expect(r.data.warnings.some((w) => w.includes('ended early'))).toBe(false);
  });

  it('keeps an endedEarly screen segment in the JSON and says so in its verdict', () => {
    const r = buildSyncReport({
      ...base,
      guests: [guest],
      screenSegments: [
        { file: 'guest_screen_r.mp4', offsetMs: 3400, endedEarly: true },
      ],
      checks: new Map<string, FileCheck>([
        ['guest_screen_r.mp4', { bytes: 10, received: { finalized: false, abandoned: false, sha256Written: 'x' } }],
      ]),
    });
    const parsed = JSON.parse(r.json);
    expect(parsed.screenSegments[0].endedEarly).toBe(true);
    expect(parsed.timeline.screenSegments[0].endedEarly).toBe(true);

    const screenFile = r.data.fileList.find((f) => f.kind === 'screen');
    expect(screenFile?.verdict?.status).toBe('incomplete');
    expect(screenFile?.verdict?.text).toMatch(/backup/);
    expect(screenFile?.detail).toBe('+3400ms');
    expect(r.data.warnings.some((w) => w.includes('ended early'))).toBe(false);
  });

  it('lists a call-audio copy with its offset and whose audio it is', () => {
    const r = buildSyncReport({
      ...base,
      guests: [],
      callCopies: [{ file: 'call1_r.m4a', offsetMs: 1200, name: 'Dana' }],
    });
    expect(r.data.fileList.at(-1)).toMatchObject({
      name: 'call1_r.m4a',
      kind: 'call',
      detail: 'Dana, +1200ms',
      participant: 'Dana',
    });
    expect((JSON.parse(r.json) as { callCopies: { files: unknown[] } }).callCopies.files).toEqual([
      { file: 'call1_r.m4a', offsetMs: 1200, name: 'Dana' },
    ]);
  });

  it('lists a copy the guest never named without a participant', () => {
    const r = buildSyncReport({
      ...base,
      guests: [],
      callCopies: [{ file: 'call1_r.m4a', offsetMs: 0 }],
    });
    const entry = r.data.fileList.at(-1)!;
    expect(entry).toMatchObject({ name: 'call1_r.m4a', kind: 'call', detail: '+0ms' });
    expect(entry).not.toHaveProperty('participant');
    expect((JSON.parse(r.json) as { callCopies: { files: object[] } }).callCopies.files[0]).not.toHaveProperty('name');
  });

  it('leaves the sync file and the file list unchanged when no copy was recorded', () => {
    const without = buildSyncReport({ ...base, guests: [] });
    const empty = buildSyncReport({ ...base, guests: [], callCopies: [] });
    expect(empty.json).toBe(without.json);
    expect(JSON.parse(without.json)).not.toHaveProperty('callCopies');
    expect(empty.data.fileList).toEqual(without.data.fileList);
  });

  it('says in the copy note when the take reached its file limit, and nothing when it did not', () => {
    const callCopies = [{ file: 'call1_r.m4a', offsetMs: 0 }];
    const capped = buildSyncReport({ ...base, guests: [], callCopies, callCopiesCapped: true });
    const plain = buildSyncReport({ ...base, guests: [], callCopies });
    expect((JSON.parse(capped.json) as { callCopies: { note: string } }).callCopies.note).toMatch(
      /file limit, so later stretches have no copy\.$/
    );
    expect((JSON.parse(plain.json) as { callCopies: { note: string } }).callCopies.note).not.toMatch(
      /file limit/
    );
  });

  it('writes the copy note when the cap left no copy to list', () => {
    const r = buildSyncReport({ ...base, guests: [], callCopies: [], callCopiesCapped: true });
    const callCopies = (JSON.parse(r.json) as { callCopies: { files: unknown[]; note: string } }).callCopies;
    expect(callCopies.files).toEqual([]);
    expect(callCopies.note).toMatch(/file limit, so later stretches have no copy\.$/);
  });

  it('sanitises a hostile copy name and drops one that is not usable', () => {
    const r = buildSyncReport({
      ...base,
      guests: [],
      callCopies: [
        { file: 'call1_r.m4a', offsetMs: 0, name: 'Da\nna\u202E x' },
        { file: 'call2_r.m4a', offsetMs: 0, name: 42 as never },
        { file: 'call3_r.m4a', offsetMs: 0, name: '   ' },
      ],
    });
    const files = (JSON.parse(r.json) as { callCopies: { files: { name?: string }[] } }).callCopies.files;
    expect(files[0]).toEqual({ file: 'call1_r.m4a', offsetMs: 0, name: 'Da na x' });
    const copies = r.data.fileList.filter((f) => f.kind === 'call');
    expect(copies[0]?.detail).toBe('Da na x, +0ms');
    expect(files[1]).not.toHaveProperty('name');
    expect(copies[1]?.detail).toBe('+0ms');
    expect(files[2]).not.toHaveProperty('name');
    expect(copies[2]?.detail).toBe('+0ms');
  });

  it('leads the warnings with the interrupted notice, leaving the others alone', () => {
    // Removal that must fail this test: pushing the notice anywhere but as the
    // first warning, or pushing it when the input does not ask for it.
    const notice =
      'This recording was interrupted — the files were rebuilt from the browser’s copy after it closed.';
    const input = {
      ...base,
      guests: [
        { slot: 0, name: 'Bob', file: 'guest_rec1.mp4', startHostMs: 1_000_000, rttMs: 5, noWav: true, endedEarly: true },
      ],
    };
    const plain = buildSyncReport(input);
    const rebuilt = buildSyncReport({ ...input, interrupted: true });

    expect(plain.data.warnings).toContain('no WAV master for Bob');
    expect(plain.data.warnings.some((w) => w === notice)).toBe(false);
    expect(rebuilt.data.warnings[0]).toBe(notice);
    expect(rebuilt.data.warnings.slice(1)).toEqual(plain.data.warnings);
    expect((JSON.parse(rebuilt.json) as { warnings: string[] }).warnings[0]).toBe(notice);
  });
});

describe('a resumed take', () => {
  const RELOAD =
    'This recording continued after a browser reload, so the host\'s own track is in two files. ' +
    "Each one's offset from the start is in hostParts.";
  const NOT_VERIFIED =
    'Not verified — this file continued after a browser reload, so no single digest covers it.';
  const hostParts = [
    { name: 'host_r.mp4', offsetMs: 0, kind: 'camera' as const },
    { name: 'host_r_resumed.mp4', offsetMs: 90_000, kind: 'camera' as const },
  ];
  const input = {
    recordingId: 'r',
    hostFile: 'host_r_resumed.mp4',
    hostStartMs: 1_000_000,
    resumed: true,
    hostParts,
    guests: [{ slot: 0, name: 'Bob', file: 'guest_r.mp4', startHostMs: 1_000_500, rttMs: 10 }],
    checks: new Map<string, FileCheck>([['host_r.mp4', { bytes: 5 }]]),
  };

  it("lists the host's own track once per part, with each part's offset", () => {
    // Removal that must fail this test: dropping the hostParts handling, or
    // keying the extra part off offset 0 instead of off the file name.
    const r = buildSyncReport(input);

    const hostNames = r.data.fileList.map((f) => f.name).filter((n) => n.startsWith('host_r'));
    expect(hostNames).toEqual(['host_r_resumed.mp4', 'host_r.mp4']);
    expect(r.data.fileList.find((f) => f.name === 'host_r.mp4')).toMatchObject({
      kind: 'video',
      detail: 'the part before the reload',
      bytes: 5,
      verdict: { status: 'complete', text: 'Complete. Recorded on this computer.' },
    });
    expect(r.data.fileList.find((f) => f.name === 'host_r_resumed.mp4')).toMatchObject({
      kind: 'video',
      detail: 'continues from 90.000 s',
    });

    const j = JSON.parse(r.json) as {
      hostParts: { file: string; offsetMs: number; kind: string }[];
      verification: { file: string }[];
      aligned: { files: { file: string; padMs: number | null; cmd?: string }[] };
    };
    expect(j.hostParts).toEqual([
      { file: 'host_r.mp4', offsetMs: 0, kind: 'camera' },
      { file: 'host_r_resumed.mp4', offsetMs: 90_000, kind: 'camera' },
    ]);
    expect(j.verification.map((v) => v.file)).toEqual([
      'host_r_resumed.mp4',
      'guest_r.mp4',
      'host_r.mp4',
    ]);
    expect(j.aligned.files).toEqual([
      {
        file: 'host_r_resumed.mp4',
        padMs: 90_000,
        cmd: 'ffmpeg -itsoffset 90.000 -i "host_r_resumed.mp4" -c copy -tag:v avc1 -movflags +faststart "host_r_resumed_aligned.mp4"',
      },
      { file: 'host_r.mp4', padMs: 0 },
      {
        file: 'guest_r.mp4',
        padMs: 500,
        cmd: 'ffmpeg -itsoffset 0.500 -i "guest_r.mp4" -c copy -tag:v avc1 -movflags +faststart "guest_r_aligned.mp4"',
      },
    ]);
    expect(r.data.warnings).toContain(RELOAD);
    expect(r.data.commands).toContainEqual({
      label: 'Host: aligned copy of the video (starts 90.000 s in)',
      cmd: 'ffmpeg -itsoffset 90.000 -i "host_r_resumed.mp4" -c copy -tag:v avc1 -movflags +faststart "host_r_resumed_aligned.mp4"',
    });

    // hostParts alone is not a reload: same files, no take-level notice, and
    // the field is absent from sync.json unless there are parts to list.
    const beforeReload = buildSyncReport({
      ...input,
      resumed: undefined,
      hostParts: undefined,
      hostFile: 'host_r.mp4',
    });
    expect(beforeReload.data.warnings.some((w) => w === RELOAD)).toBe(false);
    expect((JSON.parse(beforeReload.json) as { hostParts?: unknown }).hostParts).toBeUndefined();

    // A host file at offset 0 gets no detail row.
    const partAtZero = buildSyncReport({
      ...input,
      resumed: undefined,
      hostFile: 'host_r.mp4',
      hostParts: [{ name: 'host_r.mp4', offsetMs: 0, kind: 'camera' }],
    });
    expect(partAtZero.data.fileList.find((f) => f.name === 'host_r.mp4')?.detail).toBeUndefined();

    // The two take-level lines sit together, interrupted first.
    const rebuilt = buildSyncReport({ ...input, interrupted: true });
    expect(rebuilt.data.warnings[0]).toBe(
      'This recording was interrupted — the files were rebuilt from the browser’s copy after it closed.'
    );
    expect(rebuilt.data.warnings[1]).toBe(RELOAD);
  });

  it("gives each WAV part its own offset, kind and aligned copy", () => {
    // Removal that must fail this test: ignoring the WAV part's own offset (or
    // its kind), which would list it as video and align it at zero.
    const r = buildSyncReport({
      recordingId: 'r',
      hostFile: 'host_r_resumed.mp4',
      hostWavFile: 'host_r_resumed.wav',
      hostStartMs: 1_000_000,
      resumed: true,
      hostParts: [
        { name: 'host_r.mp4', offsetMs: 0, kind: 'camera' },
        { name: 'host_r_resumed.mp4', offsetMs: 90_000, kind: 'camera' },
        { name: 'host_r.wav', offsetMs: 0, kind: 'wav' },
        { name: 'host_r_resumed.wav', offsetMs: 90_000, kind: 'wav' },
      ],
      guests: [],
    });

    expect(r.data.fileList.find((f) => f.name === 'host_r.wav')).toMatchObject({
      kind: 'audio',
      detail: 'the part before the reload',
    });
    expect(r.data.fileList.find((f) => f.name === 'host_r_resumed.wav')).toMatchObject({
      kind: 'audio',
      detail: 'continues from 90.000 s',
    });

    const aligned = (
      JSON.parse(r.json) as {
        aligned: { files: { file: string; padMs: number | null; cmd?: string }[] };
      }
    ).aligned.files;
    expect(aligned).toEqual([
      {
        file: 'host_r_resumed.mp4',
        padMs: 90_000,
        cmd: 'ffmpeg -itsoffset 90.000 -i "host_r_resumed.mp4" -c copy -tag:v avc1 -movflags +faststart "host_r_resumed_aligned.mp4"',
      },
      {
        file: 'host_r_resumed.wav',
        padMs: 90_000,
        cmd: 'ffmpeg -i "host_r_resumed.wav" -af "adelay=90000:all=1" -c:a pcm_s24le -rf64 auto "host_r_resumed_aligned.wav"',
      },
      { file: 'host_r.mp4', padMs: 0 },
      { file: 'host_r.wav', padMs: 0 },
    ]);
  });

  it('says why a resumed guest file is not verified', () => {
    // Removal that must fail this test: dropping the resumed verdict branch,
    // which brings the generic not-checked sentence back.
    const r = buildSyncReport({
      recordingId: 'r',
      hostFile: 'host_r.mp4',
      hostStartMs: 1_000_000,
      guests: [{ slot: 0, file: 'guest_rec1.mp4', startHostMs: 1_000_500, rttMs: 10, resumed: true }],
      checks: new Map<string, FileCheck>([['host_r.mp4', { bytes: 10 }]]),
    });

    expect(r.data.guests?.[0]?.integrity).toEqual({ ok: false, text: NOT_VERIFIED });
    expect(r.data.warnings).toContain(NOT_VERIFIED);
    expect(r.data.warnings.join(' ')).not.toContain('one of the digests is missing');
    expect(r.data.integrity).toEqual({
      ok: false,
      text: "Not every file is complete and verified (1 of 2). Each file's verdict says why.",
    });
    expect((JSON.parse(r.json) as { guests: { integrity: { text: string } }[] }).guests[0]?.integrity.text)
      .toBe(NOT_VERIFIED);
  });

  it('cleans a participant name before it reaches the report', () => {
    // Removal that must fail this test: using g.name and s.sharer raw, the way
    // the call-copy names would be if they skipped sanitizeText.
    const r = buildSyncReport({
      recordingId: 'r',
      hostFile: 'host_r.mp4',
      hostStartMs: 1_000_000,
      guests: [
        {
          slot: 0,
          name: 'Sam\n\u202Eevil',
          file: 'guest_evil.mp4',
          startHostMs: 1_000_500,
          rttMs: 10,
          drained: false,
        },
        { slot: 1, name: '   ', file: 'guest_blank.mp4', startHostMs: 1_000_500, rttMs: 10 },
      ],
      screenSegments: [{ file: 'host_screen_evil.mp4', offsetMs: 1000, sharer: 'Ann\n\u202Eevil' }],
    });

    for (const w of r.data.warnings) {
      expect(w).not.toContain('\n');
      expect(w).not.toContain('\u202E');
    }
    expect(r.data.warnings).toContain(
      'Sam evil could not finish sending within the drain window — the file may be short. ' +
        'Use the guest backup for the tail.'
    );
    expect(r.data.fileList.find((f) => f.name === 'guest_evil.mp4')?.participant).toBe('Sam evil');
    expect(r.data.fileList.find((f) => f.name === 'guest_blank.mp4')?.participant).toBeUndefined();
    expect(r.data.fileList.find((f) => f.name === 'host_screen_evil.mp4')).toMatchObject({
      participant: 'Ann evil',
      detail: 'Ann evil, +1000ms',
    });

    const j = JSON.parse(r.json) as {
      guests: { name?: string }[];
      timeline: { guests: { name?: string }[] };
    };
    expect(j.guests.map((g) => g.name)).toEqual(['Sam evil', undefined]);
    expect(j.timeline.guests.map((g) => g.name)).toEqual(['Sam evil', undefined]);
  });

  it('gives an extra resumed part and an extra WAV part their offsets and commands', () => {
    // Removal that must fail this test: ignoring offsetMs > 0 for extra host parts
    // (which would mark them as 'the part before the reload'), or failing to pass wav
    // to align for extra parts (which would generate a video -itsoffset instead of adelay).
    const r = buildSyncReport({
      recordingId: 'r',
      hostFile: 'host_r_resumed2.mp4',
      hostWavFile: 'host_r_resumed2.wav',
      hostStartMs: 1_000_000,
      resumed: true,
      hostParts: [
        { name: 'host_r.mp4', offsetMs: 0, kind: 'camera' },
        { name: 'host_r_part1.mp4', offsetMs: 40_000, kind: 'camera' },
        { name: 'host_r_resumed2.mp4', offsetMs: 80_000, kind: 'camera' },
        { name: 'host_r_part1.wav', offsetMs: 40_000, kind: 'wav' },
        { name: 'host_r_resumed2.wav', offsetMs: 80_000, kind: 'wav' },
      ],
      guests: [],
    });

    expect(r.data.fileList.find((f) => f.name === 'host_r_part1.mp4')?.detail).toBe('continues from 40.000 s');
    expect(r.data.fileList.find((f) => f.name === 'host_r_part1.wav')?.detail).toBe('continues from 40.000 s');
    expect(r.data.fileList.find((f) => f.name === 'host_r.mp4')?.detail).toBe('the part before the reload');

    const aligned = (
      JSON.parse(r.json) as {
        aligned: { files: { file: string; padMs: number | null; cmd?: string }[] };
      }
    ).aligned.files;
    expect(aligned.find((f) => f.file === 'host_r_part1.wav')?.cmd).toContain('adelay=40000');
  });

  it('prefixes warning with guest name when one of multiple guests is resumed', () => {
    // Removal that must fail this test: omitting displayName prefix in the resumed warning
    // when guests.length > 1.
    const r = buildSyncReport({
      recordingId: 'r',
      hostFile: 'host_r.mp4',
      hostStartMs: 1_000_000,
      guests: [
        { slot: 0, name: 'Alice', file: 'guest_a.mp4', startHostMs: 1_000_500, rttMs: 10, resumed: true },
        { slot: 1, name: 'Bob', file: 'guest_b.mp4', startHostMs: 1_000_500, rttMs: 10 },
      ],
      checks: new Map<string, FileCheck>([['host_r.mp4', { bytes: 10 }]]),
    });

    expect(r.data.warnings).toContain(`Alice: ${NOT_VERIFIED}`);
    expect(r.data.warnings).not.toContain(NOT_VERIFIED);
  });
});

describe('buildChatLog', () => {
  const opts = { startMs: 10_000, endMs: 30_000, localName: 'Ana' };

  it('filters messages to the [startMs, endMs] window', () => {
    const messages = [
      { from: 'guest' as const, fromName: 'Bob', text: 'too early', ts: 9_999 },
      { from: 'guest' as const, fromName: 'Bob', text: 'at start', ts: 10_000 },
      { from: 'host' as const, text: 'in middle', ts: 15_000, self: true },
      { from: 'guest' as const, fromName: 'Bob', text: 'at end', ts: 30_000 },
      { from: 'guest' as const, fromName: 'Bob', text: 'too late', ts: 30_001 },
    ];

    const log = buildChatLog(messages, opts);
    expect(log).toBe(
      '[0:00] guest Bob: at start\n' +
      '[0:05] host Ana: in middle\n' +
      '[0:20] guest Bob: at end\n'
    );
  });

  it('uses the three name sources: localName for self, fromName, and role fallback', () => {
    const messages = [
      { from: 'host' as const, text: 'message from self', ts: 10_000, self: true },
      { from: 'guest' as const, fromName: 'Charlie', text: 'message from remote peer', ts: 12_000 },
      { from: 'producer' as const, text: 'message without fromName', ts: 14_000 },
    ];

    const log = buildChatLog(messages, opts);
    expect(log).toBe(
      '[0:00] host Ana: message from self\n' +
      '[0:02] guest Charlie: message from remote peer\n' +
      '[0:04] producer: message without fromName\n'
    );
  });

  it('flattens line breaks inside a message to single spaces', () => {
    const messages = [
      { from: 'guest' as const, fromName: 'Bob', text: 'hello\nworld\r\nthis is\ra test', ts: 10_000 },
    ];

    const log = buildChatLog(messages, opts);
    expect(log).toBe('[0:00] guest Bob: hello world this is a test\n');
  });

  it('returns empty string when no messages are in the window or messages list is empty', () => {
    expect(buildChatLog([], opts)).toBe('');
    expect(
      buildChatLog(
        [{ from: 'guest' as const, fromName: 'Bob', text: 'outside', ts: 5_000 }],
        opts
      )
    ).toBe('');
  });

  it('replaces runs of control characters and line or paragraph separators with one space in both name and text', () => {
    const messages = [
      {
        from: 'guest' as const,
        fromName: 'Sam\n[0:01] Priya: I agree',
        text: 'hello\r\nworld\u2028line\u2029para\x00null\x1funit',
        ts: 10_000,
      },
    ];

    const log = buildChatLog(messages, opts);
    expect(log).toBe('[0:00] guest Sam [0:01] Priya: I agree: hello world line para null unit\n');
    expect(log.trim().split('\n')).toHaveLength(1);
  });

  it('strips NEL and bidi overrides from speaker name and message text', () => {
    const messages = [
      {
        from: 'guest' as const,
        fromName: 'Sam\u0085Priya\u202Erev',
        text: 'hello\u0085world\u202Erev',
        ts: 10_000,
      },
    ];

    const log = buildChatLog(messages, opts);
    expect(log).toBe('[0:00] guest Sam Priya rev: hello world rev\n');
  });

  it('sanitises control characters, separators and bidi controls while keeping joined emoji', () => {
    expect(sanitizeText('\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}')).toBe('\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}');
    expect(sanitizeText('a' + ' '.repeat(120) + 'b')).toBe('a b');
    expect(sanitizeText('a\u0085b')).toBe('a b');
    expect(sanitizeText('a\u2028b')).toBe('a b');
    expect(sanitizeText('a\u202Eb')).toBe('a b');
    expect(sanitizeText('a\u00A0b')).toBe('a b');
  });
});

describe('frame rate section', () => {
  const base = { recordingId: 'r', hostFile: 'host_r.mp4', hostStartMs: 0 };
  const guest = { slot: 0, file: 'guest_r.mp4', startHostMs: 0, rttMs: 10 };
  const section = (input: Parameters<typeof buildSyncReport>[0]) => JSON.parse(buildSyncReport(input).json).frameRate;

  it('lists every video file once, in order host, guests, screens, with its kind', () => {
    const inputWithHost = {
      ...base,
      guests: [guest, { slot: 1, file: 'guest2_r.mp4', startHostMs: 0, rttMs: 10 }],
      screenSegments: [
        { file: 'host_screen_r.mp4', offsetMs: 0 },
        { file: 'guest_screen_r.mp4', offsetMs: 100 },
      ],
    };
    const s = section(inputWithHost);
    expect(s.files.map((f: { file: string; kind: string }) => [f.file, f.kind])).toEqual([
      ['host_r.mp4', 'camera'],
      ['guest_r.mp4', 'camera'],
      ['guest2_r.mp4', 'camera'],
      ['host_screen_r.mp4', 'screen'],
      ['guest_screen_r.mp4', 'screen'],
    ]);

    const { hostFile: _, ...inputWithoutHost } = inputWithHost;
    const sNoHost = section(inputWithoutHost);
    expect(sNoHost.files.map((f: { file: string; kind: string }) => [f.file, f.kind])).toEqual([
      ['guest_r.mp4', 'camera'],
      ['guest2_r.mp4', 'camera'],
      ['host_screen_r.mp4', 'screen'],
      ['guest_screen_r.mp4', 'screen'],
    ]);
  });

  it('preserves the contract keys', () => {
    const s = section({ ...base, guests: [guest] });
    expect(Object.keys(s)).toEqual(['note', 'requestedFps', 'conformNote', 'files']);
    expect(Object.keys(s.files[0])).toEqual(['file', 'kind', 'trackFps', 'measure', 'conform']);
  });

  it('reports the requested rate and a known track rate', () => {
    const s = section({
      ...base,
      hostTrackFps: 30,
      guests: [{ ...guest, trackFps: 25 }],
    });
    expect(s.requestedFps).toBe(RECORDING_FRAME_RATE);
    expect(s.files[0].trackFps).toBe(30);
    expect(s.files[1].trackFps).toBe(25);
  });

  it('keeps unknown figures as null, never guessed', () => {
    const s1 = section({ ...base, guests: [guest] });
    expect(s1.files.every((f: { trackFps: number | null }) => f.trackFps === null)).toBe(true);

    const s2 = section({
      ...base,
      hostTrackFps: 25,
      guests: [guest],
      screenSegments: [{ file: 'host_screen_r.mp4', offsetMs: 0 }],
    });
    const screenEntry = s2.files.find((f: { kind: string }) => f.kind === 'screen');
    expect(screenEntry.trackFps).toBeNull();
    expect(screenEntry.conform).toContain(`-vf fps=${RECORDING_FRAME_RATE} `);
  });

  it('targets the file own rate in conform and falls back to the requested one', () => {
    const s = section({
      ...base,
      guests: [{ ...guest, trackFps: 25 }, { slot: 1, file: 'guest2_r.mp4', startHostMs: 0, rttMs: 10, trackFps: null }],
    });
    expect(s.files[1].conform).toContain('-vf fps=25 ');
    expect(s.files[2].conform).toContain(`-vf fps=${RECORDING_FRAME_RATE} `);
  });

  it('formats NTSC rates as exact fractions and other rates as reported', () => {
    const check = (hostTrackFps: number) => section({ ...base, hostTrackFps, guests: [] }).files[0];
    expect(check(29.97).conform).toContain('fps=30000/1001 ');
    expect(check(23.976).conform).toContain('fps=24000/1001 ');
    expect(check(59.94).conform).toContain('fps=60000/1001 ');
    expect(check(30).conform).toContain('fps=30 ');
    expect(check(12.5).conform).toContain('fps=12.5 ');

    const roundedNtsc = check(29.970029830932617);
    expect(roundedNtsc.trackFps).toBe(29.97);
    expect(roundedNtsc.conform).toContain('fps=30000/1001 ');
  });

  it('never lets a nonsense rate reach the JSON or a command', () => {
    const nonsenseValues = [NaN, -30, 0, 1000, Infinity, '25' as never];
    for (const val of nonsenseValues) {
      const s = section({ ...base, hostTrackFps: val as number, guests: [{ ...guest, trackFps: val as number }] });
      expect(s.files[0].trackFps).toBeNull();
      expect(s.files[0].conform).toContain(`-vf fps=${RECORDING_FRAME_RATE} `);
      expect(s.files[1].trackFps).toBeNull();
      expect(s.files[1].conform).toContain(`-vf fps=${RECORDING_FRAME_RATE} `);
    }
  });

  it('matches the two commands character for character', () => {
    const s = section({ ...base, guests: [guest] });
    expect(s.files[0].conform).toBe('ffmpeg -i "host_r.mp4" -vf fps=30 -c:v libx264 -crf 18 -c:a copy -movflags +faststart "host_r_cfr.mp4"');
    expect(s.files[0].measure).toBe('ffmpeg -hide_banner -i "host_r.mp4" -an -vf vfrdet -f null -');
  });

  it('keeps the lossless remux as default', () => {
    const r = buildSyncReport({ ...base, guests: [guest] });
    const j = JSON.parse(r.json);
    expect(j.seekability.remuxHost).toContain('-c copy');
    expect(r.data.commands.some((c) => c.cmd.includes('libx264'))).toBe(false);
  });

  it('says the conform is not lossless in the report notes', () => {
    const s = section({ ...base, guests: [guest] });
    expect(s.conformNote).toContain('re-encodes');
    expect(s.conformNote).toContain('not lossless');
    expect(s.note).toContain('Neither is a count of the frames');
  });
});

describe('verification and file sizes', () => {
  it('formats byte counts in decimal units as file managers do', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(44_000)).toBe('44 kB');
    expect(formatBytes(812_300_000)).toBe('812 MB');
    expect(formatBytes(1_500_000_000)).toBe('1.5 GB');
  });

  it('puts bytes on fileList entries with a check, leaves others without, and lists every file in verification in order', () => {
    const checks = new Map<string, FileCheck>([
      ['host_rec.mp4', { bytes: 812_300_000 }],
      ['guest_rec.mp4', { bytes: 44_000 }],
    ]);
    const r = buildSyncReport({
      recordingId: 'rec',
      hostFile: 'host_rec.mp4',
      hostStartMs: 10_000,
      guests: [{ slot: 0, file: 'guest_rec.mp4', startHostMs: 10_500, rttMs: 10 }],
      screenSegments: [{ file: 'host_screen_rec.mp4', offsetMs: 1000 }],
      checks,
    });

    expect(r.data.fileList).toEqual([
      expect.objectContaining({ name: 'host_rec.mp4', bytes: 812_300_000 }),
      expect.objectContaining({ name: 'guest_rec.mp4', bytes: 44_000 }),
      expect.objectContaining({ name: 'host_screen_rec.mp4' }),
    ]);
    expect(r.data.fileList.find((f) => f.name === 'host_screen_rec.mp4')?.bytes).toBeUndefined();

    const parsed = JSON.parse(r.json);
    expect(parsed.verification.map((v: { file: string }) => v.file)).toEqual(
      r.data.fileList.map((f) => f.name)
    );
    expect(parsed.verification[0]).toEqual(
      expect.objectContaining({ file: 'host_rec.mp4', bytes: 812_300_000 })
    );
    expect(parsed.verification[1]).toEqual(
      expect.objectContaining({ file: 'guest_rec.mp4', bytes: 44_000 })
    );
    expect(parsed.verification[2]).toEqual(
      expect.objectContaining({ file: 'host_screen_rec.mp4', bytes: null })
    );
  });

  it("tells a host screen file that recorded nothing apart from the host's other empty files", () => {
    const r = buildSyncReport({
      recordingId: 'rec',
      hostFile: 'host_rec.mp4',
      hostStartMs: 10_000,
      guests: [],
      screenSegments: [{ file: 'host_screen_rec.mp4', offsetMs: 0 }],
      checks: new Map<string, FileCheck>([
        ['host_rec.mp4', { bytes: 0 }],
        ['host_screen_rec.mp4', { bytes: 0 }],
      ]),
    });

    const verdictOf = (name: string) => r.data.fileList.find((f) => f.name === name)?.verdict;
    expect(verdictOf('host_screen_rec.mp4')).toEqual({
      status: 'incomplete',
      text: 'Empty. Nothing was recorded.',
    });
    expect(verdictOf('host_rec.mp4')?.text).toContain("Your browser's backup");
  });

  const received = (
    over: Partial<NonNullable<FileCheck['received']>> = {}
  ): NonNullable<FileCheck['received']> => ({
    finalized: true,
    abandoned: false,
    sha256Written: 'x',
    ...over,
  });

  // Each row is one outcome of the state machine: which facts put a file in
  // which of the three states, and the words a host acts on.
  const verdicts: [string, FileCheck | undefined, FileVerdict, SummaryFile['kind']?][] = [
    ['no check at all', undefined, { status: 'unverified', text: 'Not verified. This file was not checked.' }],
    [
      'empty and arrived from a guest',
      { bytes: 0, received: received() },
      {
        status: 'incomplete',
        text: 'Empty. Nothing arrived from Priya. If they were recording, ask them for the backup their browser kept; it is listed in the lobby on their device.',
      },
    ],
    [
      "empty and the host's own",
      { bytes: 0 },
      {
        status: 'incomplete',
        text: "Empty. Nothing was recorded. Your browser's backup, if it caught anything, is under Safety copies in the session summary; download it before you leave the call.",
      },
    ],
    [
      "empty and the host's own screen file",
      { bytes: 0 },
      { status: 'incomplete', text: 'Empty. Nothing was recorded.' },
      'screen',
    ],
    [
      "the host's own with bytes",
      { bytes: 1024 },
      { status: 'complete', text: 'Complete. Recorded on this computer.' },
    ],
    [
      'abandoned, even with equal digests',
      { bytes: 10, received: received({ abandoned: true, sha256Sent: 'same', sha256Written: 'same' }) },
      {
        status: 'incomplete',
        text: 'Incomplete. The upload from Priya fell too far behind and stopped, so this file ends early. Ask Priya for the backup their browser kept; it is listed in the lobby on their device.',
      },
    ],
    [
      'digests equal',
      { bytes: 10, received: received({ sha256Sent: 'same', sha256Written: 'same' }) },
      { status: 'complete', text: 'Complete. Matches what Priya sent (SHA-256).' },
    ],
    [
      'digests differ',
      { bytes: 10, received: received({ sha256Sent: 'sent', sha256Written: 'written' }) },
      {
        status: 'incomplete',
        text: 'Incomplete. Part of this file is missing or damaged: it differs from what Priya sent (SHA-256). Ask Priya for the backup their browser kept; it is listed in the lobby on their device.',
      },
    ],
    [
      'finalized with no digest reported',
      { bytes: 10, received: received() },
      { status: 'unverified', text: 'Complete, not verified. No checksum arrived from Priya to compare.' },
    ],
    [
      'finalized with an empty digest',
      { bytes: 10, received: received({ sha256Sent: '' }) },
      { status: 'unverified', text: 'Complete, not verified. No checksum arrived from Priya to compare.' },
    ],
    [
      'no finish signal',
      { bytes: 10, received: received({ finalized: false }) },
      {
        status: 'incomplete',
        text: 'Incomplete. No finish signal arrived from Priya, so this file may end early. Ask Priya for the backup their browser kept; it is listed in the lobby on their device.',
      },
    ],
    [
      'rebuilt from the crash copy',
      { bytes: 10, recovered: true },
      {
        status: 'unverified',
        text: 'Not verified. This file was rebuilt from the browser’s crash copy, so there was no checksum to compare.',
      },
    ],
    [
      'rebuilt from the crash copy and empty',
      { bytes: 0, recovered: true },
      {
        status: 'incomplete',
        text: "Empty. Nothing was recorded. Your browser's backup, if it caught anything, is under Safety copies in the session summary; download it before you leave the call.",
      },
    ],
    [
      'rebuilt from the crash copy and reported by the guest',
      { bytes: 10, recovered: true, received: received({ sha256Sent: 'sent', sha256Written: 'written' }) },
      {
        status: 'unverified',
        text: 'Not verified. This file was rebuilt from the browser’s crash copy, so there was no checksum to compare.',
      },
    ],
  ];

  it.each(verdicts)('gives a file %s its verdict', (_row, check, expected, kind) => {
    expect(fileVerdict(check, 'Priya', kind)).toEqual(expected);
  });

  it('names each file by who sent it, falling back to the guest or the sharer', () => {
    const check = () => ({ bytes: 10, received: received({ finalized: false }) });
    const r = buildSyncReport({
      recordingId: 'rec',
      hostStartMs: 10_000,
      guests: [
        { slot: 0, name: 'Bob', file: 'guest_bob.mp4', wavFile: 'guest_bob.wav', startHostMs: 10_500, rttMs: 10 },
        { slot: 1, file: 'guest_noname.mp4', startHostMs: 10_500, rttMs: 10 },
      ],
      screenSegments: [
        { file: 'host_screen_alice.mp4', offsetMs: 1000, sharer: 'Alice' },
        { file: 'host_screen_noname.mp4', offsetMs: 2000 },
      ],
      checks: new Map<string, FileCheck>([
        ['guest_bob.mp4', check()],
        ['guest_bob.wav', check()],
        ['guest_noname.mp4', check()],
        ['host_screen_alice.mp4', check()],
        ['host_screen_noname.mp4', check()],
      ]),
    });
    const text = (name: string) => r.data.fileList.find((f) => f.name === name)?.verdict?.text;
    expect(text('guest_bob.mp4')).toContain('from Bob');
    expect(text('guest_bob.wav')).toContain('from Bob');
    expect(text('guest_noname.mp4')).toContain('from the guest');
    expect(text('host_screen_alice.mp4')).toContain('from Alice');
    expect(text('host_screen_noname.mp4')).toContain('from the sharer');
  });

  it('cleans a name before it reaches the verdict, and survives one that is not a string', () => {
    const check: FileCheck = { bytes: 10, received: received({ finalized: false }) };
    const r = buildSyncReport({
      recordingId: 'rec',
      hostStartMs: 10_000,
      guests: [
        { slot: 0, name: 'Sam\n\u202Eevil', file: 'guest_evil.mp4', startHostMs: 10_500, rttMs: 10 },
        { slot: 1, name: 42 as never, file: 'guest_42.mp4', startHostMs: 10_500, rttMs: 10 },
      ],
      checks: new Map<string, FileCheck>([
        ['guest_evil.mp4', check],
        ['guest_42.mp4', check],
      ]),
    });
    const evil = r.data.fileList.find((f) => f.name === 'guest_evil.mp4')?.verdict?.text ?? '';
    expect(evil).toContain('from Sam evil');
    expect(evil).not.toContain('\n');
    expect(evil).not.toContain('\u202E');
    expect(r.data.fileList.find((f) => f.name === 'guest_42.mp4')?.verdict?.text).toContain('from the guest');
  });

  it('trims a name, and falls back when it holds only whitespace', () => {
    const check: FileCheck = { bytes: 10, received: received({ finalized: false }) };
    const r = buildSyncReport({
      recordingId: 'rec',
      hostStartMs: 10_000,
      guests: [
        { slot: 0, name: '  Sam  ', file: 'guest_padded.mp4', startHostMs: 10_500, rttMs: 10 },
        { slot: 1, name: '   ', file: 'guest_blank.mp4', startHostMs: 10_500, rttMs: 10 },
      ],
      checks: new Map<string, FileCheck>([
        ['guest_padded.mp4', check],
        ['guest_blank.mp4', check],
      ]),
    });
    const text = (name: string) => r.data.fileList.find((f) => f.name === name)?.verdict?.text ?? '';
    expect(text('guest_padded.mp4')).toContain('from Sam, so this file may end early.');
    expect(text('guest_blank.mp4')).toContain('from the guest, so this file may end early.');
  });

  it('falls back when a name holds no character a reader can see', () => {
    const check: FileCheck = { bytes: 10, received: received({ finalized: false }) };
    const r = buildSyncReport({
      recordingId: 'rec',
      hostStartMs: 10_000,
      guests: [
        { slot: 0, name: '\u200B\u2060', file: 'guest_invisible.mp4', startHostMs: 10_500, rttMs: 10 },
        { slot: 1, name: '42 \u266A', file: 'guest_symbols.mp4', startHostMs: 10_500, rttMs: 10 },
      ],
      checks: new Map<string, FileCheck>([
        ['guest_invisible.mp4', check],
        ['guest_symbols.mp4', check],
      ]),
    });
    const text = (name: string) => r.data.fileList.find((f) => f.name === name)?.verdict?.text ?? '';
    expect(text('guest_invisible.mp4')).toContain('from the guest, so this file may end early.');
    // A name a reader can see is kept even when it holds no letter.
    expect(text('guest_symbols.mp4')).toContain('from 42 \u266A, so this file may end early.');
  });

  it('calls a file it has no check for unverified, with or without a checks map', () => {
    const input = {
      recordingId: 'rec',
      hostFile: 'host_rec.mp4',
      hostStartMs: 10_000,
      guests: [{ slot: 0, file: 'guest_rec.mp4', startHostMs: 10_500, rttMs: 10 }],
    };
    const partial = buildSyncReport({
      ...input,
      checks: new Map<string, FileCheck>([['host_rec.mp4', { bytes: 10 }]]),
    });
    expect(partial.data.fileList.find((f) => f.name === 'guest_rec.mp4')?.verdict).toEqual({
      status: 'unverified',
      text: 'Not verified. This file was not checked.',
    });

    const unchecked = buildSyncReport(input);
    expect(unchecked.data.fileList.map((f) => f.verdict)).toEqual([
      { status: 'unverified', text: 'Not verified. This file was not checked.' },
      { status: 'unverified', text: 'Not verified. This file was not checked.' },
    ]);
  });

  it('writes file, bytes, status and detail for every listed file, in fileList order', () => {
    const r = buildSyncReport({
      recordingId: 'rec',
      hostFile: 'host_rec.mp4',
      hostStartMs: 10_000,
      guests: [{ slot: 0, name: 'Priya', file: 'guest_rec.mp4', startHostMs: 10_500, rttMs: 10 }],
      screenSegments: [{ file: 'host_screen_rec.mp4', offsetMs: 1000 }],
      checks: new Map<string, FileCheck>([
        ['host_rec.mp4', { bytes: 812 }],
        [
          'guest_rec.mp4',
          { bytes: 44_000, received: received({ sha256Sent: 'same', sha256Written: 'same' }) },
        ],
        ['host_screen_rec.mp4', { bytes: 0, received: received() }],
      ]),
    });
    expect(JSON.parse(r.json).verification).toEqual([
      { file: 'host_rec.mp4', bytes: 812, status: 'complete', detail: 'Complete. Recorded on this computer.' },
      {
        file: 'guest_rec.mp4',
        bytes: 44_000,
        status: 'complete',
        detail: 'Complete. Matches what Priya sent (SHA-256).',
      },
      {
        file: 'host_screen_rec.mp4',
        bytes: 0,
        status: 'incomplete',
        detail:
          'Empty. Nothing arrived from the sharer. If they were recording, ask them for the backup their browser kept; it is listed in the lobby on their device.',
      },
    ]);
  });

});

describe('aligned copies', () => {
  const base = { recordingId: 'r', hostFile: 'host_r.mp4', hostStartMs: 1_000_000 };
  const bob = (startHostMs: number | null) => ({
    slot: 0,
    name: 'Bob',
    file: 'guest_r.mp4',
    startHostMs,
    rttMs: 20,
  });
  const HINT =
    "The aligned-copy commands under Editor commands write copies that start when the host's recording starts, " +
    "so each copy lines up with the host's files at 00:00 on a timeline. Audio copies get real silence. " +
    'Video copies are not re-encoded: the delay is stored in the file, and an editor that ignores it needs ' +
    'the clip moved by the time shown with its command.';
  const VIDEO_CMD =
    'ffmpeg -itsoffset 1.500 -i "guest_r.mp4" -c copy -tag:v avc1 -movflags +faststart "guest_r_aligned.mp4"';

  it('gives a late guest a delayed video copy and the host none', () => {
    const r = buildSyncReport({ ...base, guests: [bob(1_001_500)] });
    const aligned = JSON.parse(r.json).aligned;
    expect(Object.keys(aligned)).toEqual(['note', 'files']);
    expect(aligned.note).toContain('not re-encoded');
    expect(aligned.files).toEqual([
      { file: 'host_r.mp4', padMs: 0 },
      { file: 'guest_r.mp4', padMs: 1500, cmd: VIDEO_CMD },
    ]);
    expect(r.data.commands).toContainEqual({
      label: 'Bob: aligned copy of the video (starts 1.500 s in)',
      cmd: VIDEO_CMD,
    });
  });

  it('gives a guest WAV a silence-padded copy with the same pad as its video', () => {
    const r = buildSyncReport({
      ...base,
      hostWavFile: 'host_r.wav',
      guests: [{ ...bob(1_001_500), wavFile: 'guest_r.wav' }],
    });
    const aligned = JSON.parse(r.json).aligned;
    const wavCmd =
      'ffmpeg -i "guest_r.wav" -af "adelay=1500:all=1" -c:a pcm_s24le -rf64 auto "guest_r_aligned.wav"';
    expect(aligned.files).toEqual([
      { file: 'host_r.mp4', padMs: 0 },
      { file: 'host_r.wav', padMs: 0 },
      { file: 'guest_r.mp4', padMs: 1500, cmd: VIDEO_CMD },
      { file: 'guest_r.wav', padMs: 1500, cmd: wavCmd },
    ]);
    expect(r.data.commands).toContainEqual({
      label: 'Bob: aligned copy of the audio master (1.500 s of silence added)',
      cmd: wavCmd,
    });
  });

  it('gives no command when the start is unknown or not a finite number', () => {
    for (const g of [bob(null), bob(Infinity)]) {
      const r = buildSyncReport({ ...base, guests: [g] });
      const aligned = JSON.parse(r.json).aligned;
      expect(aligned.files).toEqual([
        { file: 'host_r.mp4', padMs: 0 },
        { file: 'guest_r.mp4', padMs: null },
      ]);
      const alignedLabels = r.data.commands.filter((c) => c.label.includes('aligned copy'));
      expect(alignedLabels).toEqual([]);
      expect(r.data.alignment).not.toContain('aligned-copy');
    }
    const rEmpty = buildSyncReport({ recordingId: 'r', hostStartMs: 1_000_000, guests: [] });
    expect(JSON.parse(rEmpty.json).aligned.files).toEqual([]);
  });

  it('never pads a file whose start was estimated before the host', () => {
    const r = buildSyncReport({ ...base, guests: [bob(999_600)] });
    expect(r.guestMinusHostMs).toBe(-400);
    const aligned = JSON.parse(r.json).aligned;
    expect(aligned.files).toEqual([
      { file: 'host_r.mp4', padMs: 0 },
      { file: 'guest_r.mp4', padMs: 0 },
    ]);
    const alignedLabels = r.data.commands.filter((c) => c.label.includes('aligned copy'));
    expect(alignedLabels).toEqual([]);
  });

  it("takes each guest's pad from that guest alone", () => {
    const r = buildSyncReport({
      ...base,
      guests: [
        bob(1_001_500),
        { slot: 1, name: 'Carol', file: 'guest2_r.mp4', startHostMs: 999_000, rttMs: 20 },
      ],
    });
    const aligned = JSON.parse(r.json).aligned;
    expect(aligned.files.map((f: { file: string; padMs: number | null }) => [f.file, f.padMs])).toEqual([
      ['host_r.mp4', 0],
      ['guest_r.mp4', 1500],
      ['guest2_r.mp4', 0],
    ]);
  });

  it('delays a screen segment by its offset', () => {
    const cmd =
      'ffmpeg -itsoffset 27.000 -i "guest_screen_r_2.mp4" -c copy -tag:v avc1 -movflags +faststart "guest_screen_r_2_aligned.mp4"';
    const r = buildSyncReport({
      ...base,
      guests: [],
      screenSegments: [
        { file: 'host_screen_r.mp4', offsetMs: 0 },
        { file: 'guest_screen_r_2.mp4', offsetMs: 27000 },
      ],
    });
    const aligned = JSON.parse(r.json).aligned;
    expect(aligned.files).toEqual([
      { file: 'host_r.mp4', padMs: 0 },
      { file: 'host_screen_r.mp4', padMs: 0 },
      { file: 'guest_screen_r_2.mp4', padMs: 27000, cmd },
    ]);
    const alignedLabels = r.data.commands.filter((c) => c.label.includes('aligned copy'));
    expect(alignedLabels).toEqual([
      { label: 'Screen segment 2: aligned copy of the video (starts 27.000 s in)', cmd },
    ]);
    expect(r.data.alignment).toBe(HINT);
  });

  it('pads by whole milliseconds, written as plain decimals', () => {
    const r = buildSyncReport({ ...base, guests: [bob(1_000_000 + 3_600_000.4)] });
    const aligned = JSON.parse(r.json).aligned;
    const guestEntry = aligned.files.find((f: { file: string }) => f.file === 'guest_r.mp4');
    expect(guestEntry.padMs).toBe(3_600_000);
    expect(guestEntry.cmd).toContain('-itsoffset 3600.000 ');
  });

  it('explains the commands in the summary only, after the existing alignment line', () => {
    const line = 'Bob started 1500 ms AFTER host. Shift the Bob clip +1500 ms (later) relative to host.';
    const r = buildSyncReport({ ...base, guests: [bob(1_001_500)] });
    expect(r.data.alignment).toBe(`${line}\n${HINT}`);
    expect(JSON.parse(r.json).alignment).toBe(line);
  });

  it('lists the aligned-copy commands after every existing command', () => {
    const r = buildSyncReport({
      ...base,
      hostWavFile: 'host_r.wav',
      guests: [
        { ...bob(1_001_500), wavFile: 'guest_r.wav' },
        { slot: 1, name: 'Carol', file: 'guest2_r.mp4', wavFile: 'guest2_r.wav', startHostMs: 1_003_200, rttMs: 20 },
      ],
    });
    expect(r.data.commands.map((c) => c.label)).toEqual([
      'Make the host file seekable (lossless)',
      'Make the Bob file seekable (lossless)',
      'Make the Carol file seekable (lossless)',
      'Host: pair video with the uncompressed audio master',
      'Bob: pair video with the uncompressed audio master',
      'Carol: pair video with the uncompressed audio master',
      'Bob: aligned copy of the video (starts 1.500 s in)',
      'Bob: aligned copy of the audio master (1.500 s of silence added)',
      'Carol: aligned copy of the video (starts 3.200 s in)',
      'Carol: aligned copy of the audio master (3.200 s of silence added)',
    ]);
  });

  it('keeps a screen segment on its own offset, lists it after the guests, and names an unnamed guest', () => {
    const r = buildSyncReport({
      ...base,
      guests: [{ slot: 0, file: 'guest_r.mp4', startHostMs: 1_001_500, rttMs: 20 }],
      screenSegments: [{ file: 'host_screen_r.mp4', offsetMs: 27000 }],
    });
    const aligned = JSON.parse(r.json).aligned;
    expect(aligned.files.map((f: { file: string; padMs: number | null }) => [f.file, f.padMs])).toEqual([
      ['host_r.mp4', 0],
      ['guest_r.mp4', 1500],
      ['host_screen_r.mp4', 27000],
    ]);
    expect(r.data.commands.map((c) => c.label).filter((l) => l.includes('aligned copy'))).toEqual([
      'Guest: aligned copy of the video (starts 1.500 s in)',
      'Screen segment 1: aligned copy of the video (starts 27.000 s in)',
    ]);
  });
});

describe('audio masters note', () => {
  const note = () =>
    (JSON.parse(
      buildSyncReport({ recordingId: 'r', hostFile: 'host_r.mp4', hostStartMs: 0, guests: [] }).json
    ) as { audioMasters: { note: string } }).audioMasters.note;

  it('describes the masters at the fixed 48 kHz, not at the rate the microphone ran at', () => {
    const text = note();
    expect(text).toContain('48 kHz');
    expect(text).not.toContain('capture rate');
    expect(text).toBe(
      'Uncompressed 24-bit PCM at 48 kHz, whatever rate the microphone ran at. ' +
        'Edit from these; the MP4 audio track is the convenience copy.'
    );
  });

  it('takes the depth and the rate in the note from the constants', async () => {
    vi.resetModules();
    vi.doMock('@openmeet/protocol', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@openmeet/protocol')>()),
      WAV_BIT_DEPTH: 32,
      WAV_SAMPLE_RATE: 44_100,
    }));
    const { buildSyncReport: build } = await import('@/lib/sync-report');
    const text = (JSON.parse(build({ recordingId: 'r', hostStartMs: 0, guests: [] }).json) as {
      audioMasters: { note: string };
    }).audioMasters.note;
    vi.doUnmock('@openmeet/protocol');
    vi.resetModules();
    expect(text).toContain('32-bit PCM at 44.1 kHz');
  });
});
