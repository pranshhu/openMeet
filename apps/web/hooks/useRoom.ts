'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DATA_CHANNEL_RECORDING_AUDIO,
  DATA_CHANNEL_RECORDING_SCREEN,
  WS_CLOSE_CAPACITY_FULL,
  WS_CLOSE_REPLACED,
  recordingChannelKind,
  type BrowserNote,
  type Role,
  type ServerMessage,
} from '@openmeet/protocol';
import { getRoom, getTurnCred, patchRecording, type TurnCred } from '@/lib/api';
import { WS_BASE } from '@/lib/env';
import { SignalClient } from '@/lib/signal';
import { PeerConnection, ConnectionTimeoutError } from '@/lib/peer';
import { MediaManager } from '@/lib/media';
import { SwitchableMedia, isPhone } from '@/lib/switchable-media';
import { buildIceServers } from '@/lib/ice';
import { getScreenStream, presentFile, presentRearCamera } from '@/lib/screen';
import { pickRecordingMime, UnsupportedCodecError } from '@/lib/recorder';
import { BackupRecorder } from '@/lib/backup-recorder';
import { isPcmCaptureSupported } from '@/lib/pcm-recorder';
import { MediaBoard } from '@/lib/media-board';
import { getHostToken } from '@/lib/host-token';
import { getOrCreateClientId } from '@/lib/client-id';
import { hostTagNote } from '@/lib/browser-guidance';
import {
  buildSyncReport,
  buildChatLog,
  MAX_CHAT_MESSAGE_LENGTH,
  type ChapterMarker,
  type SyncReport,
  type SyncReportData,
  type ChatMessage,
} from '@/lib/sync-report';
import {
  startHostRecording,
  startGuestRecording,
  endHostRecording,
  endGuestRecording,
  requestResume,
  allWriters,
  bindHostGuestChannel,
  bindHostAudioChannel,
  bindHostScreenChannel,
  rolePicker,
  startScreenRecording,
  stopScreenRecording,
  rebindGuestRecordingWhenConnected,
  collectGuestReports,
  collectScreenSegments,
  takeName,
  writeTakeSidecars,
  type RecordingHandles,
} from './recording-controller';

export type RoomPhase =
  | 'checking'
  | 'not-found'
  | 'lobby'
  | 'waiting'
  | 'connecting'
  | 'in-call'
  | 'recording'
  | 'finalizing'
  | 'done'
  | 'peer-left'
  // YOU left, deliberately. Distinct from 'peer-left' (the other person went)
  // so the screen can say the right thing. Without it, leave() tore down the
  // connection but never changed phase, leaving the user staring at a frozen
  // call stage with dead video and no indication anything had happened.
  | 'left'
  // The room refused this socket (4001), or another tab or device took this
  // host seat over (4006). Each gets its own screen and next step.
  | 'full'
  | 'replaced'
  | 'error';

export type { ChatMessage };

export interface PeerPresence {
  micOn: boolean;
  camOn: boolean;
  screenSharing: boolean;
}

export interface RemotePeer {
  peerId: string;
  name: string | null;
  stream: MediaStream | null;
  presence?: PeerPresence | undefined;
  role?: Role | undefined;
  companion?: boolean | undefined;
}

export function applyRemotePeerPresence(
  remotePeers: RemotePeer[],
  m: { fromPeerId?: string; fromName?: string; micOn: boolean; camOn: boolean; screenSharing: boolean }
): RemotePeer[] {
  const presence: PeerPresence = {
    micOn: m.micOn,
    camOn: m.camOn,
    screenSharing: m.screenSharing,
  };
  const targetPeerId = m.fromPeerId ?? remotePeers[0]?.peerId;
  if (!targetPeerId) return remotePeers;
  const exists = remotePeers.some((r) => r.peerId === targetPeerId);
  if (exists) {
    return remotePeers.map((r) =>
      r.peerId === targetPeerId
        ? {
            ...r,
            presence,
            ...(m.fromName && !r.name ? { name: m.fromName } : {}),
          }
        : r
    );
  }
  return [
    ...remotePeers,
    {
      peerId: targetPeerId,
      name: m.fromName ?? null,
      stream: null,
      presence,
    },
  ];
}

export function removeRemotePeer(remotePeers: RemotePeer[], peerId: string): RemotePeer[] {
  return remotePeers.filter((r) => r.peerId !== peerId);
}

export interface RoomState {
  phase: RoomPhase;
  role: Role | null;
  companion?: boolean | undefined;
  localStream: MediaStream | null;
  isFallbackMedia?: boolean;
  activeMicId?: string | undefined;
  activeCamId?: string | undefined;
  /** Primary remote — the first peer. Kept so the 1:1 stage path is unchanged. */
  remoteStream: MediaStream | null;
  /** Everyone else in the room. Length > 1 means a mesh call. */
  remotePeers: RemotePeer[];
  remoteScreenStream: MediaStream | null;
  localScreenStream: MediaStream | null; // self-preview of the screen we're sharing
  localName: string;
  screenSharing: boolean; // local user is sharing their screen
  presentingRearCamera?: boolean;
  error: string | null;
  // Recording-specific failure, surfaced as a banner INSIDE the call rather than
  // as phase:'error'. Switching phase unmounts CallStage, which takes the
  // "End & save" button with it and strands the file unclosed — so a recording
  // problem must never be allowed to end the call.
  recordingError: string | null;
  // Peer-connection health, surfaced non-fatally. Without this an ICE failure is
  // an eternal "Connecting…" with no explanation anywhere.
  connectionWarning: string | null;
  messages: ChatMessage[];
  backupBlobUrl: string | null;
  wavBackupBlobUrl: string | null;
  drained: boolean;
  // Host-only: editor alignment + seekability companion for the finished pair.
  syncReportUrl: string | null;
  sidecarsSaved: boolean;
  markers: ChapterMarker[];
  chaptersUrl: string | null;
  summary: SyncReportData | null;
  /** Finished takes in this session, newest last. */
  takes: { take: number; startedAt: number; durationMs: number; discarded: boolean }[];
  /**
   * The host has a recording running. Drives the "this call is being recorded"
   * notice — everyone in the room is entitled to know, whether or not their own
   * capture started.
   */
  peerRecording: boolean;
  /**
   * What each remote peer's browser can actually capture, keyed by peerId.
   * Lets the host see BEFORE pressing Record who won't be captured, and why,
   * instead of finding out at playback. Populated from `recording-capability`
   * relays; an entry is dropped when that peer leaves.
   */
  capabilities: Record<string, { mp4: boolean; wav: boolean; note?: BrowserNote }>;
  /** List of guests the host is still receiving tail data from during finalize. */
  finalizingGuests: string[];
}

/** One reading of how this device is coping with the take it is recording. */
export interface LoadSample {
  /** Audio the WAV master had to pad with silence so far in this take, in ms. */
  audioDroppedMs: number;
  /** The browser reports a live video encoder as limited by the processor. */
  cpuLimited: boolean;
}

export type PresentSource = File | 'rear-camera';

/**
 * What THIS browser can actually record. Sent as `recording-capability` right
 * after `role-assigned` and again on every `peer-joined`, so every peer —
 * including a late joiner — learns it. Pure and exported so it's testable
 * without a full hook harness, the same seam as `shouldFollowHostRecording`.
 */
export function computeRecordingCapability(ua?: string): { mp4: boolean; wav: boolean; note?: BrowserNote } {
  const mp4 = pickRecordingMime() !== null;
  const wav = isPcmCaptureSupported();
  const note = hostTagNote(ua);
  return { mp4, wav, ...(note ? { note } : {}) };
}

/**
 * Where to go when the peer's socket closes.
 *
 * An in-progress recording MUST hold its phase. Moving to 'peer-left' unmounts
 * CallStage, removing the "End & save" button — the only thing that closes the
 * file handle — so a two-second wifi blip used to leave two zero-byte MP4s.
 * Extracted as a pure function so this specific decision is testable without a
 * full hook harness; it is the highest-consequence branch in the file.
 */
/** Phases a live media event must never drag the room out of. */
const TERMINAL_PHASES = new Set<RoomPhase>(['recording', 'finalizing', 'done', 'left', 'full', 'replaced', 'error']);

export function phaseOnPeerLeft(phase: RoomPhase): RoomPhase {
  return phase === 'recording' || phase === 'finalizing' || phase === 'done' ? phase : 'peer-left';
}

/**
 * What a TERMINAL server close does to the room.
 *
 * Same rule as phaseOnPeerLeft, and for the same reason: switching phase
 * unmounts CallStage, which takes "End & save" with it, and that button is the
 * only thing that closes the file handles. This path used to switch
 * unconditionally, so a 4001/4002/4003 arriving mid-recording left every file
 * at zero bytes. Returning null means "hold the phase, show a banner instead".
 */
export function phaseOnFatalClose(phase: RoomPhase, code: number): { phase: RoomPhase } | null {
  if (phase === 'recording' || phase === 'finalizing') return null;
  if (code === WS_CLOSE_REPLACED) return { phase: 'replaced' };
  return code === WS_CLOSE_CAPACITY_FULL
    ? { phase: 'full' }
    : { phase: 'not-found' }; // invalid (4002) or expired (4003) slug
}

/**
 * Should this peer start its own capture when a `recording-started` arrives?
 *
 * Pure and exported because every branch here is a silent failure if it is
 * wrong: follow when we shouldn't and a producer ends up in the recording;
 * don't follow when we should and the host records itself talking to an
 * unrecorded guest, which nobody notices until playback.
 *
 * An older tab may still send it; nothing here reacts to a message that is not
 * from the host.
 */
