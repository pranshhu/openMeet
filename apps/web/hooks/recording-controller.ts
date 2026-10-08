import type { Role, ChunkAck, ChunkResumeOffset, ClockPong } from '@openmeet/protocol';
import {
  FileWriter,
  pickRecordingDirectory,
  type DirectoryPicker,
  type FsDirectoryHandle,
} from '@/lib/fs-writer';
import { ChunkRecorder, pickRecordingMime, UnsupportedCodecError, pickCallAudioMime } from '@/lib/recorder';
import { ChunkSender } from '@/lib/chunk-sender';
import { ChunkReceiver } from '@/lib/chunk-receiver';
import { BackupRecorder, type OpfsRootGetter } from '@/lib/backup-recorder';
import { ClockSync } from '@/lib/clock-sync';
import { presetForTrack } from '@/lib/quality';
import {
  DATA_CHANNEL_RECORDING,
  DATA_CHANNEL_RECORDING_AUDIO,
  recordingChannelKind,
} from '@openmeet/protocol';
import { PcmRecorder, isPcmCaptureSupported } from '@/lib/pcm-recorder';
import { patchWavHeader } from '@/lib/wav';
import { openTakeJournal, type TakeJournal } from '@/lib/take-journal';
import { copyBackupInto } from '@/lib/take-recovery';
import type { PeerConnection } from '@/lib/peer';
import { sanitizeText } from '@/lib/sync-report';
import type { CallCopyInput, FileCheck, GuestSyncInput, ScreenSegmentInput } from '@/lib/sync-report';

/** Most files one take opens for call copies; a guest who keeps reconnecting gets no more. */
export const CALL_COPY_MAX_FILES = 50;

/**
 * Most files one connection may spend of that budget. Not small on purpose: the
 * host's own reconnect ends every running copy and spends one of each guest's
 * share, so four recorded guests still fit inside the take's files.
 */
export const CALL_COPY_MAX_PER_PEER = 12;

/** Guest files one take opens: three recorded guests plus a reloaded tab each, and a ceiling a guest cannot pass. */
export const MAX_GUEST_SLOTS = 8;

/** New keys one connection may introduce in one take: its own, and one more for a tab that reloaded. */
export const MAX_GUEST_SLOTS_PER_PEER = 2;

/**
 * Screen segments one take journals. Later segments are still recorded, they
 * only have no crash copy: a guest toggling a share must not spend the notes
 * the other guests' recovery needs.
 */
const MAX_GUEST_SCREEN_NOTES = 48;

/** Folder lookups a resumed take makes for one free guest screen file name. */
const MAX_SCREEN_PROBES = 50;

/** One stretch of one guest's live call audio, recorded by the host as a fallback. */
export interface CallCopy {
  peerId: string;
  /** Display name when the copy started; the peer may be gone by the end of the take. */
  name?: string;
  track: MediaStreamTrack;
  writer: FileWriter;
  /** Settles once the file is open and the recorder running, or that was given up. */
  opened: Promise<void>;
  recorder?: ChunkRecorder;
  /** Recorder start on the host clock, for the sync sidecar. */
  startMs?: number;
  /** Set once the copy has been told to stop; resolves when its file is closed. */
  finished?: Promise<void>;
  /** A write or the close failed, so what the folder holds of it is unknown. */
  failed?: boolean;
}

/** One guest's open ingest: its receiver, the channel target and the file behind it. */
type GuestIngest = { receiver: ChunkReceiver; ref: { current: RTCDataChannel | null }; writer?: FileWriter };

export interface RecordingHandles {
  recordingId: string;
  hostWriter?: FileWriter;
  guestWriter?: FileWriter;
  hostRecorder?: ChunkRecorder;
  receiver?: ChunkReceiver;
  guestRecorder?: ChunkRecorder;
  sender?: ChunkSender;
  backup?: BackupRecorder;
  wavBackup?: BackupRecorder;
  clockSync?: ClockSync;
  channel?: RTCDataChannel;
  // Mutable send target for host control frames. Survives channel rebinds, so
  // acks keep reaching the guest after a reconnect instead of a dead channel.
  channelRef?: { current: RTCDataChannel | null };
  // Host's own recorder start, in host wall-clock (for the sync sidecar).
  hostStartMs?: number;
  /** The frame rate the camera track reported when this side's recorder started, as the browser gave it. */
  videoFps?: number | undefined;
  /** Room slug, carried so backups know which room they came from. */
  room?: string;
  /**
   * The host's take id, learned from the acks arriving on this side's channels.
   * The two sides mint different ids for one take, so a guest that joined
   * mid-take only learns the host's from here. Used to recognise a repeat of
   * the take already in progress, never as a file name or a channel key.
   */
  onHostTakeId?: (id: string) => void;
  /** The take's crash journal, present only when browser storage took one. */
  journal?: TakeJournal;
  /** True when no journal opened: nothing of this take survives a crash. */
  unprotected?: boolean;
  /**
   * This take was picked up from its crash journal. File names already in the
   * folder are never replaced, so a number is probed instead of reused.
   */
  resumed?: boolean;
  /** The host's own files, first part first, each with its offset from hostStartMs. */
  hostParts?: { name: string; offsetMs: number; kind: 'camera' | 'wav' }[];
  /** Pre-crash host files a resume copied into the folder from their backup, with their size. */
  hostCopied?: Map<string, number>;
  /**
   * Guest files a resume left as the folder had them: the folder held more of
   * them than the crash copy, and those bytes could not be carried over.
   * Opening the name again would replace the file, so nothing in this take
   * opens it.
   */
  keptFiles?: Set<string>;
  /** Resumed guest files whose replay stopped short, so the folder file has a hole. */
  shortFiles?: Set<string>;
  /**
   * Clock-sync numbers a resume read back from the notes, by guest slot. The
   * guest measures once, on its first channel, so the receiver built after the
   * reload never hears them.
   */
  slotClock?: Map<number, { startHostMs: number | null; rttMs: number | null }>;
  /** Surfaces a journal or backup warning for the caller to show. */
  onWarn?: (msg: string) => void;

  // --- Uncompressed WAV master, captured in parallel with the MP4 ---
  // Held so the guest's .wav can be opened lazily, only once its audio channel
  // actually arrives. Opening it up front would leave a 0-byte file behind for
  // any guest whose browser can't do raw PCM capture.
  dir?: FsDirectoryHandle;
  /**
   * Guest ingest, one entry per source peer. Opened lazily when that peer's
   * channel arrives — a mesh room may have three guests or none, and opening
   * files up front would leave 0-byte artefacts for peers that never record.
   * Index 0 keeps the original `guest_<id>.*` names so the two-person path is
   * unchanged.
   */
  guestSlots?: Map<string, number>;
  /** Key to the peer id that first used it this take, so one connection's key count can be bounded. */
  guestSlotOwners?: Map<string, string>;
  /** Set on the first refusal, so later refusals in the same take stay silent. */
  guestSlotsRefused?: boolean;
  /** Map from slot index to socket remotePeerId, so display names can be mapped. */
  slotPeerIds?: Map<number, string>;
  /**
   * The name the host knew for each slot when its channel was bound. Kept
   * because a guest who leaves is gone from the room before the report is
   * built, and an incomplete file is exactly when the host needs to know whose
   * it is. A name still in the room at finalize wins over this.
   */
  slotNames?: Map<number, string>;
  /**
   * Ingest for guests 2+, keyed `<peerId>:<ext>`. Slot 0 keeps using
   * `receiver`/`wavReceiver` so the two-person path is untouched.
   */
  guestReceivers?: Map<string, GuestIngest>;
  /**
   * Opens still in flight, keyed as `guestReceivers`. Channels of one key can
   * arrive in a burst; sharing the first open keeps a burst from opening a
   * writer per channel over the same file.
   */
  guestOpenings?: Map<string, Promise<GuestIngest>>;
  /** Files opened for guests 2+, so endHostRecording can close them. */
  extraWriters?: FileWriter[];
  hostPcm?: PcmRecorder;
  hostWavWriter?: FileWriter;
  guestWavWriter?: FileWriter;
  wavReceiver?: ChunkReceiver;
  wavChannelRef?: { current: RTCDataChannel | null };
  guestPcm?: PcmRecorder;
  wavSender?: ChunkSender;
  wavChannel?: RTCDataChannel;

  // --- Screen capture, recorded as its own track ---
  // A screen share can start and stop several times in one recording, so each
  // stretch becomes its own numbered file rather than trying to splice gaps
  // into a single timeline.
  take?: number;
  screenSegment?: number;
  screenRecorder?: ChunkRecorder | undefined;
  screenWriter?: FileWriter | undefined;
  screenSender?: ChunkSender | undefined;
  screenBackup?: BackupRecorder | undefined;
  screenBackups?: BackupRecorder[] | undefined;
  screenChannel?: RTCDataChannel | undefined;
  screenReceivers?: Map<number, ChunkReceiver>;
  /**
   * Segment numbers handed out to guests' screen channels this take. A number
   * is taken before the file opens, so two channels arriving together cannot
   * share one.
   */
  guestScreenSegments?: number;
  /** Guest screen segments whose channel is still open, with the sharer's peerId. */
  screenLive?: Map<number, string>;
  /** Set at the first screen share refused for want of a free file name, so later refusals stay silent. */
  screenRefused?: boolean;
  screenWriters?: FileWriter[];
  screenChannelRef?: { current: RTCDataChannel | null };
  screenEndedEarlyByFile?: Set<string>;
  /**
   * Segment start times on the local clock, keyed by file name, for the sync
   * sidecar. Keyed, not positional: host and guest segments register at
   * different moments, and an empty guest segment is dropped from screenWriters.
   */
  screenStartsByFile?: Map<string, number>;
  screenSharersByFile?: Map<string, string>;
  screenSharerPeerIdsByFile?: Map<string, string>;

  // --- Call-audio copies ---
  // The host's own recording of each guest's incoming live audio, as a fallback
  // for a guest track that stops arriving or ends short.
  /** Every call copy this take has opened, in order. */
  callCopies?: CallCopy[];
  /** Set as the take starts ending: a stream arriving after that opens nothing. */
  callCopiesClosed?: boolean;
  /** Set at the first refusal: the take's file limit was reached, so later stretches have no copy. */
  callCopiesCapped?: boolean;
}

/**
 * `host_<id>.mp4` for the first take, `host_<id>_take2.mp4` after. Keeping take
 * 1 unsuffixed means the common single-take session has clean filenames.
 */
export function takeName(
  prefix: string,
  recordingId: string,
  take: number,
  ext: string
): string {
  return take <= 1 ? `${prefix}_${recordingId}.${ext}` : `${prefix}_${recordingId}_take${take}.${ext}`;
}

/**
 * `host_<id>_resumed.mp4` for the host's own track after a reload. A running
 * MediaRecorder cannot continue the file the crashed tab left, and opening its
 * name again would replace it, so the part after the crash gets its own file.
 */
export function resumedName(recordingId: string, ext: 'mp4' | 'wav'): string {
  return `host_${recordingId}_resumed.${ext}`;
}

export async function writeTakeSidecars(
  dir: FsDirectoryHandle,
  files: { name: string; content: string }[]
): Promise<boolean> {
  try {
    const encoder = new TextEncoder();
    for (const f of files) {
      if (!f.content) continue;
      const fw = new FileWriter();
      await fw.openIn(dir, f.name);
      await fw.write(0, encoder.encode(f.content));
      await fw.close();
    }
    return true;
  } catch (e) {
    console.warn('openMeet: failed to write take sidecars', e);
    return false;
  }
}

