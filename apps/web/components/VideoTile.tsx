'use client';

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { followSpeaker } from '@/lib/speaker';

function initial(label: string): string {
  const m = label.trim().match(/[a-z0-9]/i);
  return m ? m[0]!.toUpperCase() : '?';
}

export function VideoTile({
  stream,
  muted,
  label,
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
}: {
  stream: MediaStream | null;
  muted: boolean;
  label: string;
  presence?: ReactNode;
  camOff?: boolean;
  fit?: 'cover' | 'contain';
  className?: string;
  tagClassName?: string;
  mirror?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
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

  const showVideo = !!stream && !camOff;

  return (
    <div
      className={`group relative overflow-hidden rounded-2xl ring-1 ring-white/5 ${fit === 'contain' ? 'bg-black' : 'bg-[#3c4043]'} ${className}`}
    >
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={muted}
        className={`h-full w-full ${fit === 'contain' ? 'object-contain' : 'object-cover'} transition-opacity duration-200 ${showVideo ? 'opacity-100' : 'opacity-0'} ${mirror ? '-scale-x-100' : ''}`}
      />
      {!showVideo && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#5f6368] text-2xl font-medium text-white select-none sm:h-20 sm:w-20 sm:text-3xl">
            {initial(label)}
          </div>
        </div>
      )}
      <span
        title={label}
        className={`absolute bottom-2 left-2 truncate rounded-md bg-black/55 px-2 py-0.5 text-xs font-medium text-white backdrop-blur-sm sm:bottom-3 sm:left-3 sm:px-2.5 sm:py-1 sm:text-[13px] ${tagClassName}`}
      >
        {label}
      </span>
      {presence}
    </div>
  );
}
