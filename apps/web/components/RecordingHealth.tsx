'use client';

import { useEffect, useRef, useState } from 'react';
import { DC_BUFFERED_HIGH_WATERMARK } from '@openmeet/protocol';
import type { TrackReading } from '@/hooks/recording-controller';
import { formatHiddenDuration } from '@/hooks/use-take-guard';
import { Icon } from '@/components/Icon';

/** A recorder emits every two seconds and the host acknowledges a slow track every ten, so this
 *  long without either is not jitter. */
export const TRACK_STALL_MS = 15_000;
export const HEALTH_SAMPLE_MS = 1000;
/** Above this a sender is behind by its own definition: it has started queueing. */
export const BACKLOG_WARN_BYTES = DC_BUFFERED_HIGH_WATERMARK;

export type TrackState = 'starting' | 'ok' | 'quiet' | 'behind' | 'stopped';
export interface TrackRow extends TrackReading {
  state: TrackState;
  /** Since the count watched for this track last changed, or since it was first seen. */
  idleMs: number;
}
/** Per track key: the last count watched, when it last changed, and whether it ever has. */
export type TrackMemory = Map<string, { bytes: number; at: number; grew: boolean }>;

/** A guest's own camera or WAV: the host's acknowledgements say whether it is arriving. */
const byAcks = (r: TrackReading): r is TrackReading & { acked: number } =>
  r.acked !== undefined && r.track !== 'screen';

export function classifyTracks(
  readings: TrackReading[],
  prev: TrackMemory,
  now: number
): { rows: TrackRow[]; seen: TrackMemory } {
  const seen: TrackMemory = new Map();
  const rows = readings.map((r): TrackRow => {
    // A recorder keeps producing into a dead channel, so a track this browser
    // streams is judged on what the host has confirmed. A still screen sends
    // too little to be acknowledged, so a screen is judged on its own bytes.
    const live = byAcks(r) ? r.acked : r.bytes;
    const was = prev.get(r.key);
    const m = !was
      ? { bytes: live, at: now, grew: false }
      : live !== was.bytes
        ? { bytes: live, at: now, grew: true }
        : was;
    seen.set(r.key, m);
    const idleMs = now - m.at;
    // A screen that is not changing may produce no data, so once a screen
    // track has had some, silence is not counted against it.
    const quiet = idleMs >= TRACK_STALL_MS && (r.track !== 'screen' || !m.grew);
    const behind = r.acked !== undefined && r.bytes - r.acked >= BACKLOG_WARN_BYTES;
    const state: TrackState = r.stopped
      ? 'stopped'
      : quiet
        ? 'quiet'
        : behind
          ? 'behind'
          : m.grew
            ? 'ok'
            : 'starting';
    return { ...r, state, idleMs };
  });
  return { rows, seen };
}

const TRACK_LABEL: Record<TrackReading['track'], string> = {
  camera: 'Camera',
  wav: 'WAV master',
  screen: 'Screen',
};

function size(bytes: number): string {
  if (bytes < 1e9) {
    return `${(bytes / 1e6).toFixed(1)} MB`;
  }
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

function status(row: TrackRow): string {
  if (row.state === 'stopped') {
    return row.who !== undefined
      ? 'Stopped. Their backup has the rest.'
      : 'Stopped. Your backup has the rest.';
  }
  if (row.state === 'quiet') {
    return byAcks(row)
      ? `Not reaching the host for ${formatHiddenDuration(row.idleMs)}`
      : `No data for ${formatHiddenDuration(row.idleMs)}`;
  }
  if (row.state === 'behind') {
    return `${size(row.bytes - (row.acked ?? 0))} still to send`;
  }
  if (row.state === 'ok') {
    if (row.who !== undefined) {
      return 'Receiving';
    }
    return byAcks(row) ? 'Reaching the host' : 'OK';
  }
  return 'Starting…';
}

function indicator(rows: TrackRow[]): { text: string; mark: string; tone: string } {
  if (rows.some((r) => r.state === 'quiet' || r.state === 'behind' || r.state === 'stopped')) {
    return { text: 'Check tracks', mark: '!', tone: 'text-[#fdd663]' };
  }
  if (rows.some((r) => r.state === 'starting')) {
    return { text: 'Tracks starting', mark: '…', tone: 'text-white/60' };
  }
  return { text: 'Tracks OK', mark: '✓', tone: 'text-[#81c995]' };
}

export function RecordingHealth({ read }: { read: () => TrackReading[] }): React.ReactElement | null {
  const [rows, setRows] = useState<TrackRow[]>([]);
  const memory = useRef<TrackMemory>(new Map());

  useEffect(() => {
    const sample = () => {
      // This sits inside the call screen. A throw that reached React would
      // unmount it and take "End & save" with it, so a failed sample keeps
      // the last rows instead.
      try {
        const next = classifyTracks(read(), memory.current, Date.now());
        memory.current = next.seen;
        setRows(next.rows);
      } catch {
        /* keep the last rows */
      }
    };
    sample();
    const id = setInterval(sample, HEALTH_SAMPLE_MS);
    return () => clearInterval(id);
  }, [read]);

  if (rows.length === 0) {
    return null;
  }

  const { text, mark, tone } = indicator(rows);

  return (
    <details
      data-testid="track-health"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !e.currentTarget.open) return;
        e.currentTarget.open = false;
        e.currentTarget.querySelector('summary')?.focus();
      }}
    >
      {/* 44px to tap; the negative margin keeps the status bar from growing. */}
      <summary className="-my-2 inline-flex min-h-11 min-w-11 cursor-pointer list-none items-center justify-center gap-1.5 rounded-full px-2 text-sm text-white/80 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8] sm:px-3 [&::-webkit-details-marker]:hidden">
        <span aria-hidden className={`w-4 text-center font-bold ${tone}`}>{mark}</span>
        {/* The words do not fit beside the clock on a phone; they stay for screen readers. */}
        <span className="sr-only sm:not-sr-only">{text}</span>
        <Icon name="arrow_drop_down" size={18} className="hidden sm:block" />
      </summary>
      {/* aria-live off: the status bar is a live region, and byte counts read
          out every second would drown out the announcements that matter. */}
      <div
        data-testid="track-health-panel"
        aria-live="off"
        className="absolute left-4 top-full z-40 max-h-[60dvh] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl bg-[#202124] p-3 text-sm text-white shadow-2xl ring-1 ring-white/10 min-[861px]:left-14"
      >
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.key}>
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate font-medium">{row.who ?? 'You'}</span>
                <span className="shrink-0 text-white/70">{TRACK_LABEL[row.track]}</span>
                <span className="shrink-0 tabular-nums">{size(row.bytes)}</span>
              </div>
              <div
                className={`truncate text-xs ${
                  row.state === 'quiet' || row.state === 'behind' || row.state === 'stopped'
                    ? 'text-[#fdd663]'
                    : 'text-white/70'
                }`}
              >
                {status(row)}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