/** Stable per-source slot: first guest unsuffixed, later ones numbered. */
export function guestSlot(h: RecordingHandles, peerId: string): number {
  const slots = (h.guestSlots ??= new Map());
  const existing = slots.get(peerId);
  if (existing !== undefined) return existing;
  // One past the highest slot in use, not the map's size: a map rebuilt from a
  // crash journal can have a hole where a claimed slot left no note, and the
  // size would then hand a new guest the file of one already in it.
  let next = 0;
  for (const slot of slots.values()) next = Math.max(next, slot + 1);
  slots.set(peerId, next);
  return next;
}

/**
 * The slot for a key a guest's channel carries, or null when the take refuses it.
 *
 * The key is the guest's to choose, so without a bound every invented key would
 * become a file in the host's folder. A key that already has a slot always
 * binds: the point of the label key is that a reconnected guest resumes its own
 * file. A new key needs a free slot in the take and an unused key allowance for
 * the connection that introduced it. The first refusal is reported once; the
 * rest are silent so a flood of channels cannot flood the error banner too.
 */
function claimGuestSlot(
  h: RecordingHandles,
  key: string,
  peerId: string,
  onError?: (err: unknown) => void
): number | null {
  const existing = h.guestSlots?.get(key);
  if (existing !== undefined) return existing;
  const owners = (h.guestSlotOwners ??= new Map());
  let introduced = 0;
  for (const owner of owners.values()) if (owner === peerId) introduced++;
  if ((h.guestSlots?.size ?? 0) >= MAX_GUEST_SLOTS || introduced >= MAX_GUEST_SLOTS_PER_PEER) {
    if (!h.guestSlotsRefused) {
      h.guestSlotsRefused = true;
      const refusal = new Error(
        'A guest opened more recordings than one take allows. The extra ones were not saved; their own backup has them.'
      );
      // Named so the banner can show this as the plain statement it is:
      // nothing on this browser failed.
      refusal.name = 'GuestLimitError';
      onError?.(refusal);
    }
    return null;
  }
  const slot = guestSlot(h, key);
  owners.set(key, peerId);
  return slot;
}

export function guestName(slot: number, recordingId: string, take: number, ext: string): string {
  const role = slot === 0 ? 'guest' : `guest${slot + 1}`;
  return take <= 1 ? `${role}_${recordingId}.${ext}` : `${role}_${recordingId}_take${take}.${ext}`;
}

/**
 * Keep the name a slot's channel was bound with, for the report built after
 * the guest may already have left. A name from another participant ends up as
 * text on the host's disk and in the summary, so it is cleaned as a call
 * copy's name is; one with nothing usable left keeps the last usable name
 * rather than erasing it.
 */
function rememberSlotName(h: RecordingHandles, slot: number, name?: string): void {
  const clean = typeof name === 'string' ? sanitizeText(name).trim() : '';
  if (clean) (h.slotNames ??= new Map()).set(slot, clean);
}

/** The name stored for the slot of `peerId`, for a sharer the room no longer lists. */
function slotNameForPeer(h: RecordingHandles, peerId: string): string | undefined {
  for (const [slot, id] of h.slotPeerIds ?? []) {
    if (id === peerId) return h.slotNames?.get(slot);
  }
  return undefined;
}

function screenFileName(role: 'host' | 'guest', recordingId: string, segment: number): string {
  return segment <= 1
    ? `${role}_screen_${recordingId}.mp4`
    : `${role}_screen_${recordingId}_${segment}.mp4`;
}

/**
 * The first screen segment number the folder does not already hold, from `from`
 * onward, or null when none was found. A resumed take restarts its counter, and
 * opening a name replaces the file behind it, so the folder itself is asked;
 * the probe is bounded so a folder that answers every name cannot spin here,
 * and a name that was not asked about is never handed out. `next` picks the
 * number to try after one that is taken.
 */
async function freeScreenSegment(
  dir: FsDirectoryHandle,
  role: 'host' | 'guest',
  recordingId: string,
  from: number,
  next: (taken: number) => number = (taken) => taken + 1
): Promise<number | null> {
  let segment = from;
  for (let probes = 0; probes < MAX_SCREEN_PROBES; probes += 1) {
    try {
      await dir.getFileHandle(screenFileName(role, recordingId, segment));
    } catch {
      return segment;
    }
    segment = next(segment);
  }
  return null;
}

/**
 * Say once per take that a screen share got no file. Named the way a refused
 * guest slot is, so the banner shows it as the plain statement it is. A guest's
 * share is still in the backup its own browser keeps; the host's own is not
 * recorded at all, and each is told so.
 */
function refuseScreenSegment(
  h: RecordingHandles,
  role: 'host' | 'guest',
  onError?: (err: unknown) => void
): void {
  if (h.screenRefused) return;
  h.screenRefused = true;
  const refusal = new Error(
    role === 'host'
      ? 'Your screen is not being recorded: the folder has no free file name left for it.'
      : 'A screen share was not saved here: the folder has no free file name left for it. The sharer has it in their own backup.'
  );
  refusal.name = 'GuestLimitError';
  onError?.(refusal);
}

/** A file as the folder holds it now, or null when there is none or the handle cannot hand it over. */
async function folderFile(dir: FsDirectoryHandle, name: string): Promise<{ size: number } | null> {
  try {
    const handle = await dir.getFileHandle(name);
    return typeof handle.getFile === 'function' ? await handle.getFile() : null;
  } catch {
    return null;
  }
}

/** Keep a guest's clock-sync numbers in its file's note, for a take that is recovered or resumed. */
function noteClock(
  journal: TakeJournal | undefined,
  file: string,
  meta: { guestStartHostMs: number | null; rttMs: number | null }
): void {
  journal?.note((n) => {
    const note = n.files.find((f) => f.file === file);
    if (!note) return;
    note.guestStartHostMs = meta.guestStartHostMs;
    note.rttMs = meta.rttMs;
  });
}

export interface StartHostArgs {
  recordingId: string;
  localStream: MediaStream;
  /** The raw mic for the WAV master, when `localStream` carries the media-board
   *  mix. The master stays mic-only so a sting can be re-timed in post. */
  micStream?: MediaStream;
  /** 1-based. Later takes are suffixed so they don't overwrite earlier ones. */
  take?: number;
  /**
   * Directory chosen on a previous take. showDirectoryPicker needs transient
   * user activation, and reusing the handle is what lets take 2 start without a
   * second folder prompt — the main reason takes aren't free.
   */
  dir?: FsDirectoryHandle;
  /**
   * Guest ingest, one entry per source peer. Opened lazily when that peer's
   * channel arrives — a mesh room may have three guests or none, and opening
   * files up front would leave 0-byte artefacts for peers that never record.
   * Index 0 keeps the original `guest_<id>.*` names so the two-person path is
   * unchanged.
   */
  guestSlots?: Map<string, number>;
  // Optional: the host may start recording BEFORE the guest has opened the
  // recording DataChannel. When it arrives, useRoom rebinds it via
  // bindHostChannel. Requiring it here used to make host-first a silent no-op.
  channel?: RTCDataChannel;
  // Reports a fatal disk write failure on either the host's own track or the
  // received guest track (e.g. DiskFullError). The caller surfaces it in the UI.
  onError?: (err: unknown) => void;
  // Test seam for the folder prompt.
  directoryPicker?: DirectoryPicker;
  /** Room slug, so the host's backup can say which room it came from. */
  room?: string;
  onWarn?: (msg: string) => void;
  /** `false` starts a take with no crash copy; the default is on. */
  journal?: boolean;
  /** Test seam for the journal's storage root, the same shape as `directoryPicker`. */
  journalRoot?: OpfsRootGetter;
}
export interface StartGuestArgs {
  recordingId: string;
  localStream: MediaStream;
  /** The raw mic for the WAV master, when `localStream` carries the media-board
   *  mix. The master stays mic-only so a sting can be re-timed in post. */
  micStream?: MediaStream;
  channel: RTCDataChannel;
  /** Separate channel for the uncompressed WAV master. Optional: without it the
   *  MP4 still records, just with no WAV companion. */
  audioChannel?: RTCDataChannel;
  // Surfaces a MediaRecorder failure; without it the guest's UI keeps saying
  // "Recording" while nothing is being captured.
  onError?: (err: unknown) => void;
  onWarn?: (msg: string) => void;
  /** Pre-started in-browser backup recorder (e.g. started before waiting for peer connection). */
  backup?: BackupRecorder;
  /** Room slug, so guest backups know which room they came from. */
  room?: string;
  wavBackup?: BackupRecorder;
  /** Called with the host's take id whenever an ack carries one. */
  onHostTakeId?: (id: string) => void;
}

