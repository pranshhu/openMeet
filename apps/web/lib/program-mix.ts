import { RECORDING_FRAME_RATE, WAV_BIT_DEPTH } from '@openmeet/protocol';
import type { SummaryFile, SyncReportInput } from './sync-report';
import { WAV_HEADER_BYTES } from './wav';

const PROGRAM_NOTE =
  "cmd writes one file, named in output, and changes none of the take's files. It shows each camera in video in a " +
  'grid on a 1920x1080 picture at 30 frames a second, the first top left, and mixes the files in audio. Each file ' +
  'is placed by its padMs under aligned: a person who started later is black and silent until then, and a person ' +
  'whose file ends first stays as a still picture. It re-encodes to H.264 and AAC, so it is slow and not lossless. ' +
  'Voices are added at the level they were recorded. Run it in the recording folder with ffmpeg 4.4 or later. ' +
  "leftOut names every file of the take that cmd does not read, and why. If ffmpeg says that ':a' matches " +
  'no streams, a file in audio has no sound track: take its input and its adelay out. ' +
  "If ffmpeg says that ':v' matches no streams, a file in video has no picture (a person recorded without a " +
  'camera whose take did not finish cleanly, or a take saved from its crash copy): ' +
  "keep its input, take its [k:v] chain out of the filter and its label out of xstack, and lower xstack's " +
  'inputs by one; if one camera is left, replace the xstack filter and its pad with pad=1920:1080:-1:-1. ' +
  'Its sound is already in the mix. Or ask for the take again.';

const SOUND_NOTE =
  "cmd writes one file, named in output, and changes none of the take's files. Nobody in this take was recorded " +
  'with a camera, so it is sound only: the files in audio mixed into one WAV at the depth of the masters. Each file ' +
  'is placed by its padMs under aligned, so a person who started later is silent until then. Voices are added at ' +
  'the level they were recorded, and the mix is not compressed. Run it in the recording folder with ffmpeg 4.4 or ' +
  'later. leftOut names every file of the take that cmd does not read, and why.';

const WIDTH = 1920;
const HEIGHT = 1080;

const WHY_EMPTY = 'no recording in this file';
const WHY_SCREEN = 'screen recording: the program file shows cameras only';
const WHY_CALL = 'call-audio copy: a fallback, not a master';
const WHY_UNPLACED = 'start unknown: clock sync did not converge, so it cannot be placed';
const WHY_BEFORE_RELOAD =
  "the host's camera before the reload: the host's place in the grid is black until the file after the reload starts";
const WHY_NO_PICTURE = "no picture, and the same sound is in this person's WAV master";
const WHY_UNUSED = 'not used';

export interface ProgramMix {
  /** The summary's row for the command. */
  row: { label: string; cmd: string };
  /** The `program` section of the sync file. */
  section: {
    note: string;
    output: string;
    cmd: string;
    video: string[];
    audio: string[];
    leftOut: { file: string; why: string }[];
  };
}

interface Person {
  /** The files in the camera's place: the camera file, and for the host the camera files of earlier parts. */
  cameras: string[];
  wavs: string[];
  /** The one camera file that may give a picture. */
  tile: string | undefined;
}

/**
 * One ffmpeg command that lays every camera of the take in a grid and mixes
 * everyone's sound, each file placed by the padMs the report holds for it, or
 * when nobody has a camera, one that mixes the sound into a WAV; null when
 * the take has no such command. Only files the host measured and
 * found to hold something are read, so a report built without checks has none.
 */