export function shouldFollowHostRecording(opts: {
  from: Role;
  role: Role | null;
  producer: boolean;
  alreadyRecording: boolean;
}): boolean {
  if (opts.from !== 'host') return false;
  if (opts.producer) return false; // present to run the session, never recorded
  if (opts.role !== 'guest') return false;
  return !opts.alreadyRecording;
}

/**
 * Where to go when a peer (re)joins. 'peer-left' must be recoverable — the peer
 * may simply have reconnected — or a blip strands the session permanently.
 */
export function phaseOnPeerJoined(phase: RoomPhase): RoomPhase {
  return phase === 'waiting' || phase === 'peer-left' ? 'connecting' : phase;
}

/**
 * Where to go when role is assigned. Move to 'waiting' only if alone in the
 * room; stay 'connecting' if peers are already present. Never downgrade
 * established calls or terminal states.
 */
export function phaseOnRoleAssigned(currentPhase: RoomPhase, anyoneHere: boolean): RoomPhase {
  if (currentPhase === 'connecting' || currentPhase === 'waiting') {
    return anyoneHere ? 'connecting' : 'waiting';
  }
  return currentPhase;
}

/**
 * Compute recordingError when a peer joins.
 * Clear stale error if recovering from peer-left or if a host re-joins.
 */
export function recordingErrorOnPeerJoined(
  phase: RoomPhase,
  remoteRole: Role | null,
  currentError: string | null
): string | null {
  if (phase === 'peer-left' || remoteRole === 'host') return null;
  return currentError;
}

/**
 * Forget any guest recording channels that arrived before this take started.
 * Guests create channels only after recording-started, so anything older
 * belongs to a previous host connection or take.
 *
 * Stale channels are deliberately NOT closed: closing them while the guest's
 * old take is ending forces ChunkSender.drain() to poll until its 30 s hard
 * cap. Leaving them open lets the guest drain queued bytes immediately into
 * the unbound channel.
 */
export function forgetPreTakeGuestChannels(
  hostChannelRef: { current: RTCDataChannel | null },
  audioChannelsRef: { current: Map<string, RTCDataChannel> }
): void {
  hostChannelRef.current = null;
  audioChannelsRef.current.clear();
}

/**
 * Handle host recording-started signal for a guest peer.
 * If already recording, ends the current take cleanly (flushing and keeping backup)
 * before starting the new take with a fresh recordingId.
 */
export async function handleGuestRecordingStarted(opts: {
  recordingRef: { current: RecordingHandles | null };
  endRecording: () => Promise<void>;
  beginGuestRecording: () => Promise<void>;
}): Promise<void> {
  if (opts.recordingRef.current) {
    await opts.endRecording();
  }
  await opts.beginGuestRecording();
}

// Turn a recording failure into something the user can act on. Anything not
// recognised still surfaces its message rather than being swallowed.
export function recordingErrorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === 'ConnectionTimeoutError') {
    return "Couldn't connect to the host, so your camera isn't reaching their recording. Your in-browser backup is still recording.";
  }
  if (name === 'StreamAbandonedError') {
    return 'Upload backlog exceeded — upload stopped to protect the recording. Your full copy is saved locally (backup).';
  }
  if (name === 'UnsupportedCodecError') {
    return 'This browser cannot record MP4. Use a Chromium browser such as Google Chrome.';
  }
  if (name === 'ChannelNeverOpenedError') {
    return (e as Error).message;
  }
  if (name === 'DiskFullError') {
    return 'Disk full — recording stopped. Free up space, then press End & save to keep what was recorded.';
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Permission to write to that folder was denied. Press Record again and choose a folder you own.';
  }
  const msg = e instanceof Error ? e.message : String(e);
  return `Recording failed: ${msg}`;
}

// Resolve once the channel is open. Attach the listener BEFORE checking
// readyState so a channel that opens between the two can't be missed.
/**
 * Wait for a DataChannel to open, or fail loudly.
 *
 * The unbounded version was survivable while recording was a button the user
 * pressed: nothing happened, and they could see that and press it again. Now
 * the guest starts automatically, so a channel that never opens — host pressed
 * Record mid-ICE-restart, connection still coming up — left the guest showing
 * "being recorded" while recording nothing at all, with no error anywhere.
 */
/** Minimum gap between automatic reconnects triggered by a repeated ICE failure. */
export const ICE_RECONNECT_COOLDOWN_MS = 120_000;

