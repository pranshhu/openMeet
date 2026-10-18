'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode, SyntheticEvent } from 'react';
import { followSpeaker } from '@/lib/speaker';

export function initial(label: string): string {
  const m = label.trim().match(/[a-z0-9]/i);
  return m ? m[0]!.toUpperCase() : '?';
}

export function VideoTile({
  stream,
  muted,
  label,
  title,
  presence,
  camOff = false,
  fit = 'cover',
  // Outer-box sizing. Default 16:9 (lobby preview); pass 'h-full w-full' to fill
  // a positioned parent (Stage spotlight / PiP).
  className = 'aspect-video w-full',
  // Width cap for the name tag, which truncates to it. Stage's focused spotlight
  // passes a tighter one so the tag ends left of the corner PiP.
  tagClassName = 'max-w-[calc(100%-1rem)]',
  // Flip the picture like a mirror, as a self-view should be. Display only: the
  // stream (and so the recording) is untouched.
  mirror = false,
  // How loud this tile plays in this tab, 0 to 1. It is the element's own
  // volume: nobody else hears it, and a recorder reads the stream, never
  // this element.
  volume = 1,
}: {
  stream: MediaStream | null;
  muted: boolean;
  label: string;
  /** The person's own title, a second line under the name. Not shown in a narrow tile. */
  title?: string;
  presence?: ReactNode;
  camOff?: boolean;
  fit?: 'cover' | 'contain';
  className?: string;
  tagClassName?: string;
  mirror?: boolean;
  volume?: number;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  // Whether the picture the element holds is taller than wide (a phone held
  // upright). Such a picture is drawn whole, as a contained one is, instead of as
  // a band across its middle.
  const [tall, setTall] = useState(false);
  const whole = fit === 'contain' || tall;
  const showVideo = !!stream && !camOff;
  // The black box belongs to a picture that is shown; a tile with the camera off
  // keeps the colour every such tile has.
  const black = fit === 'contain' || (tall && showVideo);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A stream that is new, or gone, has not told its size yet.
    setTall(false);
    // Assign AND clear. Only assigning meant a tile whose stream went away kept
    // rendering the last frame of a dead stream — e.g. after the peer left or
    // the call was torn down — so the UI showed video that no longer existed.
    el.srcObject = stream ?? null;
    if (!stream) return;
    // An element given a stream that lists a video track waits for that
    // track's first frame before it plays anything, sound included. When the
    // track is taken out first (the other side was told not to send it), the
    // wait never ends, so the element is given the stream as it then stands.
    // One that already plays is left alone: loading it again would cut the sound.
    const reload = () => {
      if (el.readyState === 0) el.srcObject = stream;
    };
    stream.addEventListener('removetrack', reload);
    return () => stream.removeEventListener('removetrack', reload);
  }, [stream]);

  // A tile that sounds plays through the speaker the person chose. A muted one
  // (their own camera, the lobby preview) plays nothing, so it is left alone.
  useEffect(() => {
    const el = ref.current;
    if (!el || muted) return;
    return followSpeaker(el);
  }, [muted]);

  // The element reports its picture size when it first knows it and when it
  // changes. It is read there, not per frame.
  const readShape = ({ currentTarget: v }: SyntheticEvent<HTMLVideoElement>) =>
    setTall(v.videoWidth > 0 && v.videoHeight > v.videoWidth);

  useEffect(() => {
    if (ref.current) ref.current.volume = volume;
  }, [volume]);

  return (
    <div
      className={`@container group relative overflow-hidden rounded-2xl ring-1 ring-white/5 ${black ? 'bg-black' : 'bg-[#3c4043]'} ${className}`}
    >
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={muted}
        onLoadedMetadata={readShape}
        onResize={readShape}
        className={`h-full w-full ${whole ? 'object-contain' : 'object-cover'} transition-opacity duration-200 ${showVideo ? 'opacity-100' : 'opacity-0'} ${mirror ? '-scale-x-100' : ''}`}
      />
      {!showVideo && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#5f6368] text-2xl font-medium text-white select-none sm:h-20 sm:w-20 sm:text-3xl">
            {initial(label)}
          </div>
        </div>
      )}
      <span
        title={title ? `${label}\n${title}` : label}
        className={`absolute bottom-2 left-2 truncate rounded-md bg-black/55 px-2 py-0.5 text-xs font-medium text-white backdrop-blur-sm [border-left:var(--om-tag-bar,none)] sm:bottom-3 sm:left-3 sm:px-2.5 sm:py-1 sm:text-[13px] ${tagClassName}`}
      >
        {title ? (
          <>
            <span className="block truncate">{label}</span>
            {/* The tile is the container: below 224 px wide the line is left out. */}
            <span className="hidden truncate text-[11px] font-normal text-white/70 @[224px]:block">{title}</span>
          </>
        ) : (
          label
        )}
      </span>
      {presence}
    </div>
  );
}
