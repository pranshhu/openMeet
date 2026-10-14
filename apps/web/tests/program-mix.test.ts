import { describe, it, expect } from 'vitest';
import { programMix } from '@/lib/program-mix';
import { buildSyncReport, type FileCheck, type SyncReportInput } from '@/lib/sync-report';

const START = 1_000_000;

const take: SyncReportInput = {
  recordingId: 'r',
  hostFile: 'host_r.mp4',
  hostWavFile: 'host_r.wav',
  hostStartMs: START,
  guests: [{ slot: 0, file: 'guest_r.mp4', wavFile: 'guest_r.wav', startHostMs: START + 1234, rttMs: 20 }],
};

/** One check per name, each holding `bytes`, with a few overridden. */
const checksFor = (names: string[], over: Record<string, FileCheck> = {}) =>
  new Map<string, FileCheck>([...names.map((n): [string, FileCheck] => [n, { bytes: 1000 }]), ...Object.entries(over)]);

const filesOf = (input: SyncReportInput) => [
  ...(input.hostFile ? [input.hostFile] : []),
  ...(input.hostWavFile ? [input.hostWavFile] : []),
  ...(input.hostParts ?? []).map((p) => p.name),
  ...input.guests.flatMap((g) => [g.file, ...(g.wavFile ? [g.wavFile] : [])]),
  ...(input.screenSegments ?? []).map((s) => s.file),
  ...(input.callCopies ?? []).map((c) => c.file),
];

const withChecks = (input: SyncReportInput, over: Record<string, FileCheck> = {}): SyncReportInput => ({
  ...input,
  checks: checksFor(filesOf(input), over),
});

interface Program {
  note: string;
  output: string;
  cmd: string;
  video: string[];
  audio: string[];
  leftOut: { file: string; why: string }[];
}
const programOf = (input: SyncReportInput) =>
  (JSON.parse(buildSyncReport(input).json) as { program?: Program }).program;

const CMD_TWO =
  'ffmpeg -y -i "host_r.mp4" -i "guest_r.mp4" -i "host_r.wav" -i "guest_r.wav" -filter_complex ' +
  '"[0:v]fps=30,scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:-1:-1,setsar=1,tpad=start_duration=0.000[v0];' +
  '[1:v]fps=30,scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:-1:-1,setsar=1,tpad=start_duration=1.234[v1];' +
  '[v0][v1]xstack=inputs=2:layout=0_0|960_0:fill=black,pad=1920:1080:-1:-1[v];' +
  '[2:a]pan=stereo|FL=FL+FC|FR=FR+FC,adelay=0:all=1[a0];[3:a]pan=stereo|FL=FL+FC|FR=FR+FC,adelay=1234:all=1[a1];[a0][a1]amix=inputs=2:normalize=0[a]" ' +
  '-map "[v]" -map "[a]" -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a aac -b:a 192k -ac 2 ' +
  '-movflags +faststart "host_r_program.mp4"';

const NOTE =
  'cmd writes one file, named in output, and changes none of the take\'s files. It shows each camera in video in a ' +
  'grid on a 1920x1080 picture at 30 frames a second, the first top left, and mixes the files in audio. Each file ' +
  'is placed by its padMs under aligned: a person who started later is black and silent until then, and a person ' +
  'whose file ends first stays as a still picture. It re-encodes to H.264 and AAC, so it is slow and not lossless. ' +
  'Voices are added at the level they were recorded, and a one-channel master is put on both channels at its own ' +
  'level. Run it in the recording folder with ffmpeg 4.4 or later. ' +
  "leftOut names every file of the take that cmd does not read, and why. If ffmpeg says that ':a' matches " +
  'no streams, a file in audio has no sound track: take its input and its adelay out. ' +
  "If ffmpeg says that ':v' matches no streams, a file in video has no picture (a person recorded without a " +
  'camera whose take did not finish cleanly, or a take saved from its crash copy): ' +
  "keep its input, take its [k:v] chain out of the filter and its label out of xstack, and lower xstack's " +
  'inputs by one; if one camera is left, replace the xstack filter and its pad with pad=1920:1080:-1:-1. ' +
  'Its sound is already in the mix. Or ask for the take again.';

const LABEL_TWO = "Program file: the 2 cameras in a grid with everyone's audio mixed (re-encodes, slow)";
const LEFT_OUT_SENTENCE = '. The sync file lists the files it leaves out.';

