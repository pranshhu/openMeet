import { RECORDING_FRAME_RATE, WAV_BIT_DEPTH, WAV_SAMPLE_RATE, type Role } from '@openmeet/protocol';
import { cleanFps } from './quality';

export interface ChapterMarker {
  /** Milliseconds from the host's recording start. */
  atMs: number;
  label: string;
  from: Role;
  name?: string;
}

export interface ChatMessage {
  from: Role;
  text: string;
  ts: number;
  fromPeerId?: string;
  fromName?: string;
  self?: boolean;
}

export interface GuestSyncInput {
  /** 0 writes `guest_*`, n writes `guest<n+1>_*`. */
  slot: number;
  name?: string | undefined;
  file: string;
  /** Only when the WAV master actually received bytes. */
  wavFile?: string | undefined;
  startHostMs: number | null; // guest recorder start on the host clock, or null if sync failed
  rttMs: number | null;
  /** Set when the guest's drain hit its cap with data still queued. */
  drained?: boolean | undefined;
  noWav?: boolean | undefined;
  abandoned?: boolean | undefined;
  timedOut?: boolean | undefined;
  endedEarly?: boolean | undefined;
  /** What this guest's camera track reported when its recorder started, if the host knows. */
  trackFps?: number | null | undefined;
}

export interface ScreenSegmentInput {
  file: string;
  /** Start relative to the host recording start. */
  offsetMs: number;
  endedEarly?: boolean | undefined;
  sharer?: string | undefined;
}

export interface CallCopyInput {
  file: string;
  /** Start relative to the host recording start. */
  offsetMs: number;
  /** Whose audio it is, when the guest gave a name. */
  name?: string | undefined;
}

/** What the host measured about one file once the take has ended. */
export interface FileCheck {
  /** Size on the host's disk. */
  bytes: number;
  /** Only for a file that arrived from another participant. */
  received?:
    | {
        /** The sender said it had sent everything. */
        finalized: boolean;
        /** The sender gave up because its upload fell too far behind. */
        abandoned: boolean;
        /** Digest of what the sender sent, as the sender reported it. */
        sha256Sent?: string | undefined;
        /** Digest of what the host wrote. */
        sha256Written: string;
      }
    | undefined;
}

export interface FileVerdict {
  status: 'complete' | 'unverified' | 'incomplete';
  text: string;
}

export interface SyncReportInput {
  recordingId: string;
  hostFile?: string | undefined;
  hostStartMs: number;
  markers?: ChapterMarker[] | undefined;
  /** Uncompressed audio master, if PCM capture ran. */
  hostWavFile?: string | undefined;
  /** Every guest slot that wrote a file, lowest slot first. */
  guests: GuestSyncInput[];
  /** Screen-share segments, in order. */
  screenSegments?: ScreenSegmentInput[] | undefined;
  /** What the host's camera track reported when the take started. */
  hostTrackFps?: number | null | undefined;
  /** One entry per file in the folder, keyed by file name. */
  checks?: ReadonlyMap<string, FileCheck> | undefined;
  /** The host's own copies of each guest's live call audio, in the order they were opened. */
  callCopies?: CallCopyInput[] | undefined;
}

export interface SummaryFile {
  name: string;
  kind: 'video' | 'audio' | 'screen' | 'call';
  detail?: string | undefined;
  participant?: string | undefined;
  bytes?: number | undefined;
  verdict?: FileVerdict | undefined;
}

export interface SyncReport {
  guestMinusHostMs: number | null;
  summary: string; // one-line UI text
  json: string; // sidecar file content (<id>.sync.json)
  chapters: string; // chapters.txt, pasteable into a YouTube/podcast description
  data: SyncReportData; // same content, structured — the summary screen reads this
}

export interface SyncReportData {
  files: { host?: string; [key: string]: string | undefined };
  fileList: SummaryFile[];
  audioMasters: { host: string | null; [key: string]: string | null };
  screenFiles: string[];
  screenSegments?: ScreenSegmentInput[];
  alignment: string;
  backupNote: string;
  integrity: { ok: boolean; text: string };
  warnings: string[];
  markers: { at: string; atMs: number; label: string; from: string; name?: string }[];
  commands: { label: string; cmd: string }[];
  guests?: {
    slot: number;
    name?: string;
    file: string;
    wavFile?: string | null;
    offsetMs: number | null;
    integrity: { ok: boolean; text: string };
    abandoned?: boolean;
    timedOut?: boolean;
    endedEarly?: boolean;
  }[];
}

