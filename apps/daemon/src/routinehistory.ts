/**
 * P2-316: per-routine execution history. Pure module — zero imports (no
 * node:fs, no node:path/os, no child process, no http, no network, no clock
 * reads), the same hygiene as routinedue.ts / routinelease.ts / routinesfile.ts
 * (lessons P2-149 and P2-228): index.ts runs main() on import, so any unit
 * test importing impure code would boot a whole daemon. Every input is
 * injected; the caller owns all I/O and all timestamp reads.
 *
 * Why this exists: the daemon persisted only the day mark of the last fire
 * (lastRun) and threw everything else away, so a routine failing every day
 * for a week left no trace anywhere — nobody could tell whether it ran, how
 * long a trigger took or when it last failed. This module owns the history
 * shape and the two operations on it (normalize, append) and nothing else;
 * the sweep (index.ts) decides when a record is due and persists the history
 * as a routine field through the SAME routines.json file, the same atomic
 * 0600 write and no new file.
 *
 * PRIVACY CONTRACT (pinned by test — this is the reason the record type has
 * exactly the fields below and nothing else):
 *   - a record NEVER carries the routine prompt text or any fragment of it;
 *   - a record NEVER carries an agent reply, an error message or any other
 *     free text (a failure is the single word "failed");
 *   - a record NEVER carries an absolute path, a URL scheme or a secret;
 *   - a record NEVER carries user data of any other kind.
 * The only fields are: the trigger start instant (ISO), the trigger duration
 * in milliseconds, the outcome from the closed set below, and the identifier
 * of the session created for the run when there is one. normalize() rebuilds
 * every record field by field precisely so unknown/hostile fields (prompt,
 * output, path, …) are dropped on the floor instead of riding along, and
 * recordRoutineTrigger() only accepts the typed facts above, so prompt text
 * has no way into a record through this module.
 *
 * CAP CONTRACT (same form as the staged-ids ceiling of chunkstore.ts): the
 * history holds at most ROUTINE_HISTORY_CAP records per routine, always the
 * NEWEST ones — appending never refuses the new record; the oldest is
 * discarded to make room (strictly-below admission, exactly-at-the-cap still
 * fits by dropping the oldest), so the array can never grow without bound.
 * The cap is applied on every append and on every load-side normalization.
 *
 * ORDER CONTRACT: a resulting history is always newest first, ordered by the
 * parsed start instant (a stable sort, so equal instants keep their relative
 * order). The same input always yields the identical result — the functions
 * are pure, never mutate their arguments and never read the clock.
 */

/** Documented ceiling of records kept per routine. Thirty daily triggers are
 * a full month of history; interval routines rotate through the same newest-
 * first window. */
export const ROUTINE_HISTORY_CAP = 30;

/** The closed outcome set: the trigger ran to completion, the trigger failed
 * (fire failure or run failure), or the scheduled run was skipped for the
 * day (the sweep closed the day without a fire). */
export type RoutineHistoryOutcome = "completed" | "failed" | "skipped";

export const ROUTINE_HISTORY_OUTCOMES: readonly RoutineHistoryOutcome[] = [
  "completed",
  "failed",
  "skipped",
];

/** One trigger of one routine. The four-field privacy contract above is the
 * whole record — no fifth field ever ships. */
