/**
 * The seven-day cycle of the probe: a server whose host would get more requests a day than it allows is probed on
 * one day of seven, and so is every package server. No side effects, so the tests and both probes can import it.
 */

/** Which day of a seven-day cycle a server is probed on: a stable hash of its name (FNV-1a), 0 to 6. */
export function shardOf(name: string): number {
  let h = 2166136261;
  for (const c of name) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 7;
}

/** Today's day of the cycle: the UTC day of the year modulo 7, as the stdio workflow computes it from date +%j. */
export function todayShard(now = new Date()): number {
  const day = Math.floor((now.getTime() - Date.UTC(now.getUTCFullYear(), 0, 0)) / 86_400_000);
  return day % 7;
}
