'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { RemotePeer, RoomState } from '@/hooks/useRoom';
import { followSpeaker } from '@/lib/speaker';
import { findViewed, viewCamOff, type ViewLink } from '@/lib/view-link';
import { PasscodeForm } from './PasscodeForm';
import { initial } from './VideoTile';

function Line({ children }: { children: ReactNode }) {
  return <p className="max-w-full truncate text-center text-sm text-white/70">{children}</p>;
}

/**
 * The viewed person's camera and sound, filling the page. The element is not
 * muted: a page nobody clicked may be refused sound by the browser, and is then
 * muted so the picture still runs, with a button to turn the sound on.
 */
function ViewedPerson({ peer, label }: { peer: RemotePeer; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const camOff = viewCamOff(peer);
  const { stream } = peer;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const start = async () => {
      try {
        await el.play();
      } catch (e) {
        if (!(e instanceof DOMException) || e.name !== 'NotAllowedError') return;
        el.muted = true;
        setSoundBlocked(true);
        await el.play().catch(() => {});
      }
    };
    el.srcObject = stream;
    if (!stream) return;
    void start();
    // An element given a stream that lists a video track waits for that track's
    // first frame; one whose track was taken out first is given the stream as it
    // then stands. One that already plays is left alone: loading it again would
    // cut the sound.
    const reload = () => {
      if (el.readyState !== 0) return;
      el.srcObject = stream;
      void start();
    };
    stream.addEventListener('removetrack', reload);
    return () => stream.removeEventListener('removetrack', reload);
  }, [stream]);

  useEffect(() => {
    const el = ref.current;
    return el ? followSpeaker(el) : undefined;
  }, []);

  const turnOnSound = () => {
    const el = ref.current;
    if (!el) return;
    el.muted = false;
    setSoundBlocked(false);
    void el.play().catch(() => {});
  };

  return (
    <>
      <video
        ref={ref}
        playsInline
        className={`h-full w-full object-contain ${camOff ? 'opacity-0' : 'opacity-100'}`}
      />
      {camOff && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-[#5f6368] text-3xl font-medium text-white select-none">
            {initial(label)}
          </div>
        </div>
      )}
      {soundBlocked && (
        <button
          type="button"
          onClick={turnOnSound}
          className="absolute bottom-4 left-1/2 inline-flex min-h-11 -translate-x-1/2 items-center rounded-full bg-[#8ab4f8] px-5 text-sm font-medium text-[#202124] hover:bg-[#a8c7fa] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          Turn on sound
        </button>
      )}
    </>
  );
}

/**
 * The page a view link opens: one person's camera and sound on black, with no
 * name tag and no controls. Only what the person must act on is drawn: the
 * passcode field, and the button that turns the sound on when the browser held
 * it back.
 */
export function CleanView({
  link,
  peers,
  door,
  onPasscode,
}: {
  link: ViewLink;
  peers: readonly RemotePeer[];
  door: RoomState['door'];
  onPasscode: (code: string) => void;
}) {
  const viewed = findViewed(peers, link);
  const who = link.kind === 'guest' ? <bdi>{link.name}</bdi> : 'the host';
  let body: ReactNode;
  if (door === 'passcode' || door === 'wrong-passcode') {
    body = (
      <div className="flex w-full max-w-xs flex-col items-center gap-3">
        <Line>This room needs a passcode</Line>
        <PasscodeForm wrong={door === 'wrong-passcode'} onSubmit={onPasscode} />
      </div>
    );
  } else if (door === 'waiting') {
    body = <Line>Waiting for the host to let this view in</Line>;
  } else if (link.kind === 'incomplete') {
    body = <Line>This view link is incomplete. Ask the host to copy it again.</Line>;
  } else if (!viewed) {
    body = <Line>Waiting for {who} to join</Line>;
  } else {
    return (
      <div className="fixed inset-0 bg-black">
        <ViewedPerson peer={viewed} label={viewed.name ?? 'Host'} />
      </div>
    );
  }
  return <div className="fixed inset-0 flex items-center justify-center bg-black px-4">{body}</div>;
}