export interface RoutineHistoryRecord {
  /** Trigger start instant in ISO form (the module writes toISOString). */
  at: string;
  /** Trigger duration in milliseconds (never negative; 0 when instant). */
  durationMs: number;
  /** Closed-set outcome — never an error text, never a reply fragment. */
  outcome: RoutineHistoryOutcome;
  /** The session created for the run, when there is one. */
  sessionId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOutcome(value: unknown): RoutineHistoryOutcome | null {
  return typeof value === "string" && (ROUTINE_HISTORY_OUTCOMES as readonly string[]).includes(value)
    ? (value as RoutineHistoryOutcome)
    : null;
}

function parseInstant(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function parseDuration(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * Validate one record and rebuild it field by field. Returns null for a
 * malformed record; a well-formed one comes back with ONLY the four
 * documented fields, so extra fields (prompt, output, path, …) never survive
 * a round trip through this module.
 */
export function isRoutineHistoryRecord(value: unknown): RoutineHistoryRecord | null {
  if (!isRecord(value)) return null;
  const at = parseInstant(value.at);
  const durationMs = parseDuration(value.durationMs);
  const outcome = parseOutcome(value.outcome);
  if (at === null || durationMs === null || outcome === null) return null;
  const sessionId = typeof value.sessionId === "string" && value.sessionId !== "" ? value.sessionId : undefined;
  const record: RoutineHistoryRecord = sessionId === undefined ? { at, durationMs, outcome } : { at, durationMs, outcome, sessionId };
  return record;
}

function instantOf(record: RoutineHistoryRecord): number {
  return Date.parse(record.at);
}

/**
 * Normalize a stored history into the documented shape: only well-formed
 * records survive (each one rebuilt field by field — malformed entries are
 * discarded alone, never the whole history), the array is ordered newest
 * first and capped at ROUTINE_HISTORY_CAP. Missing, truncated, non-array or
 * hostile input yields an empty history — never a throw, never an invention.
 */
export function normalizeRoutineHistory(value: unknown): RoutineHistoryRecord[] {
  if (!Array.isArray(value)) return [];
  const records: RoutineHistoryRecord[] = [];
  for (const entry of value) {
    const record = isRoutineHistoryRecord(entry);
    if (record) records.push(record);
  }
  records.sort((a, b) => instantOf(b) - instantOf(a));
  return records.length > ROUTINE_HISTORY_CAP ? records.slice(0, ROUTINE_HISTORY_CAP) : records;
}

/**
 * Append one new record to a routine's history and answer the resulting
 * history: newest first, capped, with the oldest record discarded when the
 * cap is reached (chunkstore staged-ids form — see the cap contract). The
 * current history is tolerated in any shape (absent, truncated, malformed —
 * only its valid records survive, normalized); the new record is validated
 * with the same rule, and an invalid one is refused without touching the
 * surviving history. Pure: neither argument is mutated and the same input
 * always yields the identical result.
 */
export function appendRoutineHistory(
  history: unknown,
  record: RoutineHistoryRecord,
): RoutineHistoryRecord[] {
  const current = normalizeRoutineHistory(history);
  const valid = isRoutineHistoryRecord(record);
  if (!valid) return current;
  return normalizeRoutineHistory([...current, valid]);
}

/** The typed facts of one trigger, as observed by the sweep. No free text
 * exists on this shape — that is the privacy gate. */
export interface RoutineTriggerFacts {
  outcome: RoutineHistoryOutcome;
  /** Epoch ms the trigger started (fire time; the run start when the record
   * documents a resolved run). */
  startedAtMs: number;
  /** Epoch ms the trigger resolved (completion, failure or the sweep instant
   * for a skipped day). */
  endedAtMs: number;
  /** The session created for the run, when there is one. */
  sessionId?: string;
}

/**
 * Build the one record a trigger deserves, or null when the facts do not
 * describe a trigger (unknown outcome, non-finite instants). This is the
 * only constructor of records: it takes no prompt, no reply, no path and no
 * other free text, so nothing outside the four documented fields can reach
 * the history through it. A negative duration (clock moved backward mid-run)
 * clamps to 0 instead of going negative or inventing a refill.
 */
export function recordRoutineTrigger(facts: RoutineTriggerFacts | null | undefined): RoutineHistoryRecord | null {
  if (!isRecord(facts)) return null;
  const outcome = parseOutcome(facts.outcome);
  if (!outcome) return null;
  const startedAtMs = facts.startedAtMs;
  const endedAtMs = facts.endedAtMs;
  if (typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs)) return null;
  if (typeof endedAtMs !== "number" || !Number.isFinite(endedAtMs)) return null;
  const durationMs = Math.max(0, Math.floor(endedAtMs - startedAtMs));
  const sessionId =
    typeof facts.sessionId === "string" && facts.sessionId !== "" ? facts.sessionId : undefined;
  return isRoutineHistoryRecord({
    at: new Date(startedAtMs).toISOString(),
    durationMs,
    outcome,
    sessionId,
  });
}
