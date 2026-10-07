'use client';

import { useEffect, useRef, useState } from 'react';
import { WAV_SAMPLE_RATE } from '@openmeet/protocol';
import {
  MediaDeviceMissingError,
  MediaManager,
  MediaPermissionError,
  RECORDING_CONSTRAINTS,
  deviceConstraints,
  type DeviceList,
} from '@/lib/media';
import { isRecordingSupported } from '@/lib/recorder';
import { isPcmCaptureSupported } from '@/lib/pcm-recorder';
import {
  DEFAULT_QUALITY_ID,
  describeTrack,
  formatPerHour,
  presetById,
  supportedPresets,
} from '@/lib/quality';
import { PreflightPanel } from './PreflightPanel';
import { VideoTile } from './VideoTile';
import { Icon } from './Icon';
import { SiteHeader } from './Logo';
import { backupRoom, findBackups, deleteBackup, isScreenBackup } from '@/lib/backup-recorder';
import { getHostToken } from '@/lib/host-token';
import { guestRecordingGuidance } from '@/lib/browser-guidance';
import { getScreenStream, isScreenShareSupported } from '@/lib/screen';
import type { CheckLevel } from '@/lib/preflight';
import { isTakeLockHeld } from '@/lib/take-lock';

export function RecordingDisclosure({ isHost, presenting = false }: { isHost: boolean; presenting?: boolean }) {
  return (
    <p className="text-[13px] leading-relaxed text-[#5f6368]">
      {isHost ? (
        <>
          You can record this call. Files save straight to your computer&nbsp;— nothing is
          uploaded&nbsp;— and everyone is told on screen when recording starts.
        </>
      ) : (
        <>
          The host can record this call. If they do, your {presenting ? 'shared screen and chat are' : 'camera, mic and chat are'} written
          straight to <strong>their computer</strong>&nbsp;— nothing is uploaded to a server,
          and you’ll be told on screen the moment it starts.
        </>
      )}
    </p>
  );
}

interface BackupItem {
  file: File;
  url: string;
}

const EMPTY_DEVICES: DeviceList = { audioInputs: [], videoInputs: [] };

const QUALITY_KEY = 'om_quality';