/** `H:MM:SS` past one hour, `M:SS` below it — the convention YouTube parses. */
export function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** `1.5 GB`, `812 MB`, `44 kB`, `0 B`: decimal units, as file managers show them. */
export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} kB`;
  return `${n} B`;
}

// Names, chapter labels and chat text originate from other participants and
// are written directly to the host's disk. Every run of control characters,
// separators and bidirectional controls becomes one space; joiners are kept
// so joined emoji and scripts that need them survive.
export const sanitizeText = (s: string) => s.replace(/[\p{Cc}\p{Z}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]+/gu, ' ');

// A name comes from another participant and ends up in text on the host's disk.
const whoOf = (name: unknown, fallback: string): string =>
  (typeof name === 'string' ? sanitizeText(name).trim() : '') || fallback;

/**
 * Chapter list in description format.
 *
 * A leading 0:00 entry is synthesised when the first marker isn't at the very
 * start, because YouTube silently ignores the whole list otherwise. The output
 * is meant to be pasted as-is, so it has to be valid without editing.
 */
export function buildChapters(markers: ChapterMarker[]): string {
  const sorted = [...markers].sort((a, b) => a.atMs - b.atMs);
  const lines = sorted.map((m) => {
    const clean = sanitizeText(m.label || '').trim();
    return `${formatTimecode(m.atMs)} ${clean || 'Marker'}`;
  });
  if (sorted.length === 0) return '';
  if ((sorted[0] as ChapterMarker).atMs >= 1000) lines.unshift('0:00 Start');
  return lines.join('\n') + '\n';
}

export const MAX_CHAT_MESSAGE_LENGTH = 4000;

/** Plain chat log of the take: [m:ss] role Name: text. */
export function buildChatLog(
  messages: ChatMessage[],
  opts: { startMs: number; endMs: number; localName: string }
): string {
  const inWindow = messages.filter((m) => m.ts >= opts.startMs && m.ts <= opts.endMs);
  if (inWindow.length === 0) return '';
  const lines = inWindow.map((m) => {
    const time = formatTimecode(m.ts - opts.startMs);
    const rawName = m.self ? (opts.localName || m.fromName) : m.fromName;
    const speaker = rawName ? `${m.from} ${sanitizeText(rawName)}` : m.from;
    const text = sanitizeText(m.text);
    return `[${time}] ${speaker}: ${text}`;
  });
  return lines.join('\n') + '\n';
}

function remuxCmd(file: string): string {
  const out = file.replace(/\.[^.]+$/, '') + '_seekable.mp4';
  // -tag:v avc1 re-tags the video track regardless of whether it was recorded as
  // avc1 or avc3 (same H.264 bytestream, different parameter-set signalling) — the
  // file an editor opens is always avc1, which is the tag editors expect.
  return `ffmpeg -i "${file}" -c copy -tag:v avc1 -movflags +faststart "${out}"`;
}

/**
 * Pair a video file with its uncompressed audio master, losslessly.
 *
 * The output is .mov, not .mp4: MP4 has no standard way to carry linear PCM, so
 * muxing the WAV into MP4 would mean re-encoding the audio and throwing away the
 * exact thing the WAV exists to preserve. MOV carries PCM natively, and every
 * editor that opens MP4 opens MOV.
 */
function muxWavCmd(video: string, wav: string): string {
  const out = video.replace(/\.[^.]+$/, '') + '_master.mov';
  return `ffmpeg -i "${video}" -i "${wav}" -map 0:v -map 1:a -c:v copy -c:a copy -tag:v avc1 "${out}"`;
}

const seconds = (ms: number) => (ms / 1000).toFixed(3);

// The remux with a start delay. Real padding would mean encoding black frames,
// so the delay is an empty edit in the container and the stream is copied as is.
function alignVideoCmd(file: string, padMs: number): string {
  const out = file.replace(/\.[^.]+$/, '') + '_aligned.mp4';
  return `ffmpeg -itsoffset ${seconds(padMs)} -i "${file}" -c copy -tag:v avc1 -movflags +faststart "${out}"`;
}

// PCM in, PCM out at the depth the master was written in, so every sample after
// the silence is the one in the master. all=1 delays every channel, not only the
// first; the depth is named because ffmpeg writes 16-bit WAV otherwise; -rf64
// keeps a copy that crosses 4 GiB readable.
function alignWavCmd(file: string, padMs: number): string {
  const out = file.replace(/\.[^.]+$/, '') + '_aligned.wav';
  return `ffmpeg -i "${file}" -af "adelay=${padMs}:all=1" -c:a pcm_s${WAV_BIT_DEPTH}le -rf64 auto "${out}"`;
}

const ALIGNED_HINT =
  "The aligned-copy commands under Editor commands write copies that start when the host's recording starts, " +
  "so each copy lines up with the host's files at 00:00 on a timeline. Audio copies get real silence. " +
  'Video copies are not re-encoded: the delay is stored in the file, and an editor that ignores it needs ' +
  'the clip moved by the time shown with its command.';

const FRAME_RATE_NOTE =
  "MediaRecorder has no constant-frame-rate setting, so the frame rate inside these files can vary. requestedFps is the rate a camera is asked for by default. trackFps is what the browser reported that camera running at when its recording started, or null when that was not reported; a screen is only captured when it changes, so screen files have none. Neither is a count of the frames in a file. For that, run the file's measure command: it decodes the file with your own ffmpeg, and its last VFR line reads 0.000000 when every frame interval is the same.";

const CONFORM_NOTE =
  'Each conform command re-encodes the video to a constant frame rate: trackFps when it is known, requestedFps otherwise. That is not lossless and it is slow; the audio is copied untouched. Run it only when an editor drifts or refuses a file. The result is seekable, so it replaces the remux for that file; for every other file the lossless remux under seekability is still the one to run.';

/**
 * ffmpeg's spelling of a frame rate: the NTSC rates as the exact fractions
 * editors use, the rest as reported.
 */
function ffmpegRate(fps: number): string {
  for (const n of [24000, 30000, 60000]) {
    if (Math.abs(fps - n / 1001) < 0.01) return `${n}/1001`;
  }
  return String(fps);
}

// Runs on the user's machine: vfrdet counts the frame intervals that differ.
// The tab writes the encoder's bytes without reading them back, so it has no
// such count to offer.
function measureFpsCmd(file: string): string {
  return `ffmpeg -hide_banner -i "${file}" -an -vf vfrdet -f null -`;
}

/**
 * Re-encode to a constant frame rate. Unlike remuxCmd this is not lossless: a
 * frame rate cannot be changed by copying the stream. The fps filter rather
 * than -fps_mode or -vsync, because -fps_mode is missing before ffmpeg 5.1 and
 * -vsync is deprecated after it; the filter works in both. Audio is copied.
 */
function conformCmd(file: string, fps: number): string {
  const out = file.replace(/\.[^.]+$/, '') + '_cfr.mp4';
  return `ffmpeg -i "${file}" -vf fps=${ffmpegRate(fps)} -c:v libx264 -crf 18 -c:a copy -movflags +faststart "${out}"`;
}

/**
 * One video file's frame-rate entry. The reported rate is bounded here, where
 * it becomes part of a command, whatever the caller was handed.
 */
function frameRateEntry(file: string, kind: 'camera' | 'screen', reported?: number | null) {
  const trackFps = kind === 'camera' ? cleanFps(reported) : null;
  return {
    file,
    kind,
    trackFps,
    measure: measureFpsCmd(file),
    conform: conformCmd(file, trackFps ?? RECORDING_FRAME_RATE),
  };
}

/** Integrity verdict for the transferred guest track. */
export function integrityVerdict(sent?: string, written?: string): { ok: boolean; text: string } {
  if (!sent || !written) {
    return { ok: false, text: 'Integrity not verified — one of the digests is missing.' };
  }
  return sent === written
    ? { ok: true, text: 'Integrity verified — bytes written match bytes sent (sha256).' }
    : { ok: false, text: 'INTEGRITY MISMATCH — the received file differs from what was sent. Keep the guest backup.' };
}

/**
 * One file's verdict, in words a host can act on.
 *
 * A file that arrived from a guest is complete only when the sender said it
 * had sent everything and the two digests agree; anything short of that says
 * what is missing and where the full copy is. The host's own files never
 * travelled, so there is nothing to compare: they are complete once they
 * hold bytes.
 */
export function fileVerdict(c: FileCheck | undefined, who: string): FileVerdict {
  if (!c) return { status: 'unverified', text: 'Not verified. This file was not checked.' };
  const r = c.received;
  const ask = `Ask ${who} for the backup their browser kept; it is listed in the lobby on their device.`;
  const incomplete = (text: string): FileVerdict => ({ status: 'incomplete', text });
  if (c.bytes === 0) {
    return incomplete(
      r
        ? `Empty. Nothing arrived from ${who}. If they were recording, ask them for the backup their browser kept; it is listed in the lobby on their device.`
        : "Empty. Nothing was recorded. Your browser's backup, if it caught anything, is under Safety copies in the session summary; download it before you leave the call."
    );
  }
  if (!r) return { status: 'complete', text: 'Complete. Recorded on this computer.' };
  if (r.abandoned) {
    return incomplete(
      `Incomplete. The upload from ${who} fell too far behind and stopped, so this file ends early. ${ask}`
    );
  }
  if (r.sha256Sent) {
    return r.sha256Sent === r.sha256Written
      ? { status: 'complete', text: `Complete. Matches what ${who} sent (SHA-256).` }
      : incomplete(
          `Incomplete. Part of this file is missing or damaged: it differs from what ${who} sent (SHA-256). ${ask}`
        );
  }
  if (r.finalized) {
    return { status: 'unverified', text: `Complete, not verified. No checksum arrived from ${who} to compare.` };
  }
  return incomplete(`Incomplete. No finish signal arrived from ${who}, so this file may end early. ${ask}`);
}

/**
 * Builds the editor companion for a finished recording:
 *  - #2 alignment: the start-time offset between the host and guest files so they
 *    can be lined up on a multicam timeline (they start at independent click times).
 *  - #3 seekability: a lossless (no re-encode) ffmpeg remux that adds a seek index
 *    + faststart, since MediaRecorder writes the container progressively.
 * Pure — no I/O — so it is fully unit-testable; the caller writes/downloads `json`.
 */
export function buildSyncReport(input: SyncReportInput): SyncReport {
  const { recordingId, hostFile, hostStartMs, guests } = input;
  const markers = input.markers ?? [];
  const screenSegments = input.screenSegments ?? [];
  const screenFiles = screenSegments.map((s) => s.file);
  // A guest's display name is theirs to choose, and this goes to the host's disk.
  const callCopies = (input.callCopies ?? []).map((c) => {
    const name = typeof c.name === 'string' ? sanitizeText(c.name).trim() : '';
    return { file: c.file, offsetMs: c.offsetMs, ...(name ? { name } : {}) };
  });

  const filesRecord: SyncReportData['files'] = hostFile ? { host: hostFile } : {};
  const audioMastersRecord: SyncReportData['audioMasters'] = { host: input.hostWavFile ?? null };
  const remuxCommands: { label: string; cmd: string }[] = hostFile
    ? [{ label: 'Make the host file seekable (lossless)', cmd: remuxCmd(hostFile) }]
    : [];
  const seekabilityMap: Record<string, string> = hostFile
    ? { remuxHost: remuxCmd(hostFile) }
    : {};
  const combineMap: Record<string, string> = {
    ...(input.hostWavFile && hostFile ? { host: muxWavCmd(hostFile, input.hostWavFile) } : {}),
  };
  const combineCommands: { label: string; cmd: string }[] = input.hostWavFile && hostFile
    ? [{ label: 'Host: pair video with the uncompressed audio master', cmd: muxWavCmd(hostFile, input.hostWavFile) }]
    : [];

  const warnings: string[] = [];
  const guestReports: NonNullable<SyncReportData['guests']> = [];
  const timelineGuests: {
    slot: number;
    name: string | undefined;
    file: string;
    startUnixMs: number | null;
    offsetMs: number | null;
    rttMs: number | null;
  }[] = [];
  const alignmentLines: string[] = [];

  const alignedFiles: { file: string; padMs: number | null; cmd?: string }[] = [];
  const alignCommands: { label: string; cmd: string }[] = [];
  const align = (file: string, offsetMs: number | null, who: string, wav = false) => {
    // Zero is the floor: a guest starts on the host's signal, so an estimate
    // that puts it before the host is clock-sync error, and zero is nearer the
    // truth than the estimate.
    const padMs =
      offsetMs === null || !Number.isFinite(offsetMs) ? null : Math.max(0, Math.round(offsetMs));
    if (!padMs) {
      alignedFiles.push({ file, padMs });
      return;
    }
    const cmd = wav ? alignWavCmd(file, padMs) : alignVideoCmd(file, padMs);
    alignedFiles.push({ file, padMs, cmd });
    alignCommands.push({
      label: wav
        ? `${who}: aligned copy of the audio master (${seconds(padMs)} s of silence added)`
        : `${who}: aligned copy of the video (starts ${seconds(padMs)} s in)`,
      cmd,
    });
  };
  if (hostFile) align(hostFile, 0, 'Host');
  if (input.hostWavFile) align(input.hostWavFile, 0, 'Host', true);

  for (const g of guests) {
    const { slot } = g;
    const key = slot === 0 ? 'guest' : `guest${slot + 1}`;
    const defaultName = slot === 0 ? 'Guest' : `Guest ${slot + 1}`;
    const displayName = g.name || defaultName;

    filesRecord[key] = g.file;
    audioMastersRecord[key] = g.wavFile ?? null;

    const remuxKey = slot === 0 ? 'remuxGuest' : `remuxGuest${slot + 1}`;
    seekabilityMap[remuxKey] = remuxCmd(g.file);
    remuxCommands.push({
      label: `Make the ${slot === 0 && !g.name ? 'guest' : displayName} file seekable (lossless)`,
      cmd: remuxCmd(g.file),
    });

    if (g.wavFile) {
      combineMap[key] = muxWavCmd(g.file, g.wavFile);
      combineCommands.push({
        label: `${slot === 0 && !g.name ? 'Guest' : displayName}: pair video with the uncompressed audio master`,
        cmd: muxWavCmd(g.file, g.wavFile),
      });
    } else if (g.noWav) {
      warnings.push(`no WAV master for ${displayName}`);
    }

    // Offset
    const guestMinusHostMs = g.startHostMs === null ? null : g.startHostMs - hostStartMs;
    align(g.file, guestMinusHostMs, displayName);
    if (g.wavFile) align(g.wavFile, guestMinusHostMs, displayName, true);

    if (guestMinusHostMs === null) {
      if (guests.length === 1) {
        warnings.push('Clock sync did not converge, so the start offset is unknown. Align by waveform.');
        alignmentLines.push('Clock sync unavailable — align the two files by their audio waveform (clap/slate).');
      } else {
        warnings.push(`Clock sync did not converge for ${displayName}, so the start offset is unknown. Align by waveform.`);
        alignmentLines.push(`Clock sync unavailable for ${displayName} — align by audio waveform.`);
      }
    } else {
      if (guests.length === 1 && !g.name) {
        alignmentLines.push(
          guestMinusHostMs >= 0
            ? `Guest started ${guestMinusHostMs} ms AFTER host. Shift the guest clip +${guestMinusHostMs} ms (later) relative to host.`
            : `Guest started ${-guestMinusHostMs} ms BEFORE host. Shift the guest clip ${guestMinusHostMs} ms (earlier) relative to host.`
        );
      } else {
        alignmentLines.push(
          guestMinusHostMs >= 0
            ? `${displayName} started ${guestMinusHostMs} ms AFTER host. Shift the ${displayName} clip +${guestMinusHostMs} ms (later) relative to host.`
            : `${displayName} started ${-guestMinusHostMs} ms BEFORE host. Shift the ${displayName} clip ${guestMinusHostMs} ms (earlier) relative to host.`
        );
      }
    }

    // Integrity: the camera file's verdict, under the key scripts already read.
    const camera = fileVerdict(input.checks?.get(g.file), whoOf(g.name, 'the guest'));
    const integrity = { ok: camera.status === 'complete', text: camera.text };

    if (g.drained === false) {
      warnings.push(
        guests.length === 1
          ? 'The guest could not finish sending within the drain window — the guest file may be short. Use the guest backup for the tail.'
          : `${displayName} could not finish sending within the drain window — the file may be short. Use the guest backup for the tail.`
      );
    }

    const endedEarly = Boolean(g.abandoned || g.timedOut || g.endedEarly);
    const abandoned = Boolean(g.abandoned);
    const timedOut = Boolean(g.timedOut);

    guestReports.push({
      slot,
      ...(g.name ? { name: g.name } : {}),
      file: g.file,
      wavFile: g.wavFile ?? null,
      offsetMs: guestMinusHostMs,
      integrity,
      ...(abandoned ? { abandoned: true } : {}),
      ...(timedOut ? { timedOut: true } : {}),
      ...(endedEarly ? { endedEarly: true } : {}),
    });
    timelineGuests.push({
      slot,
      name: g.name,
      file: g.file,
      startUnixMs: g.startHostMs,
      offsetMs: guestMinusHostMs,
      rttMs: g.rttMs,
    });
  }

  const primaryGuestMinusHostMs = guestReports[0]?.offsetMs ?? null;

  const backupNote =
    "The offset applies to guest_* files written by the host, not to a participant's own backup copy, which started at a different instant.";

  const alignment = alignmentLines.join('\n');

  const fileList: SummaryFile[] = [
    ...(hostFile ? [{ name: hostFile, kind: 'video' as const }] : []),
    ...guests.map((g) => ({
      name: g.file,
      kind: 'video' as const,
      ...(g.name ? { participant: g.name } : {}),
    })),
    ...(input.hostWavFile ? [{ name: input.hostWavFile, kind: 'audio' as const }] : []),
    ...guests
      .filter((g) => Boolean(g.wavFile))
      .map((g) => ({
        name: g.wavFile!,
        kind: 'audio' as const,
        ...(g.name ? { participant: g.name } : {}),
      })),
    ...screenSegments.map((s) => {
      const sharer = s.sharer;
      const parts = [
        sharer,
        `+${s.offsetMs}ms`,
      ].filter(Boolean);
      return {
        name: s.file,
        kind: 'screen' as const,
        detail: parts.join(', '),
        ...(sharer ? { participant: sharer } : {}),
      };
    }),
    ...callCopies.map((c) => ({
      name: c.file,
      kind: 'call' as const,
      detail: [c.name, `+${c.offsetMs}ms`].filter(Boolean).join(', '),
      ...(c.name ? { participant: c.name } : {}),
    })),
  ].map((f: SummaryFile) => {
    const c = input.checks?.get(f.name);
    const who = whoOf(f.participant, f.kind === 'screen' ? 'the sharer' : 'the guest');
    return { ...f, ...(c ? { bytes: c.bytes } : {}), verdict: fileVerdict(c, who) };
  });

  const flagged = fileList.filter((f) => f.verdict?.status !== 'complete').length;
  const overallIntegrity =
    flagged === 0
      ? { ok: true, text: 'Every file is complete.' }
      : {
          ok: false,
          text: `Not every file is complete and verified (${flagged} of ${fileList.length}). Each file's verdict says why.`,
        };
  if (!overallIntegrity.ok) warnings.push(overallIntegrity.text);

  const screenRemuxCommands = screenFiles.map((f, i) => ({
    label: `Make screen segment ${i + 1} seekable`,
    cmd: remuxCmd(f),
  }));
  screenSegments.forEach((s, i) => align(s.file, s.offsetMs, `Screen segment ${i + 1}`));

  const commands: { label: string; cmd: string }[] = [
    ...remuxCommands,
    ...screenRemuxCommands,
    ...combineCommands,
    ...alignCommands,
  ];

  const report = {
    recordingId,
    files: filesRecord,
    timeline: {
      hostStartUnixMs: hostStartMs,
      guestStartUnixMs: guests[0]?.startHostMs ?? null, // expressed on the host clock
      guestMinusHostMs: primaryGuestMinusHostMs,
      clockSyncRttMs: guests[0]?.rttMs ?? null,
      ...(guests.length > 1 ? { guests: timelineGuests } : {}),
      ...(screenSegments.length > 0 ? { screenSegments } : {}),
    },
    alignment,
    backupNote,
    markers: markers
      .slice()
      .sort((a, b) => a.atMs - b.atMs)
      .map((m) => ({
        at: formatTimecode(m.atMs),
        atMs: m.atMs,
        label: m.label,
        from: m.from,
        ...(m.name ? { name: m.name } : {}),
      })),
    audioMasters: {
      ...audioMastersRecord,
      // The rate is fixed: capture runs the mic through an AudioContext at
      // WAV_SAMPLE_RATE, so a device that runs at another rate is resampled.
      note:
        `Uncompressed ${WAV_BIT_DEPTH}-bit PCM at ${WAV_SAMPLE_RATE / 1000} kHz, whatever rate the ` +
        'microphone ran at. Edit from these; the MP4 audio track is the convenience copy.',
    },
    screenFiles,
    ...(screenSegments.length > 0 ? { screenSegments } : {}),
    ...(guests.length > 0 ? { guests: guestReports } : {}),
    ...(callCopies.length > 0
      ? {
          callCopies: {
            note: "The host's own recording of each guest's live call audio: call quality, as the host heard it. A fallback for a guest track that is missing or short. Place each file at its offsetMs from the host start.",
            files: callCopies,
          },
        }
      : {}),
    integrity: overallIntegrity.text,
    verification: fileList.map((f) => ({
      file: f.name,
      bytes: f.bytes ?? null,
      status: f.verdict?.status,
      detail: f.verdict?.text,
    })),
    warnings,
    seekability: {
      note: 'MediaRecorder writes MP4 progressively and may lack a seek index/duration until remuxed. This is lossless (no re-encode) and fast.',
      ...seekabilityMap,
      ...(screenFiles.length > 0 ? { remuxScreen: screenFiles.map(remuxCmd) } : {}),
    },
    combine: {
      note: 'Pairs each camera file with its uncompressed audio master, losslessly. Output is .mov because MP4 cannot carry linear PCM without re-encoding.',
      ...combineMap,
    },
    aligned: {
      note:
        "Each cmd writes a copy that starts at the host's recording start, so the copies and the host's own files " +
        'all go at 00:00 on a timeline. padMs is how late the file starts: 0 needs no copy, null means the start ' +
        "is unknown (align by waveform). A start estimated before the host's counts as 0. WAV copies get real " +
        'silence, losslessly. MP4 copies are not re-encoded and are seekable like the remux copies: the delay is ' +
        'stored as an edit list, and an editor that ignores it needs the clip moved by padMs.',
      files: alignedFiles,
    },
    frameRate: {
      note: FRAME_RATE_NOTE,
      requestedFps: RECORDING_FRAME_RATE,
      conformNote: CONFORM_NOTE,
      files: [
        ...(hostFile ? [frameRateEntry(hostFile, 'camera', input.hostTrackFps)] : []),
        ...guests.map((g) => frameRateEntry(g.file, 'camera', g.trackFps)),
        ...screenFiles.map((f) => frameRateEntry(f, 'screen')),
      ],
    },
    generatedBy: 'openMeet',
  };

  const summary =
    primaryGuestMinusHostMs === null
      ? 'Clock sync unavailable — align tracks by waveform (see sync.json).'
      : `Guest started ${primaryGuestMinusHostMs >= 0 ? '+' : ''}${primaryGuestMinusHostMs} ms vs host (±${guests[0]?.rttMs ?? '?'} ms RTT). See sync.json.`;

  return {
    guestMinusHostMs: primaryGuestMinusHostMs,
    summary,
    json: JSON.stringify(report, null, 2),
    chapters: buildChapters(markers),
    data: {
      files: filesRecord,
      fileList,
      audioMasters: audioMastersRecord,
      screenFiles,
      ...(screenSegments.length > 0 ? { screenSegments } : {}),
      alignment: alignCommands.length > 0 ? [alignment, ALIGNED_HINT].filter(Boolean).join('\n') : alignment,
      backupNote,
      integrity: overallIntegrity,
      warnings,
      markers: report.markers,
      commands,
      ...(guests.length > 0 ? { guests: guestReports } : {}),
    },
  };
}
