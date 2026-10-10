'use client';

import { useEffect, useRef, useState } from 'react';

// How often a meter is read: quick enough to follow speech, slow enough to cost
// nothing beside the encoder.
const METER_POLL_MS = 100;
// Samples read each time: 171 ms at 48 kHz, longer than the gap between two
// readings, so no sound falls between them.
const METER_WINDOW_SAMPLES = 8192;
// How far a bar falls per reading once the sound drops, so a peak can be seen.
const METER_FALL = 5;

/** A peak sample (0 to 1) as a bar width: empty at -60 dBFS or less, 100 at full scale. */
export function levelPercent(peak: number): number {
  return Math.max(0, Math.min(100, Math.round((20 * Math.log10(peak) + 60) / 0.6))) || 0;
}

function LevelRow({
  ctx,
  name,
  stream,
  percent,
  onPercent,
}: {
  /** The panel's audio context; null before it exists and where there is no Web Audio. */
  ctx: AudioContext | null;
  name: string;
  stream: MediaStream | null;
  percent: number;
  onPercent: (percent: number) => void;
}) {
  const meter = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ctx || !stream) return;
    let source: MediaStreamAudioSourceNode;
    let analyser: AnalyserNode;
    try {
      // Listening only. The analyser is where this path ends: it is connected
      // to nothing, so what it hears is never played and never recorded.
      source = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = METER_WINDOW_SAMPLES;
      source.connect(analyser);
    } catch {
      // The stream has no audio track: the bar stays empty and the fader works.
      return;
    }
    const samples = new Float32Array(METER_WINDOW_SAMPLES);
    // Written straight to the DOM: a React render per person ten times a
    // second would run beside the encoder.
    const draw = (value: number) => {
      const el = meter.current;
      if (!el) return;
      el.setAttribute('aria-valuenow', String(value));
      (el.firstElementChild as HTMLElement).style.width = `${value}%`;
    };
    let shown = 0;
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let peak = 0;
      for (const v of samples) {
        const abs = Math.abs(v);
        if (abs > peak) peak = abs;
      }
      shown = Math.max(levelPercent(peak), shown - METER_FALL);
      draw(shown);
    }, METER_POLL_MS);
    return () => {
      clearInterval(timer);
      draw(0);
      try {
        source.disconnect();
      } catch {
        // The context closed first and took its nodes with it.
      }
    };
  }, [ctx, stream]);

  return (
    <li className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <span title={name} className="block truncate text-sm">
          {name}
        </span>
        <div
          ref={meter}
          role="meter"
          aria-label={`Level for ${name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={0}
          className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/15"
        >
          <div className="h-full w-0 rounded-full bg-[#81c995] transition-[width] duration-100" />
        </div>
      </div>
      {/* h-11: 44px to drag on a phone. */}
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={percent}
        onChange={(e) => onPercent(Number(e.target.value))}
        aria-label={`Volume for ${name}`}
        className="h-11 w-32 shrink-0 accent-[#8ab4f8] sm:w-40"
      />
      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-white/70">{percent}%</span>
    </li>
  );
}

/**
 * A fader for each other person: how loud this tab plays them. The value ends
 * up as the volume of that person's <video> elements and nowhere else, so
 * what the others hear and every recording stay as they were. Beside it, a
 * meter of what arrives from that person, whatever the fader says.
 */
export function LevelsPanel({
  peers,
  volumes,
  onVolume,
}: {
  /** The people who have a tile, in tile order. */
  peers: { peerId: string; name: string | null; stream: MediaStream | null }[];
  /** 0 to 1 by peerId. A person who is not in it plays at 1. */
  volumes: ReadonlyMap<string, number>;
  onVolume: (peerId: string, volume: number) => void;
}) {
  // One context for all the meters, alive only while the panel is on screen.
  // It is not a context a recorder or the media board runs in, and a node
  // cannot be connected from one context to another.
  const [ctx, setCtx] = useState<AudioContext | null>(null);
  useEffect(() => {
    let made: AudioContext;
    try {
      made = new AudioContext();
    } catch {
      // No Web Audio here: the faders work and the bars stay empty.
      return;
    }
    setCtx(made);
    return () => {
      void made.close().catch(() => {});
    };
  }, []);

  return (
    <section
      aria-label="Levels"
      className="mb-2 w-full max-w-md rounded-2xl bg-[#2a2b2e] px-4 py-3 text-white ring-1 ring-white/5"
    >
      <h2 className="text-sm font-medium">Levels</h2>
      <p className="text-xs text-white/70">For your ears only. Recordings are not changed.</p>
      {peers.length === 0 ? (
        <p className="mt-2 text-xs text-white/70">No one else to hear right now.</p>
      ) : (
        <ul className="mt-1">
          {peers.map((p) => (
            <LevelRow
              key={p.peerId}
              ctx={ctx}
              name={p.name ?? 'Guest'}
              stream={p.stream}
              percent={Math.round((volumes.get(p.peerId) ?? 1) * 100)}
              onPercent={(percent) => onVolume(p.peerId, percent / 100)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
