'use client';

import type { ReactNode } from 'react';
import { VideoTile } from './VideoTile';
import { Icon } from './Icon';

export interface StageFeed {
  stream: MediaStream | null;
  name: string;
  muted: boolean;
  camOff: boolean;
  presence?: ReactNode;
  /** Flip the picture, for your own camera. Display only. */
  mirror?: boolean;
}

function feedProps(f: StageFeed) {
  return {
    stream: f.stream,
    muted: f.muted,
    label: f.name,
    camOff: f.camOff,
    // Avoid passing an explicit `presence: undefined` (exactOptionalPropertyTypes).
    ...(f.presence !== undefined ? { presence: f.presence } : {}),
    ...(f.mirror ? { mirror: true } : {}),
  };
}

/**
 * Google Meet-style stage. Derives the layout from the available feeds:
 *  - presenting (a screen is live): screen spotlight + cameras (desktop column /
 *    mobile floating peer PiP), other people first and yourself last. A desktop
 *    screen sharer sees a "You're presenting" placeholder with a Stop button
 *    instead of a self-mirror; a phone presenting its rear camera or a file
 *    passes `localScreen` and sees what it is showing.
 *  - focused (2 cameras): one big spotlight + a tap-to-swap corner PiP.
 *  - grid (3+ people): equal tiles. Mesh calls have no natural "the other
 *    person", so the focused/PiP layout stops making sense.
 *  - solo (alone): local camera fills the stage (used by the waiting room too).
 * Pure layout — no media logic.
 */
export function Stage({
  local,
  remote,
  others = [],
  remoteScreen,
  localScreen,
  localPresenting,
  spotlight,
  onSwapSpotlight,
  presenterName,
  screenLabel: screenLabelProp,
  companion,
  onStopPresenting,
}: {
  local: StageFeed;
  remote: StageFeed | null; // null while alone
  /** Additional remotes beyond the first. Non-empty means a mesh call. */
  others?: StageFeed[];
  remoteScreen: MediaStream | null; // peer's shared screen (viewer side)
  localScreen?: MediaStream | null; // our own shared screen (self-preview)
  localPresenting: boolean;
  spotlight: 'local' | 'remote';
  onSwapSpotlight: () => void;
  presenterName?: string;
  screenLabel?: string;
  companion?: boolean | undefined;
  onStopPresenting?: () => void;
}) {
  const presenting = !!remoteScreen || localPresenting;
  // Spotlight the peer's screen if we're viewing, else our own (self-preview).
  const screen = remoteScreen ?? localScreen ?? null;
  const presenter = presenterName ?? remote?.name?.split(' — ')[0];
  const screenLabel =
    screenLabelProp ??
    (remoteScreen
      ? (presenter ? `${presenter}'s screen` : 'Shared screen')
      : 'Your screen');

  // 3+ people: no natural "other person", so equal tiles rather than a
  // spotlight + PiP. Columns grow with the count so tiles stay as large as
  // possible instead of shrinking into a fixed grid.
  if (!presenting && others.length > 0) {
    const all = [...(!companion ? [local] : []), ...(remote ? [remote] : []), ...others];
    const cols = all.length <= 2 ? 1 : 2;
    return (
      <div
        className="grid h-full w-full gap-2 p-2"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {all.map((f, i) => (
          <VideoTile key={`${f.name}-${i}`} {...feedProps(f)} fit="cover" className="h-full w-full" />
        ))}
      </div>
    );
  }

  if (presenting) {
    const cams = [...(remote ? [remote] : []), ...others, ...(!companion ? [local] : [])];
    return (
      <div className="flex h-full w-full flex-col gap-2 p-2 md:flex-row">
        {/* Screen spotlight */}
        <div className="relative min-h-0 flex-1">
          {screen ? (
            <VideoTile
              stream={screen}
              muted={companion ? true : !remoteScreen}
              label={screenLabel}
              fit="contain"
              className="h-full w-full"
            />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 rounded-2xl bg-[#3c4043] px-4 text-center ring-1 ring-white/5">
              <Icon name="present" size={40} className="mb-2 text-[#8ab4f8]" />
              <span className="text-lg font-medium text-white">You’re presenting</span>
              <span className="text-sm text-white/70">
                Everyone in the call can see what you’re sharing.
              </span>
              {onStopPresenting && (
                <button
                  type="button"
                  onClick={onStopPresenting}
                  className="mt-4 rounded-full bg-[#8ab4f8] px-6 py-3 text-sm font-medium text-[#062e6f] transition-colors hover:bg-[#aecbfa] focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                >
                  Stop presenting
                </button>
              )}
            </div>
          )}
          {/* Mobile: floating PiP of the peer over the screen */}
          {remote && (
            <div className="absolute bottom-4 right-4 z-10 w-28 overflow-hidden rounded-xl shadow-lg ring-1 ring-white/15 md:hidden">
              <VideoTile {...feedProps(remote)} className="aspect-video w-full" />
            </div>
          )}
        </div>
        {/* Desktop: camera side column */}
        {cams.length > 0 && (
          <div className="hidden shrink-0 flex-col gap-2 md:flex md:w-52 lg:w-60">
            {cams.map((c, i) => (
              <VideoTile key={c === local ? 'local' : `remote-${i}`} {...feedProps(c)} className="aspect-video w-full" />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (!remote) {
    // Solo / waiting: local camera fills the stage.
    return (
      <div className="relative h-full w-full p-2">
        <VideoTile {...feedProps(local)} className="h-full w-full" />
      </div>
    );
  }

  if (companion) {
    return (
      <div className="relative h-full w-full p-2">
        <VideoTile {...feedProps(remote)} className="h-full w-full" />
      </div>
    );
  }

  // Focused: spotlight one feed big, the other as a tap-to-swap corner PiP.
  const big = spotlight === 'local' ? local : remote;
  const pip = spotlight === 'local' ? remote : local;
  return (
    <div className="relative h-full w-full p-2">
      <VideoTile
        {...feedProps(big)}
        className="h-full w-full"
        tagClassName="max-w-[calc(100%-9rem)] sm:max-w-[calc(100%-15rem)]"
      />
      <button
        type="button"
        onClick={onSwapSpotlight}
        aria-label="Swap spotlight"
        className="absolute bottom-4 right-4 z-10 w-28 overflow-hidden rounded-xl shadow-lg ring-1 ring-white/15 transition-transform hover:scale-[1.03] sm:bottom-6 sm:right-6 sm:w-48"
      >
        <VideoTile {...feedProps(pip)} className="aspect-video w-full" />
      </button>
    </div>
  );
}