export async function startHostRecording(args: StartHostArgs): Promise<RecordingHandles> {
  const hasLocalMedia = args.localStream.getTracks().length > 0;
  let mimeType: string | null = null;
  if (hasLocalMedia) {
    // Probe BEFORE prompting for a folder: failing after the user has picked a
    // save location is worse than refusing up front, and MediaRecorder would
    // otherwise throw NotSupportedError only after the files already exist.
    mimeType = pickRecordingMime();
    if (!mimeType) throw new UnsupportedCodecError();
  }

  // ONE prompt for both files. Two showSaveFilePicker() calls would consume the
  // single transient user activation this click carries, so the second would be
  // rejected — and two dialogs per recording is hostile anyway.
  const dir = args.dir ?? (await pickRecordingDirectory(args.directoryPicker));
  const take = args.take ?? 1;
  let hostWriter: FileWriter | undefined;
  if (hasLocalMedia) {
    hostWriter = new FileWriter();
    await hostWriter.openIn(dir, takeName('host', args.recordingId, take, 'mp4'));
  }
  const guestWriter = new FileWriter();
  await guestWriter.openIn(dir, takeName('guest', args.recordingId, take, 'mp4'));

  // One start time for the take: the recorders' origin, the sync sidecar and
  // the journal's directory name must agree.
  const hostStartMs = Date.now();
  const journal = args.journal === false
    ? null
    : await openTakeJournal(
        { room: args.room ?? '', recordingId: args.recordingId, take, hostStartMs },
        args.journalRoot
      ).catch(() => null);
  if (journal) {
    journal.note((n) => n.files.push({ file: guestWriter.fileName, kind: 'camera', slot: 0 }));
  }

  // The channel may not exist yet: the host is allowed to start recording before
  // the guest has opened the recording DataChannel. Control frames are addressed
  // through this box so they follow the live channel across rebinds, instead of
  // being pinned to whatever channel existed at construction time.
  const channelRef: { current: RTCDataChannel | null } = { current: args.channel ?? null };

  let hostRecorder: ChunkRecorder | undefined;
  if (hasLocalMedia && mimeType && hostWriter) {
    const hw = hostWriter;
    hostRecorder = new ChunkRecorder({
      mimeType,
      stream: args.localStream,
      // From the ACTUAL negotiated resolution: capture constraints are `ideal`, so
      // a camera that quietly degraded would otherwise be encoded at a bitrate
      // sized for a frame it never produced.
      videoBitsPerSecond: presetForTrack(args.localStream.getVideoTracks()[0]).videoBps,
      // Fire-and-forget by design (ordering is preserved by FileWriter's write
      // chain), but a rejection must still reach the UI rather than vanish.
      onChunk: (c) => { hw.write(c.header.offset, c.payload).catch((e) => args.onError?.(e)); },
      ...(args.onError ? { onError: args.onError } : {}),
    });
  }

  const receiver = new ChunkReceiver({
    recordingId: args.recordingId,
    writer: guestWriter,
    sendControl: (json) => {
      const c = channelRef.current;
      if (c && c.readyState === 'open') c.send(json);
    },
    ...(journal
      ? {
          journalFile: journal.file(guestWriter.fileName),
          onMeta: (meta) => noteClock(journal, guestWriter.fileName, meta),
        }
      : {}),
    ...(args.onWarn ? { onWarn: args.onWarn } : {}),
    ...(args.onError ? { onError: args.onError } : {}),
  });
  if (args.channel) bindHostChannel(args.channel, receiver, channelRef);

  // Uncompressed WAV master for the host's own mic, straight to disk — no
  // network hop, same as the host's own video. Optional: if raw PCM capture is
  // unavailable the MP4 recording is unaffected.
  let hostPcm: PcmRecorder | undefined;
  let hostWavWriter: FileWriter | undefined;
  if (hasLocalMedia && isPcmCaptureSupported() && args.localStream.getAudioTracks().length > 0) {
    hostWavWriter = new FileWriter();
    await hostWavWriter.openIn(dir, takeName('host', args.recordingId, take, 'wav'));
    const w = hostWavWriter;
    hostPcm = new PcmRecorder({
      stream: args.micStream ?? args.localStream,
      onChunk: (c) => { w.write(c.header.offset, c.payload).catch((e) => args.onError?.(e)); },
      ...(args.onError ? { onError: args.onError } : {}),
    });
  }

  const onWarn = args.onWarn ?? (args.onError ? (msg: string) => args.onError?.(new Error(msg)) : undefined);
  // Known limit: a second concurrent encode on the host; drop it if CPU telemetry shows encode overload.
  let backup: BackupRecorder | undefined;
  if (hasLocalMedia && mimeType) {
    backup = new BackupRecorder({
      mimeType,
      stream: args.localStream,
      fileName: 'openmeet-backup-host',
      ...(args.room ? { room: args.room } : {}),
      ...(onWarn ? { onWarn } : {}),
    });
  }

  let wavBackup: BackupRecorder | undefined;
  if (hasLocalMedia && isPcmCaptureSupported() && args.localStream.getAudioTracks().length > 0) {
    wavBackup = new BackupRecorder({
      mimeType: 'audio/wav',
      stream: args.micStream ?? args.localStream,
      fileName: 'openmeet-backup-host-audio',
      ...(args.room ? { room: args.room } : {}),
      ...(onWarn ? { onWarn } : {}),
    });
  }

  hostRecorder?.start();
  hostPcm?.start();
  backup?.start();
  wavBackup?.start();

  // The backups' storage probe must not hold up the take's start, so their
  // directory names land in the notes once the probe settles.
  const recordBackup = (b: BackupRecorder | undefined, kind: 'camera' | 'wav', file: string | undefined) => {
    if (!journal || !b || !file) return;
    void b.whenOpen().then(() => {
      const dirName = b.dirName;
      if (dirName) journal.note((n) => n.backups.push({ dir: dirName, file, kind }));
    });
  };
  recordBackup(backup, 'camera', hostWriter?.fileName);
  recordBackup(wavBackup, 'wav', hostWavWriter?.fileName);

  return {
    recordingId: args.recordingId,
    ...(hostWriter ? { hostWriter } : {}),
    guestWriter,
    ...(hostRecorder ? { hostRecorder } : {}),
    receiver,
    channelRef,
    ...(backup ? { backup } : {}),
    ...(wavBackup ? { wavBackup } : {}),
    dir,
    take,
    ...(hostPcm ? { hostPcm } : {}),
    ...(hostWavWriter ? { hostWavWriter } : {}),
    wavChannelRef: { current: null },
    ...(args.channel ? { channel: args.channel } : {}),
    hostStartMs,
    videoFps: args.localStream.getVideoTracks()[0]?.getSettings?.().frameRate,
    ...(args.room ? { room: args.room } : {}),
    ...(journal ? { journal } : { unprotected: true }),
    ...(args.onWarn ? { onWarn: args.onWarn } : {}),
  };
}

/**
 * Resolve (opening it on first use) the ingest for ONE guest's ONE file.
 *
 * Every guest's channel used to be bound to the single receiver opened up
 * front. In a two-person room that is correct; with two guests it writes two
 * independent H.264 streams into one file at each sender's own offsets, and the
 * result is unplayable. Now recording is host-driven, one click starts every
 * guest at once, so that had gone from "needs three deliberate clicks" to the
 * default outcome of a three-person room.
 *
 * Returns null when the host has no directory yet — i.e. isn't recording.
 */
async function ingestFor(
  h: RecordingHandles,
  peerId: string,
  ext: 'mp4' | 'wav',
  onError?: (err: unknown) => void,
  who?: string
): Promise<{ receiver: ChunkReceiver; ref: { current: RTCDataChannel | null } } | null> {
  const slot = guestSlot(h, peerId);
  // Slot 0's MP4 writer is opened eagerly by startHostRecording, and its
  // receiver carries the digest and byte count the sync report reads.
  if (slot === 0 && ext === 'mp4') {
    return h.receiver && h.channelRef ? { receiver: h.receiver, ref: h.channelRef } : null;
  }
  const key = `${peerId}:${ext}`;
  const cached = h.guestReceivers?.get(key);
  if (cached) return cached;
  const dir = h.dir;
  if (!dir) return null; // host isn't recording; nothing to write into
  // A resume left this file as the folder had it; opening its name would replace it.
  if (h.keptFiles?.has(guestName(slot, h.recordingId, h.take ?? 1, ext))) return null;

  const openings = (h.guestOpenings ??= new Map());
  const inFlight = openings.get(key);
  if (inFlight) return inFlight;
  const open = (async (): Promise<GuestIngest> => {
    const writer = new FileWriter();
    await writer.openIn(dir, guestName(slot, h.recordingId, h.take ?? 1, ext));
    const name = writer.fileName;
    const cappedWho = who ? who.slice(0, 200) : undefined;
    h.journal?.note((n) => {
      // Not bounded by the note count: the take's guest slots already bound how
      // many camera and WAV files one guest can open, and one guest's screen
      // shares must not spend the notes another guest's recovery needs.
      n.files.push({
        file: name,
        kind: ext === 'mp4' ? 'camera' : 'wav',
        key: peerId.slice(0, 64),
        slot,
        ...(cappedWho ? { who: cappedWho } : {}),
      });
    });
    const ref: { current: RTCDataChannel | null } = { current: null };
    const receiver = new ChunkReceiver({
      recordingId: h.recordingId,
      writer,
      sendControl: (json) => {
        const c = ref.current;
        if (c && c.readyState === 'open') c.send(json);
      },
      ...(h.journal
        ? { journalFile: h.journal.file(name), onMeta: (meta) => noteClock(h.journal, name, meta) }
        : {}),
      ...(h.onWarn ? { onWarn: h.onWarn } : {}),
      ...(onError ? { onError } : {}),
    });
    const entry = { receiver, ref, writer };
    h.guestReceivers = new Map(h.guestReceivers ?? []).set(key, entry);
    if (slot === 0) {
      // Keep the fields endHostRecording and the sync report already read.
      h.guestWavWriter = writer;
      h.wavReceiver = receiver;
      h.wavChannelRef = ref;
    } else {
      h.extraWriters = [...(h.extraWriters ?? []), writer];
    }
    return entry;
  })();
  openings.set(key, open);
  try {
    return await open;
  } finally {
    if (openings.get(key) === open) openings.delete(key);
  }
}

/** A recording channel that arrived while no take was running. */
export interface PendingRecordingChannel {
  channel: RTCDataChannel;
  peerId: string;
}

export interface ResumeHostArgs {
  journal: TakeJournal;
  /** The folder chosen before a reload, when the caller still has it. */
  dir?: FsDirectoryHandle;
  directoryPicker?: DirectoryPicker;
  channels: PendingRecordingChannel[];
  /** The host's own capture, as `startHostRecording` receives it. */
  localStream: MediaStream;
  /** The raw mic, when the recording stream carries the board's mix instead. */
  micStream?: MediaStream | undefined;
  onError?: (err: unknown) => void;
  onWarn?: (msg: string) => void;
}

/**
 * Open the host's own camera and WAV for the part of the take after a resume.
 *
 * Mirrors `startHostRecording`'s host half, with one difference: the files are
 * named `_resumed`, because `openIn` replaces a name it opens and the crashed
 * tab's file must survive beside it. Each opened file is appended to
 * `hostParts` with its offset from the take's start.
 */
async function startResumedHostTracks(
  h: RecordingHandles,
  args: ResumeHostArgs,
  dir: FsDirectoryHandle,
  warn: ((msg: string) => void) | undefined
): Promise<void> {
  const notes = args.journal.notes;
  const hasLocalMedia = args.localStream.getTracks().length > 0;
  if (!hasLocalMedia) return;
  const mimeType = pickRecordingMime();
  if (!mimeType) throw new UnsupportedCodecError();

  // Stamped once, before either file opens: it is the start of this run.
  const offsetMs = Math.max(0, Date.now() - notes.hostStartMs);
  const parts = (h.hostParts ??= []);

  const hostWriter = new FileWriter();
  await hostWriter.openIn(dir, resumedName(notes.recordingId, 'mp4'));
  h.hostWriter = hostWriter;
  parts.push({ name: hostWriter.fileName, offsetMs, kind: 'camera' });
  const hw = hostWriter;
  h.hostRecorder = new ChunkRecorder({
    mimeType,
    stream: args.localStream,
    videoBitsPerSecond: presetForTrack(args.localStream.getVideoTracks()[0]).videoBps,
    onChunk: (c) => { hw.write(c.header.offset, c.payload).catch((e) => args.onError?.(e)); },
    ...(args.onError ? { onError: args.onError } : {}),
  });
  h.videoFps = args.localStream.getVideoTracks()[0]?.getSettings?.().frameRate;

  if (isPcmCaptureSupported() && args.localStream.getAudioTracks().length > 0) {
    const hostWavWriter = new FileWriter();
    await hostWavWriter.openIn(dir, resumedName(notes.recordingId, 'wav'));
    h.hostWavWriter = hostWavWriter;
    parts.push({ name: hostWavWriter.fileName, offsetMs, kind: 'wav' });
    const w = hostWavWriter;
    h.hostPcm = new PcmRecorder({
      stream: args.micStream ?? args.localStream,
      onChunk: (c) => { w.write(c.header.offset, c.payload).catch((e) => args.onError?.(e)); },
      ...(args.onError ? { onError: args.onError } : {}),
    });
  }

  h.backup = new BackupRecorder({
    mimeType,
    stream: args.localStream,
    fileName: 'openmeet-backup-host',
    ...(notes.room ? { room: notes.room } : {}),
    ...(warn ? { onWarn: warn } : {}),
  });

  if (isPcmCaptureSupported() && args.localStream.getAudioTracks().length > 0) {
    h.wavBackup = new BackupRecorder({
      mimeType: 'audio/wav',
      stream: args.micStream ?? args.localStream,
      fileName: 'openmeet-backup-host-audio',
      ...(notes.room ? { room: notes.room } : {}),
      ...(warn ? { onWarn: warn } : {}),
    });
  }

  h.hostRecorder.start();
  h.hostPcm?.start();
  h.backup.start();
  h.wavBackup?.start();
}

/**
 * Pick up the take the journal belongs to: the same ids and names, the guests'
 * files continued.
 *
 * A crash leaves the journal as the only copy of every byte the host had
 * acknowledged, because a folder file only reaches the disk on close. Replaying
 * those parts back into the folder restores the file's bytes; the receiver then
 * starts where the parts end, so the guest's next fragment continues the file
 * instead of writing over its start.
 */
