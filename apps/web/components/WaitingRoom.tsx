'use client';

import { useState } from 'react';
import type { Role } from '@openmeet/protocol';
import { VideoTile } from './VideoTile';
import { Icon } from './Icon';
import { Logo } from './Logo';


export function WaitingRoom({
  role,
  localStream,
  localName,
  onLeave,
  onToggleMic,
  onToggleCam,
  title,
  note,
  busy = false,
}: {
  role: Role | null;
  localStream: MediaStream | null;
  localName: string;
  onLeave: () => void;
  onToggleMic?: (on: boolean) => void;
  onToggleCam?: (on: boolean) => void;
  /** Override the heading and copy, e.g. after everyone else left. */
  title?: string;
  note?: string;
  /** Show a spinner above the heading while the call connects. */
  busy?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  // Seeded from the tracks, so a camera turned off in the lobby stays off here
  // and whatever is set here carries into the call.
  const [micOn, setMicOn] = useState(() => localStream?.getAudioTracks().some((t) => t.enabled) ?? false);
  const [camOn, setCamOn] = useState(() => localStream?.getVideoTracks().some((t) => t.enabled) ?? false);
  const hasMic = !!onToggleMic && (localStream?.getAudioTracks().length ?? 0) > 0;
  const hasCam = !!onToggleCam && (localStream?.getVideoTracks().length ?? 0) > 0;
  const isHost = role === 'host';

  function copyLink() {
    void navigator.clipboard?.writeText(`${location.origin}${location.pathname}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const focus = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]';
  // The lobby's toggles: dark glass with a light rim reads over a bright room too.
  const pill = `inline-flex h-11 w-11 items-center justify-center rounded-full shadow-md transition-colors sm:h-12 sm:w-12 ${focus}`;
  const pillOn = 'bg-black/45 text-white ring-1 ring-white/60 backdrop-blur-sm hover:bg-black/60';
  // A self-view reads naturally mirrored; a rear camera shows the world, not you.
  const rearCamera = localStream?.getVideoTracks()[0]?.getSettings?.().facingMode === 'environment';

  return (
    // min-h, not h: on a short screen the page scrolls instead of pushing the
    // heading out of reach above the top.
    <div className="relative flex min-h-[100dvh] flex-col bg-[#202124] text-white [color-scheme:dark]">
      <header className="px-4 pt-[18px] min-[861px]:px-14 min-[861px]:pt-7">
        <a
          href="/"
          aria-label="openMeet home"
          className="inline-block rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#8ab4f8]"
        >
          <Logo tone="dark" />
        </a>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-6 px-4 pb-10 lg:flex-row lg:gap-12">
        <div className="relative w-full max-w-2xl">
          <VideoTile
            stream={localStream}
            muted
            label={localName ? `${localName} (You)` : 'You'}
            camOff={!camOn}
            mirror={!rearCamera}
            // Ends left of the centred toggles, so a long name truncates
            // instead of running under them.
            tagClassName="max-w-[calc(50%-4.5rem)]"
          />
          {(hasMic || hasCam) && (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center gap-4 sm:bottom-4">
              {hasMic && (
                <button
                  type="button"
                  onClick={() => {
                    const n = !micOn;
                    setMicOn(n);
                    onToggleMic?.(n);
                  }}
                  aria-label={micOn ? 'Turn off microphone' : 'Turn on microphone'}
                  title={micOn ? 'Turn off microphone' : 'Turn on microphone'}
                  className={`pointer-events-auto ${pill} ${micOn ? pillOn : 'bg-[#ea4335] text-white hover:bg-[#d33426]'}`}
                >
                  <Icon name={micOn ? 'mic' : 'mic_off'} size={22} />
                </button>
              )}
              {hasCam && (
                <button
                  type="button"
                  onClick={() => {
                    const n = !camOn;
                    setCamOn(n);
                    onToggleCam?.(n);
                  }}
                  aria-label={camOn ? 'Turn off camera' : 'Turn on camera'}
                  title={camOn ? 'Turn off camera' : 'Turn on camera'}
                  className={`pointer-events-auto ${pill} ${camOn ? pillOn : 'bg-[#ea4335] text-white hover:bg-[#d33426]'}`}
                >
                  <Icon name={camOn ? 'videocam' : 'videocam_off'} size={22} />
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex max-w-sm flex-col items-center gap-4 text-center lg:items-start lg:text-left">
          {busy && (
            <span
              aria-hidden
              className="h-6 w-6 animate-spin rounded-full border-2 border-white/25 border-t-white motion-reduce:animate-none"
            />
          )}
          <div role="status" className="flex flex-col items-center gap-4 lg:items-start">
            <h1 className="text-[28px] font-normal leading-tight tracking-tight">
              {title ?? (isHost ? 'Waiting for others to join' : 'Waiting for the host to join')}
            </h1>
            <p className="text-balance text-[15px] leading-relaxed text-white/70">
              {note ??
                (isHost
                  ? 'Share the invite link. You’ll connect automatically as people arrive.'
                  : 'Hang tight — the call starts as soon as the host arrives.')}
            </p>
          </div>

          <div className="mt-2 flex flex-wrap items-center justify-center gap-3 lg:justify-start">
            {isHost && (
              <button
                type="button"
                onClick={copyLink}
                className={`inline-flex min-h-11 items-center gap-2 rounded-full bg-[#0b57d0] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#0842a0] ${focus}`}
              >
                <Icon name={copied ? 'check' : 'copy'} size={18} />
                {copied ? 'Link copied' : 'Copy invite link'}
              </button>
            )}
            <button
              type="button"
              onClick={onLeave}
              className={`inline-flex min-h-11 items-center rounded-full px-5 py-2.5 text-sm font-medium text-white/80 ring-1 ring-inset ring-white/20 transition-colors hover:bg-white/10 hover:text-white ${focus}`}
            >
              Leave
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
