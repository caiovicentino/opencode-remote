/**
 * P2-286: routine due verdict. Pure decision module — zero imports (no fs,
 * no child process, no http, no network calls, no clock reads), the same
 * hygiene as routinelease.ts / routinesfile.ts (lessons P2-149 and P2-228):
 * index.ts runs main() on import, so any unit test importing impure code
 * would boot a whole daemon. Every input is injected; `nowMs` is epoch
 * milliseconds and the local calendar facts (day key, weekday, wall-clock
 * minutes) are derived from it with plain Date accessors.
 *
 * Why this exists: the sweep used to fire any daily/days routine whose time
 * had already passed on the current local day, with no ceiling — a routine
 * created at 15:00 for 07:00 fired 30 seconds later, a machine turned on at
 * 23:00 ran its morning routine at 23:00, and a failed fire cleared the day
 * mark forever so the same routine retried every sweep until midnight,
 * silently spending agent sessions. This module owns the whole fire decision
 * and answers with exactly one of four documented plans plus a short static
 * reason label.
 *
 * RULE-ORDER CONTRACT (the unit-test gate depends on this exact order):
 * 1. missing input, a non-object routine, a non-integer hour or minute (or
 *    one outside the possible 0..23 / 0..59 range), a non-finite now or a
 *    delay window that is not a finite non-negative number → refuse and
 *    NEVER fire — fail-closed, because firing on doubt spends an agent
 *    session and writes into the owner's conversation;
 * 2. the routine is already fulfilled on the current local day (its mark
 *    equals today) → wait;
 * 3. weekday mode with today's weekday outside the day list → wait;
 * 4. now is before the scheduled time → wait;
 * 5. now is past the scheduled time beyond the documented delay window →
 *    close the day WITHOUT firing — a morning routine running at midnight is
 *    worse than a morning routine not running;
 * 6. the day's fire-attempt count has reached the documented ceiling → close
 *    the day (bounded retries instead of clearing the mark forever);
 * 7. only what remains → fire.
 *
 * Properties beyond the order, both pinned by tests: a clock moved backward
 * can never make the same routine fire twice on the same local day (rule 2
 * keys on the local day string, so rewinding inside the day still answers
 * wait), and the same input always yields the identical verdict — the
 * function is pure, with no state and no clock reads.
 *
 * Interval mode is intentionally out of scope (P2-286): its pacing already
 * starts from its own marker at fire time, so it never reaches this module;
 * should it ever be passed in, the answer is wait, never fire.
 *
 * Every reason label is a short static string — no path, no address, no
 * port, no secret — and the only sentence meant for the routine record
 * (ROUTINE_DUE_EXHAUSTED_MESSAGE) is a fixed pt-BR phrase, safe for the log.
 */

/** Documented delay window in minutes: how late a routine may still fire on
 * the day it was scheduled. 30 minutes absorbs sweep jitter (the sweep runs
 * every 30 s) and a short sleep/wake, while a machine booted hours late
 * stays silent — one missed run beats a badly late one. */
export const ROUTINE_DUE_DELAY_WINDOW_MIN = 30;

/** Documented ceiling of fire attempts per routine per local day. After the
 * ceiling the day is closed with the error state instead of retrying every
 * sweep until midnight. */
export const ROUTINE_DUE_MAX_ATTEMPTS = 3;

/** The short static pt-BR phrase recorded on the routine (its existing
 * lastError field) when the day is closed at the attempt ceiling. Static,
 * content-free: no path, no address, no port, no secret. */
export const ROUTINE_DUE_EXHAUSTED_MESSAGE =
  "A rotina falhou várias vezes hoje e o dia foi encerrado; ela volta a rodar no próximo horário programado.";

export type RoutineDuePlan = "fire" | "wait" | "close-day" | "refuse";

export type RoutineDueReason =
  | "invalid-input"
  | "interval-mode"
  | "already-done"
  | "day-not-scheduled"
  | "before-time"
  | "past-window"
  | "attempts-exhausted"
  | "due";

export interface RoutineDueVerdict {
  plan: RoutineDuePlan;
  /** Short static label for the log — never carries content. */
  reason: RoutineDueReason;
}

/** The routine facts the decision needs, already normalized by the caller:
 * schedule (hour/minute), mode, weekday list for "days" mode, the last
 * fulfilled local day mark and the day's fire-attempt count. */
export interface RoutineDueFacts {
  hour: number;
  minute: number;
  mode?: "daily" | "days" | "interval";
  days?: number[];
  lastRun?: string;
  attemptsToday?: number;
}

const refuse = (): RoutineDueVerdict => ({ plan: "refuse", reason: "invalid-input" });

function localDayKey(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Decide whether a daily/days routine is due. Pure: the same input always
 * yields the same verdict, and the only calendar facts used are derived from
 * the injected `nowMs` in the machine's local time — the same local-day
 * semantics as the `lastRun` mark the sweep writes.
 */
export function routineDue(
  nowMs: number,
  routine: RoutineDueFacts | null | undefined,
  delayWindowMin: number,
): RoutineDueVerdict {
  // Rule 1 — fail-closed input validation; refuse can never become fire.
  if (!Number.isFinite(nowMs)) return refuse();
  if (typeof routine !== "object" || routine === null || Array.isArray(routine)) return refuse();
  const facts = routine as Record<string, unknown>;
  const hour = facts.hour;
  const minute = facts.minute;
  if (typeof hour !== "number" || !Number.isInteger(hour) || hour < 0 || hour > 23) return refuse();
  if (typeof minute !== "number" || !Number.isInteger(minute) || minute < 0 || minute > 59)
    return refuse();
  if (!Number.isFinite(delayWindowMin) || delayWindowMin < 0) return refuse();
  const mode = facts.mode ?? "daily";
  if (mode === "interval") return { plan: "wait", reason: "interval-mode" };
  if (mode !== "daily" && mode !== "days") return refuse();

  const now = new Date(nowMs);
  const today = localDayKey(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const scheduledMin = hour * 60 + minute;

  // Rule 2 — already fulfilled on the current local day (also the property
  // that keeps a backward-moved clock from firing the same day twice).
  if (facts.lastRun === today) return { plan: "wait", reason: "already-done" };
  // Rule 3 — weekday mode, today not scheduled.
  if (mode === "days") {
    const days = Array.isArray(facts.days) ? facts.days : [];
    if (!days.includes(now.getDay())) return { plan: "wait", reason: "day-not-scheduled" };
  }
  // Rule 4 — before the scheduled time.
  if (nowMin < scheduledMin) return { plan: "wait", reason: "before-time" };
  // Rule 5 — beyond the documented delay window: the day closes, silently.
  if (nowMin - scheduledMin > delayWindowMin) return { plan: "close-day", reason: "past-window" };
  // Rule 6 — the day's retry ceiling is exhausted.
  const attempts = Number.isFinite(facts.attemptsToday as number)
    ? Math.max(0, Math.floor(facts.attemptsToday as number))
    : 0;
  if (attempts >= ROUTINE_DUE_MAX_ATTEMPTS) {
    return { plan: "close-day", reason: "attempts-exhausted" };
  }
  // Rule 7 — only what remains fires. Exactly at the window edge still fires.
  return { plan: "fire", reason: "due" };
}
