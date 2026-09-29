'use client';

import { useEffect, useRef, useState } from 'react';
import { getTurnCred } from '@/lib/api';
import { buildIceServers } from '@/lib/ice';
import { pickRecordingMime } from '@/lib/recorder';
import { isPcmCaptureSupported } from '@/lib/pcm-recorder';
import {
  codecCheck, connectionCheck, diskCheck, folderCheck, micCheck, overallLevel, probeIce, wavCheck,
  type Check, type CheckLevel,
} from '@/lib/preflight';
import { presetById } from '@/lib/quality';
import { getHostToken } from '@/lib/host-token';
import { guestRecordingGuidance } from '@/lib/browser-guidance';

const DOT: Record<Check['level'], string> = {
  ok: 'bg-[#1e8e3e]',
  warn: 'bg-[#f9ab00]',
  fail: 'bg-[#d93025]',
};

/**
 * Pre-join readiness. Every problem here is one that otherwise shows up in the
 * recording, when it is too late to fix.
 */
export function PreflightPanel({
  slug,
  stream,
  qualityId,
  isHost,
  onLevel,
}: {
  slug: string;
  stream: MediaStream | null;
  qualityId: string;
  isHost?: boolean;
  /** The worst level across the checks, whenever it changes. */
  onLevel?: (level: CheckLevel) => void;
}) {
  const host = isHost ?? (typeof window !== 'undefined' ? !!getHostToken(slug) : false);
  const [peak, setPeak] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [disk, setDisk] = useState<Check | null>(null);
  const [conn, setConn] = useState<Check | null>(null);
  const startedAt = useRef(Date.now());

  // Live mic level. This is the check that catches an OS-muted mic, which is
  // otherwise only discovered in the finished file.
  useEffect(() => {
    const track = stream?.getAudioTracks()[0];
    if (!track) return;
    let ctx: AudioContext | null = null;
    let raf = 0;
    try {
      ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream as MediaStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        let max = 0;
        for (const v of buf) max = Math.max(max, Math.abs(v));
        setPeak((prev) => Math.max(max, prev * 0.92)); // decay, so peaks stay visible
        setElapsed(Date.now() - startedAt.current);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    } catch {
      /* no Web Audio — the mic check just stays in its "listening" state */
    }
    return () => {
      cancelAnimationFrame(raf);
      void ctx?.close();
    };
  }, [stream]);

  useEffect(() => {
    void navigator.storage
      ?.estimate?.()
      .then((e) => setDisk(diskCheck(e.quota, e.usage, presetById(qualityId))))
      .catch(() => setDisk(diskCheck(undefined, undefined, presetById(qualityId))));
  }, [qualityId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cred = await getTurnCred(slug);
        const types = await probeIce(buildIceServers(cred));
        if (!cancelled) setConn(connectionCheck(types));
      } catch {
        if (!cancelled) setConn(connectionCheck(new Set()));
      }
    })();
    return () => { cancelled = true; };
  }, [slug]);

  const checks: Check[] = [
    micCheck(peak, elapsed),
    codecCheck(pickRecordingMime()),
    wavCheck(isPcmCaptureSupported()),
    ...(disk ? [disk] : []),
    // Only the host writes everyone's files, so only the host needs the figure.
    ...(host ? [folderCheck(presetById(qualityId))] : []),
    ...(conn ? [conn] : []),
  ];
  const worst = overallLevel(checks);
  // The mic reads "Listening…" (a warning) until it has been sampled; saying
  // "with warnings" meanwhile would cry wolf on every visit. A real failure
  // (no MP4 encoder) needs no waiting, so it shows at once.
  const checking = elapsed < 1500 && worst !== 'fail';
  const pct = Math.min(100, Math.round(peak * 140));

  useEffect(() => {
    onLevel?.(worst);
  }, [worst, onLevel]);

  return (
    <div
      id="preflight"
      className="w-full scroll-mt-4 rounded-3xl border border-[#e1e5ea] bg-[#f8fafd] px-5 py-4 text-left text-[13px] leading-snug"
    >
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[#202124]">
        <span className={`h-2 w-2 rounded-full ${checking ? 'bg-[#9aa0a6]' : DOT[worst]}`} />
        {checking
          ? 'Checking your setup…'
          : worst === 'fail'
            ? 'Fix before recording'
            : worst === 'warn'
              ? 'Ready, with warnings'
              : 'Ready to record'}
      </div>

      <div className="mb-2 flex items-center gap-3">
        <span className="text-xs text-[#5f6368]">Mic</span>
        <div
          role="meter"
          aria-label="Microphone level"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#e3e9f2]"
        >
          <div className="h-full rounded-full bg-[#1e8e3e] transition-[width] duration-75" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <ul className="space-y-1 text-[#5f6368]">
        {checks.map((c) => (
          <li key={c.id} className="flex items-start gap-2">
            <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${DOT[c.level]}`} />
            <span>{c.message}</span>
          </li>
        ))}
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#5f6368]" />
          <span>
            <strong>Wear headphones.</strong> Speakers leak into your mic and your recording.
          </span>
        </li>
      </ul>
    </div>
  );
}
