// P3-084: temporal grouping of the conversation list (Hoje/Ontem/Anteriores),
// per docs/PRODUCT.md's Claude-Desktop benchmark. Pure and dependency-free so
// scripts/unit.test.ts can exercise it directly.
//
// Boundaries are LOCAL CALENDAR MIDNIGHTS, never fixed offsets: a day that
// starts/ends under a DST transition has 23 or 25 hours, so `now - 86_400_000`
// drifts an hour off the wall clock and misfiles sessions twice a year.

export type RecencyGroup = "today" | "yesterday" | "earlier";

/** Calendar Y/M/D key of a local date — equal keys ⇒ same local day. */
function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Start of the local day `d` belongs to (DST-safe: built from fields). */
export function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Which recency bucket a timestamp falls into, relative to `now`.
 * Unknown/garbage timestamps (0, NaN) land in "earlier" — they can never be
 * proven recent, and the list is sorted newest-first upstream.
 */
export function recencyGroup(ts: number, now = Date.now()): RecencyGroup {
  if (!Number.isFinite(ts) || ts <= 0) return "earlier";
  const day = localDayKey(new Date(ts));
  if (day === localDayKey(new Date(now))) return "today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1); // calendar step, not -24h
  if (day === localDayKey(yesterday)) return "yesterday";
  return "earlier";
}

/**
 * Bucket pre-sorted sessions into the three recency groups, preserving the
 * input order inside each bucket. Unknown timestamps stay in "earlier".
 */
export function groupByRecency<T>(
  sessionTs: (s: T) => number,
  sessions: T[],
  now = Date.now(),
): { today: T[]; yesterday: T[]; earlier: T[] } {
  const out = { today: [] as T[], yesterday: [] as T[], earlier: [] as T[] };
  for (const s of sessions) out[recencyGroup(sessionTs(s), now)].push(s);
  return out;
}
