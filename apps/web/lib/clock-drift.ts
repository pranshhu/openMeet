/**
 * The sync file's `clock` section: how the difference between a guest's
 * computer clock and the host's was measured, and whether it held to the end
 * of the take.
 */

/** One clock-sync report as the host holds it. */
export interface ClockReading {
  /** The guest's recorder start on the host clock, by this estimate. */
  startHostMs: number;
  /** Round trip of the exchange behind the estimate. */
  rttMs: number;
  /** When the host accepted the report, on the host clock. */
  atMs: number;
}

/** What the section reads of one guest. `GuestSyncInput` carries all of it. */
export interface ClockGuest {
  slot: number;
  name?: string | undefined;
  file: string;
  startHostMs: number | null;
  rttMs: number | null;
  clockAtMs?: number | null | undefined;
  clockEnd?: ClockReading | undefined;
}

/**
 * What one estimate can be off by on top of half its round trip: both clocks
 * are read in whole milliseconds (under 1 ms on the offset, 0.5 ms through the
 * round trip measured from them) and the reported start is rounded (0.5 ms).
 */
const STEP_MS = 2;

const NOTE =
  "Each guest's browser estimates the difference between its computer's clock and the host's by timing a short exchange with the host, and reports its recording start on the host's clock. start is the first estimate the host accepted; every offset for that guest in this file comes from it. end is a later estimate of the same start, which a guest's browser takes as its recording stops. In both, offsetMs is the guest's recording start minus the host's by that estimate; rttMs is the round trip of the exchange, and the estimate can be wrong by up to half of it plus 2 ms (null when no round trip was reported); measuredAtMs is when the host accepted the estimate, counted from the host's recording start (null when that time was not kept). movedMs is end.offsetMs minus start.offsetMs: how far the two clocks moved against each other during spanMs, the time between the two estimates. A positive movedMs means the guest's clock ran slower than the host's. errorMs is the most movedMs can be wrong by: half the sum of the two round trips plus 4 ms. A movedMs no larger than errorMs shows no movement. A guest with no end had no second estimate, and a guest that is not listed had none: its offset is null. These are the computers' system clocks, so a clock that is set during the take shows as a large movedMs. This is not a measurement of how the audio or video inside a file keeps time: two files can still drift apart on a timeline when movedMs is 0.";

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The section, or null when no guest has an estimate: nothing is written about a clock nobody measured. */
export function clockSection(hostStartMs: number, guests: readonly ClockGuest[]) {
  const listed = guests.flatMap((g) => {
    const first = g.startHostMs;
    if (!num(first)) return [];
    const at = num(g.clockAtMs) ? g.clockAtMs : null;
    const rtt = num(g.rttMs) && g.rttMs >= 0 ? g.rttMs : null;
    const start = {
      offsetMs: Math.round(first - hostStartMs),
      rttMs: rtt,
      measuredAtMs: at === null ? null : Math.round(at - hostStartMs),
    };
    const e = g.clockEnd;
    // Movement is two estimates apart in time, each with its round trip. Short
    // of that there is no figure with an error to state, so none is written.
    let moved = {};
    if (
      e &&
      at !== null &&
      rtt !== null &&
      num(e.startHostMs) &&
      num(e.rttMs) &&
      e.rttMs >= 0 &&
      num(e.atMs) &&
      e.atMs >= at
    ) {
      const end = {
        offsetMs: Math.round(e.startHostMs - hostStartMs),
        rttMs: e.rttMs,
        measuredAtMs: Math.round(e.atMs - hostStartMs),
      };
      moved = {
        end,
        movedMs: end.offsetMs - start.offsetMs,
        errorMs: Math.ceil((rtt + e.rttMs) / 2) + 2 * STEP_MS,
        spanMs: Math.round(e.atMs - at),
      };
    }
    return [{ slot: g.slot, ...(g.name ? { name: g.name } : {}), file: g.file, start, ...moved }];
  });
  return listed.length > 0 ? { note: NOTE, guests: listed } : null;
}