export async function resumeHostRecording(args: ResumeHostArgs): Promise<RecordingHandles> {
  const notes = args.journal.notes;
  // Without a take id there is nothing to name the files after and no slot 0 to
  // continue, so refuse before the host is asked for a folder.
  if (!notes.recordingId) throw new Error('This take has no recording id, so it cannot be continued.');
  const dir = args.dir ?? (await pickRecordingDirectory(args.directoryPicker));
  const h: RecordingHandles = {
    recordingId: notes.recordingId,
    take: notes.take,
    hostStartMs: notes.hostStartMs,
    dir,
    journal: args.journal,
    resumed: true,
    guestSlots: new Map(),
    slotPeerIds: new Map(),
    ...(args.onWarn ? { onWarn: args.onWarn } : {}),
  };

  // Keyed by a channel label's key plus its extension, which is how a pending
  // channel finds the file it was already writing.
  const byKey = new Map<string, { receiver: ChunkReceiver; ref: { current: RTCDataChannel | null } }>();
  for (const note of notes.files) {
    if (note.kind !== 'camera' && note.kind !== 'wav') continue;
    const key = note.key ?? note.file;
    const slot = note.slot ?? guestSlot(h, key);
    (h.guestSlots ??= new Map()).set(key, slot);
    // The guest may have left by the time the report is built, and the room
    // then has no name for this slot.
    rememberSlotName(h, slot, note.who);
    if (note.kind === 'camera' && (note.guestStartHostMs != null || note.rttMs != null)) {
      (h.slotClock ??= new Map()).set(slot, {
        startHostMs: note.guestStartHostMs ?? null,
        rttMs: note.rttMs ?? null,
      });
    }

    const position = await args.journal.file(note.file).position();
    // Opening a name replaces the file behind it when the writer closes, and
    // the folder can hold more of this file than the crash copy does: a page
    // that is closing commits every file with all it had written, a few
    // seconds ahead of the copy, and a Save rebuilds files there. Those bytes
    // are carried into the reopened file, so nothing the folder held is lost
    // when the guest never sends again.
    const existing = await folderFile(dir, note.file);
    const ahead = existing !== null && existing.size > (position?.end ?? 0);
    const carry = ahead && existing instanceof Blob ? existing : null;
    const writer = new FileWriter();
    let kept = ahead && !carry;
    if (!kept) {
      await writer.openIn(dir, note.file);
      if (carry) {
        try {
          await writer.write(0, carry);
        } catch {
          // The folder refused the copy. This writer is left unclosed on
          // purpose: closing it would put a shorter file in place of the one
          // that is there.
          kept = true;
        }
      }
    }
    if (kept) {
      (h.keptFiles ??= new Set()).add(note.file);
      args.onError?.(
        new Error(
          `${note.file} in this folder holds more than the crash copy and could not be carried over, so it was left as it is and is not continued. The guest has the rest in their own backup.`
        )
      );
      continue;
    }

    const replayed = await args.journal.replay(note.file, { write: (position, data) => writer.write(position, data) });
    // A part the folder refused leaves the file shorter than the journal says.
    // Say so, and seed the receiver from what really landed, so the end it
    // announces is the file's own. The missing part is not asked for again:
    // the guest already dropped what the host had acknowledged.
    const short = position !== null && replayed < position.end;
    if (short) {
      (h.shortFiles ??= new Set()).add(note.file);
      args.onError?.(new Error('A guest file could not be fully rebuilt from the crash copy.'));
    }
    const from = position && (short ? { nextIdx: position.nextIdx, end: replayed } : position);
    // The stored state is the digest of every byte up to the journal's
    // position. A file with a hole does not hold those bytes, so the state is
    // not handed over and no digest is claimed for the whole file.
    const resumeFrom = from
      ? { ...from, ...(note.sha256State && !short ? { sha256State: note.sha256State } : {}) }
      : undefined;
    const ref: { current: RTCDataChannel | null } = { current: null };
    const receiver = new ChunkReceiver({
      recordingId: notes.recordingId,
      writer,
      sendControl: (json) => {
        const c = ref.current;
        if (c && c.readyState === 'open') c.send(json);
      },
      ...(resumeFrom ? { resumeFrom } : {}),
      ...(args.onError ? { onError: args.onError } : {}),
      ...(args.onWarn ? { onWarn: args.onWarn } : {}),
      journalFile: args.journal.file(note.file),
    });

    const ext = note.kind === 'camera' ? 'mp4' : 'wav';
    if (slot === 0 && ext === 'mp4') {
      h.receiver = receiver;
      h.guestWriter = writer;
      h.channelRef = ref;
    } else {
      // ingestFor keeps an entry for every file it opens, the slot-0 WAV
      // included, which the file checks and the health panel read; only files
      // for guests 2+ are extra writers to close.
      h.guestReceivers = new Map(h.guestReceivers ?? []).set(`${key}:${ext}`, { receiver, ref, writer });
      if (slot === 0) {
        h.wavReceiver = receiver;
        h.guestWavWriter = writer;
        h.wavChannelRef = ref;
      } else {
        h.extraWriters = [...(h.extraWriters ?? []), writer];
      }
    }
    // A note without a key belongs to no channel label: only a key the guest
    // really sent may reach its file.
    if (note.key !== undefined) byKey.set(`${key}:${ext}`, { receiver, ref });
  }

  // Guest screen files are not reopened: the next share takes a new number, so
  // the crashed segment stays in the folder instead of being written over. The
  // number has to clear both the notes' count and the highest number any note
  // carries, since a share that stopped while its file was opening left none.
  const screenNotes = notes.files.filter(
    (note) => note.kind === 'screen' && note.file.startsWith('guest_screen')
  );
  h.guestScreenSegments = Math.max(screenNotes.length, ...screenNotes.map((note) => note.segment ?? 0));

  // The host's own files are not journaled, so these notes hold only the
  // pre-crash backups. Each is a first part of the take's host track once its
  // copy is in the folder; until then the track is the files opened below.
  const hostBackups = notes.backups.filter((b) => b.kind === 'camera' || b.kind === 'wav');
  h.hostParts = [];

  const warn = args.onWarn ?? (args.onError ? (msg: string) => args.onError?.(new Error(msg)) : undefined);
  // Best-effort, and before the channels are bound: a host file that will not
  // open costs the take's post-crash host part, never the guests' resumed files.
  try {
    await startResumedHostTracks(h, args, dir, warn);
  } catch {
    warn?.(
      'The host’s own camera and microphone could not be recorded after the resume; the guests’ files are unaffected.'
    );
  }

  // The pre-crash host part lives only in its backup, and assembling one can be
  // slow or fail: in the background, so it never holds up the resumed take and a
  // missing copy costs only the part before the crash. A part is listed once its
  // copy is in the folder, so the report never names a file that did not arrive.
  for (const entry of hostBackups) {
    void copyBackupInto(args.journal, dir, entry)
      .then((copied) => {
        if (copied.source === 'failed') return;
        const done = (h.hostCopied ??= new Map()).set(entry.file, copied.bytes);
        // First parts first, in the notes' order, ahead of the files this run opened.
        h.hostParts = [
          ...hostBackups
            .filter((b) => done.has(b.file))
            .map((b) => ({ name: b.file, offsetMs: 0, kind: b.kind as 'camera' | 'wav' })),
          ...(h.hostParts ?? []).filter((p) => !done.has(p.name)),
        ];
      })
      .catch(() => {});
  }

  for (const { channel, peerId } of args.channels) {
    const kind = recordingChannelKind(channel.label);
    // Only the camera and audio bases can match a note; a returned-backup
    // channel or any other label is left alone.
    const ext =
      kind.base === DATA_CHANNEL_RECORDING_AUDIO ? 'wav' : kind.base === DATA_CHANNEL_RECORDING ? 'mp4' : null;
    if (!ext) continue;
    const key = kind.key ?? peerId;
    const entry = byKey.get(`${key}:${ext}`);
    if (!entry) continue;
    const slot = (h.guestSlots ??= new Map()).get(key);
    if (slot === undefined) continue;
    (h.slotPeerIds ??= new Map()).set(slot, peerId);
    try {
      bindHostChannel(channel, entry.receiver, entry.ref);
    } catch (err) {
      // One channel that will not take the announcement must not lose the
      // whole take: the other guests still get their files and handles.
      args.onError?.(err);
    }
  }

  return h;
}

/**
 * Bind the guest's WAV channel, opening `guest_<id>.wav` on first arrival.
 *
 * Lazy on purpose: the host has already picked a directory, and opening a file
 * inside it needs no further user activation, so nothing is gained by creating
 * the file before we know the guest is actually sending PCM.
 */
export async function bindHostAudioChannel(
  channel: RTCDataChannel,
  h: RecordingHandles,
  peerId: string,
  onError?: (err: unknown) => void,
  name?: string
): Promise<void> {
  // The label's key (if any) is stable across a reconnect; the socket peerId
  // is not (the DO mints a fresh one per socket). Prefer the key so a
  // rebuilt channel lands on the same slot/file it started on.
  const key = recordingChannelKind(channel.label).key ?? peerId;
  // A real key is the guest's 36-character recordingId; the key is held and
  // compared for the whole take, so a longer one is not a key.
  if (key.length > 64) return;
  const slot = claimGuestSlot(h, key, peerId, onError);
  if (slot === null) return;
  h.slotPeerIds ??= new Map();
  h.slotPeerIds.set(slot, peerId);
  rememberSlotName(h, slot, name);
  const ingest = await ingestFor(h, key, 'wav', onError, name);
  if (!ingest) return;
  bindHostChannel(channel, ingest.receiver, ingest.ref);
}

/**
 * Bind one guest's camera channel to that guest's own MP4.
 *
 * Also covers reconnect rebinding: the receiver survives, so lastIdx and the
 * running digest continue across a replaced channel.
 */
export async function bindHostGuestChannel(
  channel: RTCDataChannel,
  h: RecordingHandles,
  peerId: string,
  onError?: (err: unknown) => void,
  name?: string
): Promise<void> {
  // Same stable-key preference as bindHostAudioChannel — see there.
  const key = recordingChannelKind(channel.label).key ?? peerId;
  // Same bound as bindHostAudioChannel — see there.
  if (key.length > 64) return;
  const slot = claimGuestSlot(h, key, peerId, onError);
  if (slot === null) return;
  h.slotPeerIds ??= new Map();
  h.slotPeerIds.set(slot, peerId);
  rememberSlotName(h, slot, name);
  const ingest = await ingestFor(h, key, 'mp4', onError, name);
  if (!ingest) return;
  bindHostChannel(channel, ingest.receiver, ingest.ref);
  if (ingest.receiver === h.receiver) {
    h.channel = channel;
    // The slot-0 note was written before a channel existed. Its key is what a
    // resume matches a pending channel against, so it lands here, with the name.
    const file = h.guestWriter?.fileName;
    h.journal?.note((n) => {
      const note = n.files.find((f) => f.file === file);
      if (!note) return;
      note.key = key.slice(0, 64);
      if (name) note.who = name.slice(0, 200);
    });
  }
}

// Bind (or rebind, after reconnect, or bind for the first time when the guest's
// channel arrives after the host already started) a receive channel to the
// host's receiver. Also repoints the control-send target at the new channel.
export function bindHostChannel(
  channel: RTCDataChannel,
  receiver: ChunkReceiver,
  channelRef?: { current: RTCDataChannel | null }
): void {
  channel.binaryType = 'arraybuffer';
  if (channelRef) channelRef.current = channel;
  channel.onmessage = (ev: MessageEvent) => { void receiver.handleMessage(ev.data as string | ArrayBuffer); };
  // A guest asks on its channel's open, which races this bind when the host is
  // still opening the file. Announcing here lets it replay exactly what is
  // missing instead of racing its own query.
  receiver.answerResume();
}

