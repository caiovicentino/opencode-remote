// P2-318: per-routine run history as the Settings screen renders it. Pure and
// dependency-free (same hygiene as recency.ts and sessionPreview.ts — no
// React, no fetch, no window, no clock reads) so scripts/unit.test.ts can
// exercise it directly. The raw history arrives exactly as the
// `GET /__ocr/routines` route delivers it and is parsed tolerantly here:
// a malformed record is discarded alone and never takes the routine's whole
// history down, mirroring the daemon-side contract in
// apps/daemon/src/routinehistory.ts (whose four-field privacy shape this
// module trusts but never assumes — every field is re-validated).
//
// Every label the UI shows is built here, from the i18n dictionary passed in
// as `t`: nothing user-visible is born hardcoded in JSX. The only imported
// helper is timeAgo (lib/time.ts) for the relative "when" column.

import { timeAgo } from "./time";

/** The closed outcome set — the same three words the daemon writes. An
 * unknown outcome makes the record malformed (dropped), never a new label. */
export type RoutineHistoryOutcome = "completed" | "failed" | "skipped";

export const ROUTINE_HISTORY_OUTCOMES: readonly RoutineHistoryOutcome[] = [
  "completed",
  "failed",
  "skipped",
];

/** Documented ceiling of rows the Settings screen shows per routine. The
 * daemon keeps up to 30 records for the facts; the screen is a glanceable
 * recap, not a table — the ten most recent runs answer "is it working?"
 * without a scroll trap. */
export const ROUTINE_HISTORY_VIEW_CAP = 10;

/** Minimal translate function — the `t` shape useT() hands to components. */
export type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

/** One render-ready history row: the validated facts plus the three labels
 * the screen shows (relative when, translated outcome, readable duration). */
export interface RoutineHistoryRow {
  /** Trigger start instant, verbatim from the record. */
  at: string;
  /** Parsed start instant (epoch ms) — sort key, injected into timeAgo. */
  atMs: number;
  /** Trigger duration in milliseconds (validated integer ≥ 0). */
  durationMs: number;
  /** Closed-set outcome. */
  outcome: RoutineHistoryOutcome;
  /** Relative time label ("5m", "2h", "now"), via lib/time.ts timeAgo. */
  whenLabel: string;
  /** Human duration ("0s", "12s", "1m 05s", "2h 05m"). */
  durationLabel: string;
  /** Outcome translated through the injected dictionary. */
  outcomeLabel: string;
}

const OUTCOME_KEYS: Record<RoutineHistoryOutcome, string> = {
  completed: "routineOutcomeCompleted",
  failed: "routineOutcomeFailed",
  skipped: "routineOutcomeSkipped",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Readable duration for a tight table column: "0s" for degenerate/absent
 * spans, then seconds, minutes and hours — always the two biggest units. */
export function formatDurationMs(ms: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return m > 0 ? `${h}h ${pad(m)}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${pad(s)}s` : `${m}m`;
  return `${s}s`;
}

/**
 * Parse the raw route payload into the render-ready row list: newest first
 * (stable sort on the parsed instant), capped at ROUTINE_HISTORY_VIEW_CAP,
 * with every malformed record discarded alone — a hostile or truncated entry
 * never throws and never drops its well-formed siblings. Absent, truncated,
 * non-array input yields [] (the caller renders the empty-state phrase).
 * Pure: the same input always yields the identical result.
 */
export function routineHistoryRows(
  history: unknown,
  now: number,
  t: TranslateFn,
): RoutineHistoryRow[] {
  if (!Array.isArray(history)) return [];
  const rows: RoutineHistoryRow[] = [];
  for (const entry of history) {
    if (!isRecord(entry)) continue;
    const at = typeof entry.at === "string" && entry.at !== "" ? entry.at : null;
    const atMs = at === null ? Number.NaN : Date.parse(at);
    const durationMs =
      typeof entry.durationMs === "number" &&
      Number.isInteger(entry.durationMs) &&
      entry.durationMs >= 0
        ? entry.durationMs
        : null;
    const outcome =
      typeof entry.outcome === "string" && (ROUTINE_HISTORY_OUTCOMES as readonly string[]).includes(entry.outcome)
        ? (entry.outcome as RoutineHistoryOutcome)
        : null;
    if (at === null || !Number.isFinite(atMs) || durationMs === null || outcome === null) continue;
    rows.push({
      at,
      atMs,
      durationMs,
      outcome,
      whenLabel: timeAgo(atMs, t("routineHistoryJustNow"), now),
      durationLabel: formatDurationMs(durationMs),
      outcomeLabel: t(OUTCOME_KEYS[outcome]),
    });
  }
  rows.sort((a, b) => b.atMs - a.atMs);
  return rows.length > ROUTINE_HISTORY_VIEW_CAP ? rows.slice(0, ROUTINE_HISTORY_VIEW_CAP) : rows;
}
