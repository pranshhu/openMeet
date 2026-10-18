'use client';

import { useEffect, useRef, useState } from 'react';
import { RECORD_COUNTDOWN_S } from '@openmeet/protocol';
import { BackupRecorder } from '@/lib/backup-recorder';
import { isPcmCaptureSupported } from '@/lib/pcm-recorder';
import { isRecordingSupported, pickRecordingMime } from '@/lib/recorder';
import { chooseBitrate } from '@/lib/quality';
import { useTakeGuard } from '@/hooks/use-take-guard';
import { RecordingCountdown } from './RecordingNotice';

interface Take {
  n: number;
  links: { url: string; name: string; label: string }[];
  saved: boolean;
}

type Phase = 'idle' | 'counting' | 'recording' | 'saving';

const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0b57d0]';
const START_FAILED = 'Recording could not start. Check your camera and microphone, then press Record again.';
const DEVICE_STOPPED = 'Your microphone or camera stopped. Press Stop to keep what was recorded.';

const button = `min-h-11 w-full rounded-full bg-[#0b57d0] px-6 text-[15px] font-medium text-white shadow-sm transition-colors enabled:hover:bg-[#0842a0] disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;

/**
 * Recording yourself from the room link, with nobody else present. Both files
 * are written into this browser's storage as they are recorded and nothing is
 * sent anywhere: the guest sends a take to the host later, from the room's
 * ordinary lobby, where it is listed as a backup.
 */
export function SoloTake({
  slug,
  stream,
  bitrateId,
  isHost,
  onLive,
}: {
  slug: string;
  /** The lobby's preview: what is recorded. */
  stream: MediaStream | null;
  /** The bitrate level the lobby shows. */
  bitrateId: string;
  /** This browser holds the room's host token. */
  isHost: boolean;
  /** True from the Record press until the stop has answered, the count included. */
  onLive: (live: boolean) => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [takes, setTakes] = useState<Take[]>([]);
  const [warned, setWarned] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const countRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordersRef = useRef<{ camera: BackupRecorder; wav: BackupRecorder | null } | null>(null);
  const warnedRef = useRef(false);
  const urlsRef = useRef<string[]>([]);
  const takeCountRef = useRef(0);
  const hasVideoRef = useRef(true);

  useTakeGuard(phase === 'recording' || phase === 'saving');

  const busy = phase !== 'idle';
  const unsaved = takes.some((t) => !t.saved);
  useEffect(() => {
    if (!busy && !unsaved) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [busy, unsaved]);

  useEffect(
    () => () => {
      if (countRef.current) clearTimeout(countRef.current);
      recordersRef.current?.camera.stop().catch(() => {});
      recordersRef.current?.wav?.stop().catch(() => {});
      for (const url of urlsRef.current) URL.revokeObjectURL(url);
    },
    []
  );

  async function begin(source: MediaStream) {
    countRef.current = null;
    const mimeType = pickRecordingMime();
    if (!mimeType) {
      setPhase('idle');
      setEndsAt(null);
      onLive(false);
      return;
    }
    chooseBitrate(bitrateId);
    warnedRef.current = false;
    setWarned(false);
    hasVideoRef.current = source.getVideoTracks().length > 0;
    const onWarn = () => {
      warnedRef.current = true;
      setWarned(true);
    };
    const onError = () => setProblem(DEVICE_STOPPED);
    const camera = new BackupRecorder({ mimeType, stream: source, fileName: 'openmeet-backup-solo', room: slug, onWarn, onError });
    const wav =
      isPcmCaptureSupported() && source.getAudioTracks().length > 0
        ? new BackupRecorder({ mimeType: 'audio/wav', stream: source, fileName: 'openmeet-backup-solo-audio', room: slug, onWarn, onError })
        : null;
    recordersRef.current = { camera, wav };
    try {
      camera.start();
      wav?.start();
    } catch {
      await Promise.all([camera.stop().catch(() => null), wav?.stop().catch(() => null)]);
      recordersRef.current = null;
      setProblem(START_FAILED);
      setEndsAt(null);
      setPhase('idle');
      onLive(false);
      return;
    }
    setEndsAt(null);
    setPhase('recording');
  }

  function record() {
    if (!stream) return;
    onLive(true);
    setProblem(null);
    setEndsAt(Date.now() + RECORD_COUNTDOWN_S * 1000);
    setPhase('counting');
    countRef.current = setTimeout(() => void begin(stream), RECORD_COUNTDOWN_S * 1000);
  }

  function cancel() {
    if (countRef.current) clearTimeout(countRef.current);
    countRef.current = null;
    setEndsAt(null);
    setPhase('idle');
    onLive(false);
  }

  async function stop() {
    const recorders = recordersRef.current;
    if (!recorders) return;
    setPhase('saving');
    const [video, audio] = await Promise.all([
      recorders.camera.stop().catch(() => null),
      recorders.wav ? recorders.wav.stop().catch(() => null) : Promise.resolve(null),
    ]);
    const n = ++takeCountRef.current;
    const links: Take['links'] = [];
    const add = (blob: Blob | null, ext: 'mp4' | 'wav', label: string) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      urlsRef.current.push(url);
      links.push({ url, name: `openmeet-solo-${slug}-take${n}.${ext}`, label });
    };
    add(video, 'mp4', hasVideoRef.current ? 'Download video' : 'Download audio (MP4)');
    add(audio, 'wav', 'Download audio (WAV)');
    setTakes((prev) => [...prev, { n, links, saved: !warnedRef.current && recorders.camera.wroteToDisk }]);
    setPhase('idle');
    onLive(false);
  }

  const last = takes.at(-1);
  const intro = (
    <p className="text-[13px] leading-relaxed text-[#5f6368]">
      Only you are recorded, in this browser. Nothing leaves this device while you record. Afterwards you
      choose whether to send it to the host.
    </p>
  );

  if (isHost) {
    return (
      <div className="flex w-full flex-col gap-3 text-left">
        {intro}
        <p className="text-sm text-[#5f6368]">
          This link is for guests. To record on your own, go to the room and press Continue alone.
        </p>
      </div>
    );
  }
  if (!isRecordingSupported()) {
    return (
      <div className="flex w-full flex-col gap-3 text-left">
        {intro}
        <p className="text-sm text-[#5f6368]">
          This browser can’t record. Open this link in Chrome or Edge on a computer.
        </p>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-3 text-left">
      {intro}
      {phase === 'counting' && (
        <div className="relative h-12">
          <RecordingCountdown endsAt={endsAt} className="top-0" />
        </div>
      )}
      {phase === 'recording' && (
        <p role="status" className="text-sm font-medium text-[#b3261e]">
          Recording. Press Stop when you’re done.
        </p>
      )}
      {warned && (
        <p role="alert" className="text-sm text-[#b3261e]">
          This browser isn’t keeping this recording. When you stop, download the files before you close this
          tab.
        </p>
      )}
      {problem && (
        <p role="alert" className="text-sm text-[#b3261e]">
          {problem}
        </p>
      )}
      <button
        type="button"
        className={button}
        disabled={phase === 'saving' || (phase === 'idle' && !stream)}
        onClick={phase === 'idle' ? record : phase === 'counting' ? cancel : () => void stop()}
      >
        {phase === 'idle'
          ? takes.length > 0
            ? 'Record another take'
            : 'Record'
          : phase === 'counting'
            ? 'Cancel'
            : phase === 'recording'
              ? 'Stop'
              : 'Saving…'}
      </button>
      {last && (
        <>
          <ul className="divide-y divide-[#e1e5ea]">
            {takes.map((t) => (
              <li key={t.n} className="flex flex-col gap-1 py-2 text-[13px] text-[#202124]">
                <span className="font-medium">{`Take ${t.n}`}</span>
                <div className="-ml-4 flex flex-wrap gap-x-1">
                  {t.links.map((l) => (
                    <a
                      key={l.name}
                      href={l.url}
                      download={l.name}
                      className={`inline-flex min-h-11 items-center rounded-full px-4 font-medium text-[#0b57d0] transition-colors hover:bg-[#0b57d0]/10 ${focusRing}`}
                    >
                      {l.label}
                    </a>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          {phase === 'idle' && (
            <p role="status" className="text-[13px] leading-relaxed text-[#5f6368]">
              {last.saved
                ? 'Saved in this browser. To send it to the host, go to the room while they’re there, press Send to host on it, and join.'
                : 'Not saved in this browser. Download the files now: they are lost when this tab closes.'}
            </p>
          )}
        </>
      )}
    </div>
  );
}
