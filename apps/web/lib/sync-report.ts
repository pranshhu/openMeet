import type { Role } from '@openmeet/protocol';

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
  /** sha256 of what the guest SENT vs what the host WROTE. */
  sha256Sent?: string | undefined;
  sha256Written?: string | undefined;
  /** Set when the guest's drain hit its cap with data still queued. */
  drained?: boolean | undefined;
  noWav?: boolean | undefined;
  abandoned?: boolean | undefined;
  timedOut?: boolean | undefined;
  endedEarly?: boolean | undefined;
}

export interface ScreenSegmentInput {
  file: string;
  /** Start relative to the host recording start. */
  offsetMs: number;
  endedEarly?: boolean | undefined;
  sharer?: string | undefined;
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
}

export interface SummaryFile {
  name: string;
  kind: 'video' | 'audio' | 'screen';
  detail?: string | undefined;
  participant?: string | undefined;
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

// Names, chapter labels and chat text originate from other participants and
// are written directly to the host's disk. Every run of control characters,
// separators and bidirectional controls becomes one space; joiners are kept
// so joined emoji and scripts that need them survive.
export const sanitizeText = (s: string) => s.replace(/[\p{Cc}\p{Z}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]+/gu, ' ');

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

    // Integrity
    const integrity = integrityVerdict(g.sha256Sent, g.sha256Written);
    if (!integrity.ok) {
      warnings.push(guests.length === 1 ? integrity.text : `${displayName}: ${integrity.text}`);
    }

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

    if (endedEarly) {
      warnings.push(
        guests.length === 1
          ? `The guest stream ${abandoned ? 'was abandoned due to backlog' : 'timed out'} and ended early — use the guest backup for the complete recording.`
          : `${displayName} stream ${abandoned ? 'was abandoned due to backlog' : 'timed out'} and ended early — use their backup for the complete recording.`
      );
    }

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

  for (const s of screenSegments) {
    if (s.endedEarly) {
      warnings.push(
        `Screen segment ${s.file} ended early — use the sharer's screen backup for the complete recording.`
      );
    }
  }

  const primaryGuestMinusHostMs = guestReports[0]?.offsetMs ?? null;

  const overallIntegrity =
    guests.length === 0
      ? { ok: true, text: 'Integrity verified — bytes written match bytes sent (sha256).' }
      : guests.length === 1
        ? guestReports[0]!.integrity
        : guestReports.every((g) => g.integrity.ok)
          ? { ok: true, text: 'Integrity verified — bytes written match bytes sent (sha256).' }
          : {
              ok: false,
              text: guestReports
                .filter((g) => !g.integrity.ok)
                .map((g) => `${g.name || `Guest ${g.slot + 1}`}: ${g.integrity.text}`)
                .join(' '),
            };

  const backupNote =
    "The offset applies to guest_* files written by the host, not to a participant's own backup copy, which started at a different instant.";

  const alignment = alignmentLines.join('\n');

  const fileList: SummaryFile[] = [
    ...(hostFile ? [{ name: hostFile, kind: 'video' as const }] : []),
    ...guests.map((g) => ({
      name: g.file,
      kind: 'video' as const,
      ...(g.name ? { participant: g.name } : {}),
      ...(g.abandoned || g.timedOut || g.endedEarly ? { detail: 'ended early — use backup' } : {}),
    })),
    ...(input.hostWavFile ? [{ name: input.hostWavFile, kind: 'audio' as const }] : []),
    ...guests
      .filter((g) => Boolean(g.wavFile))
      .map((g) => ({
        name: g.wavFile!,
        kind: 'audio' as const,
        ...(g.name ? { participant: g.name } : {}),
        ...(g.abandoned || g.timedOut || g.endedEarly ? { detail: 'ended early — use backup' } : {}),
      })),
    ...screenSegments.map((s) => {
      const sharer = s.sharer;
      const parts = [
        sharer,
        `+${s.offsetMs}ms`,
        s.endedEarly ? 'ended early — use backup' : undefined,
      ].filter(Boolean);
      return {
        name: s.file,
        kind: 'screen' as const,
        detail: parts.join(', '),
        ...(sharer ? { participant: sharer } : {}),
      };
    }),
  ];

  const screenRemuxCommands = screenFiles.map((f, i) => ({
    label: `Make screen segment ${i + 1} seekable`,
    cmd: remuxCmd(f),
  }));

  const commands: { label: string; cmd: string }[] = [
    ...remuxCommands,
    ...screenRemuxCommands,
    ...combineCommands,
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
      // No sample rate claimed. The requested 48kHz is `ideal`, so the device
      // is free to give 44.1k and does — ffprobe on a real capture proved the
      // note was wrong. The WAV header carries the truth; every editor reads it
      // from there anyway.
      note: 'Uncompressed 24-bit PCM at the capture rate. Edit from these; the MP4 audio track is the convenience copy.',
    },
    screenFiles,
    ...(screenSegments.length > 0 ? { screenSegments } : {}),
    ...(guests.length > 0 ? { guests: guestReports } : {}),
    integrity: overallIntegrity.text,
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
      alignment,
      backupNote,
      integrity: overallIntegrity,
      warnings,
      markers: report.markers,
      commands,
      ...(guests.length > 0 ? { guests: guestReports } : {}),
    },
  };
}
