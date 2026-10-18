'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { RemotePeer, RoomState } from '@/hooks/useRoom';
import type { RemoteScreen } from '@/lib/remote-screens';
import { followSpeaker } from '@/lib/speaker';
import { isStagePeer } from '@/lib/stage-peers';
import { findViewed, viewCamOff, type ViewLink } from '@/lib/view-link';
import { PasscodeForm } from './PasscodeForm';
import { initial } from './VideoTile';

function Line({ children }: { children: ReactNode }) {
  return <p className="max-w-full truncate text-center text-sm text-white/70">{children}</p>;
}

/**
 * One sound state for the page. The elements are not muted: a page nobody
 * clicked may be refused sound by the browser. The first refusal mutes every
 * element, so every picture still runs, and shows one button; the button turns
 * the sound on for all of them. An element that starts later plays with sound.
 */
function useSharedSound() {
  const elements = useRef(new Set<HTMLVideoElement>());
  const [blocked, setBlocked] = useState(false);
  const add = useCallback((el: HTMLVideoElement) => {
    elements.current.add(el);
    return () => void elements.current.delete(el);
  }, []);
  const refuse = useCallback(() => {
    setBlocked(true);
    for (const el of elements.current) {
      if (el.muted) continue;
      el.muted = true;
      void el.play().catch(() => {});
    }
  }, []);
  const turnOn = useCallback(() => {
    setBlocked(false);
    for (const el of elements.current) {
      el.muted = false;
      void el.play().catch(() => {});
    }
  }, []);
  return { blocked, add, refuse, turnOn };
}

type Cell = { key: string; stream: MediaStream | null; label: string; camOff: boolean };

/** One picture and its sound, filling its place in the page. */
function ViewCell({
  stream,
  label,
  camOff,
  add,
  refuse,
}: Cell & { add: (el: HTMLVideoElement) => () => void; refuse: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const start = async () => {
      try {
        await el.play();
      } catch (e) {
        if (e instanceof DOMException && e.name === 'NotAllowedError') refuse();
      }
    };
    el.srcObject = stream;
    if (!stream) return;
    const remove = add(el);
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
    return () => {
      remove();
      stream.removeEventListener('removetrack', reload);
    };
  }, [stream, add, refuse]);

  useEffect(() => {
    const el = ref.current;
    return el ? followSpeaker(el) : undefined;
  }, []);

  return (
    <div className="relative min-h-0 min-w-0 bg-black">
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
    </div>
  );
}

const peerCell = (p: RemotePeer): Cell => ({
  key: p.peerId,
  stream: p.stream,
  label: p.name ?? (p.role === 'host' ? 'Host' : 'Guest'),
  camOff: viewCamOff(p),
});

/** Every presented screen, then every person with a camera, but nobody the host kept out of the recording. */
function stageCells(peers: readonly RemotePeer[], screens: readonly RemoteScreen[]): Cell[] {
  const recorded = (peerId: string) => !peers.some((p) => p.peerId === peerId && p.notRecorded === true);
  return [
    ...screens
      .filter((s) => recorded(s.peerId))
      .map((s) => ({ key: `screen:${s.peerId}`, stream: s.stream, label: '', camOff: false })),
    ...peers.filter((p) => isStagePeer(p) && p.notRecorded !== true).map(peerCell),
  ];
}

// Fixed class names, so the stylesheet keeps them: one column for one cell, two
// up to four, three beyond.
const columnsOf = (count: number) => (count === 1 ? 'grid-cols-1' : count <= 4 ? 'grid-cols-2' : 'grid-cols-3');

/**
 * The page a view link opens: one person's camera and sound on black, or with
 * the stage view everyone's and every shared screen, with no name tag and no
 * controls. Only what the person must act on is drawn: the passcode field, and
 * the button that turns the sound on when the browser held it back.
 */
export function CleanView({
  link,
  peers,
  screens,
  door,
  onPasscode,
}: {
  link: ViewLink;
  peers: readonly RemotePeer[];
  screens: readonly RemoteScreen[];
  door: RoomState['door'];
  onPasscode: (code: string) => void;
}) {
  const sound = useSharedSound();
  const viewed = findViewed(peers, link);
  const cells = link.kind === 'stage' ? stageCells(peers, screens) : viewed ? [peerCell(viewed)] : [];
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
  } else if (cells.length === 0) {
    body = <Line>Waiting for {link.kind === 'stage' ? 'someone' : who} to join</Line>;
  } else {
    return (
      <div className={`fixed inset-0 grid auto-rows-fr bg-black ${columnsOf(cells.length)}`}>
        {cells.map(({ key, ...cell }) => (
          <ViewCell key={key} {...cell} add={sound.add} refuse={sound.refuse} />
        ))}
        {sound.blocked && (
          <button
            type="button"
            onClick={sound.turnOn}
            className="absolute bottom-4 left-1/2 inline-flex min-h-11 -translate-x-1/2 items-center rounded-full bg-[#8ab4f8] px-5 text-sm font-medium text-[#202124] hover:bg-[#a8c7fa] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            Turn on sound
          </button>
        )}
      </div>
    );
  }
  return <div className="fixed inset-0 flex items-center justify-center bg-black px-4">{body}</div>;
}