export function startGuestRecording(args: StartGuestArgs): RecordingHandles {
  const mimeType = pickRecordingMime();
  if (!mimeType) throw new UnsupportedCodecError();

  const sender = new ChunkSender({
    recordingId: args.recordingId,
    channel: args.channel,
    ...(args.onError ? { onError: args.onError } : {}),
  });
  const guestRecorder = new ChunkRecorder({
    mimeType,
    stream: args.localStream,
    videoBitsPerSecond: presetForTrack(args.localStream.getVideoTracks()[0]).videoBps,
    onChunk: (c) => sender.sendChunk(c),
    ...(args.onError ? { onError: args.onError } : {}),
  });
  const onWarn = args.onWarn ?? (args.onError ? (msg: string) => args.onError?.(new Error(msg)) : undefined);
  // Same codec as the streamed recorder on purpose: BackupRecorder derives its
  // file extension from the mime, so letting the two diverge would produce a
  // backup whose extension disagrees with its contents.
  const backup = args.backup ?? new BackupRecorder({
    mimeType,
    stream: args.localStream,
    ...(onWarn ? { onWarn } : {}),
  });

  let wavBackup = args.wavBackup;
  if (!wavBackup && isPcmCaptureSupported() && args.localStream.getAudioTracks().length > 0) {
    wavBackup = new BackupRecorder({
      mimeType: 'audio/wav',
      stream: args.micStream ?? args.localStream,
      fileName: 'openmeet-backup-audio',
      ...(onWarn ? { onWarn } : {}),
    });
  }

  // Anchor the guest's recorder start, then run clock-sync so the host learns
  // this start on its own clock (for editor alignment). Fire-and-forget: it
  // sends a recording_meta when it converges, or gives up silently on timeout.
  const guestStartMs = Date.now();
  const clockSync = new ClockSync({
    recordingId: args.recordingId,
    guestStartMs,
    send: (json) => {
      if (args.channel.readyState === 'open') args.channel.send(json);
    },
  });

  // Uncompressed WAV master over its own channel. One channel per file keeps
  // idx/offset, the retransmit buffer and the sha256 digest per-file, so
  // ChunkSender and ChunkReceiver are reused verbatim with no payload tagging.
  let guestPcm: PcmRecorder | undefined;
  let wavSender: ChunkSender | undefined;
  if (args.audioChannel && isPcmCaptureSupported() && args.localStream.getAudioTracks().length > 0) {
    const ac = args.audioChannel;
    wavSender = new ChunkSender({
      recordingId: args.recordingId,
      channel: ac,
      ...(args.onError ? { onError: args.onError } : {}),
    });
    const s2 = wavSender;
    guestPcm = new PcmRecorder({
      stream: args.micStream ?? args.localStream,
      onChunk: (c) => s2.sendChunk(c),
      ...(args.onError ? { onError: args.onError } : {}),
    });
    bindGuestChannel(ac, s2, undefined, args.onHostTakeId);
  }

  bindGuestChannel(args.channel, sender, clockSync, args.onHostTakeId);
  guestRecorder.start();
  guestPcm?.start();
  if (!args.backup) backup.start();
  if (!args.wavBackup) wavBackup?.start();
  void clockSync.run();
  return {
    recordingId: args.recordingId,
    guestRecorder,
    sender,
    backup,
    ...(wavBackup ? { wavBackup } : {}),
    clockSync,
    channel: args.channel,
    ...(guestPcm ? { guestPcm } : {}),
    ...(wavSender ? { wavSender } : {}),
    ...(args.audioChannel ? { wavChannel: args.audioChannel } : {}),
    ...(args.room ? { room: args.room } : {}),
    ...(args.onHostTakeId ? { onHostTakeId: args.onHostTakeId } : {}),
    videoFps: args.localStream.getVideoTracks()[0]?.getSettings?.().frameRate,
  };
}

export function bindGuestChannel(
  channel: RTCDataChannel,
  sender: ChunkSender,
  clockSync?: ClockSync,
  onHostTakeId?: (id: string) => void
): void {
  channel.onmessage = (ev: MessageEvent) => {
    if (typeof ev.data !== 'string') return;
    try {
      const msg = JSON.parse(ev.data) as ChunkAck | ChunkResumeOffset | ClockPong;
      if (msg.type === 'ack') {
        // The host mints its own id for the take, so this is the only place a
        // guest that joined mid-take can learn it. Observed, not authenticated:
        // anything that is not a short string is left to the sender's own ack
        // handling, which ignores the id for correlation.
        if (typeof msg.recordingId === 'string' && msg.recordingId.length <= 64) {
          onHostTakeId?.(msg.recordingId);
        }
        sender.handleControl(msg);
      } else if (msg.type === 'resume_offset') {
        // The host's own number, so it can be nonsense or out of range. `resume`
        // rebuilds the whole queue from it, so a bad value would empty it, and
        // an index this sender never put on the wire cannot have been received.
        if (
          Number.isSafeInteger(msg.lastIdx) &&
          msg.lastIdx >= -1 &&
          msg.lastIdx <= sender.lastSentIdx
        ) {
          sender.resume(msg.lastIdx);
          // A rebind held the sender until the host's receiver was bound; this
          // is that answer arriving. A sender that was never held is untouched.
          sender.release();
        }
      } else if (msg.type === 'clock_pong') clockSync?.handlePong(msg);
    } catch { /* ignore */ }
  };
  channel.bufferedAmountLowThreshold = 8 * 1024 * 1024;
  channel.onbufferedamountlow = () => sender.drainQueue();
}

export function requestResume(h: RecordingHandles): void {
  if (h.channel && h.channel.readyState === 'open') {
    h.channel.send(JSON.stringify({ type: 'resume_query', recordingId: h.recordingId }));
  }
}

/**
 * Rebind an existing guest recording to a newly rebuilt PeerConnection.
 *
 * Mirrors the channel creation and open-listener registration of beginGuestRecording.
 * Existing senders retain their queues and retransmit buffers, while new channels
 * trigger a resume_query on open so the host can report the last-received chunk.
 */
export function rebindGuestRecording(h: RecordingHandles, peer: PeerConnection): void {
  // Keyed by the guest's own recordingId, which survives the reconnect (unlike
  // the DO's per-socket peerId) — see bindHostGuestChannel/bindHostAudioChannel.
  if (h.sender) {
    const ch = peer.createRecordingChannel(h.recordingId);
    h.channel = ch;
    ch.addEventListener('open', () => requestResume(h));
    h.sender.rebind(ch);
    h.sender.hold();
    bindGuestChannel(ch, h.sender, h.clockSync, h.onHostTakeId);
  }

  if (h.wavSender) {
    const wch = peer.createRecordingAudioChannel(h.recordingId);
    h.wavChannel = wch;
    wch.addEventListener('open', () => {
      if (wch.readyState === 'open') {
        wch.send(JSON.stringify({ type: 'resume_query', recordingId: h.recordingId }));
      }
    });
    h.wavSender.rebind(wch);
    h.wavSender.hold();
    bindGuestChannel(wch, h.wavSender, undefined, h.onHostTakeId);
  }
}

/**
 * Same as rebindGuestRecording, but waits for the rebuilt connection's first
 * 'connected' before recreating the channels.
 *
 * Chrome never negotiates a DataChannel created before an implicit rollback,
 * and a rebuilt connection can glare on its own first negotiation just like
 * the initial one — so calling rebindGuestRecording immediately on rebuild
 * left the new channels stuck in 'connecting' forever. Re-checks the ref
 * after the wait: it can span an End & save, which clears it, leaving
 * nothing to rebind.
 */
export async function rebindGuestRecordingWhenConnected(
  peer: PeerConnection,
  recordingRef: { current: RecordingHandles | null },
  screenStream?: MediaStream | null,
  onError?: (err: unknown) => void
): Promise<void> {
  const hOld = recordingRef.current;
  if (hOld && screenStream) {
    await stopScreenRecording(hOld);
  }
  // No timeout: a reconnect can take longer than a fresh join, and giving up
  // here would silently stop the guest's stream for the rest of the take.
  await peer.whenConnected(Infinity);
  const h = recordingRef.current;
  if (!h) return;
  rebindGuestRecording(h, peer);
  if (screenStream && screenStream.getVideoTracks().some((t) => t.readyState === 'live')) {
    await stopScreenRecording(h);
    await startScreenRecording(h, screenStream, 'guest', peer, onError);
  }
}

/**
 * How long the host waits for the guest's tail after signalling stop.
 *
 * The stop travels host -> DO -> guest, then the guest has to flush its encoder
 * and drain three channels. Closing the writers before that lands truncates the
 * final seconds of the guest's take. Bounded because a guest that crashed must
 * not stop the host from keeping what already reached disk.
 */
export const GUEST_TAIL_TIMEOUT_MS = 45_000;

/**
 * The most the host waits for one guest file, progress or not.
 *
 * An honest guest stops its recorder on `recording-stop` and drains its sender
 * for at most `DRAIN_HARD_CAP_MS` (30 s) before finalizing, so two minutes is
 * far beyond anything an honest guest needs and still bounded: a guest that
 * keeps sending fragments cannot hold the take's files open.
 */
export const GUEST_TAIL_HARD_CAP_MS = 120_000;

/** How long a screen-share channel gets to open before we give up on it. */
export const SCREEN_CHANNEL_OPEN_TIMEOUT_MS = 15_000;

// A call copy is the lesser file: its failures are logged and never reach the
// recording error banner, which would sound the problem alert for a take that is fine.
const warnCallCopy = (e: unknown) => console.warn('openMeet: call audio copy', e);

function finishCallCopy(h: RecordingHandles, c: CallCopy): Promise<void> {
  return (c.finished ??= (async () => {
    await c.opened;
    // Separate: a stop that throws must not leave the file uncommitted, and a
    // file only reaches disk on close.
    try {
      await c.recorder?.stopAndFlush();
    } finally {
      await c.writer.close();
    }
    // Nothing was recorded: leave no empty file behind.
    if (!c.writer.size && c.writer.fileName) await h.dir?.removeEntry?.(c.writer.fileName);
  })().catch((e: unknown) => {
    c.failed = true;
    warnCallCopy(e);
  }));
}

async function openCallCopy(
  h: RecordingHandles,
  dir: FsDirectoryHandle,
  c: CallCopy,
  n: number,
  mimeType: string
): Promise<void> {
  const ext = mimeType.startsWith('audio/mp4') ? 'm4a' : 'webm';
  await c.writer.openIn(dir, takeName(`call${n}`, h.recordingId, h.take ?? 1, ext));
  // The take ended, the guest left or the track died while the file was opening.
  if (c.finished || c.track.readyState === 'ended') return;
  const recorder = new ChunkRecorder({
    mimeType,
    stream: new MediaStream([c.track]),
    onChunk: (chunk) => {
      c.writer.write(chunk.header.offset, chunk.payload).catch((e: unknown) => {
        c.failed = true;
        warnCallCopy(e);
        // A writer that failed once fails every later write: free the encoder.
        void finishCallCopy(h, c);
      });
    },
    onError: warnCallCopy,
  });
  recorder.start();
  c.recorder = recorder;
  c.startMs = Date.now();
}

/**
 * Keep one call-audio copy running for each of `peers`, and end the copy of
 * anyone who is not among them.
 *
 * The host's own recording of a guest's incoming live audio: call quality, but
 * on the host's disk whatever happens to the guest's own track. One file per
 * stretch of one guest's stream, because a running MediaRecorder cannot change
 * tracks and a rebuilt connection brings a new one. Safe to call as often as
 * the peer list changes; never throws.
 */
