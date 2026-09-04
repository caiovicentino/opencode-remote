import { nowLocalISO } from "./log";
import { notifySupervisor } from "./notify";
import { emit } from "./events";

/**
 * P2-115: repeated-guard-rejection alerts. Fail-closed guards over LLM output
 * (`validateSpec`, `verifyFindings`) used to reject the same task round after
 * round with the reason buried in pilot.log — P1-073/P1-102/P1-103 each burned
 * their full attempt budget on one opaque `no valid spec`. Every rejection
 * folds into an in-memory per-(task, guard) counter (same model as P2-114's
 * tier-B spawn streak); from the Nth consecutive rejection the guard raises an
 * `alert` event + supervisor notify carrying the actual reason.
 */
export type GuardName = "validateSpec" | "verifyFindings";

/** Alert on the 2nd consecutive rejection of the same (task, guard) pair. */
export const GUARD_ALERT_THRESHOLD = 2;

/** Reasons carry LLM text (finding bodies) — bound them so the 220-char
 * `emit` cap never truncates the informative prefix. */
const REASON_CAP = 160;

/** In-memory consecutive-rejection counter keyed by `<task>|<guard>` — no
 * persistence by design (a restart resets, same as the tier-B streak);
 * different attempts of the same task in one process DO count. */
const counts = new Map<string, number>();

function key(task: string, guard: GuardName): string {
  return `${task}|${guard}`;
}

/** Fold one rejection in and classify: `alert` from the threshold on. */
export function noteGuardRejection(task: string, guard: GuardName, _reason: string): { count: number; alert: boolean } {
  const k = key(task, guard);
  const count = (counts.get(k) ?? 0) + 1;
  counts.set(k, count);
  return { count, alert: count >= GUARD_ALERT_THRESHOLD };
}

/** A pass of the same guard clears its streak; without `guard` the whole task. */
export function clearGuardRejections(task: string, guard?: GuardName): void {
  if (guard) {
    counts.delete(key(task, guard));
    return;
  }
  const prefix = `${task}|`;
  for (const k of [...counts.keys()]) if (k.startsWith(prefix)) counts.delete(k);
}

/** Test seam: reset every counter between hermetic checks. */
export function resetGuardAlerts(): void {
  counts.clear();
}

/** Single-line, bounded alert text shared by the event feed and the notify. */
export function guardAlertDetail(guard: GuardName, count: number, reason: string): string {
  const r = reason.replace(/\s+/g, " ").trim().slice(0, REASON_CAP);
  return `${guard} rejected ${count}x in a row: ${r}`;
}

/**
 * Fold one rejection in and, from the threshold on, surface it: error JSONL
 * line, `alert` event (phase = guard name) and a supervisor notify. The hooks
 * are injectable for tests; defaults never throw into the pipeline.
 */
export function raiseGuardAlert(
  task: string,
  guard: GuardName,
  reason: string,
  hooks?: { emitEvent?: typeof emit; notify?: typeof notifySupervisor },
): { count: number; alert: boolean } {
  const note = noteGuardRejection(task, guard, reason);
  if (!note.alert) return note;
  const detail = guardAlertDetail(guard, note.count, reason);
  console.log(
    JSON.stringify({
      ts: nowLocalISO(),
      level: "error",
      msg: "guard-repeat",
      data: { task, guard, count: note.count, reason: detail },
    }),
  );
  const emitEvent = hooks?.emitEvent ?? emit;
  const notify = hooks?.notify ?? notifySupervisor;
  try {
    emitEvent("alert", { task, phase: guard, ok: false, detail });
  } catch {}
  try {
    void Promise.resolve(notify(task, false, detail)).catch(() => {});
  } catch {}
  return note;
}