export function waitForOpen(channel: RTCDataChannel, timeoutMs = 15_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (channel.readyState === 'open') return resolve();
    if (channel.readyState === 'closed') return reject(new ChannelNeverOpenedError());
    const timer =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => reject(new ChannelNeverOpenedError()), timeoutMs)
        : null;
    // A channel that closes before opening never will (its connection was rebuilt).
    channel.addEventListener(
      'close',
      () => {
        if (timer) clearTimeout(timer);
        reject(new ChannelNeverOpenedError());
      },
      { once: true }
    );
    channel.addEventListener(
      'open',
      () => {
        if (timer) clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

export class ChannelNeverOpenedError extends Error {
  constructor() {
    super('The recording connection never opened. Check the connection and try again.');
    this.name = 'ChannelNeverOpenedError';
  }
}

export function phaseOnConnectionStateChange(
  currentPhase: RoomPhase,
  connectionState: RTCPeerConnectionState
): RoomPhase {
  if (connectionState === 'connected') {
    return TERMINAL_PHASES.has(currentPhase) ? currentPhase : 'in-call';
  }
  return currentPhase;
}

export function phaseOnRemoteStream(currentPhase: RoomPhase): RoomPhase {
  return currentPhase;
}

/**
 * The stream this browser sends and records to MP4: the camera plus, once the
 * media board exists, its mic+pads mix in place of the raw mic, so the MP4 holds
 * what everyone heard. The WAV master is fed the raw mic separately.
 */
function withBoardAudio(localStream: MediaStream, board: MediaBoard | null): MediaStream {
  const mix = board?.outputTrack;
  return mix ? new MediaStream([...localStream.getVideoTracks(), mix]) : localStream;
}

export function setupJoinerNegotiation(
  peers: Iterable<PeerConnection>,
  asProducer: boolean,
  localStream: MediaStream,
  screenStream?: MediaStream | null
): void {
  if (asProducer) {
    for (const p of peers) {
      p.createControlChannel();
      p.addTransceiver('audio', { direction: 'recvonly' });
      p.addTransceiver('video', { direction: 'recvonly' });
    }
  } else {
    for (const p of peers) {
      p.createControlChannel();
      p.setLocalStream(localStream);
      if (screenStream) {
        for (const track of screenStream.getTracks()) {
          if (track.readyState !== 'ended') {
            p.addTrack(track, screenStream);
          }
        }
      }
    }
  }
}

export function startConnectWatchdog(
  peer: {
    rawConnection?: RTCPeerConnection | null;
    connectionState: RTCPeerConnectionState | null;
    restartIce: () => void;
  },
  opts: {
    iceRestarted: () => boolean;
    setIceRestarted: (val: boolean) => void;
    onWarn?: (msg: string) => void;
    timeoutMs?: number;
  }
): ReturnType<typeof setTimeout> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return setTimeout(() => {
    if (
      peer.connectionState !== 'connected' &&
      peer.connectionState !== 'closed' &&
      !opts.iceRestarted()
    ) {
      opts.setIceRestarted(true);
      opts.onWarn?.('Connection lost — retrying…');
      peer.restartIce();
    }
  }, timeoutMs);
}

export const MAX_RELAYED_MARKERS = 1000;
export const MAX_MARKER_LABEL_LENGTH = 200;

export function useRoom(slug: string) {
  const [state, setState] = useState<RoomState>({
    phase: 'checking',
    role: null,
    localStream: null,
    remoteStream: null,
    remotePeers: [],
    remoteScreenStream: null,
    localScreenStream: null,
    localName: '',
    screenSharing: false,
    error: null,
    recordingError: null,
    connectionWarning: null,
    messages: [],
    backupBlobUrl: null,
    wavBackupBlobUrl: null,
    drained: true,
    syncReportUrl: null,
    sidecarsSaved: false,
    markers: [],
    chaptersUrl: null,
    summary: null,
    takes: [],
    peerRecording: false,
    capabilities: {},
    finalizingGuests: [],
  });

  const signalRef = useRef<SignalClient | null>(null);
  // One PeerConnection per REMOTE peer (full mesh). peerRef stays as "the
  // primary peer" so the recording paths and screen share, which are inherently
  // host<->one-guest today, keep working unchanged.
  const peersRef = useRef<Map<string, PeerConnection>>(new Map());
  const peerRef = useRef<PeerConnection | null>(null);
  const myPeerIdRef = useRef<string | null>(null);
  const myOrdinalRef = useRef<number>(0);
  const localNameRef = useRef<string>('');
  const mediaRef = useRef<MediaManager | null>(null);
  const switchableMediaRef = useRef<SwitchableMedia | null>(null);
  const roleRef = useRef<Role | null>(null);
  const hostChannelRef = useRef<RTCDataChannel | null>(null);
  // Guest WAV channels that arrived before the host pressed Record, by source
  // peer. Binding needs the peerId to pick the right file.
  const audioChannelsRef = useRef<Map<string, RTCDataChannel>>(new Map());
  const recordingRef = useRef<RecordingHandles | null>(null);
  const phaseRef = useRef<RoomPhase>('checking');
  // endRecording is memoised per room, so it reads peer names through this
  // rather than a stale `state` closure.
  const remotePeersRef = useRef<RemotePeer[]>([]);
  const localStreamRef = useRef<MediaStream | null>(null);
  const micOnRef = useRef(true);
  const camOnRef = useRef(true);
  const screenSharingRef = useRef(false);
  const companionRef = useRef(false);
  const screenTrackRef = useRef<MediaStreamTrack | null>(null);
  // The local screen share gets its OWN MediaStream (distinct id) so the remote
  // peer's ontrack receives it as a separate stream, not appended to the camera.
  const screenStreamRef = useRef<MediaStream | null>(null);
  const customStopRef = useRef<(() => void) | null>(null);
  const backupUrlRef = useRef<string | null>(null);
  const wavBackupUrlRef = useRef<string | null>(null);
  const syncReportUrlRef = useRef<string | null>(null);
  const chaptersUrlRef = useRef<string | null>(null);
  const markersRef = useRef<ChapterMarker[]>([]);
  const relayedMarkersCountRef = useRef(0);
  const messagesRef = useRef<ChatMessage[]>([]);
  // Host's recording start, mirrored here so a marker can be positioned the
  // instant it arrives rather than at finalize.
  const hostStartRef = useRef<number | null>(null);
  const fatalCloseRef = useRef(false);
  const lastIceReconnectRef = useRef(0);
  // Chosen once per session and reused: showDirectoryPicker needs transient user
  // activation, so a second take could not prompt again from a non-click path.
  const boardRef = useRef<MediaBoard | null>(null);
  const dirRef = useRef<import('@/lib/fs-writer').FsDirectoryHandle | null>(null);
  const takeRef = useRef(0);
  // Anything that went wrong during a take — a recording error or connection
  // warning, even one that later cleared — means its backup may hold the only
  // complete copy, so it must not be marked finalized. Reset as a take starts.
  const takeTroubleRef = useRef(false);

  const sendPresence = useCallback(() => {
    signalRef.current?.send({
      type: 'presence',
      micOn: micOnRef.current,
      camOn: camOnRef.current,
      screenSharing: screenSharingRef.current,
    });
  }, []);

  const stopScreenShare = useCallback(() => {
    const stream = screenStreamRef.current;
    if (stream) {
      for (const p of peersRef.current.values()) {
        for (const tk of stream.getTracks()) {
          p.removeTrack(tk);
        }
      }
      stream.getTracks().forEach((tk) => tk.stop());
    }
    // A presented file's canvas/video, or the face camera coming back after the rear one.
    const customStop = customStopRef.current;
    customStopRef.current = null;
    try {
      customStop?.();
    } catch {
      /* best effort */
    }
    screenTrackRef.current = null;
    screenStreamRef.current = null;
    const recNow = recordingRef.current;
    if (recNow) {
      void stopScreenRecording(recNow).catch((e: unknown) =>
        setState((s) => ({ ...s, recordingError: recordingErrorMessage(e) }))
      );
    }
    if (!screenSharingRef.current) return; // already stopped (avoid double presence)
    screenSharingRef.current = false;
    setState((s) => ({ ...s, screenSharing: false, presentingRearCamera: false, localScreenStream: null }));
    sendPresence();
  }, [sendPresence]);

  useEffect(() => {
    phaseRef.current = state.phase;
  }, [state.phase]);

  // phase is a dep so a warning already showing when a take starts counts too.
  useEffect(() => {
    if (state.recordingError || state.connectionWarning) takeTroubleRef.current = true;
  }, [state.recordingError, state.connectionWarning, state.phase]);

  useEffect(() => {
    remotePeersRef.current = state.remotePeers;
  }, [state.remotePeers]);

  useEffect(() => {
    let cancelled = false;
    getRoom(slug)
      .then((meta) => {
        if (cancelled) return;
        setState((s) => (s.phase === 'checking' ? { ...s, phase: meta ? 'lobby' : 'not-found' } : s));
      })
      .catch(() => {
        if (!cancelled) {
          setState((s) =>
            s.phase === 'checking'
              ? {
                  ...s,
                  phase: 'error',
                  error: 'We couldn’t reach the openMeet server. Check your internet connection, then try again.',
                }
              : s
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  /**
   * Record a chapter marker. Position is stamped HERE, on the host clock,
   * relative to the host's recording start — including for markers relayed from
   * the guest. Markers are second-granularity, so the ~10-50ms of relay latency
   * is irrelevant, and stamping locally avoids depending on a peer clock that
   * may be arbitrarily wrong.
   */
  const recordMarker = useCallback((label: string, from: Role, name?: string): boolean => {
    const start = hostStartRef.current;
    if (start === null) return false; // not recording; nothing to anchor to
    const marker: ChapterMarker = {
      atMs: Date.now() - start,
      label,
      from,
      ...(name ? { name } : {}),
    };
    markersRef.current = [...markersRef.current, marker];
    setState((s) => ({ ...s, markers: markersRef.current }));
    return true;
  }, []);

  // endRecording is defined below and closes over nothing but refs, but the
  // signal handlers are registered inside join(), which runs first. The ref is
  // the seam.
  const endRecordingRef = useRef<
    (opts?: { from?: 'recording-stop' | 'leave'; internal?: boolean } | boolean) => Promise<void>
  >(async () => {});

  /**
   * Start the guest's capture and open its three egress channels.
   *
   * Driven by the host's relayed `recording-started`, not by a button of its
   * own: the host owns the disk, so the host owns the start. A guest recording
   * on its own schedule streams into a host with no file open, and those bytes
   * are silently discarded.
   */
  const beginGuestRecording = useCallback(async () => {
    if (companionRef.current) {
      if (!peerRef.current || recordingRef.current) return;
      const recordingId = crypto.randomUUID();
      takeTroubleRef.current = false;
      fatalCloseRef.current = false;
      setState((s) => ({ ...s, recordingError: null, markers: [] }));
      const handles: RecordingHandles = { recordingId, room: slug };
      recordingRef.current = handles;
      const activeScreen = screenStreamRef.current;
      if (activeScreen && peerRef.current) {
        await startScreenRecording(
          handles,
          activeScreen,
          'guest',
          peerRef.current,
          (e) => setState((s) => ({ ...s, recordingError: recordingErrorMessage(e) })),
          localNameRef.current
        );
      }
      setState((s) => ({ ...s, phase: 'recording' }));
      return;
    }
    const mic = localStreamRef.current;
    if (!peerRef.current || !mic || recordingRef.current) return;
    const localStream = withBoardAudio(mic, boardRef.current);
    const recordingId = crypto.randomUUID();
    takeTroubleRef.current = false;
    fatalCloseRef.current = false;
    setState((s) => ({ ...s, recordingError: null, markers: [] }));

    const mimeType = pickRecordingMime();
    if (!mimeType) {
      setState((s) => ({ ...s, recordingError: recordingErrorMessage(new UnsupportedCodecError()) }));
      return;
    }
    const onWarn = (msg: string) => setState((s) => ({ ...s, recordingError: msg }));
    const backup = new BackupRecorder({ mimeType, stream: localStream, room: slug, onWarn });
    backup.start();

    let wavBackup: BackupRecorder | undefined;
    if (isPcmCaptureSupported() && localStream.getAudioTracks().length > 0) {
      wavBackup = new BackupRecorder({
        mimeType: 'audio/wav',
        stream: mic,
        room: slug,
        onWarn,
      });
      wavBackup.start();
    }
    recordingRef.current = { recordingId, backup, ...(wavBackup ? { wavBackup } : {}) };

    try {
      // Chrome never negotiates a DataChannel created before this
      // connection's first negotiation finishes — this fires right after
      // 'peer-joined'/'role-assigned', which is exactly when a first offer can
      // still glare, and a guest joining mid-recording can even be pre-ICE.
      // Wait for 'connected' before creating any recording channel.
      // No 15s give-up: if connection or channel is not ready when Record
      // is pressed, keep local backup and start streaming to host when ready.
      // Always wait on the CURRENT connection to the host: a reconnect can
      // replace it while we wait, and the old one never connects or opens.
      const thisTake = () => recordingRef.current?.recordingId === recordingId;
      const canCapturePcm = isPcmCaptureSupported() && localStream.getAudioTracks().length > 0;
      let peer: PeerConnection;
      let channel: RTCDataChannel;
      let audioChannel: RTCDataChannel | undefined;
      for (;;) {
        const p: PeerConnection | null = peerRef.current;
        if (p && p.connectionState !== 'connected') {
          let poll: ReturnType<typeof setInterval> | undefined;
          const replaced = new Promise<void>((resolve) => {
            poll = setInterval(() => {
              if (peerRef.current !== p || !thisTake()) resolve();
            }, 500);
          });
          await Promise.race([p.whenConnected(Infinity), replaced]);
          clearInterval(poll);
        }
        if (!thisTake()) return;
        if (!p || peerRef.current !== p || p.connectionState !== 'connected') {
          if (!p) await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        // Three channels, three files: camera MP4, uncompressed WAV, and — while
        // presenting — the screen on its own channel per stretch.
        // recordingId is threaded into the label as a stable key: it survives a
        // full WS reconnect (unlike the DO's fresh-per-socket peerId), so the
        // host's onDataChannel below can route the rebuilt channel back to the
        // same slot/receiver/file it started on.
        const ch = p.createRecordingChannel(recordingId);
        const ach = canCapturePcm ? p.createRecordingAudioChannel(recordingId) : undefined;
        // BEFORE waitForOpen. `open` fires once; waiting first consumed it, so
        // this listener could never fire and the entire resume path
        // (requestResume/resume/answerResume) was unreachable dead code.
        ch.addEventListener('open', () => {
          const h = recordingRef.current;
          if (h) requestResume(h);
        });
        const opened = await waitForOpen(ch, Infinity).then(() => true, () => false);
        if (!thisTake()) return;
        if (opened) {
          peer = p;
          channel = ch;
          audioChannel = ach;
          break;
        }
      }
      // The WAV channel is OPTIONAL — StartGuestArgs says so. Awaiting it as a
      // hard prerequisite meant its 15s timeout aborted ALL capture: no camera
      // MP4, no backup recorder, no clock sync, for want of a companion file.
      const audioReady = audioChannel
        ? await waitForOpen(audioChannel).then(
            () => true,
            () => false
          )
        : false;
      const handles = startGuestRecording({
        recordingId,
        localStream,
        micStream: mic,
        channel,
        ...(audioReady && audioChannel ? { audioChannel } : {}),
        backup,
        ...(wavBackup ? { wavBackup } : {}),
        onError: (e) => setState((s) => ({ ...s, recordingError: recordingErrorMessage(e) })),
        room: slug,
        onWarn,
      });
      recordingRef.current = handles;
      if (canCapturePcm && !audioReady) {
        setState((s) => ({
          ...s,
          recordingError: 'The uncompressed audio channel did not open — recording video only.',
        }));
      }
      // Already presenting when the host hit Record: capture the screen too, or
      // everything shared before the next toggle is lost.
      const activeScreen = screenStreamRef.current;
      if (activeScreen) {
        await startScreenRecording(
          handles,
          activeScreen,
          'guest',
          peer,
          (e) => setState((s) => ({ ...s, recordingError: recordingErrorMessage(e) })),
          localNameRef.current
        );
      }
      setState((s) => ({ ...s, phase: 'recording' }));
    } catch (e) {
      setState((s) => ({ ...s, recordingError: recordingErrorMessage(e) }));
    }
  }, [slug]);

  const join = useCallback(
    async (
      lobbyStream: MediaStream,
      displayName: string,
      asProducer = false,
      asCompanion = false,
      initialScreenStream?: MediaStream
    ) => {
      companionRef.current = asCompanion;
      // A present-only companion or a producer has no camera or mic: wrapping its empty
      // stream would conjure a blank generator track and a silent audio track (which a
      // companion would then send, and a producer would show as a black self-tile).
      const switchableMedia = asCompanion || asProducer
        ? null
        : new SwitchableMedia(lobbyStream, {
            isRecording: () => phaseRef.current === 'recording',
            onTrackReplaced: (kind, newTrack, oldTrack) => {
              for (const p of peersRef.current.values()) {
                if (kind === 'video') {
                  p.replaceCameraTrack(newTrack, oldTrack);
                } else {
                  p.replaceAudioTrack(newTrack);
                }
              }
              const sm = switchableMediaRef.current;
              if (!sm) return;
              setState((s) => ({
                ...s,
                localStream: sm.stream,
                activeMicId: sm.activeMicId,
                activeCamId: sm.activeCamId,
              }));
            },
          });
      switchableMediaRef.current = switchableMedia;
      const localStream = switchableMedia?.stream ?? lobbyStream;

      const media = new MediaManager();
      media.adopt(localStream);
      mediaRef.current = media;
      micOnRef.current = localStream?.getAudioTracks?.()?.some((t) => t.enabled) ?? false;
      camOnRef.current = localStream?.getVideoTracks?.()?.some((t) => t.enabled) ?? false;
      localNameRef.current = displayName;
      fatalCloseRef.current = false;
      if (initialScreenStream) {
        const track = initialScreenStream.getVideoTracks()[0];
        if (track) {
          screenTrackRef.current = track;
          screenStreamRef.current = initialScreenStream;
          screenSharingRef.current = true;
          track.addEventListener('ended', () => stopScreenShare());
        }
      }
      // Stay in 'connecting' until role-assigned reports whether anyone is in
      // the room. Moving to 'waiting' prematurely would flash solo copy when
      // joining an already occupied call.
      setState((s) => ({
        ...s,
        phase: 'connecting',
        localStream,
        localName: displayName,
        companion: asCompanion,
        screenSharing: Boolean(initialScreenStream),
        ...(switchableMedia
          ? {
              isFallbackMedia: switchableMedia.isFallback,
              activeMicId: switchableMedia.activeMicId,
              activeCamId: switchableMedia.activeCamId,
            }
          : {}),
      }));

      let cred: TurnCred;
      try {
        cred = await getTurnCred(slug);
      } catch (e) {
        console.error('turn:cred_failed', e);
        cred = {
          urls: ['stun:stun.cloudflare.com:3478'],
          username: 'stub',
          credential: 'stub',
          ttl: 0,
        };
      }
      const iceServers = buildIceServers(cred);
      // Only a turn:/turns: URL can relay; STUN alone can't get through a strict NAT.
      // The response is unvalidated JSON, and this must never break a join.
      const hasRelay = Array.isArray(cred.urls) && cred.urls.some((u) => /^turns?:/i.test(u));

      const hostToken = getHostToken(slug);
      const signal = new SignalClient({
        slug,
        ...(asProducer ? { producer: true } : {}),
        ...(asCompanion ? { companion: true } : {}),
        wsBase: WS_BASE,
        displayName,
        userAgent: navigator.userAgent,
        clientId: getOrCreateClientId(),
        // Host presents its token in the join message; null for guests.
        ...(hostToken ? { hostToken } : {}),
        // Terminal server close: render the reason instead of reconnecting.
        // Terminal close must NEVER unmount a live recording. Switching phase
        // takes CallStage with it, and "End & save" is the only thing that
        // closes the file handles — the same trap peer-left and room-closed
        // both guard against with phaseOnPeerLeft. This path had no guard, so a
        // 4001/4002/4003 mid-recording left every file at 0 bytes.
        onFatalClose: (code) =>
          setState((s) => {
            const next = phaseOnFatalClose(s.phase, code);
            if (!next) {
              fatalCloseRef.current = true;
              return {
                ...s,
                recordingError:
                  roleRef.current === 'guest'
                    ? 'The connection to the room ended. Press Stop and save my recording to keep this recording.'
                    : 'The connection to the room ended. Press End & save to keep this recording.',
              };
            }
            return { ...s, ...next };
          }),
      });
      signalRef.current = signal;

      localStreamRef.current = localStream;

      // Local tracks are added only once a peer connection EXISTS for someone
      // actually in the room. Offering into an empty room would be dropped by
      // the relay, and the offer that eventually arrived would then be ignored
      // as a glare collision — deadlocking the handshake permanently.

      /**
       * Open a connection to ONE remote peer.
       *
       * Politeness is pairwise: the lower join ordinal is impolite. Ordinals are
       * a total order, so every pair in the mesh gets exactly one impolite side.
       */
      /**
       * Tell every connection how big the room is, so each divides its outbound
       * budget the same way. In a mesh the send cost is per REMOTE, so this has
       * to be re-applied on every join and leave — not just set once.
       */
      const syncSendQuality = () => {
        const count = peersRef.current.size + 1; // remotes + me
        for (const p of peersRef.current.values()) p.setPeerCount(count);
      };

      const startPeer = (
        remotePeerId: string,
        remoteOrdinal: number,
        remoteRole?: Role,
        remoteCompanion?: boolean
      ) => {
        // One ICE restart per CONNECTION. This used to be declared once per
        // join(), shared by every peer in the mesh, so one peer's restart
        // consumed the only recovery attempt for all the others — they went
        // straight to the terminal error without a single restart attempted.
        let iceRestarted = false;
        let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
        // A WS reconnect re-delivers role-assigned, so this can run again
        // mid-call. Without closing the old one it stays alive holding the
        // camera senders, still gathering ICE and still reporting state.
        peersRef.current.get(remotePeerId)?.close();
        const peer = new PeerConnection({
          polite: myOrdinalRef.current > remoteOrdinal,
          remotePeerId,
          iceServers,
          screenOnly: remoteRole === 'producer' || Boolean(remoteCompanion),
          sendSignal: (m) => signal.send(m),
          onConnectionStateChange: (cs) => {
            if (cs === 'connected') {
              iceRestarted = false;
              if (watchdogTimer) clearTimeout(watchdogTimer);
              setState((s) => ({
                ...s,
                connectionWarning: null,
                phase: phaseOnConnectionStateChange(s.phase, 'connected'),
              }));
              return;
            }
            if (cs === 'disconnected') {
              // Often transient — say so without alarming, and let ICE recover.
              setState((s) => ({ ...s, connectionWarning: 'Connection unstable — reconnecting…' }));
              return;
            }
            if (cs === 'failed') {
              if (!iceRestarted) {
                iceRestarted = true;
                setState((s) => ({ ...s, connectionWarning: 'Connection lost — retrying…' }));
                // The peer that FAILED, not peerRef. Restarting peerRef
                // recovered a different connection and left this one dead.
                peer.restartIce();
                return;
              }
              // Second failure: recover through the existing signalling reconnect
              // path, which rebuilds every connection and rebinds recording channels,
              // instead of leaving the link dead.
              setState((s) => ({
                ...s,
                connectionWarning: hasRelay
                  ? 'Can’t connect to the other person. A firewall on one of your networks may be ' +
                    'blocking the call — try another Wi-Fi network or a phone hotspot.'
                  : 'Can’t connect to the other person. Your networks block a direct connection and ' +
                    'this server has no relay (TURN). Try the same Wi-Fi network or a phone hotspot, ' +
                    'or ask whoever runs this openMeet to set up TURN.',
              }));
              // One automatic rebuild per cooldown: a pair that can never connect
              // (no TURN) must not keep tearing down every healthy connection too.
              if (Date.now() - lastIceReconnectRef.current > ICE_RECONNECT_COOLDOWN_MS) {
                lastIceReconnectRef.current = Date.now();
                signal.reconnect();
              }
            }
          },
          onRemoteStream: (remoteStream) =>
            setState((s) => {
              const remotePeers = s.remotePeers.some((r) => r.peerId === remotePeerId)
                ? s.remotePeers.map((r) => (r.peerId === remotePeerId ? { ...r, stream: remoteStream } : r))
                : [...s.remotePeers, { peerId: remotePeerId, name: null, stream: remoteStream, role: remoteRole, companion: remoteCompanion }];
              return {
                ...s,
                phase: phaseOnRemoteStream(s.phase),
                remotePeers,
                remoteStream: remotePeers.find((p) => p.role !== 'producer' && !p.companion)?.stream ?? remoteStream,
              };
            }),
          onRemoteScreen: (remoteScreenStream) =>
            setState((s) => ({ ...s, remoteScreenStream })),
          onRemoteScreenEnded: () => setState((s) => ({ ...s, remoteScreenStream: null })),
          onNegotiationError: (e) => {
            console.error('openMeet: negotiation failed', e);
            setState((s) => ({
              ...s,
              connectionWarning: 'Negotiation failed while connecting. Try rejoining the room.',
            }));
          },
          onDataChannel: (channel) => {
            // Two recording channels now arrive: video on `recording`, the
            // uncompressed WAV master on `recording-audio`. Route by label.
            if (channel.label.startsWith(DATA_CHANNEL_RECORDING_SCREEN)) {
              const recNow = recordingRef.current;
              // .catch matters: openIn() rejects on a full or read-only disk,
              // and without it the screen file silently never opens while the
              // guest keeps streaming into nothing.
              if (recNow) {
                void bindHostScreenChannel(
                  channel,
                  recNow,
                  (e) => setState((s) => ({ ...s, recordingError: recordingErrorMessage(e) })),
                  remotePeerId
                ).catch((e: unknown) =>
                  setState((s) => ({ ...s, recordingError: recordingErrorMessage(e) }))
                );
              }
              return;
            }
            const fail = (e: unknown) =>
              setState((s) => ({ ...s, recordingError: recordingErrorMessage(e) }));
            if (recordingChannelKind(channel.label).base === DATA_CHANNEL_RECORDING_AUDIO) {
              audioChannelsRef.current.set(remotePeerId, channel);
              const recNow = recordingRef.current;
              if (recNow) void bindHostAudioChannel(channel, recNow, remotePeerId, fail).catch(fail);
              return;
            }
            hostChannelRef.current = channel;
            // Routed by SOURCE peer, not to one shared receiver: two guests
            // writing into one file interleaves two H.264 streams into an
            // unplayable MP4. Also covers reconnect rebinding (the receiver
            // survives, so lastIdx and the digest continue) and first-time
            // binding when the host started recording before the guest opened
            // this channel at all.
            const rec = recordingRef.current;
            if (rec) void bindHostGuestChannel(channel, rec, remotePeerId, fail).catch(fail);
          },
        });
        peer.start();
        watchdogTimer = startConnectWatchdog(peer, {
          iceRestarted: () => iceRestarted,
          setIceRestarted: (val) => { iceRestarted = val; },
          onWarn: (msg) => setState((s) => ({ ...s, connectionWarning: msg })),
        });
        // A rebuilt PeerConnection to the host replaces the guest's recording
        // channels; without this the guest silently stops streaming into the
        // host's files and only the BackupRecorder has the rest of the take.
        // Waits for THIS connection's first 'connected' first: a DataChannel
        // created before that (this rebuild can glare on its own first
        // negotiation, same as the initial join) is never negotiated by
        // Chrome and sits in 'connecting' forever.
        if (roleRef.current === 'guest' && recordingRef.current && remoteRole === 'host') {
          void rebindGuestRecordingWhenConnected(
            peer,
            recordingRef,
            screenStreamRef.current,
            (e) => setState((s) => ({ ...s, recordingError: recordingErrorMessage(e) }))
          );
        }
        peersRef.current.set(remotePeerId, peer);
        syncSendQuality();
        // The first remote peer is "the" peer for recording and screen share,
        // both of which are still host<->one-guest.
        // peerRef is the connection the recording paths use, so it must be the
        // HOST — the only peer that opens files. It used to be "whichever peer
        // connected first", with no role check at all: if two guests joined
        // before the host, each guest opened its recording channels to ANOTHER
        // GUEST, which has no receiver and no directory. The guest streamed its
        // whole take into a channel nobody was reading, got no acks, and showed
        // "Recording" throughout while nothing reached disk.
        if (remoteRole === 'host' || !peerRef.current) peerRef.current = peer;
        return peer;
      };

      signal.on('role-assigned', (m) => {
        roleRef.current = m.role;
        myPeerIdRef.current = m.peerId;
        myOrdinalRef.current = m.ordinal;
        // Politeness is pairwise and comes from join ordinals, NOT from role.
        // Deriving it from role made every peer polite whenever the host token
        // didn't reach the tab (invite link opened directly, new tab, private
        // mode) — routine — and no all-polite set can complete a handshake.
        for (const other of m.peers) startPeer(other.peerId, other.ordinal, other.role, other.companion);
        // Everyone already here → negotiate now and leave the waiting room.
        // Otherwise wait for 'peer-joined'.
        const anyoneHere = m.peers.length > 0;
        const outgoing = withBoardAudio(localStream, boardRef.current);
        if (anyoneHere) {
          setupJoinerNegotiation(peersRef.current.values(), asProducer, outgoing, screenStreamRef.current);
        }
        setState((s) => ({
          ...s,
          role: m.role,
          remotePeers: m.peers.map((pp) => ({
            peerId: pp.peerId,
            name: pp.displayName,
            stream: null,
            role: pp.role,
            companion: pp.companion,
          })),
          phase: phaseOnRoleAssigned(s.phase, anyoneHere),
          peerRecording: m.recording ?? false,
        }));
        sendPresence();
        // Joined mid-recording (rejoin after a crash, or just arriving late):
        // the recording-started broadcast went out before this socket existed,
        // so catch up from the room state instead of sitting there unrecorded.
        if (
          m.recording &&
          shouldFollowHostRecording({
            from: 'host',
            role: m.role,
            producer: asProducer,
            alreadyRecording: recordingRef.current !== null,
          })
        ) {
          void beginGuestRecording();
        }
        // Tell every peer already in the room what THIS browser can capture.
        // A producer or companion publishes no camera/mic media, so it has nothing to report.
        if (!asProducer && !asCompanion) {
          signal.send({ type: 'recording-capability', ...computeRecordingCapability() });
        }
      });

      signal.on('peer-joined', (m) => {
        // Only the side that was already here opens the connection; the joiner
        // opened its own from the `peers` list in role-assigned. Both opening
        // one would produce two connections per pair.
        const peer = startPeer(m.peerId, m.ordinal, m.role, m.companion);
        if (!asProducer && !asCompanion) {
          peer.setLocalStreamAfterFirstOffer(
            withBoardAudio(localStream, boardRef.current),
            screenStreamRef.current
          );
          // Re-announce on every join, not just once: the DO relay only reaches
          // peers connected at send time, so a late joiner never saw the
          // capability we sent right after our own role-assigned.
          signal.send({ type: 'recording-capability', ...computeRecordingCapability() });
        } else if (asCompanion) {
          peer.setLocalStreamAfterFirstOffer(
            localStream,
            screenStreamRef.current
          );
        }
        sendPresence();
        setState((s) => ({
          ...s,
          remotePeers: s.remotePeers.some((r) => r.peerId === m.peerId)
            ? s.remotePeers.map((r) =>
                r.peerId === m.peerId
                  ? { ...r, name: m.displayName || r.name, role: m.role, companion: m.companion }
                  : r
              )
            : [
                ...s.remotePeers,
                { peerId: m.peerId, name: m.displayName, stream: null, role: m.role, companion: m.companion },
              ],
          // 'peer-left' is recoverable: the peer may have simply reconnected.
          // Without this it was a permanent dead end even after they came back.
          phase: phaseOnPeerJoined(s.phase),
          recordingError:
            s.recordingError === 'The other person disconnected. Press End & save to keep this recording.'
              ? null
              : recordingErrorOnPeerJoined(s.phase, m.role, s.recordingError),
        }));
      });

      const relay = (m: ServerMessage) => {
        if (m.type === 'webrtc-offer' || m.type === 'webrtc-answer' || m.type === 'ice-candidate') {
          // Route by sender. Handing every message to one connection would make
          // C answer a negotiation between A and B.
          const target = m.fromPeerId ? peersRef.current.get(m.fromPeerId) : peerRef.current;
          if (!target) return;
          // NOT `void`. A throw in here (e.g. setRemoteDescription in the wrong
          // state) leaves the handshake half-finished and no media flowing; as
          // a discarded rejection it was invisible in the UI and only showed up
          // as an uncaught error in the console.
          target.handleSignal(m).catch((e: unknown) => {
            console.error('openMeet: signal handling failed', m.type, e);
            setState((s) => ({
              ...s,
              connectionWarning:
                'Negotiation failed while connecting. Try rejoining the room.',
            }));
          });
        }
      };
      signal.on('webrtc-offer', relay);
      signal.on('webrtc-answer', relay);
      signal.on('ice-candidate', relay);

      // Recording is room-wide and host-driven. An older tab may still send it;
      // nothing here reacts to a message that is not from the host.
      signal.on('recording-started', (m) => {
        if (m.from !== 'host') return;
        setState((s) => ({ ...s, peerRecording: true }));
        if (roleRef.current !== 'guest' || asProducer) return;
        void handleGuestRecordingStarted({
          recordingRef,
          // Internal: a guest may not end a take on its own, but a new host's
          // take must end the old one before the guest starts again.
          endRecording: () => endRecordingRef.current({ internal: true }),
          beginGuestRecording,
        }).catch((e: unknown) => {
          console.error('openMeet: handleGuestRecordingStarted failed', e);
        });
      });
      signal.on('recording-stop', (m) => {
        if (m.from !== 'host') return;
        setState((s) => ({ ...s, peerRecording: false }));
        if (roleRef.current !== 'guest' || !recordingRef.current) return;
        // Unhandled, a failed finalize leaves the guest on 'finalizing' with a
        // spinner and no explanation, and no button to try again.
        void endRecordingRef.current({ from: 'recording-stop' }).catch((e: unknown) =>
          setState((s) => ({ ...s, phase: 'done', recordingError: recordingErrorMessage(e) }))
        );
      });

      signal.on('marker', (m) => {
        if (relayedMarkersCountRef.current >= MAX_RELAYED_MARKERS) return;
        const label = typeof m.label === 'string' && m.label.length <= MAX_MARKER_LABEL_LENGTH ? m.label : '';
        if (recordMarker(label, m.from, m.fromName)) {
          relayedMarkersCountRef.current += 1;
        }
      });
      signal.on('recording-capability', (m) =>
        setState((s) => ({
          ...s,
          capabilities: {
            ...s.capabilities,
            [m.fromPeerId]: { mp4: m.mp4, wav: m.wav, ...(m.note ? { note: m.note } : {}) },
          },
        }))
      );
      signal.on('chat', (m) => {
        if (typeof m.text !== 'string' || m.text.length > MAX_CHAT_MESSAGE_LENGTH) return;
        const msg: ChatMessage = {
          from: m.from,
          text: m.text,
          // Stamped on the local clock so a skewed or malicious peer clock cannot
          // misorder chat lines or push them outside the take window.
          ts: Date.now(),
          ...(m.fromPeerId ? { fromPeerId: m.fromPeerId } : {}),
          ...(m.fromName ? { fromName: m.fromName } : {}),
        };
        messagesRef.current = [...messagesRef.current, msg];
        setState((s) => ({
          ...s,
          messages: messagesRef.current,
        }));
      });
      signal.on('presence', (m) =>
        setState((s) => {
          const remotePeers = applyRemotePeerPresence(s.remotePeers, m);
          return {
            ...s,
            remotePeers,
            // Belt-and-suspenders: clear the screen surface when the peer reports
            // it stopped, in case the track 'ended' signal didn't fire.
            remoteScreenStream: m.screenSharing
              ? s.remoteScreenStream
              : remotePeers.some((p) => p.presence?.screenSharing)
                ? s.remoteScreenStream
                : null,
          };
        })
      );

      // A peer socket closing must NEVER end an in-progress recording. The DO
      // broadcasts peer-left on any close — a wifi blip, a laptop sleeping, a
      // tab refresh — and moving to 'peer-left' unmounts CallStage, which
      // removes the "End & save" button, which is the only thing that closes
      // the file handle. That turned a two-second network drop at minute 80
      // into two zero-byte files with no way to recover them. It also handed
      // any peer a one-frame remote wipe of the host's recording.
      signal.on('peer-left', (m) => {
        if (m.peerId) {
          peersRef.current.get(m.peerId)?.close();
          peersRef.current.delete(m.peerId);
          // The room got smaller, so everyone left can spend more again.
          syncSendQuality();
        }
        setState((s) => {
          // A peer this tab never knew changes nothing. When a new tab takes
          // over the host seat, the DO announces the replaced socket's close,
          // before or after this tab's own role-assigned; read as "everyone
          // left", it stranded a host alone in the room on "The other person left".
          if (m.peerId && !s.remotePeers.some((r) => r.peerId === m.peerId)) return s;
          const recording = s.phase === 'recording' || s.phase === 'finalizing';
          const remotePeers = m.peerId ? removeRemotePeer(s.remotePeers, m.peerId) : [];
          // Stale once the peer is gone — a returning peer re-announces on its
          // next role-assigned/peer-joined, same as everyone else does.
          const capabilities = { ...s.capabilities };
          if (m.peerId) delete capabilities[m.peerId];
          // Others still present → the call continues; only an empty mesh ends it.
          if (remotePeers.length > 0) {
            return { ...s, remotePeers, capabilities, remoteStream: remotePeers.find((p) => p.role !== 'producer')?.stream ?? null };
          }
          return {
            ...s,
            remotePeers,
            capabilities,
            phase: phaseOnPeerLeft(s.phase),
            // About the connection that just ended; left set, it greeted the
            // next person to join with "Having trouble connecting".
            connectionWarning: null,
            ...(recording
              ? { recordingError: 'The other person disconnected. Press End & save to keep this recording.' }
              : {}),
            remoteStream: null,
            remoteScreenStream: null,
          };
        });
      });
      // Same guard as peer-left: never yank the call out from under a live
      // recording, or the file handle is never closed and the MP4 stays 0 bytes.
      signal.on('room-closed', () => setState((s) => ({ ...s, phase: phaseOnPeerLeft(s.phase) })));

      signal.connect();
    },
    [slug, beginGuestRecording, recordMarker, sendPresence]
  );

  const setMic = useCallback(
    (on: boolean) => {
      switchableMediaRef.current?.setAudioEnabled(on);
      mediaRef.current?.setAudioEnabled(on);
      micOnRef.current = on;
      sendPresence();
    },
    [sendPresence]
  );
  const setCam = useCallback(
    (on: boolean) => {
      switchableMediaRef.current?.setVideoEnabled(on);
      mediaRef.current?.setVideoEnabled(on);
      camOnRef.current = on;
      sendPresence();
    },
    [sendPresence]
  );

  const switchCamera = useCallback(async (target: string) => {
    if (!switchableMediaRef.current) return;
    await switchableMediaRef.current.switchCamera(target);
    if (!camOnRef.current) {
      switchableMediaRef.current.setVideoEnabled(false);
    }
    setState((s) => ({
      ...s,
      activeCamId: switchableMediaRef.current?.activeCamId,
    }));
  }, []);

  const switchMic = useCallback(async (deviceId: string) => {
    if (!switchableMediaRef.current) return;
    await switchableMediaRef.current.switchMic(deviceId);
    if (!micOnRef.current) {
      switchableMediaRef.current.setAudioEnabled(false);
    }
    setState((s) => ({
      ...s,
      activeMicId: switchableMediaRef.current?.activeMicId,
    }));
  }, []);

  /** UI entry point: mark the current moment. Guests relay to the host. */
  const addMarker = useCallback(
    (label: string) => {
      const role: Role = roleRef.current ?? 'host';
      if (role === 'host') {
        recordMarker(label, 'host', localNameRef.current || undefined);
        return;
      }
      signalRef.current?.send({ type: 'marker', label });
      // Local count only, so the guest sees its press land the way the host
      // does. The host stamps the real position; this one is never exported.
      setState((s) => ({ ...s, markers: [...s.markers, { atMs: 0, label, from: 'guest' }] }));
    },
    [recordMarker]
  );

  /**
   * Leave the summary and go back to the call so another take can be recorded.
   * The directory handle and take counter persist, so take 2 opens new files in
   * the same folder with no second prompt.
   */
  const newTake = useCallback(() => {
    recordingRef.current = null;
    hostStartRef.current = null;
    markersRef.current = [];
    relayedMarkersCountRef.current = 0;
    // A guest mints a new recordingId (channel-label key) per take. Without
    // this, a dead take-1 audio channel left in the map claims slot 0 in take
    // 2 before the real take-2 channel arrives.
    hostChannelRef.current = null;
    audioChannelsRef.current.clear();
    if (backupUrlRef.current) {
      URL.revokeObjectURL(backupUrlRef.current);
      backupUrlRef.current = null;
    }
    if (wavBackupUrlRef.current) {
      URL.revokeObjectURL(wavBackupUrlRef.current);
      wavBackupUrlRef.current = null;
    }
    setState((s) => ({
      ...s,
      phase: s.remoteStream ? 'in-call' : 'waiting',
      markers: [],
      summary: null,
      backupBlobUrl: null,
      wavBackupBlobUrl: null,
    }));
  }, []);

  /** Mark a finished take as discarded. Never deletes files — that is the user's call. */
  const discardTake = useCallback((take: number) => {
    setState((s) => ({
      ...s,
      takes: s.takes.map((t) => (t.take === take ? { ...t, discarded: !t.discarded } : t)),
    }));
  }, []);

  /**
   * Read once how this device is coping. Both figures exist already: the WAV
   * recorder counts the audio it had to pad, and the browser says when a live
   * encoder is limited by the processor. Meant to be polled every few seconds.
   */
  const readLoad = useCallback(async (): Promise<LoadSample> => {
    const h = recordingRef.current;
    const limited = await Promise.all([...peersRef.current.values()].map((p) => p.cpuLimited()));
    return {
      audioDroppedMs: (h?.hostPcm ?? h?.guestPcm)?.droppedMs ?? 0,
      cpuLimited: limited.includes(true),
    };
  }, []);

  /**
   * Build the soundboard on first use and route its mix to every peer.
   *
   * From here on the mix replaces the raw mic on every connection, now and later
   * (withBoardAudio), and in the MP4 and backup of every take STARTED later. The
   * WAV master keeps the raw mic (micStream), so a sting is never baked into the
   * uncompressed master where it could not be re-timed. A take already running
   * keeps the mic it started with — a live MediaRecorder can't have its track
   * swapped — so its pads survive only as chapter markers.
   */
  const openMediaBoard = useCallback((): MediaBoard | null => {
    if (boardRef.current) return boardRef.current;
    const mic = localStreamRef.current;
    if (!mic || mic.getAudioTracks().length === 0) return null;
    let board: MediaBoard;
    try {
      board = new MediaBoard(mic);
    } catch {
      return null; // no Web Audio here; the call is unaffected
    }
    const mixed = board.outputTrack;
    // EVERY peer, not just the primary one — the same mesh trap as screen share.
    if (mixed) for (const p of peersRef.current.values()) p.replaceAudioTrack(mixed);
    boardRef.current = board;
    return board;
  }, []);

  const sendChat = useCallback((text: string) => {
    const ts = Date.now();
    signalRef.current?.send({ type: 'chat', text, ts });
    const from: Role = roleRef.current ?? 'host';
    const msg: ChatMessage = {
      from,
      text,
      ts,
      self: true,
      ...(localNameRef.current ? { fromName: localNameRef.current } : {}),
    };
    messagesRef.current = [...messagesRef.current, msg];
    setState((s) => ({
      ...s,
      messages: messagesRef.current,
    }));
  }, []);

  const toggleScreenShare = useCallback(
    async (source?: File | 'rear-camera') => {
      const peer = peerRef.current;
      if (!peer) return;
      if (!screenSharingRef.current) {
        let screen: MediaStream;
        let isRearCamera = false;
        let customStop: (() => void) | null = null;
        try {
          if (source === 'rear-camera') {
            screen = await presentRearCamera();
            isRearCamera = true;
          } else if (source instanceof File) {
            const res = await presentFile(source);
            screen = res.stream;
            customStop = res.stop;
          } else {
            screen = await getScreenStream();
          }
        } catch {
          return; // user dismissed the screen-picker — no-op, not an error
        }
        const track = screen.getVideoTracks()[0];
        if (!track) return;
        screenTrackRef.current = track;
        screenStreamRef.current = screen;

        if (isRearCamera) {
          // Stopping the share must bring the face camera back (on a phone the rear
          // camera replaced it: one camera at a time), so hand that to stopScreenShare.
          const target = switchableMediaRef.current?.activeCamId || 'user';
          const phone = isPhone();
          const camWasOn = camOnRef.current;
          if (phone) {
            setCam(false);
            switchableMediaRef.current?.currentCameraTrack?.stop?.();
          }
          customStop = () => {
            if (phone) setCam(camWasOn);
            void switchCamera(target).catch(() => {});
          };
        }
        customStopRef.current = customStop;

        // EVERY peer, not just the primary one. On its OWN stream id (not the
        // camera stream) so each remote receives it as a distinct stream and
        // gives it its own tile. Renegotiation fires via onnegotiationneeded.
        //
        // This used to add the track to peerRef.current alone, so in a mesh
        // exactly ONE other person saw the shared screen and the rest saw
        // nothing — with no error on either side.
        for (const p of peersRef.current.values()) {
          for (const tk of screen.getTracks()) {
            p.addTrack(tk, screen);
          }
        }
        // If a recording is running, capture the screen to its own file too —
        // otherwise a twenty-minute deck presentation leaves no trace on disk.
        const rec = recordingRef.current;
        if (rec && phaseRef.current === 'recording') {
          const onError = (e: unknown) =>
            setState((s) => ({ ...s, recordingError: recordingErrorMessage(e) }));
          void startScreenRecording(
            rec,
            screen,
            rolePicker(roleRef.current),
            peer,
            onError,
            localNameRef.current
          ).catch(onError);
        }
        // Stop via the browser's native "Stop sharing" affordance.
        track.addEventListener('ended', () => stopScreenShare());
        screenSharingRef.current = true;
        // A desktop screen sharer sees a "You're presenting" placeholder, not a
        // mirror of their screen (a hall of mirrors). A phone showing its rear
        // camera or a file has nothing to mirror, and needs the viewfinder to aim.
        setState((s) => ({
          ...s,
          screenSharing: true,
          presentingRearCamera: isRearCamera,
          localScreenStream: isRearCamera || source instanceof File ? screen : null,
        }));
        sendPresence();
      } else {
        stopScreenShare();
      }
    },
    [sendPresence, stopScreenShare, switchCamera, setCam]
  );

  const startRecording = useCallback(async () => {
    const peer = peerRef.current;
    const localStream = localStreamRef.current;
    if (!peer || !localStream) return;
    const recordingId = crypto.randomUUID();
    takeTroubleRef.current = false;
    setState((s) => ({ ...s, recordingError: null }));
    // Every failure below used to vanish: RoomView called this as
    // `void startRecording()`, so an unsupported codec, a rejected file picker
    // or a DataChannel hiccup produced no state change and no log. The user
    // clicked Record and nothing happened, forever.
    try {
    if (roleRef.current === 'guest') {
      // Guests don't drive recording — the host does, and this is only
      // reachable if a guest UI somehow still offers the button.
      await beginGuestRecording();
      return;
    }
    {
      // Forget any guest channels that arrived before this take started. Guests
      // create channels only after recording-started, so older channels belong to
      // a previous host connection or take.
      forgetPreTakeGuestChannels(hostChannelRef, audioChannelsRef);
      markersRef.current = [];
      relayedMarkersCountRef.current = 0;
      setState((s) => ({ ...s, markers: [] }));
      takeRef.current += 1;
      recordingRef.current = await startHostRecording({
        recordingId,
        localStream: withBoardAudio(localStream, boardRef.current),
        micStream: localStream,
        take: takeRef.current,
        room: slug,
        ...(dirRef.current ? { dir: dirRef.current } : {}),
        // Deliberately NOT phase:'error'. That unmounts CallStage, removing the
        // only button that closes the file handle — so a transient disk error
        // used to destroy the whole recording.
        onError: (e) => setState((s) => ({ ...s, recordingError: recordingErrorMessage(e) })),
        onWarn: (msg) => setState((s) => ({ ...s, recordingError: msg })),
      });
      dirRef.current = recordingRef.current?.dir ?? dirRef.current;
      hostStartRef.current = recordingRef.current?.hostStartMs ?? Date.now();
    }
    // Already presenting when Record was pressed: start the screen file too,
    // or everything shared before the first toggle is lost.
    const activeScreen = screenStreamRef.current;
    const recNow = recordingRef.current;
    if (activeScreen && recNow && peerRef.current) {
      await startScreenRecording(
        recNow,
        activeScreen,
        rolePicker(roleRef.current),
        peerRef.current,
        (e) => setState((s) => ({ ...s, recordingError: recordingErrorMessage(e) })),
        localNameRef.current
      );
    }
    signalRef.current?.send({
      type: 'recording-started',
      recordingId,
      kind: 'camera',
      filename: `host_${recordingId}.mp4`,
    });
    phaseRef.current = 'recording';
    setState((s) => ({ ...s, phase: 'recording', peerRecording: true }));
    } catch (e) {
      // Cancelling the folder picker is a normal outcome, not a failure.
      if ((e as { name?: string })?.name === 'AbortError') return;
      setState((s) => ({ ...s, recordingError: recordingErrorMessage(e) }));
    }
  }, [beginGuestRecording, slug]);

  const endRecording = useCallback(
    async (opts?: { from?: 'recording-stop' | 'leave'; internal?: boolean } | boolean) => {
      const isInternal =
        typeof opts === 'boolean'
          ? opts
          : Boolean(opts?.internal || opts?.from === 'recording-stop' || opts?.from === 'leave');
      if (roleRef.current === 'guest' && !isInternal && !fatalCloseRef.current) return;
      const h = recordingRef.current;
      if (!h) return;
      phaseRef.current = 'finalizing';
      setState((s) => ({ ...s, phase: 'finalizing' }));
      try {
        if (roleRef.current !== 'guest') {
          // Send FIRST. The guest needs a round trip plus an encoder flush plus
          // three channel drains before its tail is on the wire; endHostRecording
          // waits for that, and the wait only overlaps the host's own flush if the
          // signal has already gone out.
          signalRef.current?.send({ type: 'recording-stop', recordingId: h.recordingId });
          setState((s) => ({ ...s, peerRecording: false }));
        }
        if (roleRef.current === 'guest') {
          fatalCloseRef.current = false;
          const { drained, backup, wavBackup } = await endGuestRecording(h);
          // Never marked finalized: a guest can't know the host's file was
          // committed (a host tab that dies before End & save loses its copy), so
          // this backup stays until the guest deletes it.
          if (backupUrlRef.current) URL.revokeObjectURL(backupUrlRef.current);
          const backupBlobUrl = backup ? URL.createObjectURL(backup) : null;
          backupUrlRef.current = backupBlobUrl;
          if (wavBackupUrlRef.current) URL.revokeObjectURL(wavBackupUrlRef.current);
          const wavBackupBlobUrl = wavBackup ? URL.createObjectURL(wavBackup) : null;
          wavBackupUrlRef.current = wavBackupBlobUrl;
          // Release the handles. The host clears its own in newTake(), which the
          // guest never calls — so leaving these set made `alreadyRecording` true
          // forever, and the guest silently sat out take 2 and every take after it.
          // The channels and recorders in here are already stopped and drained.
          recordingRef.current = null;
          setState((s) => ({
            ...s,
            phase: 'done',
            ...(s.recordingError === 'The other person disconnected. Press End & save to keep this recording.' ||
              s.recordingError?.includes('keep this recording')
              ? { recordingError: null }
              : {}),
            drained,
            backupBlobUrl,
            wavBackupBlobUrl,
          }));
        } else {
          const peerNameMap = new Map<string, string>();
          for (const p of remotePeersRef.current) {
            if (p.name) peerNameMap.set(p.peerId, p.name);
          }
          const { sha256, totalBytes, backup, wavBackup } = await endHostRecording(h, {
            onProgress: (pending) => setState((s) => ({ ...s, finalizingGuests: pending })),
            getPeerName: (peerId) => peerNameMap.get(peerId),
          });
          if (!takeTroubleRef.current) {
            void h.backup?.markFinalized();
            void h.wavBackup?.markFinalized();
            for (const sb of h.screenBackups ?? []) {
              void sb.markFinalized();
            }
          }
          if (backupUrlRef.current) URL.revokeObjectURL(backupUrlRef.current);
          const backupBlobUrl = backup ? URL.createObjectURL(backup) : null;
          backupUrlRef.current = backupBlobUrl;
          if (wavBackupUrlRef.current) URL.revokeObjectURL(wavBackupUrlRef.current);
          const wavBackupBlobUrl = wavBackup ? URL.createObjectURL(wavBackup) : null;
          wavBackupUrlRef.current = wavBackupBlobUrl;

          const guestReports = await collectGuestReports(h, (peerId) => peerNameMap.get(peerId));

          // Editor companion: start-offset alignment + lossless faststart remux commands.
          const syncInput = {
            recordingId: h.recordingId,
            ...(h.hostWriter?.fileName ? { hostFile: h.hostWriter.fileName } : {}),
            guests: guestReports,
            hostStartMs: h.hostStartMs ?? Date.now(),
            hostTrackFps: h.videoFps,
            hostWavFile:
              (h.hostPcm?.totalBytes ?? 1) > 0 ? h.hostWavWriter?.fileName : undefined,
            screenSegments: collectScreenSegments(h, (peerId) => peerNameMap.get(peerId)),
          };
          let report: SyncReport;
          try {
            report = buildSyncReport({
              ...syncInput,
              markers: markersRef.current,
            });
          } catch (e) {
            console.warn('openMeet: buildSyncReport with markers failed, retrying without markers', e);
            report = buildSyncReport({
              ...syncInput,
              markers: [],
            });
          }
          if (syncReportUrlRef.current) URL.revokeObjectURL(syncReportUrlRef.current);
          const syncReportUrl = URL.createObjectURL(
            new Blob([report.json], { type: 'application/json' })
          );
          syncReportUrlRef.current = syncReportUrl;
          // chapters.txt only exists if anything was actually marked.
          if (chaptersUrlRef.current) URL.revokeObjectURL(chaptersUrlRef.current);
          const chaptersUrl = report.chapters
            ? URL.createObjectURL(new Blob([report.chapters], { type: 'text/plain' }))
            : null;
          chaptersUrlRef.current = chaptersUrl;
          const patchPromise = patchRecording(
            h.recordingId,
            { total_bytes: totalBytes, sha256, status: 'finalized' },
            getHostToken(slug) ?? undefined
          ).catch((e) => {
            // Non-fatal: the recording is already safely on disk; only the metadata
            // PATCH failed. Don't fail the UI, but don't swallow it silently either.
            console.warn('openMeet: recording metadata save failed', e);
          });

          let sidecarsSaved = false;
          if (h.dir) {
            const take = h.take ?? 1;
            let chatLog = '';
            try {
              chatLog = buildChatLog(messagesRef.current, {
                startMs: h.hostStartMs ?? Date.now(),
                endMs: Date.now(),
                localName: localNameRef.current,
              });
            } catch (e) {
              console.warn('openMeet: building chat log failed', e);
            }
            sidecarsSaved = await writeTakeSidecars(h.dir, [
              { name: takeName('sync', h.recordingId, take, 'json'), content: report.json },
              { name: takeName('chapters', h.recordingId, take, 'txt'), content: report.chapters },
              { name: takeName('chat', h.recordingId, take, 'txt'), content: chatLog },
            ]);
          }

          await patchPromise;
          recordingRef.current = null;
          setState((s) => ({
            ...s,
            phase: 'done',
            finalizingGuests: [],
            ...(s.recordingError === 'The other person disconnected. Press End & save to keep this recording.' ||
              s.recordingError?.includes('keep this recording')
              ? { recordingError: null }
              : {}),
            backupBlobUrl,
            wavBackupBlobUrl,
            syncReportUrl,
            chaptersUrl,
            sidecarsSaved,
            summary: report.data,
            takes: [
              ...s.takes,
              {
                take: h.take ?? 1,
                startedAt: h.hostStartMs ?? Date.now(),
                durationMs: Date.now() - (h.hostStartMs ?? Date.now()),
                discarded: false,
              },
            ],
          }));
        }
      } catch (e) {
        // Nothing may leave the room on 'finalizing': Leave is off there and the
        // toast keeps promising a save. A full disk does throw here: the writer
        // it errored rejects close(). Commit what still can be, hand over the
        // backups (stop() is idempotent), let go and say what happened.
        for (const w of allWriters(h)) void w.close().catch(() => {});
        recordingRef.current = null;
        const guest = roleRef.current === 'guest';
        const [backup, wavBackup] = await Promise.all([h.backup?.stop(), h.wavBackup?.stop()]).catch(() => []);
        if (backupUrlRef.current) URL.revokeObjectURL(backupUrlRef.current);
        if (wavBackupUrlRef.current) URL.revokeObjectURL(wavBackupUrlRef.current);
        const backupBlobUrl = backup ? URL.createObjectURL(backup) : null;
        const wavBackupBlobUrl = wavBackup ? URL.createObjectURL(wavBackup) : null;
        backupUrlRef.current = backupBlobUrl;
        wavBackupUrlRef.current = wavBackupBlobUrl;
        const reason = e instanceof Error ? e.message : String(e);
        setState((s) => ({
          ...s,
          phase: 'done',
          finalizingGuests: [],
          backupBlobUrl,
          wavBackupBlobUrl,
          ...(guest ? { drained: false } : {}),
          recordingError: guest
            ? `Sending your recording didn’t finish (${reason}).`
            : `Saving didn’t finish (${reason}). Some files in your recording folder may be incomplete.`,
        }));
      }
    },
    [slug]
  );

  // Close the seam the signal handlers registered in join() reach through.
  useEffect(() => {
    endRecordingRef.current = endRecording;
  }, [endRecording]);

  /** Let go of the room, every connection, the camera and the mic. */
  const release = useCallback(() => {
    signalRef.current?.close();
    boardRef.current?.close();
    boardRef.current = null;
    for (const p of peersRef.current.values()) p.close();
    peersRef.current.clear();
    peerRef.current?.close();
    peerRef.current = null;
    if (customStopRef.current) {
      try {
        customStopRef.current();
      } catch {}
      customStopRef.current = null;
    }
    switchableMediaRef.current?.stop();
    mediaRef.current?.stop();
  }, []);

  // A terminal screen has nothing left to send, so the camera light goes off.
  // Not 'peer-left': that tab is still in the room, showing its own camera,
  // and resumes by itself when the peer comes back.
  // Never mid-take: phaseOnPeerLeft and phaseOnFatalClose hold 'recording' and
  // 'finalizing', and a take still starting up (handles set, phase not yet
  // 'recording') keeps its tracks too.
  useEffect(() => {
    const terminal = ['full', 'replaced', 'not-found', 'error'].includes(state.phase);
    if (terminal && !recordingRef.current) release();
  }, [state.phase, release]);

  const leave = useCallback(async () => {
    fatalCloseRef.current = false;
    // "Leave call" sits directly beside "End & save" during a recording. It used
    // to tear everything down without closing the writers, so clicking the wrong
    // one of two adjacent buttons cost the whole recording.
    if (recordingRef.current) {
      try {
        await endRecording({ from: 'leave' });
      } catch {
        // Even a failed finalize must not block the teardown below.
      }
    }
    signalRef.current?.send({ type: 'leave', reason: 'user-exit' });
    release();
    // Actually tell the UI. Everything above is teardown; without this the user
    // stays on the call stage watching frozen tiles of a connection that no
    // longer exists.
    setState((s) => ({
      ...s,
      phase: 'left',
      localStream: null,
      remoteStream: null,
      remotePeers: [],
      remoteScreenStream: null,
      localScreenStream: null,
      screenSharing: false,
      connectionWarning: null,
    }));
  }, [endRecording, release]);

  // Last-resort commit. A FileSystemWritableFileStream only writes through to
  // the real file on close(), so an unclosed handle means a zero-byte MP4.
  // pagehide (not beforeunload) is the event that still fires on mobile Safari
  // and on bfcache navigations. Best-effort: the browser may kill us first, but
  // best-effort beats the previous guaranteed loss.
  useEffect(() => {
    const commit = () => {
      const h = recordingRef.current;
      if (!h) return;
      // EVERY writer, not just the host's and the first guest's. A live
      // recording can also hold both WAV masters, one writer per screen-share
      // segment and one per guest 2+ — all of which stayed at 0 bytes here,
      // which is exactly the loss this handler exists to prevent.
      for (const w of allWriters(h)) void w.close();
    };
    window.addEventListener('pagehide', commit);
    return () => window.removeEventListener('pagehide', commit);
  }, []);

  useEffect(() => {
    return () => {
      // Same reason as pagehide: never unmount holding an open writer.
      const h = recordingRef.current;
      if (h) for (const w of allWriters(h)) void w.close();
      signalRef.current?.close();
      for (const p of peersRef.current.values()) p.close();
      peersRef.current.clear();
      peerRef.current?.close();
      if (customStopRef.current) {
        try {
          customStopRef.current();
        } catch {}
        customStopRef.current = null;
      }
      switchableMediaRef.current?.stop();
      mediaRef.current?.stop();
      if (backupUrlRef.current) URL.revokeObjectURL(backupUrlRef.current);
      if (wavBackupUrlRef.current) URL.revokeObjectURL(wavBackupUrlRef.current);
      if (syncReportUrlRef.current) URL.revokeObjectURL(syncReportUrlRef.current);
    };
  }, []);

  return {
    state,
    join,
    leave,
    setMic,
    setCam,
    switchCamera,
    switchMic,
    sendChat,
    toggleScreenShare,
    startRecording,
    endRecording,
    addMarker,
    openMediaBoard,
    newTake,
    discardTake,
    readLoad,
  };
}
