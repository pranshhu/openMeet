import { describe, it, expect } from 'vitest';
import { RECORDING_FRAME_RATE } from '@openmeet/protocol';
import { buildSyncReport, formatTimecode, buildChapters, integrityVerdict, buildChatLog, sanitizeText, formatBytes, type FileCheck } from '@/lib/sync-report';

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
      ...base, hostWavFile: 'host_r.wav', guests: [{ ...guest, sha256Sent: 'x', sha256Written: 'x' }],
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
      guests: [{ ...guest, startHostMs: null, drained: false, sha256Sent: 'a', sha256Written: 'b' }],
    });
    const j = JSON.parse(r.json) as { warnings: string[] };
    expect(j.warnings).toHaveLength(3); // mismatch + undrained + no clock sync
    expect(j.warnings.join(' ')).toMatch(/MISMATCH/);
    expect(j.warnings.join(' ')).toMatch(/drain window/);
  });

  it('has no warnings on a clean session', () => {
    const r = buildSyncReport({ ...base, guests: [{ ...guest, drained: true, sha256Sent: 'a', sha256Written: 'a' }] });
    expect((JSON.parse(r.json) as { warnings: string[] }).warnings).toEqual([]);
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
          sha256Sent: 'bob_sha',
          sha256Written: 'bob_sha',
        },
        {
          slot: 1,
          name: 'Carol',
          file: 'guest2_r.mp4',
          wavFile: 'guest2_r.wav',
          startHostMs: 1_003_200,
          rttMs: 24,
          sha256Sent: 'carol_sha',
          sha256Written: 'carol_sha',
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

  it('omits audio master for a WAV-less guest and notes "no WAV master for <name>"', () => {
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
          sha256Sent: 'bob_sha',
          sha256Written: 'bob_sha',
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
      guests: [{ ...guest, wavFile: 'guest_r.wav', sha256Sent: 'a', sha256Written: 'a' }],
    });
    const j = JSON.parse(r.json);
    expect(j.files).toEqual({ host: 'host_r.mp4', guest: 'guest_r.mp4' });
    expect(Object.keys(j.timeline)).toEqual(['hostStartUnixMs', 'guestStartUnixMs', 'guestMinusHostMs', 'clockSyncRttMs']);
    expect(j.audioMasters).toMatchObject({ host: 'host_r.wav', guest: 'guest_r.wav' });
    expect(Object.keys(j.seekability)).toEqual(['note', 'remuxHost', 'remuxGuest']);
    expect(Object.keys(j.combine)).toEqual(['note', 'host', 'guest']);
  });

  it('marks an abandoned or timed out guest file and warns host to use backup', () => {
    const r = buildSyncReport({
      ...base,
      guests: [
        { slot: 0, file: 'guest_r.mp4', startHostMs: 1_000, rttMs: 5, abandoned: true },
      ],
    });
    const parsed = JSON.parse(r.json);
    expect(parsed.guests[0].abandoned).toBe(true);
    expect(parsed.guests[0].endedEarly).toBe(true);
    expect(parsed.warnings.some((w: string) => w.toLowerCase().includes('backup'))).toBe(true);

    const guestFile = r.data.fileList.find((f) => f.name === 'guest_r.mp4');
    expect(guestFile?.detail).toMatch(/backup/i);
  });

  it('marks an endedEarly screen segment in sync.json, warnings, and fileList pointing to backup', () => {
    const r = buildSyncReport({
      ...base,
      guests: [guest],
      screenSegments: [
        { file: 'guest_screen_r.mp4', offsetMs: 3400, endedEarly: true },
      ],
    });
    const parsed = JSON.parse(r.json);
    expect(parsed.screenSegments[0].endedEarly).toBe(true);
    expect(parsed.timeline.screenSegments[0].endedEarly).toBe(true);
    expect(
      parsed.warnings.some((w: string) => w.toLowerCase().includes('screen') && w.toLowerCase().includes('backup'))
    ).toBe(true);

    const screenFile = r.data.fileList.find((f) => f.kind === 'screen');
    expect(screenFile?.detail).toMatch(/ended early/i);
    expect(screenFile?.detail).toMatch(/backup/i);
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
});
