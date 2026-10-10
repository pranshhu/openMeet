'use client';

import { useEffect, useRef, useState } from 'react';
import type { BrowserNote, Role } from '@openmeet/protocol';
import { Stage, type StageFeed } from './Stage';
import { Teleprompter } from './Teleprompter';
import { SessionSummary } from './SessionSummary';
import { MediaBoardPanel } from './MediaBoardPanel';
import { PeoplePanel } from './PeoplePanel';
import type { MediaBoard } from '@/lib/media-board';
import type { LoadSample, RemotePeer } from '@/hooks/useRoom';
import type { TrackReading } from '@/hooks/recording-controller';
import { formatTimecode, type SyncReportData } from '@/lib/sync-report';
import { ChatPanel, chatSenderLabel, type ChatMessage } from './ChatPanel';
import { PresenceBadge } from './PresenceBadge';
import { ControlButton } from './ControlButton';
import { Icon } from './Icon';
import { RecordingHealth } from './RecordingHealth';
import { RecordingCountdown, RecordingNotice } from './RecordingNotice';
import { BackupNotice } from './BackupNotice';
import type { BackupTransfer } from '@/hooks/backup-return';
import { Logo } from './Logo';
import { RoleLinks } from './RoleLinks';
import { BROWSER_NOTE_TEXT } from '@/lib/browser-guidance';
import { isPhone } from '@/lib/switchable-media';
import { useProblemAlert, requestProblemNotifications } from '@/hooks/use-problem-alert';
import { useTakeGuard } from '@/hooks/use-take-guard';
import { downloadNamesFor } from '@/lib/file-names';
import { useOverloadWatch } from '@/hooks/use-overload-watch';
import { MIC_WARNING_TEXT, type MicWarning } from '@/lib/mic-watch';

/**
 * Why a remote participant won't be fully captured, or null if they will be.
 * Shown only to the host, next to that participant's name tag, BEFORE Record
 * is pressed, not at playback.
 */
function capabilityNote(cap: { mp4: boolean; wav: boolean; note?: BrowserNote } | undefined): string | null {
  if (!cap) return null;
  const parts: string[] = [];
  if (!cap.mp4) parts.push("won't be recorded (browser can't record MP4)");
  if (cap.note) parts.push(BROWSER_NOTE_TEXT[cap.note]);
  if (!cap.wav) parts.push('no WAV master');
  return parts.length > 0 ? parts.join('; ') : null;
}

function nameWithCapability(
  name: string,
  peerId: string | undefined,
  isHost: boolean,
  capabilities: Record<string, { mp4: boolean; wav: boolean; note?: BrowserNote }>
): string {
  if (!isHost || !peerId) return name;
  const note = capabilityNote(capabilities[peerId]);
  return note ? `${name} — ${note}` : name;
}

/** How long this take has run. Mounts with the take, so its clock starts there. */
function Elapsed() {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  // aria-live off: the status bar is a live region, and a clock read out
  // every second would drown out the announcements that matter.
  return (
    <span role="timer" aria-live="off" className="tabular-nums text-white/80">
      {formatTimecode(now - start)}
    </span>
  );
}

