'use client';

/**
 * A fader for each other person: how loud this tab plays them. The value ends
 * up as the volume of that person's <video> elements and nowhere else, so
 * what the others hear and every recording stay as they were.
 */
export function LevelsPanel({
  peers,
  volumes,
  onVolume,
}: {
  /** The people who have a tile, in tile order. */
  peers: { peerId: string; name: string | null }[];
  /** 0 to 1 by peerId. A person who is not in it plays at 1. */
  volumes: ReadonlyMap<string, number>;
  onVolume: (peerId: string, volume: number) => void;
}) {
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
          {peers.map((p) => {
            const name = p.name ?? 'Guest';
            const percent = Math.round((volumes.get(p.peerId) ?? 1) * 100);
            return (
              <li key={p.peerId} className="flex items-center gap-3">
                <span title={name} className="min-w-0 flex-1 truncate text-sm">
                  {name}
                </span>
                {/* h-11: 44px to drag on a phone. */}
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={percent}
                  onChange={(e) => onVolume(p.peerId, Number(e.target.value) / 100)}
                  aria-label={`Volume for ${name}`}
                  className="h-11 w-32 shrink-0 accent-[#8ab4f8] sm:w-40"
                />
                <span className="w-10 shrink-0 text-right text-xs tabular-nums text-white/70">{percent}%</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