export function syncCallCopies(
  h: RecordingHandles,
  peers: { peerId: string; stream: MediaStream | null; name?: string | null }[]
): void {
  try {
    const dir = h.dir;
    // A guest's handles have no folder, so this is also the host-only guard.
    if (!dir || h.callCopiesClosed) return;
    const copies = (h.callCopies ??= []);
    const live = new Set(peers.map((p) => p.stream?.getAudioTracks()[0]));
    // Its guest left, or its stream is gone or was replaced by a rebuilt connection.
    for (const c of copies) if (!live.has(c.track)) void finishCallCopy(h, c);
    for (const p of peers) {
      const track = p.stream?.getAudioTracks()[0];
      // One copy per track, ever: the second ontrack call for a stream and every
      // later change to the peer list end here.
      if (!track || track.readyState === 'ended' || copies.some((c) => c.track === track)) continue;
      // One connection may not spend the take's whole budget: the others'
      // later stretches need files too.
      if (
        copies.filter((c) => c.peerId === p.peerId).length >= CALL_COPY_MAX_PER_PEER ||
        copies.length >= CALL_COPY_MAX_FILES
      ) {
        if (!h.callCopiesCapped) {
          warnCallCopy(new Error('call copy file limit reached; later stretches have no copy'));
        }
        h.callCopiesCapped = true;
        continue;
      }
      const mimeType = pickCallAudioMime();
      if (!mimeType) return;
      const copy: CallCopy = {
        peerId: p.peerId,
        ...(typeof p.name === 'string' && p.name ? { name: p.name } : {}),
        track,
        writer: new FileWriter(),
        opened: Promise.resolve(),
      };
      // Listed before its file opens, so a second call cannot open a second file.
      const n = copies.push(copy);
      copy.opened = openCallCopy(h, dir, copy, n, mimeType).catch(warnCallCopy);
    }
  } catch (e) {
    warnCallCopy(e);
  }
}

/**
 * Every writer this session has open. The last-resort commit paths need all of
 * them: a live recording can hold both WAV masters, one writer per screen-share
 * segment and one per guest 2+, and a FileSystemWritableFileStream only writes
 * through on close(). A call copy is here while it runs and not once it was told
 * to finish: it closes its own file, and listing it again would let its close
 * failure be thrown by endHostRecording.
 */
export function allWriters(h: RecordingHandles): FileWriter[] {
  return [
    h.hostWriter,
    h.guestWriter,
    h.hostWavWriter,
    h.guestWavWriter,
    ...(h.screenWriters ?? []),
    ...(h.extraWriters ?? []),
    ...(h.callCopies ?? []).filter((c) => !c.finished).map((c) => c.writer),
  ].filter((w): w is FileWriter => !!w);
}

/**
 * Every receiver that has a live channel behind it, so finalize waits for the
 * tail of each FILE rather than just the camera.
 *
 * One signal used to cover all of them, which was wrong: each file rides its own
 * DataChannel, and separate SCTP streams have no ordering guarantee between
 * them. The WAV's real data size is emitted as the very last chunk on the audio
 * channel, so a `recording-finalized` racing ahead on the camera channel let the
 * host close a WAV still advertising `data size = 0` — a file every editor opens
 * as empty on top of hundreds of MB of good PCM.
 */
function pendingReceivers(h: RecordingHandles): ChunkReceiver[] {
  const out: ChunkReceiver[] = [];
  // Slot 0's camera receiver is built up front, before any guest exists, so it
  // only counts once a channel has actually been bound to it.
  if (h.receiver && h.channelRef?.current) {
    if (h.channelRef.current.readyState === 'closed') {
      h.receiver.resolveEarly();
    } else {
      out.push(h.receiver);
    }
  }
  if (h.wavReceiver) {
    if (h.wavChannelRef) {
      if (h.wavChannelRef.current) {
        if (h.wavChannelRef.current.readyState === 'closed') {
          h.wavReceiver.resolveEarly();
        } else {
          out.push(h.wavReceiver);
        }
      }
    } else {
      out.push(h.wavReceiver);
    }
  }
  // Everything else is created lazily on channel arrival, so in a fresh take
  // its existence IS the evidence that a channel exists. A resumed take opens
  // a file for every note, so an entry there can have no channel at all, and
  // only a channel that exists is waited on.
  for (const entry of h.guestReceivers?.values() ?? []) {
    if (!entry.ref.current) continue;
    if (entry.ref.current.readyState === 'closed') {
      entry.receiver.resolveEarly();
    } else {
      out.push(entry.receiver);
    }
  }
  return out;
}

export async function endHostRecording(
  h: RecordingHandles,
  opts?: {
    onProgress?: (pendingGuests: string[]) => void;
    getPeerName?: (peerId: string) => string | undefined;
  }
): Promise<{ backup: Blob | null; wavBackup?: Blob | null }> {
  // Copies for streams that arrive from here on would never be closed.
  h.callCopiesClosed = true;
  // Begun before the screen stop, so a failure there cannot leave them running.
  const callCopies = Promise.all((h.callCopies ?? []).map((c) => finishCallCopy(h, c)));
  await stopScreenRecording(h);
  // Stop host capture first so End & save halts the host's own capture
  // immediately without waiting for guests' tails (45s without progress per
  // file, two minutes in all).
  const [, , backup, wavBackup] = await Promise.all([
    h.hostRecorder?.stopAndFlush(),
    h.hostPcm?.stopAndFlush(),
    h.backup ? h.backup.stop() : Promise.resolve(null),
    h.wavBackup ? h.wavBackup.stop() : Promise.resolve(null),
    callCopies,
  ]);

  const pReceivers = pendingReceivers(h);

  const peerId0 = h.slotPeerIds?.get(0);
  const name0 = (peerId0 ? opts?.getPeerName?.(peerId0) : undefined) || h.slotNames?.get(0) || 'Guest';

  const receiverGuestMap = new Map<ChunkReceiver, string>();
  if (h.receiver) receiverGuestMap.set(h.receiver, name0);
  if (h.wavReceiver) receiverGuestMap.set(h.wavReceiver, name0);

  for (const [key, entry] of h.guestReceivers?.entries() ?? []) {
    const baseKey = key.replace(/:(mp4|wav)$/, '');
    const slot = h.guestSlots?.get(baseKey);
    // Slots are keyed by the channel-label key (the guest's recordingId), not a
    // peerId, so the name comes through slotPeerIds.
    const peerId = slot !== undefined ? h.slotPeerIds?.get(slot) : undefined;
    const name =
      (peerId ? opts?.getPeerName?.(peerId) : undefined) ||
      (slot !== undefined ? h.slotNames?.get(slot) : undefined) ||
      (slot !== undefined ? `Guest ${slot + 1}` : 'Guest');
    receiverGuestMap.set(entry.receiver, name);
  }

  const pendingCounts = new Map<string, number>();
  for (const r of pReceivers) {
    const gName = receiverGuestMap.get(r) || 'Guest';
    pendingCounts.set(gName, (pendingCounts.get(gName) ?? 0) + 1);
  }

  const reportProgress = () => {
    opts?.onProgress?.(Array.from(pendingCounts.keys()));
  };

  reportProgress();

  // Wait per file, in parallel. Screen segments are excluded on purpose: their
  // channel is closed by the guest, and bindHostScreenChannel closes the writer
  // on that event, so the close IS their finalize.
  await Promise.all(
    pReceivers.map(async (r) => {
      await r.whenFinalized(GUEST_TAIL_TIMEOUT_MS, GUEST_TAIL_HARD_CAP_MS);
      const gName = receiverGuestMap.get(r) || 'Guest';
      const count = (pendingCounts.get(gName) ?? 1) - 1;
      if (count <= 0) {
        pendingCounts.delete(gName);
      } else {
        pendingCounts.set(gName, count);
      }
      reportProgress();
    })
  );

  h.receiver?.flushAck();
  h.wavReceiver?.flushAck();
  for (const entry of h.guestReceivers?.values() ?? []) entry.receiver.flushAck();

  const patchReceiverWav = async (receiver?: ChunkReceiver, writer?: FileWriter) => {
    if (!receiver || !writer) return;
    if (receiver.receivedFinalHeader) return;
    const total = Math.max(receiver.lastOffsetValue ?? 0, receiver.bytesWritten);
    if (total > 44) {
      const dataBytes = total - 44;
      try {
        await patchWavHeader(writer, dataBytes);
      } catch {
        // Writer may be closed or failing
      }
    }
  };

  await patchReceiverWav(h.wavReceiver, h.guestWavWriter);
  for (const [key, entry] of h.guestReceivers?.entries() ?? []) {
    if (key.endsWith(':wav') || entry.writer?.fileName?.endsWith('.wav')) {
      await patchReceiverWav(entry.receiver, entry.writer);
    }
  }

  // Every writer gets its close even when one fails: a writer errored by a full
  // disk rejects close(), and closing in series skipped committing every guest
  // and screen file after it. The first failure still surfaces.
  const closed = await Promise.allSettled(allWriters(h).map((w) => w.close()));
  const failed = closed.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason;
  return { backup, wavBackup };
}

export async function endGuestRecording(
  h: RecordingHandles
): Promise<{ drained: boolean; backup: Blob | null; wavBackup?: Blob | null }> {
  // Same reason as the host path: drain() must not start until the last chunk
  // has actually been handed to the sender, or the tail is silently dropped.
  await stopScreenRecording(h);
  await h.guestRecorder?.stopAndFlush();
  // Must finish before drain(): stopAndFlush emits the final PCM batch AND the
  // rewritten WAV header, so draining first would leave the header on the wire.
  await h.guestPcm?.stopAndFlush();
  // In parallel, not in series. Each drain is capped at DRAIN_HARD_CAP_MS, so
  // running them one after another put the guest's worst case at 90s while the
  // host waited 20 — the host gave up on a tail that was still legitimately
  // arriving. Parallel bounds the whole thing at one cap.
  const [drained, wavDrained] = await Promise.all([
    h.sender ? h.sender.drain() : Promise.resolve(true),
    h.wavSender ? h.wavSender.drain() : Promise.resolve(true),
  ]);
  const sha256 = (await h.sender?.digestHex()) ?? '';
  // Finalize EACH channel it owns, not just the camera. The host waits per file
  // now, because separate SCTP streams give no ordering guarantee between them:
  // one signal on the camera channel could arrive before the WAV's final header
  // chunk had landed on the audio channel.
  const canFinalizeMain = h.sender ? (!h.sender.isAbandoned && !h.sender.hasQueuedChunks) : true;
  if (canFinalizeMain) {
    finalizeChannel(h.channel, h.recordingId, h.sender?.lastAckedIdx ?? 0, sha256, h.videoFps);
  }
  const canFinalizeWav = h.wavSender ? (!h.wavSender.isAbandoned && !h.wavSender.hasQueuedChunks) : true;
  if (canFinalizeWav) {
    finalizeChannel(
      h.wavChannel,
      h.recordingId,
      h.wavSender?.lastAckedIdx ?? 0,
      (await h.wavSender?.digestHex()) ?? ''
    );
  }
  const [backup, wavBackup] = await Promise.all([
    h.backup ? h.backup.stop() : Promise.resolve(null),
    h.wavBackup ? h.wavBackup.stop() : Promise.resolve(null),
  ]);
  return { drained: drained && wavDrained, backup, wavBackup };
}

/** Tell the host this channel's file is complete, and hand over its digest. */
function finalizeChannel(
  channel: RTCDataChannel | undefined,
  recordingId: string,
  totalBytes: number,
  sha256: string,
  frameRate?: number
): void {
  if (channel?.readyState !== 'open') return;
  try {
    channel.send(
      JSON.stringify({
        type: 'recording-finalized',
        recordingId,
        totalBytes,
        sha256,
        ...(frameRate ? { frameRate } : {}),
      })
    );
  } catch {
    // The host bounds its own wait, so a channel that died here costs it the
    // timeout rather than hanging finalize on this side.
  }
}

export function rolePicker(role: Role | null): 'host' | 'guest' {
  return role === 'guest' ? 'guest' : 'host';
}

/**
 * Begin recording a screen-share stretch.
 *
 * The screen is captured at its native resolution — text is the payload, so
 * downscaling defeats the purpose — and rides the `recording-screen` channel so
 * its chunks never interleave with the camera's on the guest side.
 *
 * Safe to call when not recording, or when a screen recording is already
 * running: both are no-ops.
 */