/** What a producer or present-only companion joins with: no camera, no mic. */
function emptyStream(): MediaStream {
  return typeof MediaStream !== 'undefined'
    ? new MediaStream()
    : ({ getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream);
}

/** Why the preview couldn't start, in words that say what to do next. */
function previewProblem(e: unknown): { title: string; body: string } {
  if (e instanceof MediaPermissionError) {
    return {
      title: 'Camera and mic are blocked',
      body: 'Your browser blocked camera and microphone permission. Open site settings from the icon in the address bar, allow both, then try again.',
    };
  }
  if (e instanceof MediaDeviceMissingError) {
    return {
      title: 'No camera or mic found',
      body: 'openMeet needs both a camera and a microphone. Connect them, then try again.',
    };
  }
  if (e instanceof Error && e.name === 'NotReadableError') {
    return {
      title: 'Camera or mic is busy',
      body: 'Another app or tab is using it. Close it (Zoom, Teams, another call), then try again.',
    };
  }
  return {
    title: 'Couldn’t start camera and mic',
    body: e instanceof Error ? e.message : 'Could not access devices.',
  };
}

function formatSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0b57d0]';
const primaryBtn = `rounded-full bg-[#0b57d0] px-6 py-3 text-[15px] font-medium text-white shadow-sm transition-colors enabled:hover:bg-[#0842a0] disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;

const TAKEOVER_PROMPT =
  'Another tab in this browser is recording this room.\n\n' +
  'Joining here takes over as host, and that recording’s files end at this point. ' +
  'To keep the recording whole, cancel, press End & save in the other tab, then join here.\n\n' +
  'Join here anyway?';

export function Lobby({
  slug,
  onJoin,
  producer = false,
  present = false,
}: {
  slug: string;
  onJoin: (
    stream: MediaStream,
    displayName: string,
    companion?: boolean,
    screenStream?: MediaStream
  ) => void;
  /** Unrecorded observer: publishes nothing, so no camera or mic is opened. */
  producer?: boolean;
  /** Join as a screen-sharing companion only: no camera/mic acquisition. */
  present?: boolean;
}) {
  // A producer link that also carries ?present=1 is still a producer.
  const isPresent = present && !producer;
  const canShareScreen = isScreenShareSupported();
  const [stream, setStream] = useState<MediaStream | null>(null);
  // Why the first preview failed. Kept apart from `error`, which holds only
  // later failures (a device switch, Present only) that leave the preview up.
  const [previewError, setPreviewError] = useState<{ title: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [copied, setCopied] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [devices, setDevices] = useState<DeviceList>(EMPTY_DEVICES);
  const [micId, setMicId] = useState('');
  const [camId, setCamId] = useState('');
  const [qualityId, setQualityId] = useState(DEFAULT_QUALITY_ID);
  // What the camera ACTUALLY produced. Constraints are `ideal`, so this can
  // differ from the request and the user should see the truth, not the ask.
  const [actual, setActual] = useState<string | null>(null);
  const [checkLevel, setCheckLevel] = useState<CheckLevel>('ok');
  const [backups, setBackups] = useState<BackupItem[]>([]);
  const backupsRef = useRef<BackupItem[]>([]);
  backupsRef.current = backups;
  const [isHost, setIsHost] = useState(false);
  const guestGuidance = !producer && !isHost ? guestRecordingGuidance() : null;
  const mmRef = useRef<MediaManager | null>(null);
  // Once the stream is handed to onJoin, useRoom owns its lifecycle. The lobby
  // must not stop it on unmount (the lobby unmounts the instant we enter the
  // call), or the call would receive dead tracks.
  const handedOffRef = useRef(false);
  // A press that is being answered, or that already handed the stream over.
  // The check below is awaited, so a second press could otherwise join twice.
  const joiningRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void findBackups().then((files) => {
      if (cancelled) return;
      const items = files.map((file) => ({
        file,
        url: URL.createObjectURL(file),
      }));
      setBackups(items);
    });
    return () => {
      cancelled = true;
      for (const item of backupsRef.current) {
        URL.revokeObjectURL(item.url);
      }
    };
  }, []);

  useEffect(() => {
    setIsHost(!!getHostToken(slug));
  }, [slug]);

  async function removeBackup(fileName: string) {
    // It may be the only copy of someone's recording.
    if (!window.confirm('Delete this backup? It can’t be recovered.')) return;
    try {
      await deleteBackup(fileName);
    } catch {
      /* ignore */
    }
    setBackups((prev) => {
      const match = prev.find((b) => b.file.name === fileName);
      if (match) {
        URL.revokeObjectURL(match.url);
      }
      return prev.filter((b) => b.file.name !== fileName);
    });
  }

  function startPreview(mm: MediaManager, quality: string) {
    setPreviewError(null);
    mm.acquire(deviceConstraints('', '', quality))
      .then(async (s) => {
        setStream(s);
        // Device labels are only populated after permission is granted.
        const d = await mm.listDevices().catch(() => EMPTY_DEVICES);
        setDevices(d);
        const micSettings = s.getAudioTracks()[0]?.getSettings?.() ?? {};
        const camSettings = s.getVideoTracks()[0]?.getSettings?.() ?? {};
        setMicId(micSettings.deviceId ?? d.audioInputs[0]?.deviceId ?? '');
        setCamId(camSettings.deviceId ?? d.videoInputs[0]?.deviceId ?? '');
        setActual(describeTrack(s.getVideoTracks()[0]));
      })
      .catch((e: unknown) => setPreviewError(previewProblem(e)));
  }

  useEffect(() => {
    // A producer publishes nothing, so opening its camera would only light it up.
    if (isPresent || producer) return;
    const mm = new MediaManager();
    mmRef.current = mm;
    let saved = DEFAULT_QUALITY_ID;
    try {
      saved = localStorage.getItem(QUALITY_KEY) ?? DEFAULT_QUALITY_ID;
    } catch {
      /* private mode — fall back to the default */
    }
    setQualityId(saved);
    startPreview(mm, saved);
    return () => {
      if (!handedOffRef.current) mm.stop();
    };
  }, []);

  async function reacquire(nextMic: string, nextCam: string, nextQuality: string) {
    const mm = mmRef.current;
    if (!mm) return;
    const old = stream;
    try {
      // Acquire FIRST; only stop the old stream once it succeeds, so a failed
      // switch (e.g. OverconstrainedError) leaves the live preview intact
      // instead of a dead frame.
      const s = await mm.acquire(deviceConstraints(nextMic, nextCam, nextQuality));
      old?.getTracks().forEach((t) => t.stop());
      mm.setAudioEnabled(micOn);
      mm.setVideoEnabled(camOn);
      setStream(s);
      // A switch that works makes any earlier failed one moot.
      setError(null);
      setMicId(nextMic);
      setCamId(nextCam);
      setQualityId(nextQuality);
      setActual(describeTrack(s.getVideoTracks()[0]));
      try {
        localStorage.setItem(QUALITY_KEY, nextQuality);
      } catch {
        /* private mode — the choice just doesn't persist */
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not switch device.');
    }
  }

  async function changeDevice(kind: 'mic' | 'cam', deviceId: string) {
    await reacquire(kind === 'mic' ? deviceId : micId, kind === 'cam' ? deviceId : camId, qualityId);
  }

  function toggleMic() {
    const next = !micOn;
    setMicOn(next);
    mmRef.current?.setAudioEnabled(next);
  }
  function toggleCam() {
    const next = !camOn;
    setCamOn(next);
    mmRef.current?.setVideoEnabled(next);
  }

  function copyLink() {
    void navigator.clipboard?.writeText(`${location.origin}${location.pathname}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  /**
   * Joining from this tab takes the host seat, and a take that another tab of
   * this browser is recording ends where it is. Asked right before the stream
   * is handed over, so the answer is about this moment and not about page load.
   */
  async function okToTakeSeat(): Promise<boolean> {
    if (joiningRef.current) return false;
    joiningRef.current = true;
    // A no clears it and leaves the lobby as it was. A yes is the hand-over.
    joiningRef.current = !(await isTakeLockHeld(slug)) || window.confirm(TAKEOVER_PROMPT);
    return joiningRef.current;
  }

  async function handlePresentOnly() {
    if (!name.trim()) return;
    try {
      const screenStream = await getScreenStream();
      // After the picker, not before it: the picker needs the click's user
      // activation, and a dialog left open outlasts that.
      if (!(await okToTakeSeat())) {
        screenStream.getTracks().forEach((t) => t.stop());
        return;
      }
      handedOffRef.current = true;
      mmRef.current?.stop();
      stream?.getTracks().forEach((t) => t.stop());
      onJoin(emptyStream(), name.trim(), true, screenStream);
    } catch (e) {
      if (e instanceof Error && e.name !== 'AbortError' && e.name !== 'NotAllowedError') {
        setError(e.message);
      }
    }
  }

  // 44px on a phone keeps a 16:9 preview's centred avatar clear of the pair.
  const pill =
    'inline-flex h-11 w-11 items-center justify-center rounded-full shadow-md transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:h-12 sm:w-12';
  // Dark glass with a light rim: legible over a bright wall or window too.
  const pillOn = 'bg-black/45 text-white ring-1 ring-white/60 backdrop-blur-sm hover:bg-black/60';
  const pillOff = 'bg-[#ea4335] text-white hover:bg-[#d33426]';
  // The selects drop their native outline, so the box around each shows focus.
  const picker =
    'flex min-w-0 items-center gap-2 rounded-lg border border-[#dadce0] px-3 py-2 text-base text-[#5f6368] focus-within:border-[#0b57d0] focus-within:ring-1 focus-within:ring-[#0b57d0] sm:text-sm';
  const select = 'w-full min-w-0 bg-transparent text-[#202124] outline-none';

  const nameField = (
    <>
      <label htmlFor="lobby-name" className="sr-only">
        Your name
      </label>
      <input
        id="lobby-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="What’s your name?"
        autoComplete="name"
        enterKeyHint="go"
        className="w-full rounded-lg border border-[#dadce0] px-4 py-3 text-base outline-none focus:border-[#0b57d0] focus:ring-1 focus:ring-[#0b57d0]"
      />
    </>
  );

  const invite = (
    <>
      <button
        type="button"
        onClick={copyLink}
        className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-[#0b57d0] transition-colors hover:bg-[#0b57d0]/10 ${focusRing}`}
      >
        <Icon name={copied ? 'check' : 'copy'} size={18} />
        {copied ? 'Link copied' : 'Copy invite link'}
      </button>
      <p className="text-xs text-[#5f6368]">Room: {slug}</p>
    </>
  );

  if (producer) {
    return (
      <main className="min-h-screen bg-white text-[#202124]">
        <SiteHeader />

        <div className="mx-auto flex max-w-sm flex-col items-center gap-6 px-4 pb-16 pt-6 text-center lg:pt-10">
          <div className="flex flex-col gap-3">
            <h1 className="text-[28px] font-normal leading-tight tracking-tight">Join as a producer</h1>
            <p className="text-[15px] leading-relaxed text-[#5f6368]">
              You’ll watch the call without being recorded. Your camera and mic stay off; you can chat
              and share your screen from the call.
            </p>
          </div>
          <form
            className="flex w-full flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              onJoin(emptyStream(), name.trim());
            }}
          >
            {nameField}
            <button type="submit" disabled={!name.trim()} className={`w-full ${primaryBtn}`}>
              Join now
            </button>
          </form>
          {invite}
        </div>
      </main>
    );
  }

  if (isPresent) {
    return (
      <main className="min-h-screen bg-white text-[#202124]">
        <SiteHeader />

        <div className="mx-auto flex max-w-sm flex-col items-center gap-6 px-4 pb-16 pt-6 text-center lg:pt-10">
          <div className="flex flex-col gap-3">
            <h1 className="text-[28px] font-normal leading-tight tracking-tight">Ready to present?</h1>
            <p className="text-[15px] leading-relaxed text-[#5f6368]">
              This device joins only to share its screen — no camera or mic. To be on camera, join from
              your main device with the normal link.
            </p>
          </div>
          <form
            className="flex w-full flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              // Enter in the field is a user gesture, so the screen picker may open.
              if (canShareScreen) void handlePresentOnly();
            }}
          >
            {nameField}
            {canShareScreen ? (
              <button
                type="submit"
                disabled={!name.trim()}
                className={`inline-flex w-full items-center justify-center gap-2 ${primaryBtn}`}
              >
                <Icon name="present" size={20} />
                Share screen &amp; join
              </button>
            ) : (
              <p className="text-sm text-[#5f6368]">
                This device can&#39;t share its screen — open this link on a computer.
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-[#b3261e]">
                {error}
              </p>
            )}
          </form>
          <RecordingDisclosure isHost={isHost} presenting />
          {invite}
        </div>
      </main>
    );
  }

  // A remembered preset this camera can't deliver has no option in the picker,
  // which then shows another one while the disk estimate used the hidden one.
  // Fall back to the best the camera can do, so both agree.
  const presets = supportedPresets(stream?.getVideoTracks()[0]);
  const shownQuality = presets.some((q) => q.id === qualityId) ? qualityId : presets.at(-1)!.id;
  // A self-view reads naturally mirrored; a rear camera shows the world, not you.
  const rearCamera = stream?.getVideoTracks()[0]?.getSettings?.().facingMode === 'environment';
  const recordingNotice = !isRecordingSupported()
    ? isHost
      ? 'Recording needs a Chromium browser (Chrome, Edge; Brave works as host only after enabling brave://flags/#file-system-access-api). The live call still works — switch browser to record.'
      : 'This browser can’t record you — join from Chrome or Edge to be recorded. The live call still works here.'
    : guestGuidance;

  return (
    <main className="min-h-screen bg-white text-[#202124]">
      <SiteHeader />

      <div className="mx-auto flex max-w-6xl flex-col items-center gap-10 px-4 pb-16 pt-6 sm:px-6 lg:grid lg:grid-cols-[minmax(0,42rem)_minmax(0,24rem)] lg:justify-center lg:gap-x-16 lg:gap-y-0 lg:pb-8 lg:pt-10">
        {/* Preview */}
        <div className="w-full max-w-2xl lg:col-start-1 lg:row-start-1">
          <div className="relative">
            <VideoTile
              stream={stream}
              muted
              label={name.trim() || 'You'}
              camOff={!camOn}
              mirror={!rearCamera}
              // Ends left of the centred mic/cam pair, so a long name truncates
              // instead of running under it.
              tagClassName="max-w-[calc(50%-4.5rem)]"
            />
            {stream ? (
              /* Overlaid mic / cam controls */
              <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center gap-4 sm:bottom-4">
                <button
                  type="button"
                  onClick={toggleMic}
                  aria-label={micOn ? 'Turn off microphone' : 'Turn on microphone'}
                  title={micOn ? 'Turn off microphone' : 'Turn on microphone'}
                  className={`pointer-events-auto ${pill} ${micOn ? pillOn : pillOff}`}
                >
                  <Icon name={micOn ? 'mic' : 'mic_off'} size={22} />
                </button>
                <button
                  type="button"
                  onClick={toggleCam}
                  aria-label={camOn ? 'Turn off camera' : 'Turn on camera'}
                  title={camOn ? 'Turn off camera' : 'Turn on camera'}
                  className={`pointer-events-auto ${pill} ${camOn ? pillOn : pillOff}`}
                >
                  <Icon name={camOn ? 'videocam' : 'videocam_off'} size={22} />
                </button>
              </div>
            ) : (
              /* No stream yet: the browser is asking, or it said no. Either way,
                 say so and what to do, instead of a blank tile. */
              <div className="absolute inset-0 flex flex-col items-center justify-center-safe gap-2 overflow-y-auto rounded-2xl bg-[#3c4043] px-4 text-center text-white sm:gap-3 sm:px-6">
                {previewError ? (
                  // Inserted, not toggled, so a screen reader announces it.
                  <div role="alert" className="flex flex-col items-center gap-2 sm:gap-3">
                    <p className="text-base font-medium">{previewError.title}</p>
                    <p className="max-w-sm text-[13px] leading-snug break-words text-white/80 sm:text-sm sm:leading-normal">
                      {previewError.body}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        if (mmRef.current) startPreview(mmRef.current, qualityId);
                      }}
                      className="mt-1 min-h-11 shrink-0 rounded-full bg-white px-5 text-sm font-medium text-[#0b57d0] transition-colors hover:bg-[#e8f0fe] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                    >
                      Try again
                    </button>
                  </div>
                ) : (
                  <>
                    <p className="text-base font-medium">Allow camera and mic</p>
                    <p className="text-sm text-white/80">Choose Allow if your browser asks.</p>
                  </>
                )}
              </div>
            )}
          </div>
          {error && (
            <p role="alert" className="mt-4 text-center text-sm text-[#b3261e]">
              {error}
            </p>
          )}
          {recordingNotice && (
            <p className="mt-4 rounded-2xl bg-[#fef7e0] px-4 py-3 text-left text-sm leading-relaxed text-[#7a4f01]">
              {recordingNotice}
            </p>
          )}
        </div>

        {/* Join panel. Top-aligned with the preview, so it stays put while the
            column under the preview fills in. */}
        <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start">
          <h1 className="text-[28px] font-normal leading-tight tracking-tight">Ready to join?</h1>
          <form
            className="flex w-full flex-col gap-6"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!stream || !name.trim()) return;
              if (!(await okToTakeSeat())) return;
              handedOffRef.current = true;
              onJoin(stream, name.trim());
            }}
          >
            {nameField}
            <div className="flex w-full flex-col gap-3">
              <button type="submit" disabled={!stream || !name.trim()} className={`w-full ${primaryBtn}`}>
                Join now
              </button>
              {!stream && <p className="text-sm text-[#5f6368]">Join opens once your camera and mic are on.</p>}
              {/* A quiet alternative, not a twin of Join: picked by mistake, it
                  joins a guest unrecorded. What it does is said on screen, not
                  only in a tooltip a phone never shows. */}
              {canShareScreen && (
                <div className="flex flex-col items-center">
                  <button
                    type="button"
                    disabled={!name.trim()}
                    onClick={() => void handlePresentOnly()}
                    aria-describedby="present-only-hint"
                    className={`min-h-11 rounded-full px-4 text-sm font-medium text-[#0b57d0] transition-colors enabled:hover:bg-[#0b57d0]/10 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`}
                  >
                    Present only
                  </button>
                  <span id="present-only-hint" className="text-xs text-[#5f6368]">
                    Joins from this device only to share a screen, with no camera or mic.
                  </span>
                </div>
              )}
              {/* On a phone the checklist sits below the fold, after Join. */}
              {checkLevel === 'fail' && (
                <a
                  href="#preflight"
                  className={`inline-flex min-h-11 items-center self-center rounded-full px-3 text-sm font-medium text-[#b3261e] underline underline-offset-4 lg:hidden ${focusRing}`}
                >
                  Fix before recording — see checks below ↓
                </a>
              )}
            </div>
          </form>
          {/* Disclosure BEFORE joining, not after. The host starts recording for
              the whole room, so by the time the in-call notice appears the
              guest is already being captured — consent has to be offered while
              declining still costs nothing. */}
          <RecordingDisclosure isHost={isHost} />
          {invite}
          {/* Beside Join, not under the checklist: a guest back after a crash may
              hold the only copy of their part, and has to see it without scrolling. */}
          {backups.length > 0 && (
            <section
              aria-labelledby="backups-title"
              className="w-full rounded-3xl border border-[#e1e5ea] bg-[#f8fafd] px-5 py-4 text-left"
            >
              <h2 id="backups-title" className="text-sm font-medium text-[#202124]">
                Backups on this device
              </h2>
              <p className="mt-1 text-[13px] leading-relaxed text-[#5f6368]">
                Safety copies of recordings made in this browser. If a recording is missing a part, download
                the matching backup — guests, send it to the host. They stay here until you delete them.
              </p>
              <ul className="mt-3 divide-y divide-[#e1e5ea]">
                {backups.map((b) => {
                  const room = backupRoom(b.file.name);
                  const isScreen = isScreenBackup(b.file.name);
                  const typeLabel = b.file.name.endsWith('.wav') ? ' (WAV)' : ' (MP4)';
                  // Rows from every room land in every lobby, so say which one —
                  // and give each row's controls a name of their own.
                  const details = `from ${new Date(b.file.lastModified).toLocaleString()}${room ? ` in room ${room}` : ''}`;
                  const what = `${isScreen ? 'screen backup' : `backup${typeLabel}`} ${details}`;
                  const title = `${isScreen ? 'Screen backup' : `Recording backup${typeLabel}`} ${details}`;
                  return (
                    <li
                      key={b.file.name}
                      className="flex flex-col gap-1 py-2.5 text-[13px] text-[#202124]"
                    >
                      <p className="min-w-0">
                        <span>{title}</span>
                        <span className="whitespace-nowrap text-[#5f6368]"> · {formatSize(b.file.size)}</span>
                      </p>
                      <div className="-ml-4 flex shrink-0 items-center gap-1">
                        <a
                          href={b.url}
                          download={b.file.name}
                          aria-label={`Download ${what}`}
                          className={`inline-flex min-h-11 items-center rounded-full px-4 font-medium text-[#0b57d0] transition-colors hover:bg-[#0b57d0]/10 sm:min-h-9 ${focusRing}`}
                        >
                          Download
                        </a>
                        <button
                          type="button"
                          onClick={() => void removeBackup(b.file.name)}
                          aria-label={`Delete ${what}`}
                          className={`inline-flex min-h-11 items-center rounded-full px-4 font-medium text-[#b3261e] transition-colors hover:bg-[#b3261e]/10 sm:min-h-9 ${focusRing}`}
                        >
                          Delete
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>

        {/* Devices + preflight. After the Join panel in the DOM, so a phone's
            single column reaches Join without scrolling past the checklist; on
            desktop the grid puts it back under the preview. */}
        <div className="w-full max-w-2xl lg:col-start-1 lg:row-start-2">
          {(devices.videoInputs.length > 0 || devices.audioInputs.length > 0) && (
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {devices.videoInputs.length > 0 && (
                <label className={picker}>
                  <Icon name="videocam" size={18} className="shrink-0" />
                  <select
                    aria-label="Camera"
                    title={devices.videoInputs.find((d) => d.deviceId === camId)?.label}
                    value={camId}
                    onChange={(e) => void changeDevice('cam', e.target.value)}
                    className={select}
                  >
                    {devices.videoInputs.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || 'Camera'}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {devices.audioInputs.length > 0 && (
                <label className={picker}>
                  <Icon name="mic" size={18} className="shrink-0" />
                  <select
                    aria-label="Microphone"
                    title={devices.audioInputs.find((d) => d.deviceId === micId)?.label}
                    value={micId}
                    onChange={(e) => void changeDevice('mic', e.target.value)}
                    className={select}
                  >
                    {devices.audioInputs.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || 'Microphone'}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className={`${picker} sm:col-span-2`}>
                <Icon name="settings" size={18} className="shrink-0" />
                <select
                  aria-label="Recording quality"
                  value={shownQuality}
                  onChange={(e) => void reacquire(micId, camId, e.target.value)}
                  className={select}
                >
                  {presets.map((q) => (
                    <option key={q.id} value={q.id}>
                      {`Quality: ${q.label} · ${formatPerHour(q, 2)} per person`}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {actual && (
            <p className="mt-2 text-center text-xs text-[#5f6368]">
              Capturing {actual} · audio{' '}
              {/* Only the WAV master is uncompressed; without it audio is the MP4's. */}
              {isPcmCaptureSupported() ? `${WAV_SAMPLE_RATE / 1000}kHz/24-bit uncompressed` : '(compressed)'}
            </p>
          )}
          {stream && (
            <div className="mt-3">
              <PreflightPanel
                slug={slug}
                stream={stream}
                qualityId={shownQuality}
                isHost={isHost}
                onLevel={setCheckLevel}
              />
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