export function programMix(
  input: SyncReportInput,
  aligned: readonly { file: string; padMs: number | null }[],
  fileList: readonly SummaryFile[]
): ProgramMix | null {
  const checks = input.checks;
  if (!checks) return null;
  const pads = new Map(aligned.map((a) => [a.file, a.padMs]));
  const padOf = (file: string): number | null => {
    const p = pads.get(file) ?? -1;
    return Number.isSafeInteger(p) && p >= 0 ? p : null;
  };
  const hasContent = (file: string) => {
    const bytes = checks.get(file)?.bytes;
    return typeof bytes === 'number' && bytes > (file.endsWith('.wav') ? WAV_HEADER_BYTES : 0);
  };
  const usable = (file: string) => hasContent(file) && padOf(file) !== null;
  const hasPicture = (file: string) => checks.get(file)?.audioOnly !== true;

  const hostParts = input.hostParts ?? [];
  const extras = hostParts.filter((p) => p.name !== input.hostFile && p.name !== input.hostWavFile);
  const people: Person[] = [
    {
      cameras: [...(input.hostFile ? [input.hostFile] : []), ...extras.filter((p) => p.kind === 'camera').map((p) => p.name)],
      wavs: [...(input.hostWavFile ? [input.hostWavFile] : []), ...extras.filter((p) => p.kind === 'wav').map((p) => p.name)],
      tile: input.hostFile,
    },
    ...input.guests.map((g) => ({ cameras: [g.file], wavs: g.wavFile ? [g.wavFile] : [], tile: g.file })),
  ];

  const tiles: string[] = [];
  const sounds: string[] = [];
  let present = 0;
  for (const person of people) {
    const tile = person.tile && usable(person.tile) && hasPicture(person.tile) ? person.tile : undefined;
    const wavs = person.wavs.filter(usable);
    const heard = wavs.length > 0 ? wavs : person.cameras.filter(usable);
    if (tile) tiles.push(tile);
    sounds.push(...heard);
    if (tile || heard.length > 0) present++;
  }
  if (present < 2) return null;

  const inputs = [...tiles, ...sounds.filter((s) => !tiles.includes(s))];
  const indexOf = (file: string) => inputs.indexOf(file);

  const n = tiles.length;
  const soundOnly = n === 0;
  const cols = Math.ceil(Math.sqrt(n));
  const w = Math.floor(WIDTH / cols);
  const h = Math.floor((w * 9) / 16);
  const chains = tiles.map((file, i) => {
    const end = n === 1 ? 'v' : `v${i}`;
    return (
      `[${indexOf(file)}:v]fps=${RECORDING_FRAME_RATE},scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${h}:-1:-1,setsar=1,tpad=start_duration=${((padOf(file) as number) / 1000).toFixed(3)}[${end}]`
    );
  });
  const layout = tiles.map((_, i) => `${(i % cols) * w}_${Math.floor(i / cols) * h}`).join('|');
  const stack =
    n <= 1
      ? []
      : [
          `${tiles.map((_, i) => `[v${i}]`).join('')}xstack=inputs=${n}:layout=${layout}:fill=black,` +
            `pad=${WIDTH}:${HEIGHT}:-1:-1[v]`,
        ];
  const delays = sounds.map((file, j) => `[${indexOf(file)}:a]adelay=${padOf(file)}:all=1[a${j}]`);
  const mix = `${sounds.map((_, j) => `[a${j}]`).join('')}amix=inputs=${sounds.length}:normalize=0[a]`;
  const graph = [...chains, ...stack, ...delays, mix].join(';');

  const first = inputs[0] as string;
  const output = first.replace(/\.[^.]+$/, '') + (soundOnly ? '_program.wav' : '_program.mp4');
  const feed = `ffmpeg ${inputs.map((f) => `-i "${f}"`).join(' ')} -filter_complex "${graph}"`;
  const cmd = soundOnly
    ? `${feed} -map "[a]" -c:a pcm_s${WAV_BIT_DEPTH}le -ac 2 -rf64 auto "${output}"`
    : `${feed} -map "[v]" -map "[a]" -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a aac -b:a 192k ` +
      `-ac 2 -movflags +faststart "${output}"`;

  const screens = new Set((input.screenSegments ?? []).map((s) => s.file));
  const copies = new Set((input.callCopies ?? []).map((c) => c.file));
  const beforeReload = new Set(extras.filter((p) => p.kind === 'camera').map((p) => p.name));
  const why = (file: string) => {
    if (!hasContent(file)) return WHY_EMPTY;
    if (screens.has(file)) return WHY_SCREEN;
    if (copies.has(file)) return WHY_CALL;
    if (padOf(file) === null) return WHY_UNPLACED;
    if (beforeReload.has(file) && hasPicture(file)) return WHY_BEFORE_RELOAD;
    if (!hasPicture(file)) return WHY_NO_PICTURE;
    return WHY_UNUSED;
  };
  const leftOut = fileList
    .map((f) => f.name)
    .filter((f) => !inputs.includes(f))
    .map((file) => ({ file, why: why(file) }));

  const head = soundOnly
    ? "Program file: everyone's audio mixed into one WAV"
    : n === 1
      ? "Program file: the camera with everyone's audio mixed (re-encodes, slow)"
      : `Program file: the ${n} cameras in a grid with everyone's audio mixed (re-encodes, slow)`;
  const label = head + (leftOut.length > 0 ? ' The sync file lists the files it leaves out.' : '');

  return {
    row: { label, cmd },
    section: { note: soundOnly ? SOUND_NOTE : PROGRAM_NOTE, output, cmd, video: tiles, audio: sounds, leftOut },
  };
}
