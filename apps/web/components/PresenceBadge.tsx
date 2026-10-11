'use client';

import { Icon } from './Icon';

// Meet-style tile indicators: shown only for the "notable" states (hand
// raised / muted / camera off / sharing screen). A person's own tile gets
// one only for their own raised hand.
export function PresenceBadge({
  micOn,
  camOn,
  screenSharing,
  handRaised = false,
}: {
  micOn: boolean;
  camOn: boolean;
  screenSharing: boolean;
  /** This person has a hand raised: they are waiting to speak. */
  handRaised?: boolean;
}) {
  const chip =
    'flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm sm:h-7 sm:w-7';
  return (
    <div className="absolute right-2 top-2 flex gap-1 sm:right-3 sm:top-3 sm:gap-1.5">
      {/* First and in the accent colour: the one mark that asks the others for something. */}
      {handRaised && (
        <span
          role="img"
          aria-label="Hand raised"
          title="Hand raised"
          className="flex h-6 w-6 items-center justify-center rounded-full bg-[#8ab4f8] text-[#062e6f] sm:h-7 sm:w-7"
        >
          <Icon name="hand" size={16} />
        </span>
      )}
      {!micOn && (
        <span role="img" aria-label="Muted" className={chip} title="Muted">
          <Icon name="mic_off" size={16} />
        </span>
      )}
      {!camOn && (
        <span role="img" aria-label="Camera off" className={chip} title="Camera off">
          <Icon name="videocam_off" size={16} />
        </span>
      )}
      {screenSharing && (
        <span role="img" aria-label="Sharing screen" className={chip} title="Sharing screen">
          <Icon name="present" size={16} />
        </span>
      )}
    </div>
  );
}