/** A take of the host and `n` guests, each with a camera file and a WAV. */
const crowd = (n: number): SyncReportInput => ({
  ...take,
  guests: Array.from({ length: n }, (_, i) => ({
    slot: i,
    file: `guest${i + 1}_r.mp4`,
    wavFile: `guest${i + 1}_r.wav`,
    startHostMs: START,
    rttMs: 20,
  })),
});

describe('buildSyncReport: the program file command', () => {
  it('writes the command for a host and a guest 1234 ms late, in the sync file and as the last row', () => {
    const r = buildSyncReport(withChecks(take));
    const program = (JSON.parse(r.json) as { program: Program }).program;
    expect(program).toEqual({
      note: NOTE,
      output: 'host_r_program.mp4',
      cmd: CMD_TWO,
      video: ['host_r.mp4', 'guest_r.mp4'],
      audio: ['host_r.wav', 'guest_r.wav'],
      leftOut: [],
    });
    expect(r.data.commands.at(-1)).toEqual({ label: LABEL_TWO, cmd: CMD_TWO });
    expect(Object.keys(JSON.parse(r.json) as object).indexOf('program')).toBe(
      Object.keys(JSON.parse(r.json) as object).indexOf('flac') + 1
    );
  });

  it('writes neither a section nor a row without checks, or with none that match', () => {
    const withIt = buildSyncReport(withChecks(take)).data.commands;
    for (const checks of [undefined, new Map<string, FileCheck>()]) {
      const r = buildSyncReport({ ...take, ...(checks ? { checks } : {}) });
      expect('program' in (JSON.parse(r.json) as object)).toBe(false);
      expect(r.data.commands).toEqual(withIt.slice(0, -1));
    }
  });

  it('writes no command for a take of one person', () => {
    const solo = withChecks({ ...take, guests: [] });
    expect(programOf(solo)).toBeUndefined();
    expect(buildSyncReport(solo).data.commands.some((c) => c.cmd.includes('_program'))).toBe(false);
  });

  it('puts three people in cells of 960x540 and five in cells of 640x360', () => {
    const three = programOf(withChecks(crowd(2)));
    expect(three?.cmd).toContain('xstack=inputs=3:layout=0_0|960_0|0_540:fill=black');
    expect(three?.cmd).toContain('[2:v]fps=30,scale=960:540:');
    const five = programOf(withChecks(crowd(4)));
    expect(five?.cmd).toContain('xstack=inputs=5:layout=0_0|640_0|1280_0|0_360|640_360:fill=black');
    expect(five?.cmd).toContain('[4:v]fps=30,scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:-1:-1');
    expect(five?.cmd).toContain('[v0][v1][v2][v3][v4]xstack');
    expect(five?.cmd).toContain('amix=inputs=5:normalize=0[a]');
    expect(buildSyncReport(withChecks(crowd(4))).data.commands.at(-1)?.label).toBe(
      "Program file: the 5 cameras in a grid with everyone's audio mixed (re-encodes, slow)"
    );
  });

  it('leaves out both files of a guest whose start is unknown, and says so in the label', () => {
    const input = crowd(2);
    input.guests[1] = { ...input.guests[1]!, startHostMs: null };
    const r = buildSyncReport(withChecks(input));
    const program = (JSON.parse(r.json) as { program: Program }).program;
    expect(program.video).toEqual(['host_r.mp4', 'guest1_r.mp4']);
    expect(program.audio).toEqual(['host_r.wav', 'guest1_r.wav']);
    expect(program.cmd).not.toContain('guest2_r');
    const why = 'start unknown: clock sync did not converge, so it cannot be placed';
    expect(program.leftOut).toEqual([
      { file: 'guest2_r.mp4', why },
      { file: 'guest2_r.wav', why },
    ]);
    expect(r.data.commands.at(-1)?.label).toBe(LABEL_TWO + LEFT_OUT_SENTENCE);
  });

  it('reads the sound of a guest whose WAV holds only a header from the guest camera file', () => {
    const r = buildSyncReport(withChecks(take, { 'guest_r.wav': { bytes: 44 } }));
    const program = (JSON.parse(r.json) as { program: Program }).program;
    expect(program.video).toEqual(['host_r.mp4', 'guest_r.mp4']);
    expect(program.audio).toEqual(['host_r.wav', 'guest_r.mp4']);
    expect(program.cmd.startsWith('ffmpeg -y -i "host_r.mp4" -i "guest_r.mp4" -i "host_r.wav" -filter_complex')).toBe(true);
    expect(program.cmd).toContain('[1:v]fps=30');
    expect(program.cmd).toContain('[2:a]pan=stereo|FL=FL+FC|FR=FR+FC,adelay=0:all=1[a0];[1:a]pan=stereo|FL=FL+FC|FR=FR+FC,adelay=1234:all=1[a1]');
    expect(program.cmd.match(/-i "/g)).toHaveLength(3);
    expect(program.leftOut).toEqual([{ file: 'guest_r.wav', why: 'no recording in this file' }]);
    expect(r.data.commands.at(-1)?.label).toBe(LABEL_TWO + LEFT_OUT_SENTENCE);
  });

  it('counts a WAV of 45 bytes as holding sound', () => {
    expect(programOf(withChecks(take, { 'guest_r.wav': { bytes: 45 } }))?.audio).toEqual(['host_r.wav', 'guest_r.wav']);
  });

  it('gives a guest with a microphone and no camera no tile, and its WAV a place in the mix', () => {
    const r = buildSyncReport(withChecks(take, { 'guest_r.mp4': { bytes: 1000, audioOnly: true } }));
    const program = (JSON.parse(r.json) as { program: Program }).program;
    expect(program.video).toEqual(['host_r.mp4']);
    expect(program.audio).toEqual(['host_r.wav', 'guest_r.wav']);
    expect(program.cmd).not.toContain('xstack');
    expect(program.cmd).toContain(
      '[0:v]fps=30,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:-1:-1,setsar=1,tpad=start_duration=0.000[v];'
    );
    expect(program.leftOut).toEqual([
      { file: 'guest_r.mp4', why: "no picture, and the same sound is in this person's WAV master" },
    ]);
    expect(r.data.commands.at(-1)?.label).toBe(
      "Program file: the camera with everyone's audio mixed (re-encodes, slow)" + LEFT_OUT_SENTENCE
    );
  });

  it('reads the sound of a microphone-only guest with no WAV from its MP4, with no tile for it', () => {
    const input = withChecks(
      { ...take, guests: [{ slot: 0, file: 'guest_r.mp4', startHostMs: START + 1234, rttMs: 20 }] },
      { 'guest_r.mp4': { bytes: 1000, audioOnly: true } }
    );
    const program = programOf(input);
    expect(program?.video).toEqual(['host_r.mp4']);
    expect(program?.audio).toEqual(['host_r.wav', 'guest_r.mp4']);
    expect(program?.cmd).toContain('[2:a]pan=stereo|FL=FL+FC|FR=FR+FC,adelay=1234:all=1[a1]');
    expect(program?.cmd).not.toContain('[2:v]');
    expect(program?.leftOut).toEqual([]);
  });

  it('places the host by the file written after a reload, and mixes both of its WAVs', () => {
    const input = withChecks({
      ...take,
      hostFile: 'host_r_resumed.mp4',
      hostWavFile: 'host_r_resumed.wav',
      resumed: true,
      hostParts: [
        { name: 'host-ana_r.mp4', offsetMs: 0, kind: 'camera' },
        { name: 'host-ana_r.wav', offsetMs: 0, kind: 'wav' },
        { name: 'host_r_resumed.mp4', offsetMs: 20_000, kind: 'camera' },
        { name: 'host_r_resumed.wav', offsetMs: 20_000, kind: 'wav' },
      ],
    });
    const program = programOf(input);
    expect(program?.output).toBe('host_r_resumed_program.mp4');
    expect(program?.video).toEqual(['host_r_resumed.mp4', 'guest_r.mp4']);
    expect(program?.cmd).toContain('tpad=start_duration=20.000[v0]');
    expect([...(program?.audio ?? [])].sort()).toEqual(['guest_r.wav', 'host-ana_r.wav', 'host_r_resumed.wav']);
    expect(program?.cmd).toContain('adelay=0:all=1');
    expect(program?.cmd).toContain('adelay=20000:all=1');
    expect(program?.cmd).toContain('amix=inputs=3:normalize=0[a]');
    expect(program?.leftOut).toEqual([
      {
        file: 'host-ana_r.mp4',
        why: "the host's camera before the reload: the host's place in the grid is black until the file after the reload starts",
      },
    ]);
  });

  it('lists screen segments and call copies as left out, and every file once', () => {
    const input = withChecks({
      ...take,
      screenSegments: [{ file: 'host_screen_r.mp4', offsetMs: 500 }],
      callCopies: [{ file: 'call1_r.m4a', offsetMs: 500 }],
    });
    const program = programOf(input);
    expect(program?.leftOut).toEqual([
      { file: 'host_screen_r.mp4', why: 'screen recording: the program file shows cameras only' },
      { file: 'call1_r.m4a', why: 'call-audio copy: a fallback, not a master' },
    ]);
    const seen = [...(program?.video ?? []), ...(program?.audio ?? []), ...(program?.leftOut.map((l) => l.file) ?? [])];
    const listed = buildSyncReport(input).data.fileList.map((f) => f.name);
    expect([...seen].sort()).toEqual([...listed].sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('gives a screen segment with no recording the reason for an empty file', () => {
    const input = withChecks(
      { ...take, screenSegments: [{ file: 'host_screen_r.mp4', offsetMs: 0 }] },
      { 'host_screen_r.mp4': { bytes: 0 } }
    );
    expect(programOf(input)?.leftOut).toEqual([{ file: 'host_screen_r.mp4', why: 'no recording in this file' }]);
  });

  it('leaves out a guest whose start would not be a safe integer, and does not throw', () => {
    const input = crowd(2);
    input.guests[1] = { ...input.guests[1]!, startHostMs: START + Number.MAX_SAFE_INTEGER + 2 };
    const program = programOf(withChecks(input));
    expect(program?.video).toEqual(['host_r.mp4', 'guest1_r.mp4']);
    expect(program?.leftOut.map((l) => l.file)).toEqual(['guest2_r.mp4', 'guest2_r.wav']);
    expect(program?.cmd).not.toContain('guest2_r');
  });

  it('leaves out a guest whose start is before the host start as a pad of 0, not as unplaced', () => {
    const input = crowd(1);
    input.guests[0] = { ...input.guests[0]!, startHostMs: START - 500 };
    expect(programOf(withChecks(input))?.video).toEqual(['host_r.mp4', 'guest1_r.mp4']);
  });

  it('returns a report without the section when reading a check throws', () => {
    // The report's own rows read each WAV's check once; the second read is the program's.
    const checks = checksFor(filesOf(take));
    const read = checks.get.bind(checks);
    let wavReads = 0;
    checks.get = (file) => {
      if (file === 'host_r.wav' && ++wavReads > 1) throw new Error('no checks');
      return read(file);
    };
    const r = buildSyncReport({ ...take, checks });
    expect(wavReads).toBe(2);
    expect('program' in (JSON.parse(r.json) as object)).toBe(false);
    expect(r.data.commands.some((c) => c.cmd.includes('_program'))).toBe(false);
  });
});

describe('programMix: the level of each voice and a command that can be run again', () => {
  const PAN = 'pan=stereo|FL=FL+FC|FR=FR+FC,adelay=';
  const silent = {
    'host_r.mp4': { bytes: 1000, audioOnly: true },
    'guest_r.mp4': { bytes: 1000, audioOnly: true },
  };

  it('puts every sound input of a camera take on both channels before its delay', () => {
    const cmd = programOf(withChecks(crowd(2)))?.cmd ?? '';
    const inputs = cmd.match(/\[\d+:a\][^;"]*/g) ?? [];
    expect(inputs).toHaveLength(3);
    for (const input of inputs) {
      expect(input).toMatch(/^\[\d+:a\]pan=stereo\|FL=FL\+FC\|FR=FR\+FC,adelay=\d+:all=1\[a\d\]$/);
    }
    expect(cmd.split(PAN)).toHaveLength(4);
  });

  it('puts every sound input of a sound-only take on both channels before its delay', () => {
    const audioOnly = { bytes: 1000, audioOnly: true };
    const input = withChecks(crowd(2), { ...silent, 'guest1_r.mp4': audioOnly, 'guest2_r.mp4': audioOnly });
    const cmd = programOf(input)?.cmd ?? '';
    expect(cmd).toContain('-rf64 auto "host_r_program.wav"');
    expect(cmd.split(PAN)).toHaveLength(4);
  });

  it.each([
    ['a camera take', () => programOf(withChecks(take))],
    ['a sound-only take', () => programOf(withChecks(take, silent))],
  ])('writes over its own output in %s', (_, run) => {
    const cmd = run()?.cmd ?? '';
    expect(cmd.startsWith('ffmpeg -y -i ')).toBe(true);
    expect(cmd.match(/ -y /g)).toHaveLength(1);
  });

  it('ends the label of each kind with a full stop before the second sentence', () => {
    const lastLabel = (input: SyncReportInput) => buildSyncReport(input).data.commands.at(-1)?.label;
    const leaves = ' The sync file lists the files it leaves out.';
    expect(lastLabel(withChecks(take, { 'guest_r.mp4': { bytes: 1000, audioOnly: true } }))).toBe(
      "Program file: the camera with everyone's audio mixed (re-encodes, slow)." + leaves
    );
    expect(lastLabel(withChecks(crowd(2), { 'guest2_r.wav': { bytes: 0 } }))).toBe(
      "Program file: the 3 cameras in a grid with everyone's audio mixed (re-encodes, slow)." + leaves
    );
    expect(lastLabel(withChecks(take, silent))).toBe("Program file: everyone's audio mixed into one WAV." + leaves);
  });
});

describe('programMix: input it cannot use', () => {
  it('returns nothing for a report built without checks', () => {
    expect(programMix(take, [], [])).toBeNull();
  });

  it('names the output after the first camera, not after the first sound', () => {
    const input = withChecks({ ...take, hostWavFile: 'master_r.wav' });
    expect(programOf(input)?.output).toBe('host_r_program.mp4');
  });
});

describe('programMix: a pad that is not a non-negative whole number', () => {
  it.each([-1, 1.5, Number.NaN])('does not place a file whose pad is %s', (padMs) => {
    const input = withChecks(crowd(2));
    const aligned = [
      { file: 'host_r.mp4', padMs: 0 },
      { file: 'host_r.wav', padMs: 0 },
      { file: 'guest1_r.mp4', padMs: 0 },
      { file: 'guest1_r.wav', padMs: 0 },
      { file: 'guest2_r.mp4', padMs },
      { file: 'guest2_r.wav', padMs },
    ];
    const r = programMix(input, aligned, buildSyncReport(input).data.fileList);
    expect(r?.section.video).toEqual(['host_r.mp4', 'guest1_r.mp4']);
    expect(r?.section.leftOut.map((l) => l.file)).toEqual(['guest2_r.mp4', 'guest2_r.wav']);
  });
});

describe('programMix: a take where nobody has a camera', () => {
  const silent = {
    'host_r.mp4': { bytes: 1000, audioOnly: true },
    'guest_r.mp4': { bytes: 1000, audioOnly: true },
  };
  const CMD_WAV =
    'ffmpeg -y -i "host_r.wav" -i "guest_r.wav" -filter_complex "[0:a]pan=stereo|FL=FL+FC|FR=FR+FC,adelay=0:all=1[a0];[1:a]pan=stereo|FL=FL+FC|FR=FR+FC,adelay=1234:all=1[a1];' +
    '[a0][a1]amix=inputs=2:normalize=0[a]" -map "[a]" -c:a pcm_s24le -ac 2 -rf64 auto "host_r_program.wav"';
  const WAV_NOTE =
    "cmd writes one file, named in output, and changes none of the take's files. Nobody in this take was recorded " +
    'with a camera, so it is sound only: the files in audio mixed into one WAV at the depth of the masters. Each ' +
    'file is placed by its padMs under aligned, so a person who started later is silent until then. Voices are ' +
    'added at the level they were recorded, a one-channel master is put on both channels at its own level, and ' +
    'the mix is not compressed. Run it in the recording folder with ffmpeg 4.4 or later. leftOut names every ' +
    'file of the take that cmd does not read, and why.';
  const LABEL_WAV = "Program file: everyone's audio mixed into one WAV";

  it('writes one command that mixes the WAVs, each placed by its start', () => {
    const r = buildSyncReport(withChecks(take, silent));
    const program = (JSON.parse(r.json) as { program: Program }).program;
    expect(program).toEqual({
      note: WAV_NOTE,
      output: 'host_r_program.wav',
      cmd: CMD_WAV,
      video: [],
      audio: ['host_r.wav', 'guest_r.wav'],
      leftOut: [
        { file: 'host_r.mp4', why: "no picture, and the same sound is in this person's WAV master" },
        { file: 'guest_r.mp4', why: "no picture, and the same sound is in this person's WAV master" },
      ],
    });
    expect(r.data.commands.at(-1)).toEqual({ label: LABEL_WAV + LEFT_OUT_SENTENCE, cmd: CMD_WAV });
    expect(program.note).not.toContain('H.264');
  });

  it('reads a guest with no WAV from its MP4 and still writes a WAV', () => {
    const input = withChecks(
      { ...take, guests: [{ slot: 0, file: 'guest_r.mp4', startHostMs: START + 1234, rttMs: 20 }] },
      silent
    );
    const r = buildSyncReport(input);
    const program = (JSON.parse(r.json) as { program: Program }).program;
    expect(program.audio).toEqual(['host_r.wav', 'guest_r.mp4']);
    expect(program.cmd).toContain('[1:a]pan=stereo|FL=FL+FC|FR=FR+FC,adelay=1234:all=1[a1]');
    expect(program.output).toBe('host_r_program.wav');
    expect(program.leftOut).toEqual([
      { file: 'host_r.mp4', why: "no picture, and the same sound is in this person's WAV master" },
    ]);
    expect(r.data.commands.at(-1)?.label).toBe(LABEL_WAV + LEFT_OUT_SENTENCE);
  });

  it('ends the label without the leftOut sentence when every file is read', () => {
    const input = withChecks(
      { ...take, hostWavFile: undefined, guests: [{ slot: 0, file: 'guest_r.mp4', startHostMs: START + 1234, rttMs: 20 }] },
      silent
    );
    const r = buildSyncReport(input);
    expect(programOf(input)?.leftOut).toEqual([]);
    expect(programOf(input)?.output).toBe('host_r_program.wav');
    expect(r.data.commands.at(-1)?.label).toBe(LABEL_WAV);
  });

  it('writes no command for one microphone-only person alone', () => {
    const solo = withChecks({ ...take, guests: [] }, silent);
    expect(programOf(solo)).toBeUndefined();
    expect(buildSyncReport(solo).data.commands.some((c) => c.cmd.includes('_program'))).toBe(false);
  });

  it('keeps the video command when one person has a camera and one has none', () => {
    const program = programOf(withChecks(take, { 'guest_r.mp4': { bytes: 1000, audioOnly: true } }));
    expect(program?.cmd).toContain('-map "[v]"');
    expect(program?.output).toBe('host_r_program.mp4');
    expect(program?.video).toEqual(['host_r.mp4']);
    expect(program?.note).toContain('H.264');
  });
});

describe('programMix: the note of a camera take', () => {
  it('says what to do when ffmpeg stops on a file that has no picture', () => {
    const note = programOf(withChecks(take))?.note ?? '';
    expect(note).toContain("If ffmpeg says that ':v' matches no streams, a file in video has no picture");
    expect(note).toContain("If ffmpeg says that ':a' matches no streams");
    expect(note).toContain('keep its input, take its [k:v] chain out of the filter and its label out of xstack');
    expect(note).toContain('if one camera is left, replace the xstack filter and its pad with pad=1920:1080:-1:-1');
    expect(note).toContain('Its sound is already in the mix');
    expect(note).toContain('a file in audio has no sound track: take its input and its adelay out.');
  });
});

describe('programMix: a resumed take with no host WAV', () => {
  it("reads the host's resumed camera file once and mixes it once", () => {
    const input = withChecks({
      ...take,
      hostFile: 'host_r_resumed.mp4',
      hostWavFile: undefined,
      resumed: true,
      hostParts: [
        { name: 'host-ana_r.mp4', offsetMs: 0, kind: 'camera' },
        { name: 'host_r_resumed.mp4', offsetMs: 20_000, kind: 'camera' },
      ],
    });
    const program = programOf(input);
    expect(program?.video).toEqual(['host_r_resumed.mp4', 'guest_r.mp4']);
    expect([...(program?.audio ?? [])].sort()).toEqual(['guest_r.wav', 'host-ana_r.mp4', 'host_r_resumed.mp4']);
    expect(program?.cmd.match(/-i "host_r_resumed\.mp4"/g)).toHaveLength(1);
    expect(program?.cmd).toContain('amix=inputs=3:normalize=0[a]');
  });
});