export async function startScreenRecording(
  h: RecordingHandles,
  screen: MediaStream,
  role: 'host' | 'guest',
  peer: { createRecordingScreenChannel: () => RTCDataChannel } | null,
  onError?: (err: unknown) => void,
  sharerName?: string
): Promise<void> {
  if (h.screenRecorder) return;
  const mimeType = pickRecordingMime();
  if (!mimeType) return; // no encoder here; camera recording is unaffected
  if (role === 'host' && !h.dir) return;
  if (role === 'guest' && !peer) return;
  const track = screen.getVideoTracks()[0];
  if (!track || track.readyState === 'ended') return;

  let segment = (h.screenSegment ?? 0) + 1;
  h.screenSegment = segment;

  const rollback = () => {
    if (segment > 1) {
      h.screenSegment = segment - 1;
    } else {
      delete h.screenSegment;
    }
  };

  const videoBitsPerSecond = presetForTrack(track).videoBps;
  const screenBackup = new BackupRecorder({
    mimeType,
    fileName: 'openmeet-backup-screen',
    ...(h.room ? { room: h.room } : {}),
  });

  if (role === 'host') {
    if (!h.dir) return;
    if (h.resumed) {
      // The counter starts again after a resume, so the first share would open
      // the number the crashed tab left in the folder. Step past every name
      // already there; a fresh take's id is new, so it never probes.
      const free = await freeScreenSegment(h.dir, 'host', h.recordingId, segment);
      if (free === null) {
        // No name the folder was asked about is free, and an unasked one could
        // be a file from before the crash.
        rollback();
        refuseScreenSegment(h, 'host', onError);
        return;
      }
      segment = free;
      h.screenSegment = segment;
    }
    const writer = new FileWriter();
    await writer.openIn(h.dir, screenFileName('host', h.recordingId, segment));
    if (screen.getVideoTracks()[0]?.readyState === 'ended') {
      await writer.close();
      rollback();
      return;
    }
    const rec = new ChunkRecorder({
      mimeType,
      stream: screen,
      videoBitsPerSecond,
      onChunk: (c) => {
        screenBackup.writeChunk(c.payload);
        writer.write(c.header.offset, c.payload).catch((e) => onError?.(e));
      },
      ...(onError ? { onError } : {}),
    });
    try {
      rec.start();
      screenBackup.start();
      h.screenBackup = screenBackup;
      h.screenWriters = [...(h.screenWriters ?? []), writer];
      (h.screenStartsByFile ??= new Map()).set(writer.fileName, Date.now());
      if (sharerName) {
        (h.screenSharersByFile ??= new Map()).set(writer.fileName, sharerName);
      }
      h.screenWriter = writer;
      h.screenRecorder = rec;
    } catch (e) {
      await writer.close();
      await screenBackup.stop();
      rollback();
      onError?.(e);
    }
  } else {
    if (!peer) return;
    // One channel per segment: each carries exactly one file, so idx/offset and
    // the retransmit buffer reset naturally instead of needing a segment tag.
    const channel = peer.createRecordingScreenChannel();
    h.screenChannel = channel;
    // Bounded. Unbounded, a channel whose SCTP negotiation stalled never
    // settled — and this is awaited from beginGuestRecording, so the guest sat
    // in the call with no recording, no phase change and no error: the catch
    // could never run either.
    const opened = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), SCREEN_CHANNEL_OPEN_TIMEOUT_MS);
      channel.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        { once: true }
      );
      if (channel.readyState === 'open') {
        clearTimeout(timer);
        resolve(true);
      }
    });
    if (!opened) {
      onError?.(new Error('The screen-recording channel did not open; the screen is not being recorded.'));
      h.screenChannel = undefined;
      rollback();
      try { channel.close(); } catch { /* already gone */ }
      return;
    }
    if (screen.getVideoTracks()[0]?.readyState === 'ended') {
      try { channel.close(); } catch { /* already gone */ }
      h.screenChannel = undefined;
      rollback();
      return;
    }
    const sender = new ChunkSender({
      recordingId: h.recordingId,
      channel,
      ...(onError ? { onError } : {}),
    });
    h.screenSender = sender;
    bindGuestChannel(channel, sender);
    const rec = new ChunkRecorder({
      mimeType,
      stream: screen,
      videoBitsPerSecond,
      onChunk: (c) => {
        screenBackup.writeChunk(c.payload);
        sender.sendChunk(c);
      },
      ...(onError ? { onError } : {}),
    });
    try {
      rec.start();
      screenBackup.start();
      h.screenBackup = screenBackup;
      h.screenRecorder = rec;
    } catch (e) {
      try { channel.close(); } catch { /* already gone */ }
      await screenBackup.stop();
      h.screenChannel = undefined;
      h.screenSender = undefined;
      rollback();
      onError?.(e);
    }
  }
}

/** End the current screen-share stretch, flushing its tail. No-op if inactive. */
export async function stopScreenRecording(h: RecordingHandles): Promise<void> {
  const rec = h.screenRecorder;
  const sb = h.screenBackup;
  if (!rec && !sb) return;
  h.screenRecorder = undefined;
  h.screenBackup = undefined;
  await rec?.stopAndFlush();
  if (h.screenSender && h.screenChannel?.readyState === 'open') {
    await h.screenSender.drain();
    const canFinalize = !h.screenSender.isAbandoned && !h.screenSender.hasQueuedChunks;
    if (canFinalize) {
      const sha256 = (await h.screenSender.digestHex()) ?? '';
      finalizeChannel(h.screenChannel, h.recordingId, h.screenSender.lastAckedIdx ?? 0, sha256);
    }
  }
  await h.screenWriter?.close();
  h.screenWriter = undefined;
  h.screenSender = undefined;
  if (h.screenChannel) {
    try { h.screenChannel.close(); } catch { /* already gone */ }
    h.screenChannel = undefined;
  }
  await sb?.stop();
  if (sb) {
    h.screenBackups = [...(h.screenBackups ?? []), sb];
  }
}

/**
 * Host side: a guest screen segment arrived. Each segment opens its own file,
 * numbered to match the guest's, so repeated shares don't overwrite each other.
 */
export async function bindHostScreenChannel(
  channel: RTCDataChannel,
  h: RecordingHandles,
  onError?: (err: unknown) => void,
  sharerPeerIdOrName?: string
): Promise<void> {
  channel.binaryType = 'arraybuffer';
  if (!h.dir) return;
  // A number is claimed before anything is awaited, so two shares arriving
  // together never hold the same one.
  const claim = () =>
    (h.guestScreenSegments = Math.max(h.guestScreenSegments ?? 0, h.screenReceivers?.size ?? 0) + 1);
  let segment: number | null = claim();
  if (h.resumed) {
    // After a resume the notes can be short of the numbers already handed out.
    // A number the folder already holds is given up for the next unclaimed one,
    // which keeps a segment saved before the crash from being opened over. A
    // fresh take reuses its own number.
    segment = await freeScreenSegment(h.dir, 'guest', h.recordingId, segment, claim);
  }
  if (segment === null) {
    refuseScreenSegment(h, 'guest', onError);
    return;
  }
  const writer = new FileWriter();
  await writer.openIn(h.dir, screenFileName('guest', h.recordingId, segment));
  // The share can stop while the file is opening. Its close event has fired by
  // now, so nothing below would ever close this file or drop its row.
  if (channel.readyState === 'closed') {
    await writer.close();
    await h.dir.removeEntry?.(writer.fileName);
    return;
  }
  h.screenWriters = [...(h.screenWriters ?? []), writer];
  (h.screenStartsByFile ??= new Map()).set(writer.fileName, Date.now());
  h.journal?.note((n) => {
    // Screen shares get their own bound: later segments are still recorded,
    // they only have no crash copy to reopen.
    if (n.files.filter((f) => f.kind === 'screen').length >= MAX_GUEST_SCREEN_NOTES) return;
    n.files.push({
      file: writer.fileName,
      kind: 'screen',
      segment,
      startedAtMs: Date.now(),
      ...(sharerPeerIdOrName ? { who: sharerPeerIdOrName.slice(0, 200) } : {}),
    });
  });
  if (sharerPeerIdOrName) {
    (h.screenSharerPeerIdsByFile ??= new Map()).set(writer.fileName, sharerPeerIdOrName);
  }
  const ref: { current: RTCDataChannel | null } = { current: channel };
  const receiver = new ChunkReceiver({
    recordingId: h.recordingId,
    writer,
    sendControl: (json) => {
      const c = ref.current;
      if (c && c.readyState === 'open') c.send(json);
    },
    ...(h.journal ? { journalFile: h.journal.file(writer.fileName) } : {}),
    ...(h.onWarn ? { onWarn: h.onWarn } : {}),
    ...(onError ? { onError } : {}),
  });
  h.screenReceivers = new Map(h.screenReceivers ?? []).set(segment, receiver);
  (h.screenLive ??= new Map()).set(segment, sharerPeerIdOrName ?? '');
  channel.onmessage = (ev: MessageEvent) => {
    void receiver.handleMessage(ev.data as string | ArrayBuffer);
  };
  channel.addEventListener('close', () => {
    h.screenLive?.delete(segment);
    if (!receiver.receivedFinalized) {
      (h.screenEndedEarlyByFile ??= new Set()).add(writer.fileName);
    }
    void writer.close().then(async () => {
      // A share stopped before its first chunk leaves an empty file: don't keep or list it.
      if (receiver.bytesWritten > 0) return;
      h.screenWriters = (h.screenWriters ?? []).filter((w) => w !== writer);
      h.screenEndedEarlyByFile?.delete(writer.fileName);
      await h.dir?.removeEntry?.(writer.fileName);
      // The note named a file that is gone; a resume must not open it again.
      h.journal?.note((n) => {
        n.files = n.files.filter((f) => f.file !== writer.fileName);
      });
    }).catch((e: unknown) => onError?.(e));
  });
}

/**
 * Gather guest report data for all guest slots (slot 0 and extra slots) and
 * match display names.
 */
