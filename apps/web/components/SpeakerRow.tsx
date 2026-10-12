'use client';

import { setSpeaker, speakersIn } from '@/lib/speaker';
import { useSpeakerId } from '@/hooks/use-speaker';

/**
 * The speaker choice as one row of the call's microphone menu. Nothing where the
 * browser names no output it can switch to.
 */
export function SpeakerRow({ devices }: { devices: readonly MediaDeviceInfo[] }) {
  const speaker = useSpeakerId();
  const speakers = speakersIn(devices);
  if (speakers.length === 0) return null;
  return (
    <label className="mb-1 flex items-center gap-2 border-b border-white/10 px-3 text-sm text-white">
      <span className="shrink-0 text-xs font-semibold uppercase tracking-wider text-white/70">
        Speaker
      </span>
      {/* No width of its own, so a long device name is cut short, not the menu made wider. */}
      <select
        aria-label="Speaker"
        value={speaker}
        onChange={(e) => setSpeaker(e.target.value)}
        className="min-h-11 w-0 flex-1 truncate rounded-lg bg-[#202124] text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]"
      >
        <option value="">System default</option>
        {speakers.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `Speaker ${i + 1}`}
          </option>
        ))}
      </select>
    </label>
  );
}
