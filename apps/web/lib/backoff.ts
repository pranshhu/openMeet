const BASE_MS = 1000;
const CAP_MS = 30_000;

// attempt is 0-based: attempt 0 -> 1000ms, attempt n -> min(1000 * 2^n, 30000)
export function nextBackoffMs(attempt: number): number {
  return Math.min(BASE_MS * 2 ** attempt, CAP_MS);
}