export function CallStage({
  role,
  phase,
  companion,
  localStream,
  remoteStream,
  remotePeers,
  remoteScreenStream,
  localScreenStream,
  localName,
  peerName,
  screenSharing,
  canRecord,
  roomRecording,
  recordBlocked,
  messages,
  peerPresence,
  screenShareSupported,
  backupUrl,
  wavBackupUrl,
  recordingError,
  micWarning = null,
  recordUnavailableReason,
  syncReportUrl,
  sidecarsSaved,
  drained = true,
  onToggleMic,
  onToggleCam,
  onRecord,
  onEnd,
  onLeave,
  onSendChat,
  slug,
  onMark,
  markerCount,
  chaptersUrl,
  summary,
  takes,
  onNewTake,
  onDiscardTake,
  onOpenMediaBoard,
  onToggleScreen,
  capabilities,
  finalizingGuests,
  onSwitchMic,
  onSwitchCamera,
  activeMicId,
  activeCamId,
  isFallbackMedia = false,
  presentingRearCamera = false,
  readLoad,
  readTrackHealth,
  lowPower = false,
  onSetLowPower,
  incomingVideoOff = false,
  onSetIncomingVideoOff,
  unprotectedRecording,
  backupTransfers,
  onAcceptBackups,
  onDeclineBackups,
  onDismissBackup,
  onStopBackup,
  resumeOffer,
  onResumeRecording,
  onSaveRecording,
  takeNotice,
  recoveryBusy = false,
  notRecorded,
  onSetPeerRecorded,
  hostMuted = false,
  onMutePeer,
  onRemovePeer,
  countdownEndsAt = null,
}: {
  role: Role | null;
  phase: 'in-call' | 'recording' | 'finalizing' | 'done';
  companion?: boolean | undefined;
  finalizingGuests?: string[];
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  remotePeers: RemotePeer[];
  remoteScreenStream: MediaStream | null;
  localScreenStream: MediaStream | null;
  localName: string;
  peerName?: string | null;
  screenSharing: boolean;
  canRecord: boolean;
  /**
   * The HOST has a recording running. Not the same as phase==='recording',
   * which is only this peer's own capture: a guest whose browser can't encode
   * MP4 still has to be told the room is being recorded.
   */
  roomRecording: boolean;
  /** The reason below is a real problem, not just "you aren't the host". */
  recordBlocked: boolean;
  messages: ChatMessage[];
  peerPresence?: { micOn: boolean; camOn: boolean; screenSharing: boolean } | null;
  screenShareSupported: boolean;
  backupUrl: string | null;
  wavBackupUrl: string | null;
  syncReportUrl: string | null;
  sidecarsSaved?: boolean;
  /** Guest: every chunk of the last take reached the host before the drain cap. */
  drained?: boolean;
  // Non-fatal: shown as a banner without ending the call.
  recordingError: string | null;
  micWarning?: MicWarning | null;
  // Why Record is disabled, if it is. Computed by the caller so the capability
  // rules live in one place — and so the message names the ACTUAL cause rather
  // than always blaming the File System Access API.
  recordUnavailableReason: string | null;
  onToggleMic: (on: boolean) => void;
  onToggleCam: (on: boolean) => void;
  onRecord: () => void;
  onEnd: () => void;
  onLeave: () => void;
  onSendChat: (text: string) => void;
  slug: string;
  onMark: (label: string) => void;
  markerCount: number;
  chaptersUrl: string | null;
  summary: SyncReportData | null;
  takes: { take: number; durationMs: number; discarded: boolean }[];
  onNewTake: () => void;
  onDiscardTake: (take: number) => void;
  onOpenMediaBoard: () => MediaBoard | null;
  onToggleScreen: (source?: File | 'rear-camera') => void;
  /** What each remote peer's browser can actually capture, keyed by peerId. */
  capabilities: Record<string, { mp4: boolean; wav: boolean; note?: BrowserNote }>;
  onSwitchMic?: (deviceId: string) => Promise<void>;
  onSwitchCamera?: (deviceId: string) => Promise<void>;
  activeMicId?: string | undefined;
  activeCamId?: string | undefined;
  isFallbackMedia?: boolean;
  presentingRearCamera?: boolean;
  /** One reading of how this device is coping; polled only while a take records. */
  readLoad?: () => Promise<LoadSample>;
  /** Read on a timer by the track panel; it must keep its identity between renders. */
  readTrackHealth?: () => TrackReading[];
  /** This device is sending everyone a smaller live picture to spare its processor. */
  lowPower?: boolean;
  onSetLowPower?: (on: boolean) => void;
  /** This device has stopped taking everyone else's video; it still hears the call. */
  incomingVideoOff?: boolean;
  onSetIncomingVideoOff?: (off: boolean) => void;
  /** The running take has no crash copy in this browser, so say so. */
  unprotectedRecording?: boolean;
  /** Returned backups: what the guests are sending back, and the host's answer. */
  backupTransfers?: BackupTransfer[];
  onAcceptBackups?: () => void;
  onDeclineBackups?: () => void;
  /** The host gave up on a dead returned backup. */
  onDismissBackup?: (id: string) => void;
  /** The host ended a returned backup that was still running. */
  onStopBackup?: (id: string) => void;
  /** A take in this room ended without its files and its crash copy is here. */
  resumeOffer?: { take: number; canResume: boolean } | null;
  onResumeRecording?: () => void;
  onSaveRecording?: () => void;
  /** One line after an interrupted take was saved from inside the call. */
  takeNotice?: string | null;
  /** A Resume or a Save of the interrupted take is running, so neither can be pressed, nor Record. */
  recoveryBusy?: boolean;
  /** The host set this viewer as not recorded. */
  notRecorded?: boolean;
  /** Host: choose whether one guest is recorded in the takes that follow. */
  onSetPeerRecorded?: (peerId: string, recorded: boolean) => void;
  /** The host turned this viewer's microphone off, and it is still off. */
  hostMuted?: boolean;
  /** Host: ask for one person's microphone to be turned off. */
  onMutePeer?: (peerId: string) => void;
  /** Host: remove one person from the room. */
  onRemovePeer?: (peerId: string) => void;
  /** When the countdown before a take ends, on this tab's own clock; null while none runs. */
  countdownEndsAt?: number | null;
}) {
  const [micOn, setMicOn] = useState(
    () => (localStream ? localStream.getAudioTracks().some((t) => t.enabled) : true)
  );
  const [camOn, setCamOn] = useState(
    () => (localStream ? localStream.getVideoTracks().some((t) => t.enabled) : true)
  );
  // The host turned this microphone off. The button has to show it: it is how
  // the person sees what happened, and the switch they turn it back on with.
  useEffect(() => {
    if (hostMuted) setMicOn(false);
  }, [hostMuted]);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [micMenuOpen, setMicMenuOpen] = useState(false);
  const [camMenuOpen, setCamMenuOpen] = useState(false);
  const [presentMenuOpen, setPresentMenuOpen] = useState(false);
  const [recordMenuOpen, setRecordMenuOpen] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  // A mic that gates to silence makes this note wrong for a setup that is
  // fine, so each kind can be sent away.
  const [micDismissed, setMicDismissed] = useState<MicWarning[]>([]);
  // A take is where a dead mic costs the most, so each take starts with the note
  // armed. The updater hands back the same array when nothing was dismissed, so
  // starting a take costs no extra render.
  useEffect(() => {
    if (phase === 'recording') setMicDismissed((d) => (d.length ? [] : d));
  }, [phase]);
  const micNote = micWarning && !micDismissed.includes(micWarning) ? micWarning : null;
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);
  const isTakeActive = phase === 'recording' || phase === 'finalizing';
  const { backgroundNote, dismissBackgroundNote, batteryNote } = useTakeGuard(isTakeActive);
  const overloaded = useOverloadWatch(phase === 'recording', readLoad, lowPower);

  // The invite link is only in the waiting room otherwise, and the host leaves
  // that as soon as the first guest arrives. origin+pathname drops ?producer=1
  // and ?present=1, so this always invites a recorded guest.
  function copyInvite() {
    const show = (result: 'copied' | 'failed') => {
      setCopied(result);
      setTimeout(() => setCopied(null), result === 'copied' ? 1500 : 4000);
    };
    // No clipboard (plain-http self-host) or permission denied: say so, so the
    // click never does nothing.
    const write = navigator.clipboard?.writeText(`${location.origin}${location.pathname}`);
    if (!write) return show('failed');
    write.then(() => show('copied'), () => show('failed'));
  }

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return;
    function updateDevices() {
      navigator.mediaDevices.enumerateDevices().then(setDevices).catch(() => {});
    }
    updateDevices();
    navigator.mediaDevices.addEventListener?.('devicechange', updateDevices);
    return () => {
      navigator.mediaDevices.removeEventListener?.('devicechange', updateDevices);
    };
  }, []);

  useEffect(() => {
    if (!micMenuOpen && !camMenuOpen && !presentMenuOpen && !recordMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-picker-container]')) return;
      setMicMenuOpen(false);
      setCamMenuOpen(false);
      setPresentMenuOpen(false);
      setRecordMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Hand focus back to the menu's trigger; otherwise it falls to <body>
      // when the item it was on unmounts.
      const picker = (document.activeElement as HTMLElement | null)?.closest('[data-picker-container]');
      (picker?.querySelector<HTMLElement>('[aria-haspopup]') ?? picker?.querySelector<HTMLElement>('button'))?.focus();
      setMicMenuOpen(false);
      setCamMenuOpen(false);
      setPresentMenuOpen(false);
      setRecordMenuOpen(false);
    };
    window.addEventListener('click', onDocClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onDocClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [micMenuOpen, camMenuOpen, presentMenuOpen, recordMenuOpen]);

  const currentMicId = activeMicId ?? localStream?.getAudioTracks()[0]?.getSettings?.().deviceId;
  const currentCamSettings = localStream?.getVideoTracks()[0]?.getSettings?.();
  const currentCamId = activeCamId ?? currentCamSettings?.deviceId;
  const currentFacingMode = currentCamSettings?.facingMode;

  const audioInputs = devices.filter((d) => d.kind === 'audioinput');
  const videoInputs = devices.filter((d) => d.kind === 'videoinput');
  const hasFacingMode =
    devices.some((d) => 'facingMode' in d && (d as { facingMode?: unknown }).facingMode) ||
    Boolean(currentFacingMode);

  const takeActive = phase === 'recording' || roomRecording;
  const showFallbackNotice = Boolean(isFallbackMedia && takeActive);

  async function handleSwitchMic(deviceId: string) {
    if (!onSwitchMic) return;
    try {
      setDeviceError(null);
      await onSwitchMic(deviceId);
      setMicMenuOpen(false);
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : 'Could not switch microphone.');
    }
  }

  async function handleSwitchCamera(deviceIdOrFacing: string) {
    if (!onSwitchCamera) return;
    try {
      setDeviceError(null);
      await onSwitchCamera(deviceIdOrFacing);
      setCamMenuOpen(false);
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : 'Could not switch camera.');
    }
  }

  const [chatOpen, setChatOpen] = useState(false);
  // Hand focus back to the Chat button, as the device menus do for theirs. A
  // tick later, because on phones the control bar is hidden until chat closes.
  function closeChat() {
    setChatOpen(false);
    setTimeout(() => document.querySelector<HTMLElement>('button[aria-label^="Chat"]')?.focus());
  }
  // The summary is a column beside the stage, so the host still sees the
  // guests between takes. It shares that side with chat (never both, so the
  // stage isn't squeezed) and opens again at the end of every take, unless
  // chat is open: closing chat there threw away whatever was being typed.
  const [summaryOpen, setSummaryOpen] = useState(true);
  useEffect(() => {
    if (phase !== 'done' || !summary) return;
    // chatOpen is read, not a dependency: this runs when a take ends, never
    // because chat closed.
    setSummaryOpen(!chatOpen);
  }, [phase, summary]);
  const showSummary = phase === 'done' && !!summary && summaryOpen;
  function openChat(open: boolean) {
    setChatOpen(open);
    if (open) setSummaryOpen(false);
  }
  function closeSummary() {
    setSummaryOpen(false);
    setTimeout(() => document.querySelector<HTMLElement>('button[aria-label="Show session summary"]')?.focus());
  }
  // Messages up to here were on screen; anything past it arrived while chat was closed.
  const [seenCount, setSeenCount] = useState(0);
  useEffect(() => {
    if (chatOpen) setSeenCount(messages.length);
  }, [chatOpen, messages.length]);
  const unread = chatOpen ? 0 : messages.length - seenCount;

  const [popup, setPopup] = useState<{ sender: string; text: string } | null>(null);
  const prevMessagesLengthRef = useRef(messages.length);

  useEffect(() => {
    if (messages.length > prevMessagesLengthRef.current) {
      const newest = messages[messages.length - 1];
      if (newest && !newest.self && !chatOpen) {
        const text = newest.text.length > 120 ? `${newest.text.slice(0, 120)}…` : newest.text;
        setPopup({
          sender: chatSenderLabel(newest),
          text,
        });
      }
    }
    prevMessagesLengthRef.current = messages.length;
  }, [messages, chatOpen]);

  useEffect(() => {
    if (chatOpen) setPopup(null);
  }, [chatOpen]);

  useEffect(() => {
    if (!popup) return;
    const t = setTimeout(() => setPopup(null), 6000);
    return () => clearTimeout(t);
  }, [popup]);

  // While the page is hidden, prefix document.title with REC during a take and unread count.
  useEffect(() => {
    const updateTitle = () => {
      const raw = document.title;
      const base = raw.replace(/^(?:● REC )?(?:\(\d+\)\s*)?/, '');
      if (document.hidden) {
        const takePrefix = isTakeActive ? '● REC ' : '';
        const unreadPrefix = unread > 0 ? `(${unread}) ` : '';
        const prefix = `${takePrefix}${unreadPrefix}`;
        if (prefix) {
          document.title = `${prefix}${base || 'openMeet'}`;
        } else {
          document.title = base;
        }
      } else {
        document.title = base;
      }
    };

    updateTitle();
    document.addEventListener('visibilitychange', updateTitle);
    return () => {
      document.removeEventListener('visibilitychange', updateTitle);
      document.title = document.title.replace(/^(?:● REC )?(?:\(\d+\)\s*)?/, '');
    };
  }, [unread, isTakeActive]);

  const [prompterOpen, setPrompterOpen] = useState(false);
  const [board, setBoard] = useState<MediaBoard | null>(null);
  const [boardOpen, setBoardOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  // Hand focus back to the People button, as closing chat does for its own.
  function closePeople() {
    setPeopleOpen(false);
    setTimeout(() => document.querySelector<HTMLElement>('button[aria-label="People"]')?.focus());
  }
  // First opened mid-take: that take's recorder keeps the raw mic (a running
  // MediaRecorder can't swap tracks), so its pads aren't in the file. Only
  // that take: the next one starts with the board already in the mix.
  const [boardMidTake, setBoardMidTake] = useState(false);
  useEffect(() => {
    if (phase !== 'recording') setBoardMidTake(false);
  }, [phase]);
  // 'M' marks the moment. Ignored while typing so it can't fire from chat or
  // the teleprompter editor.
  useEffect(() => {
    if (phase !== 'recording') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'm' && e.key !== 'M') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      onMark('');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, onMark]);

  useProblemAlert({
    active: phase === 'recording' || phase === 'finalizing',
    message: recordingError,
  });

  const [spotlight, setSpotlight] = useState<'local' | 'remote'>('remote');

  const peerFallback = role === 'host' ? 'Guest' : 'Host';
  const isHost = role === 'host';
  // Name tags truncate, so the one warning a host must not miss gets a line of its own.
  const unrecordable = isHost
    ? remotePeers
        .filter((p) => !p.notRecorded && capabilities[p.peerId]?.mp4 === false)
        .map((p) => p.name ?? 'A guest')
    : [];
  // Said to everyone, on a line of its own like the warning above: name tags truncate.
  const notRecordedNames = remotePeers.filter((p) => p.notRecorded).map((p) => p.name ?? 'A guest');
  // Guests the host can choose. A present-only device is listed only while it
  // is set, so a guest who was set and came back that way can be ticked again.
  const choosable = remotePeers.filter((p) => p.role === 'guest' && (!p.companion || p.notRecorded));
  const phone = isPhone();
  const faceTrackEnded = !localStream?.getVideoTracks()[0] || localStream.getVideoTracks()[0]?.readyState === 'ended';
  const rearCameraEndsFace = !!presentingRearCamera && (phone || !!isFallbackMedia || faceTrackEnded);

  const local: StageFeed = {
    stream: localStream,
    name: localName ? `${localName} (You)` : 'You',
    muted: true,
    camOff: !camOn || rearCameraEndsFace,
    // A self-view reads mirrored, as in the lobby; a rear camera shows the world.
    mirror: currentFacingMode !== 'environment',
  };
  const stagePeers = remotePeers.filter((p) => p.role !== 'producer' && !p.companion);
  const firstRemote = stagePeers[0];
  const firstRemotePresence = firstRemote?.presence ?? peerPresence ?? null;
  const remote: StageFeed | null = stagePeers.length > 0 && remoteStream
    ? {
        stream: remoteStream,
        name: nameWithCapability(firstRemote?.name ?? peerName ?? peerFallback, firstRemote?.peerId, isHost, capabilities),
        muted: companion ? true : false,
        camOff: incomingVideoOff || (firstRemotePresence ? !firstRemotePresence.camOn : false),
        ...(firstRemotePresence ? { presence: <PresenceBadge {...firstRemotePresence} /> } : {}),
      }
    : null;

  const summaryFiles = summary?.fileList ?? [];
  const fileCount = summaryFiles.length;
  const savedWithWarnings = !!summary?.warnings.length;

  const downloadNames = downloadNamesFor({
    room: slug,
    take: takes[takes.length - 1]?.take,
    localName,
    role,
  });

  // "Record another take" has to record. newTake only resets the refs, and
  // startRecording reads refs and reuses the folder, so both run inside the one
  // click: no second folder prompt, and the user activation still holds.
  const canRecordNext = isHost && canRecord && !!remote;
  const handleRecord = () => {
    setRecordMenuOpen(false);
    requestProblemNotifications();
    onRecord();
  };
  const recordNextTake = () => {
    onNewTake();
    handleRecord();
  };

  const toastPlace = prompterOpen ? 'top-3 sm:top-auto sm:bottom-3' : 'top-3';
  // 44px to tap on a phone, and underlined so they aren't told apart by colour alone.
  const guestLink = 'inline-flex min-h-11 items-center text-[#8ab4f8] underline underline-offset-2 sm:min-h-0';

  const finalizingCopy = !isHost
    ? 'Sending your last few seconds to the host. Keep this tab open.'
    : finalizingGuests?.length
      ? `Saving — getting the last few seconds from ${finalizingGuests.join(', ')}. Keep this tab open.`
      : 'Saving your files. Keep this tab open.';

  const popupEl = popup ? (
    // z-30: above the phone summary sheet, which hides the bar and its badge.
    <div role="status" aria-live="polite" className="absolute bottom-11 left-4 z-30 max-w-[calc(100%-9.5rem)] sm:bottom-14 sm:left-5 sm:max-w-sm">
      <button
        type="button"
        onClick={() => {
          openChat(true);
          setPopup(null);
        }}
        className="w-full rounded-xl bg-[#202124]/95 p-3 text-left shadow-2xl ring-1 ring-white/10 backdrop-blur transition hover:bg-[#2d2f34] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]"
      >
        <span className="block text-xs font-medium text-white/70">{popup.sender}</span>
        <span className="block text-sm text-white/95 wrap-anywhere">{popup.text}</span>
      </button>
    </div>
  ) : null;

  return (
    <div className="relative flex h-[100dvh] flex-col overflow-hidden bg-[#202124] text-white [color-scheme:dark]">
      {/* Top status bar. aria-live so a screen-reader user is told when
          recording starts, stops, or fails — for a recording tool, "am I
          recording" is the one status that must not be silent. */}
      <div
        data-testid="status-bar"
        className="relative flex items-center gap-3 px-4 py-3.5 text-sm min-[861px]:px-14"
        aria-live="polite"
      >
        {/* Top-left at the waiting room's inset, so the mark stays put when the
            call connects. self-start: stays on the first line when the done
            line wraps on a phone. Not a link: going home would drop the call. */}
        <Logo tone="dark" className="shrink-0 self-start" />
        {(phase === 'recording' || roomRecording) && (
          <span className="flex items-center gap-2 font-medium text-[#f28b82]">
            <span
              className="h-2.5 w-2.5 rounded-full bg-[#ea4335]"
              style={{ animation: 'om-rec-pulse 1.4s ease-in-out infinite' }}
            />
            Recording
          </span>
        )}
        {phase === 'recording' && <Elapsed />}
        {/* Announced from here, a live region that is always mounted: many
            screen readers skip one inserted along with its text, like the toast. */}
        {phase === 'finalizing' && <span className="sr-only">{finalizingCopy}</span>}
        {phase === 'recording' && markerCount > 0 && (
          <span className="text-white/70">
            {markerCount} marker{markerCount === 1 ? '' : 's'}
          </span>
        )}
        {phase === 'recording' && unprotectedRecording && (
          <span role="status" className="text-[#fdd663]">This take isn’t protected if the browser crashes.</span>
        )}
        {phase === 'recording' && readTrackHealth && <RecordingHealth read={readTrackHealth} />}
        {/* The host's downloads live in the summary; here is only the verdict.
            A guest has no summary, so its backups stay on this line. */}
        {phase === 'done' && !roomRecording && (
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
            {isHost && summary ? (
              <span className={savedWithWarnings ? 'text-[#fdd663]' : 'text-[#81c995]'}>
                {`${savedWithWarnings ? 'Saved with warnings' : 'Saved'} — ${fileCount} file${fileCount === 1 ? '' : 's'} in your recording folder.`}
              </span>
            ) : isHost ? (
              // No summary means the finalize threw; the banner says why.
              <span className="text-[#fdd663]">Saving didn’t finish.</span>
            ) : drained ? (
              <span className="text-[#81c995]">Sent to the host.</span>
            ) : (
              // The drain hit its cap or the sender gave up: the host's copy may
              // be short, and only this guest's backup has the rest.
              <span className="text-[#fdd663]">
                {`Some of your recording may not have reached the host${backupUrl ? ' — rejoin and press Send to host on your backup, or download it.' : '.'}`}
              </span>
            )}
            {!(isHost && summary) && backupUrl && (
              <a href={backupUrl} download={downloadNames.backup} className={guestLink}>
                Download your backup
              </a>
            )}
            {!(isHost && summary) && wavBackupUrl && (
              <a href={wavBackupUrl} download={downloadNames.wav} className={guestLink}>
                Download your WAV backup
              </a>
            )}
          </span>
        )}
        {/* 44px tall for touch; the negative margin keeps the bar from growing
            and then shrinking back the moment a take starts. */}
        {isHost && phase === 'in-call' && (
          <button
            type="button"
            onClick={copyInvite}
            className="-my-2 inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm text-white/80 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]"
          >
            <Icon name={copied === 'copied' ? 'check' : 'copy'} size={16} />
            {copied === 'copied'
              ? 'Link copied'
              : copied === 'failed'
                ? 'Couldn’t copy — use the address bar'
                : 'Copy invite link'}
          </button>
        )}
        {isHost && phase === 'in-call' && (
          <RoleLinks className="-my-2 -ml-2" menuClassName="left-4 top-full min-[861px]:left-14" />
        )}
        {/* Why there is no Record button, when that is just how the room works
            (a guest or producer). A real problem gets the yellow line below. */}
        {!canRecord && recordUnavailableReason && phase === 'in-call' && !recordBlocked && (
          <span className="min-w-0 text-xs leading-snug text-white/70 sm:text-sm">{recordUnavailableReason}</span>
        )}
      </div>

      {/* Real capture problems live up here, in the flow, so they never cover
          the Recording pill, a name tag or the PiP. */}
      {unrecordable.length > 0 && (
        <p className="mb-1 max-w-[92vw] self-center rounded-2xl bg-black/40 px-3 py-1 text-center text-xs text-[#fdd663]">
          {unrecordable.join(', ')} won’t be recorded — their browser can’t record MP4.
        </p>
      )}
      {(notRecorded || notRecordedNames.length > 0) && (
        <p
          role="status"
          className="mb-1 max-w-[92vw] self-center rounded-2xl bg-black/40 px-3 py-1 text-center text-xs text-white/80"
        >
          {notRecorded &&
            'The host has set you as not recorded — your camera, microphone, screen and chat messages are left out of the recording.'}
          {notRecorded && notRecordedNames.length > 0 && ' '}
          {notRecordedNames.length > 0 &&
            `${notRecordedNames.join(', ')} ${notRecordedNames.length === 1 ? 'is' : 'are'} not being recorded.`}
        </p>
      )}
      {hostMuted && (
        <p
          role="status"
          className="mb-1 max-w-[92vw] self-center rounded-2xl bg-black/40 px-3 py-1 text-center text-xs text-[#fdd663]"
        >
          {phase === 'recording'
            ? 'The host muted your microphone. Your recording has no sound until you turn it back on.'
            : 'The host muted your microphone. Turn it back on when you want to speak.'}
        </p>
      )}
      {!canRecord && recordUnavailableReason && phase === 'in-call' && recordBlocked && (
        <p className="mb-1 max-w-[92vw] self-center rounded-2xl bg-black/40 px-3 py-1 text-center text-xs text-[#fdd663]">
          {recordUnavailableReason}
        </p>
      )}
      {backgroundNote && (
        <div
          role="status"
          className="mb-1 flex max-w-[92vw] items-center gap-2 self-center rounded-2xl bg-black/40 px-3 py-1 text-center text-xs text-[#fdd663]"
        >
          <span>{backgroundNote}</span>
          <button
            type="button"
            onClick={dismissBackgroundNote}
            className="rounded-full px-2 py-0.5 text-xs text-white/80 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]"
          >
            Dismiss
          </button>
        </div>
      )}
      {batteryNote && (
        <p
          role="status"
          className="mb-1 max-w-[92vw] self-center rounded-2xl bg-black/40 px-3 py-1 text-center text-xs text-[#fdd663]"
        >
          {batteryNote}
        </p>
      )}
      {resumeOffer && (
        <div role="status" aria-busy={recoveryBusy} className="mb-1 flex max-w-[92vw] flex-wrap items-center justify-center gap-x-2 gap-y-1 self-center rounded-2xl bg-black/40 px-3 py-1 text-center text-xs text-[#fdd663]">
          <span>Recording was interrupted. This browser still has the take.</span>
          {resumeOffer.canResume && (
            <button
              type="button"
              onClick={onResumeRecording}
              disabled={recoveryBusy}
              className="inline-flex min-h-11 shrink-0 items-center rounded-full px-3 text-xs font-medium text-white ring-1 ring-white/30 transition-colors hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8] disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-7"
            >
              Resume recording
            </button>
          )}
          <button
            type="button"
            onClick={onSaveRecording}
            disabled={recoveryBusy}
            className={`${guestLink} disabled:cursor-not-allowed disabled:opacity-50`}
          >
            Save what was recorded
          </button>
        </div>
      )}
      {takeNotice && (
        <p role="status" className="mb-1 max-w-[92vw] self-center rounded-2xl bg-black/40 px-3 py-1 text-center text-xs text-[#fdd663]">
          {takeNotice}
        </p>
      )}
      {micNote && (
        <div className="mb-1 flex max-w-[92vw] items-center gap-2 self-center rounded-2xl bg-black/40 px-3 py-1 text-center text-xs text-[#fdd663]">
          <span role="alert">{MIC_WARNING_TEXT[micNote]}</span>
          <button
            type="button"
            aria-label="Dismiss microphone warning"
            onClick={() => setMicDismissed((d) => [...d, micNote])}
            className="rounded-full px-2 py-0.5 text-xs text-white/80 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]"
          >
            Dismiss
          </button>
        </div>
      )}
      {(overloaded || lowPower) && (
        <div
          role="status"
          className="mb-1 flex max-w-[92vw] flex-wrap items-center justify-center gap-x-2 gap-y-1 self-center rounded-2xl bg-black/40 px-3 py-1 text-center text-xs text-[#fdd663]"
        >
          <span>
            {!lowPower
              ? 'This device is struggling to keep up, so the recording may skip. Close other apps and tabs.'
              : overloaded
                ? 'Low-power mode is on, but this device is still struggling. Turn your camera off to protect the audio, and pick a lower quality before you join next time.'
                : 'Low-power mode is on: the others see you in lower quality. Your recording is unchanged.'}
          </span>
          <button
            type="button"
            onClick={() => onSetLowPower?.(!lowPower)}
            className="inline-flex min-h-11 shrink-0 items-center rounded-full px-3 text-xs font-medium text-white ring-1 ring-white/30 transition-colors hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8] sm:min-h-7"
          >
            {lowPower ? 'Turn off low-power mode' : 'Turn on low-power mode'}
          </button>
        </div>
      )}
      {incomingVideoOff && (
        <div
          role="status"
          className="mb-1 flex max-w-[92vw] flex-wrap items-center justify-center gap-x-2 gap-y-1 self-center rounded-2xl bg-black/40 px-3 py-1 text-center text-xs text-white/80"
        >
          <span>Incoming video is off. You still hear everyone, and the recording is not affected.</span>
          <button
            type="button"
            onClick={() => onSetIncomingVideoOff?.(false)}
            className="inline-flex min-h-11 shrink-0 items-center rounded-full px-3 text-xs font-medium text-white ring-1 ring-white/30 transition-colors hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8] sm:min-h-7"
          >
            Show video
          </button>
        </div>
      )}

      <BackupNotice
        role={role}
        transfers={backupTransfers ?? []}
        takeActive={isTakeActive}
        onAccept={onAcceptBackups}
        onDecline={onDeclineBackups}
        onDismiss={onDismissBackup}
        onStop={onStopBackup}
      />

      {/* Recording failures render HERE, inside the call, rather than switching
          the app to an error screen. Unmounting this component would take the
          "End & save" button with it, and that button is the only thing that
          commits the file to disk. */}
      {recordingError &&
        !(
          phase === 'done' &&
          (recordingError === 'The other person disconnected. Press End & save to keep this recording.' ||
            recordingError.includes('keep this recording'))
        ) && (
          <div
            role="alert"
            className="relative z-50 mx-5 mb-1 rounded-md border border-[#f28b82]/40 bg-[#f28b82]/10 px-4 py-2.5 text-sm text-[#f6aea9]"
          >
            {recordingError}
          </div>
        )}

      {deviceError && (
        <div
          role="alert"
          className="relative z-50 mx-5 mb-1 rounded-md border border-[#f28b82]/40 bg-[#f28b82]/10 px-4 py-2.5 text-sm text-[#f6aea9]"
        >
          {deviceError}
        </div>
      )}

      {/* Body: stage column (stage/summary, then the control bar) + optional
          chat. The bar lives in the stage column so it is centred under the
          stage, not under the chat column beside it. `relative` here is what
          the mobile chat sheet fills, so it never covers the status bar and its
          Recording pill. */}
      <div className="relative flex min-h-0 flex-1">
        <div data-testid="stage-column" className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <main data-testid="stage-main" className="relative min-h-0 flex-1">
            {/* The consent toast floats over the top of the stage: in the flow it
                pushed the stage down when a take started and back up 7 s later.
                With the teleprompter open (Record is its main moment) the top
                band is its controls, so on desktop both toasts drop to the
                stage's bottom centre, clear of the name tag and the PiP. */}
            <RecordingNotice
              recording={roomRecording}
              host={role === 'host'}
              notRecorded={!!notRecorded}
              className={toastPlace}
            />
            <RecordingCountdown endsAt={countdownEndsAt} className={toastPlace} />
            {/* Saving takes up to ~45 s while the last seconds arrive. Leave is
                off until it finishes, so this says why and what to do. */}
            {phase === 'finalizing' && (
              <div aria-hidden className={`pointer-events-none absolute inset-x-0 z-30 flex justify-center px-4 ${toastPlace}`}>
                {/* rounded-3xl, not -full: a pill on one line, and a soft card
                    rather than a squashed stadium when it wraps on a phone. */}
                <div className="flex max-w-md items-center gap-3 rounded-3xl bg-[#3c4043] px-5 py-2.5 text-sm font-medium text-white shadow-2xl">
                  <span
                    aria-hidden
                    className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-white/30 border-t-white motion-reduce:animate-none"
                  />
                  {finalizingCopy}
                </div>
              </div>
            )}
            <Stage
              companion={companion}
              local={local}
              remote={remote}
              others={stagePeers.slice(1).map((r) => {
                const presence = r.presence;
                return {
                  stream: r.stream,
                  name: nameWithCapability(r.name ?? 'Guest', r.peerId, isHost, capabilities),
                  muted: companion ? true : false,
                  camOff: incomingVideoOff || (presence ? !presence.camOn : !r.stream),
                  ...(presence ? { presence: <PresenceBadge {...presence} /> } : {}),
                };
              })}
              remoteScreen={remoteScreenStream}
              localScreen={localScreenStream}
              localPresenting={screenSharing}
              screenLabel={(() => {
                if (!remoteScreenStream) return presentingRearCamera ? 'Your rear camera' : 'What you’re presenting';
                const sharingPeer =
                  remotePeers.find((r) => r.presence?.screenSharing) ??
                  remotePeers.find((r) => r.companion);
                if (sharingPeer) {
                  return sharingPeer.companion
                    ? `${sharingPeer.name || 'Guest'} (Presenting)`
                    : `${sharingPeer.name ?? 'Guest'}'s screen`;
                }
                const name = peerName ?? remotePeers[0]?.name ?? (role === 'host' ? 'Guest' : 'Host');
                return `${name}'s screen`;
              })()}
              spotlight={spotlight}
              onSwapSpotlight={() => setSpotlight((s) => (s === 'remote' ? 'local' : 'remote'))}
              onStopPresenting={() => onToggleScreen()}
              onShowVideo={incomingVideoOff ? () => onSetIncomingVideoOff?.(false) : undefined}
            />
            {prompterOpen && <Teleprompter slug={slug} onClose={() => setPrompterOpen(false)} />}
            {boardOpen && (
              <MediaBoardPanel
                board={board}
                midTake={boardMidTake}
                onFire={(name) => onMark(name)}
                onClose={() => setBoardOpen(false)}
              />
            )}
            {peopleOpen && isHost && onMutePeer && remotePeers.length > 0 && (
              <PeoplePanel
                people={remotePeers}
                recording={takeActive || Boolean(resumeOffer)}
                onMute={onMutePeer}
                onRemove={onRemovePeer}
                onClose={closePeople}
              />
            )}
            {popupEl}
          </main>

          {/* Control bar: in the flow below the stage, never over it, so the
              stage ends where the bar begins at every width and however many
              rows the bar wraps to. Hidden on mobile while chat or the summary
              covers the stage. */}
          <div
            className={`shrink-0 flex-col items-center px-2 pb-[max(1.25rem,env(safe-area-inset-bottom))] ${chatOpen || showSummary ? 'hidden sm:flex' : 'flex'}`}
          >
            <div className="flex max-w-full flex-wrap items-center justify-center gap-2 rounded-[32px] bg-[#2a2b2e]/80 px-3 py-2 shadow-2xl ring-1 ring-white/5 backdrop-blur sm:gap-3">
              {/* A producer joins with no camera or mic, so these would only
                  show red and do nothing. */}
              {!companion && role !== 'producer' && (
                <>
                  {/* Mic button + device picker, one split pill as in Meet */}
                  <div data-picker-container className="relative inline-flex items-center rounded-full bg-[#3c4043]">
                    <ControlButton
                      icon={micOn ? 'mic' : 'mic_off'}
                      label={micOn ? 'Turn off microphone' : 'Turn on microphone'}
                      variant={micOn ? 'default' : 'danger'}
                      onClick={() => {
                        const next = !micOn;
                        setMicOn(next);
                        onToggleMic(next);
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setMicMenuOpen((o) => !o);
                        setCamMenuOpen(false);
                        setPresentMenuOpen(false);
                        setRecordMenuOpen(false);
                      }}
                      aria-label="Select microphone"
                      title="Select microphone"
                      aria-haspopup="menu"
                      aria-expanded={micMenuOpen}
                      className="inline-flex h-12 w-11 items-center justify-center rounded-r-full sm:w-9 text-white hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]"
                    >
                      <Icon name={micMenuOpen ? 'arrow_drop_down' : 'arrow_drop_up'} size={18} />
                    </button>
                    {micMenuOpen && (
                      <div
                        role="menu"
                        className="absolute bottom-full mb-2 left-0 z-30 min-w-64 max-w-[calc(100vw-2rem)] max-h-60 overflow-y-auto rounded-xl bg-[#202124] p-1.5 text-white shadow-2xl ring-1 ring-white/10"
                      >
                        <div className="px-3 py-1.5 text-xs font-semibold text-white/70 uppercase tracking-wider">
                          Microphone
                        </div>
                        {showFallbackNotice ? (
                          <div className="px-3 py-2 text-xs font-medium text-[#fdd663]">
                            Switch after this take
                          </div>
                        ) : audioInputs.length === 0 ? (
                          <div className="px-3 py-2 text-xs text-white/70">No microphones found</div>
                        ) : (
                          audioInputs.map((d, i) => {
                            const isSelected = d.deviceId === currentMicId || (!currentMicId && i === 0);
                            return (
                              <button
                                key={d.deviceId || i}
                                type="button"
                                role="menuitemradio"
                                aria-checked={isSelected}
                                onClick={() => void handleSwitchMic(d.deviceId)}
                                className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left text-sm text-white hover:bg-white/10"
                              >
                                <span className="truncate">{d.label || `Microphone ${i + 1}`}</span>
                                {isSelected && <Icon name="check" size={16} className="text-[#8ab4f8] shrink-0" />}
                              </button>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>

                  {/* Camera button + device picker */}
                  <div data-picker-container className="relative inline-flex items-center rounded-full bg-[#3c4043]">
                    <ControlButton
                      icon={camOn ? 'videocam' : 'videocam_off'}
                      label={camOn ? 'Turn off camera' : 'Turn on camera'}
                      variant={camOn ? 'default' : 'danger'}
                      onClick={() => {
                        const next = !camOn;
                        setCamOn(next);
                        onToggleCam(next);
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setCamMenuOpen((o) => !o);
                        setMicMenuOpen(false);
                        setPresentMenuOpen(false);
                        setRecordMenuOpen(false);
                      }}
                      aria-label="Select camera"
                      title="Select camera"
                      aria-haspopup="menu"
                      aria-expanded={camMenuOpen}
                      className="inline-flex h-12 w-11 items-center justify-center rounded-r-full sm:w-9 text-white hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]"
                    >
                      <Icon name={camMenuOpen ? 'arrow_drop_down' : 'arrow_drop_up'} size={18} />
                    </button>
                    {camMenuOpen && (
                      <div
                        role="menu"
                        className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-30 min-w-64 max-w-[calc(100vw-2rem)] max-h-60 overflow-y-auto rounded-xl bg-[#202124] p-1.5 text-white shadow-2xl ring-1 ring-white/10"
                      >
                        {onSetIncomingVideoOff && (
                          <button
                            type="button"
                            role="menuitemcheckbox"
                            aria-checked={incomingVideoOff}
                            onClick={() => {
                              setCamMenuOpen(false);
                              onSetIncomingVideoOff(!incomingVideoOff);
                            }}
                            className="mb-1 flex w-full items-center justify-between gap-2 rounded-lg border-b border-white/10 px-3 py-2.5 text-left text-sm text-white hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]"
                          >
                            <span>Stop incoming video</span>
                            {incomingVideoOff && <Icon name="check" size={16} className="shrink-0 text-[#8ab4f8]" />}
                          </button>
                        )}
                        <div className="px-3 py-1.5 text-xs font-semibold text-white/70 uppercase tracking-wider">
                          Camera
                        </div>
                        {showFallbackNotice ? (
                          <div className="px-3 py-2 text-xs font-medium text-[#fdd663]">
                            Switch after this take
                          </div>
                        ) : (
                          <>
                            {hasFacingMode && (
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  const nextFacing = currentFacingMode === 'user' ? 'environment' : 'user';
                                  void handleSwitchCamera(nextFacing);
                                }}
                                className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-[#8ab4f8] hover:bg-white/10 border-b border-white/10 mb-1"
                              >
                                <span>Flip camera</span>
                              </button>
                            )}
                            {videoInputs.length === 0 ? (
                              <div className="px-3 py-2 text-xs text-white/70">No cameras found</div>
                            ) : (
                              videoInputs.map((d, i) => {
                                const isSelected = d.deviceId === currentCamId || (!currentCamId && i === 0);
                                return (
                                  <button
                                    key={d.deviceId || i}
                                    type="button"
                                    role="menuitemradio"
                                    aria-checked={isSelected}
                                    onClick={() => void handleSwitchCamera(d.deviceId)}
                                    className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left text-sm text-white hover:bg-white/10"
                                  >
                                    <span className="truncate">{d.label || `Camera ${i + 1}`}</span>
                                    {isSelected && <Icon name="check" size={16} className="text-[#8ab4f8] shrink-0" />}
                                  </button>
                                );
                              })
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}
              {/* Present control:
                  With getDisplayMedia the button presents the screen in one click and
                  the arrow beside it opens a menu with "A photo or video".
                  Without it (phones) the button itself opens the menu, which offers
                  "Rear camera" as well.
                  Where neither is possible, disabled with explanation. */}
              {(() => {
                const canPresentFile =
                  typeof window !== 'undefined' &&
                  typeof HTMLCanvasElement !== 'undefined' &&
                  typeof MediaStream !== 'undefined';
                const fileArrow = screenShareSupported && canPresentFile;
                return (
                  <div
                    data-picker-container
                    className={`relative inline-flex items-center${fileArrow ? ' rounded-full bg-[#3c4043]' : ''}`}
                  >
                    <ControlButton
                      icon="present"
                      label={
                        screenSharing
                          ? 'Stop presenting'
                          : screenShareSupported
                            ? 'Present screen'
                            : canPresentFile
                              ? 'Present a photo, video or your rear camera'
                              : 'Screen sharing isn’t available in this browser — most mobile browsers can’t share a screen. Use a desktop browser.'
                      }
                      variant={screenSharing ? 'active' : 'default'}
                      disabled={!screenSharing && !screenShareSupported && !canPresentFile}
                      onClick={() => {
                        if (screenSharing || screenShareSupported) {
                          setPresentMenuOpen(false);
                          onToggleScreen();
                        } else if (canPresentFile) {
                          setPresentMenuOpen((o) => !o);
                          setMicMenuOpen(false);
                          setCamMenuOpen(false);
                        }
                      }}
                    />
                    {fileArrow && (
                      <button
                        type="button"
                        disabled={screenSharing}
                        onClick={() => {
                          setPresentMenuOpen((o) => !o);
                          setMicMenuOpen(false);
                          setCamMenuOpen(false);
                          setRecordMenuOpen(false);
                        }}
                        aria-label="Choose what to present"
                        title="Choose what to present"
                        aria-haspopup="menu"
                        aria-expanded={presentMenuOpen}
                        className="inline-flex h-12 w-11 items-center justify-center rounded-r-full sm:w-9 text-white hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8] disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Icon name={presentMenuOpen ? 'arrow_drop_down' : 'arrow_drop_up'} size={18} />
                      </button>
                    )}
                    {!screenSharing && canPresentFile && presentMenuOpen && (
                      <div
                        role="menu"
                        aria-label="Present options"
                        className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-30 min-w-48 overflow-hidden rounded-xl bg-[#202124] p-1.5 text-white shadow-2xl ring-1 ring-white/10"
                      >
                        <label
                          role="menuitem"
                          className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-white hover:bg-white/10 focus-within:ring-2 focus-within:ring-[#8ab4f8]"
                        >
                          <span>A photo or video</span>
                          <input
                            type="file"
                            accept="image/*,video/*"
                            className="sr-only"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              setPresentMenuOpen(false);
                              onToggleScreen(file);
                            }}
                          />
                        </label>
                        {!screenShareSupported && (
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setPresentMenuOpen(false);
                              onToggleScreen('rear-camera');
                            }}
                            className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-white hover:bg-white/10"
                          >
                            <span>Rear camera</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}
              <ControlButton
                icon="chat"
                label={unread ? `Chat, ${unread} unread` : 'Chat'}
                badge={unread > 0}
                variant={chatOpen ? 'active' : 'default'}
                onClick={() => openChat(!chatOpen)}
              />
              {isHost && onMutePeer && remotePeers.length > 0 && (
                <ControlButton
                  icon="people"
                  label={peopleOpen ? 'Hide people' : 'People'}
                  variant={peopleOpen ? 'active' : 'default'}
                  onClick={() => {
                    setPeopleOpen((o) => !o);
                    setBoardOpen(false);
                  }}
                />
              )}
              {phase === 'done' && summary && (
                <ControlButton
                  icon="folder"
                  text="Summary"
                  label={summaryOpen ? 'Hide session summary' : 'Show session summary'}
                  variant={summaryOpen ? 'active' : 'default'}
                  onClick={() => {
                    setSummaryOpen(!summaryOpen);
                    if (!summaryOpen) setChatOpen(false);
                  }}
                />
              )}
              {!companion && (
                <>
                  <ControlButton
                    icon="script"
                    label={prompterOpen ? 'Hide teleprompter' : 'Show teleprompter'}
                    variant={prompterOpen ? 'active' : 'default'}
                    onClick={() => setPrompterOpen((o) => !o)}
                  />
                  {/* The board mixes into your mic, and a producer has none. */}
                  {role !== 'producer' && (
                    <ControlButton
                      icon="board"
                      label={boardOpen ? 'Hide media board' : 'Media board'}
                      variant={boardOpen ? 'active' : 'default'}
                      onClick={() => {
                        if (!boardOpen && !board) {
                          setBoard(onOpenMediaBoard());
                          setBoardMidTake(phase === 'recording');
                        }
                        setBoardOpen((o) => !o);
                        setPeopleOpen(false);
                      }}
                    />
                  )}
                </>
              )}
              {((phase === 'in-call' && canRecord) || (phase === 'done' && canRecordNext)) && (
                <div data-picker-container className="relative inline-flex items-center rounded-full bg-[#3c4043]">
                  <ControlButton
                    icon="record"
                    text="Record"
                    label="Start recording"
                    variant="record"
                    disabled={recoveryBusy || countdownEndsAt !== null}
                    onClick={phase === 'done' ? recordNextTake : handleRecord}
                  />
                  {/* Not while an interrupted take can still be resumed or saved: the
                      guests are still capturing it, and who is recorded must not change
                      under a capture in progress. */}
                  {onSetPeerRecorded && !roomRecording && !resumeOffer && choosable.length > 0 && (
                    <>
                      <button
                        type="button"
                        disabled={recoveryBusy}
                        onClick={() => {
                          setRecordMenuOpen((o) => !o);
                          setMicMenuOpen(false);
                          setCamMenuOpen(false);
                          setPresentMenuOpen(false);
                        }}
                        aria-label="Choose who is recorded"
                        title="Choose who is recorded"
                        aria-haspopup="menu"
                        aria-expanded={recordMenuOpen}
                        className="inline-flex h-12 w-11 items-center justify-center rounded-r-full sm:w-9 text-white hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8] disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Icon name={recordMenuOpen ? 'arrow_drop_down' : 'arrow_drop_up'} size={18} />
                      </button>
                      {recordMenuOpen && (
                        <div
                          role="menu"
                          aria-label="Who is recorded"
                          className="absolute bottom-full right-0 z-30 mb-2 max-h-60 min-w-56 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl bg-[#202124] p-1.5 text-white shadow-2xl ring-1 ring-white/10"
                        >
                          <div className="px-3 py-1.5 text-xs font-semibold text-white/70 uppercase tracking-wider">
                            Who is recorded
                          </div>
                          {choosable.map((p) => (
                            <button
                              key={p.peerId}
                              type="button"
                              role="menuitemcheckbox"
                              aria-checked={!p.notRecorded}
                              onClick={() => onSetPeerRecorded(p.peerId, Boolean(p.notRecorded))}
                              className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left text-sm text-white hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]"
                            >
                              <span className="truncate">{p.name ?? 'Guest'}</span>
                              {!p.notRecorded && <Icon name="check" size={16} className="shrink-0 text-[#8ab4f8]" />}
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
              {phase === 'recording' && (
                <>
                  <ControlButton
                    icon="bookmark"
                    label={`Mark this moment (M)${markerCount ? ` — ${markerCount} so far` : ''}`}
                    onClick={() => onMark('')}
                  />
                  {isHost ? (
                    <ControlButton icon="stop" text="End & save" label="End & save recording" variant="active" onClick={onEnd} />
                  ) : (
                    recordingError && recordingError.includes('Stop and save my recording') && (
                      <ControlButton
                        icon="stop"
                        text="Stop and save"
                        label="Stop and save my recording"
                        variant="active"
                        onClick={onEnd}
                      />
                    )
                  )}
                </>
              )}
              {/* Leaving mid-save started a second finalize and tore down the
                  connections the guests' last seconds were still arriving on. */}
              <ControlButton
                icon="call_end"
                label={phase === 'finalizing' ? 'Leave call (available when saving finishes)' : 'Leave call'}
                variant="danger"
                wide
                disabled={phase === 'finalizing'}
                onClick={onLeave}
              />
            </div>
          </div>
        </div>

        {/* Chat: full sheet on mobile (covers the stage, not the status bar),
            a card beside the stage on desktop, top level with the stage tile
            and bottom level with the control bar. On mobile the control bar
            hides while chat is open (above), so the chat input and the bar
            never collide. */}
        {chatOpen && (
          <div
            data-testid="chat-column"
            className="absolute inset-0 z-20 sm:static sm:z-0 sm:w-80 sm:shrink-0 sm:pb-5 sm:pr-2 sm:pt-2"
          >
            <ChatPanel messages={messages} onSend={onSendChat} onClose={closeChat} />
          </div>
        )}

        {/* The summary sits where chat does, as the same card: a sheet over the
            stage on a phone, a column beside it on desktop. */}
        {showSummary && (
          <aside
            data-testid="summary-column"
            aria-label="Session summary"
            className="absolute inset-0 z-20 sm:static sm:z-0 sm:w-80 sm:shrink-0 sm:pb-5 sm:pr-2 sm:pt-2 lg:w-[26rem]"
          >
            <div className="h-full overflow-y-auto bg-[#202124] px-4 py-5 [scrollbar-color:rgb(255_255_255/0.25)_transparent] [scrollbar-width:thin] sm:rounded-2xl sm:bg-[#2a2b2e] sm:px-5">
              <SessionSummary
                files={summaryFiles}
                markers={summary.markers}
                warnings={summary.warnings}
                integrity={summary.integrity}
                alignment={summary.alignment}
                commands={summary.commands}
                syncReportUrl={syncReportUrl}
                chaptersUrl={chaptersUrl}
                backupUrl={backupUrl}
                wavBackupUrl={wavBackupUrl}
                downloadNames={downloadNames}
                takes={takes}
                sidecarsSaved={sidecarsSaved ?? false}
                // Nobody left to record: invite someone and keep the summary.
                // newTake would drop to the waiting room and lose it, sync.json
                // with it. Once a guest is back, the button records again.
                onNewTake={canRecordNext ? recordNextTake : copyInvite}
                nextTakeLabel={
                  canRecordNext
                    ? 'Record another take'
                    : copied === 'copied'
                      ? 'Link copied'
                      : copied === 'failed'
                        ? 'Couldn’t copy — use the address bar'
                        : 'Copy invite link'
                }
                onDiscardTake={onDiscardTake}
                onClose={closeSummary}
              />
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