export async function collectGuestReports(
  h: RecordingHandles,
  getPeerName?: (peerId: string) => string | undefined
): Promise<GuestSyncInput[]> {
  const out: GuestSyncInput[] = [];

  // Slot 0
  if (h.receiver) {
    const peerId0 = h.slotPeerIds?.get(0);
    // The name the room still lists wins; a guest who left is named by the
    // name their slot was bound with.
    const name0 = (peerId0 ? getPeerName?.(peerId0) : undefined) || h.slotNames?.get(0);
    const abandoned0 = Boolean(h.receiver.isAbandoned || h.wavReceiver?.isAbandoned);
    const timedOut0 = Boolean(h.receiver.isTimedOut || h.wavReceiver?.isTimedOut);
    const endedEarly0 = abandoned0 || timedOut0;
    // This tab hashed only the part that arrived after the crash, so a resumed
    // file has no digest that can stand for the whole file.
    const writtenSha0 = h.receiver.resumed ? undefined : await h.receiver.digestHex();
    out.push({
      slot: 0,
      ...(name0 ? { name: name0 } : {}),
      file: h.guestWriter?.fileName || guestName(0, h.recordingId, h.take ?? 1, 'mp4'),
      // Any WAV writer means a file in the folder, empty or not; a guest whose
      // browser never opened one has nothing to report.
      ...(h.guestWavWriter?.fileName ? { wavFile: h.guestWavWriter.fileName } : {}),
      startHostMs: h.receiver.guestStartHostMs ?? h.slotClock?.get(0)?.startHostMs ?? null,
      rttMs: h.receiver.syncRttMs ?? h.slotClock?.get(0)?.rttMs ?? null,
      trackFps: h.receiver.senderFrameRate,
      sha256Written: writtenSha0,
      noWav: !h.guestWavWriter,
      ...(h.receiver.resumed ? { resumed: true } : {}),
      ...(abandoned0 ? { abandoned: true } : {}),
      ...(timedOut0 ? { timedOut: true } : {}),
      ...(endedEarly0 ? { endedEarly: true } : {}),
    });
  }

  // Extra slots (1, 2, ...)
  const handledSlots = new Set<number>([0]);
  for (const [key, slot] of h.guestSlots?.entries() ?? []) {
    if (handledSlots.has(slot)) continue;
    handledSlots.add(slot);

    const mp4Entry = h.guestReceivers?.get(`${key}:mp4`);
    const wavEntry = h.guestReceivers?.get(`${key}:wav`);
    if (!mp4Entry && !wavEntry) continue;

    const peerId = h.slotPeerIds?.get(slot) || key;
    const name = getPeerName?.(peerId) || h.slotNames?.get(slot);
    const abandoned = Boolean(mp4Entry?.receiver.isAbandoned || wavEntry?.receiver.isAbandoned);
    const timedOut = Boolean(mp4Entry?.receiver.isTimedOut || wavEntry?.receiver.isTimedOut);
    const endedEarly = abandoned || timedOut;
    const writtenSha = mp4Entry && !mp4Entry.receiver.resumed ? await mp4Entry.receiver.digestHex() : undefined;

    out.push({
      slot,
      ...(name ? { name } : {}),
      file: mp4Entry?.writer?.fileName || guestName(slot, h.recordingId, h.take ?? 1, 'mp4'),
      ...(wavEntry?.writer?.fileName ? { wavFile: wavEntry.writer.fileName } : {}),
      startHostMs: mp4Entry?.receiver.guestStartHostMs ?? h.slotClock?.get(slot)?.startHostMs ?? null,
      rttMs: mp4Entry?.receiver.syncRttMs ?? h.slotClock?.get(slot)?.rttMs ?? null,
      trackFps: mp4Entry?.receiver.senderFrameRate ?? null,
      sha256Written: writtenSha,
      noWav: !wavEntry,
      ...(mp4Entry?.receiver.resumed ? { resumed: true } : {}),
      ...(abandoned ? { abandoned: true } : {}),
      ...(timedOut ? { timedOut: true } : {}),
      ...(endedEarly ? { endedEarly: true } : {}),
    });
  }

  out.sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
  return out;
}

/**
 * Every screen file still on disk, each with its start relative to the host
 * recording start. Looked up by file name, so a dropped or late-registered
 * segment can't shift another segment's offset.
 */
export function collectScreenSegments(
  h: RecordingHandles,
  getPeerName?: (peerId: string) => string | undefined
): ScreenSegmentInput[] {
  return (h.screenWriters ?? [])
    .filter((w) => w.fileName)
    .map((w) => {
      const startMs = h.screenStartsByFile?.get(w.fileName);
      const endedEarly = Boolean(h.screenEndedEarlyByFile?.has(w.fileName));
      const peerIdOrName = h.screenSharerPeerIdsByFile?.get(w.fileName);
      // A sharer still in the room is named by the room; one who left by the
      // name their slot was bound with.
      const sharer =
        (peerIdOrName ? getPeerName?.(peerIdOrName) : undefined) ??
        (peerIdOrName ? slotNameForPeer(h, peerIdOrName) : undefined) ??
        h.screenSharersByFile?.get(w.fileName) ??
        (peerIdOrName && !getPeerName ? peerIdOrName : undefined);
      return {
        file: w.fileName,
        offsetMs: startMs != null && h.hostStartMs != null ? Math.max(0, startMs - h.hostStartMs) : 0,
        ...(endedEarly ? { endedEarly: true } : {}),
        ...(sharer ? { sharer } : {}),
      };
    });
}

/**
 * Copies the folder really holds: the writer committed bytes and no write or
 * close of it failed. A failed copy may be gone or half-written, so the summary
 * and the sync file must not name it.
 */
const keptCallCopies = (h: RecordingHandles): CallCopy[] =>
  (h.callCopies ?? []).filter((c) => !c.failed && c.writer.size > 0 && c.writer.fileName);

/** Call copies that are in the folder, each with its start relative to the host recording start. */
export function collectCallCopies(h: RecordingHandles): CallCopyInput[] {
  return keptCallCopies(h).map((c) => ({
    file: c.writer.fileName,
    offsetMs: c.startMs != null && h.hostStartMs != null ? Math.max(0, c.startMs - h.hostStartMs) : 0,
    ...(c.name ? { name: c.name } : {}),
  }));
}

/**
 * What the host knows about every file this take wrote, keyed by file name:
 * its size and, for a file that arrived from a guest, what the sender
 * reported against what was written.
 */
export async function collectFileChecks(h: RecordingHandles): Promise<Map<string, FileCheck>> {
  const receivers = new Map<string, ChunkReceiver>();
  const all = [
    h.receiver,
    ...[...(h.guestReceivers?.values() ?? [])].map((e) => e.receiver),
    ...(h.screenReceivers?.values() ?? []),
  ];
  for (const r of all) if (r) receivers.set(r.fileName, r);
  const out = new Map<string, FileCheck>();
  for (const w of allWriters(h)) {
    const r = receivers.get(w.fileName);
    // A resumed receiver hashed only the part that arrived after the crash, so
    // its check is the same "recovered" one a rebuilt file gets only once the
    // sender said it had finished: a stopped or unfinished resumed file keeps
    // its received block, with the digest comparison withheld because no
    // digest can stand for the whole file, so it still reads Incomplete.
    // A file whose replay stopped short has a hole, which is known and not
    // merely unverified: it is never "recovered", and the sender's digest is
    // compared, so it reads as differing from what was sent.
    const short = Boolean(h.shortFiles?.has(w.fileName));
    const recovered = Boolean(r?.resumed && r.receivedFinalized && !r.isAbandoned && !short);
    out.set(w.fileName, {
      bytes: w.size,
      ...(recovered
        ? { recovered: true }
        : r
          ? {
              received: {
                finalized: r.receivedFinalized,
                abandoned: r.isAbandoned,
                sha256Sent: r.resumed && !short ? undefined : r.senderSha256 ?? undefined,
                sha256Written: await r.digestHex(),
              },
            }
          : {}),
    });
  }
  // A pre-crash host part was written by its copy, not by a writer of this take.
  for (const [name, bytes] of h.hostCopied ?? []) out.set(name, { bytes });
  // A finished call copy closed its own file and is not in allWriters; one the
  // take removed, or whose write or close failed, has no file to check.
  for (const c of keptCallCopies(h)) out.set(c.writer.fileName, { bytes: c.writer.size });
  return out;
}

/** One recorded file's progress at one instant. The health panel reads these on a timer. */
export interface TrackReading {
  /** Stable for the life of the file, and never built from anything a peer chose.
   *  Which peer a slot belongs to is the last one to bind that key, so a row's
   *  owner is only as private as the key itself. */
  key: string;
  /** Whose file, for a guest's track arriving at the host. Absent for this browser's own. */
  who?: string;
  track: 'camera' | 'wav' | 'screen';
  /** Own track: bytes that reached the disk, or the recorder's count when this
   *  browser has no writer. A guest's track on the host: bytes written. */
  bytes: number;
  /** Own track on a guest: bytes of it the host has acknowledged writing. */
  acked?: number;
  /** The sender gave up streaming this file; the rest is only in its backup. */
  stopped?: boolean;
}

/** Someone else in the room, as the health reading needs to know them. */
export interface HealthPeer {
  peerId: string;
  name: string | null;
  /** A guest whose browser can record: the host should be receiving its camera. */
  expected: boolean;
}

/** Rows from one peer's channels: camera, WAV and live screens, with headroom.
 *  One guest opening many channels must not push another guest's rows out. */
const MAX_ROWS_PER_PEER = 4;

export function collectTrackHealth(h: RecordingHandles, peers: HealthPeer[]): TrackReading[] {
  const own: TrackReading[] = [];
  // What the host has confirmed of a track this browser streams to it. The
  // host's own tracks go straight to disk and have no sender.
  const sent = (s: ChunkSender | undefined) =>
    s ? { acked: s.ackedBytes, ...(s.isAbandoned ? { stopped: true } : {}) } : {};
  const camera = h.hostRecorder ?? h.guestRecorder;
  if (camera) {
    own.push({
      key: 'own:camera',
      track: 'camera',
      // The recorder counts what it produced, which a refused write never
      // reaches the disk with; the writer counts what did.
      bytes: h.hostWriter ? h.hostWriter.size : camera.totalBytes,
      ...sent(h.sender),
    });
  }
  const pcm = h.hostPcm ?? h.guestPcm;
  if (pcm) {
    own.push({
      key: 'own:wav',
      track: 'wav',
      bytes: h.hostWavWriter ? h.hostWavWriter.size : pcm.totalBytes,
      ...sent(h.wavSender),
    });
  }
  if (h.screenRecorder) {
    own.push({
      key: `own:screen:${h.screenSegment ?? 0}`,
      track: 'screen',
      bytes: h.screenWriter ? h.screenWriter.size : h.screenRecorder.totalBytes,
      ...sent(h.screenSender),
    });
  }

  const guests: TrackReading[] = [];
  const peerRows = new Map<string, number>();
  const cameraPeers = new Set<string>();
  const inRoom = (peerId: string | undefined) => peers.find((p) => p.peerId === peerId);
  // A name can be blank as easily as missing, and a blank row reads as nobody.
  const named = (name: unknown, fallback: string) =>
    (typeof name === 'string' && name.trim() ? name : fallback);
  const received = (key: string, who: string, track: TrackReading['track'], r: ChunkReceiver) =>
    guests.push({ key, who, track, bytes: r.bytesWritten, ...(r.isAbandoned ? { stopped: true } : {}) });
  // The file of a guest who left, or who reloaded into a new slot, never
  // grows again. Listed, it would read as a stalled track until the take
  // ends and hide the next real one.
  const slotRow = (slot: number, wav: boolean, r: ChunkReceiver) => {
    const peer = inRoom(h.slotPeerIds?.get(slot));
    if (!peer) return;
    if (!wav) cameraPeers.add(peer.peerId);
    const count = peerRows.get(peer.peerId) ?? 0;
    if (count >= MAX_ROWS_PER_PEER) return;
    peerRows.set(peer.peerId, count + 1);
    const who = named(peer.name, slot === 0 ? 'Guest' : `Guest ${slot + 1}`);
    received(`g${slot}:${wav ? 'wav' : 'mp4'}`, who, wav ? 'wav' : 'camera', r);
  };

  // Slot 0's camera receiver is built before any guest exists; it is a track
  // only once a channel has been bound to it.
  if (h.receiver && h.channelRef?.current) slotRow(0, false, h.receiver);
  for (const [key, entry] of h.guestReceivers?.entries() ?? []) {
    const slot = h.guestSlots?.get(key.replace(/:(mp4|wav)$/, ''));
    if (slot !== undefined) slotRow(slot, key.endsWith(':wav'), entry.receiver);
  }
  for (const [segment, peerId] of h.screenLive?.entries() ?? []) {
    const peer = inRoom(peerId);
    const r = h.screenReceivers?.get(segment);
    if (!peer || !r) continue;
    const count = peerRows.get(peer.peerId) ?? 0;
    if (count >= MAX_ROWS_PER_PEER) continue;
    peerRows.set(peer.peerId, count + 1);
    received(`s${segment}`, named(peer.name, 'Guest'), 'screen', r);
  }
  // Host only. A recorded guest with no file yet is the one failure the host
  // has no other way to see, so it gets a row that stays at zero. At most one
  // per person in the room, so these are not counted against the cap.
  if (h.dir) {
    for (const p of peers) {
      if (p.expected && !cameraPeers.has(p.peerId)) {
        guests.push({ key: `p:${p.peerId}`, who: named(p.name, 'Guest'), track: 'camera', bytes: 0 });
      }
    }
  }
  guests.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return [...own, ...guests];
}
