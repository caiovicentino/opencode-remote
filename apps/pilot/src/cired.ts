/**
 * P2-334: a ci-red task whose checks are ALSO red on main was punished for a
 * shared defect (P3-415/P3-401/P3-378/P3-371 all landed in ## Blocked with the
 * same generic reason while main was the broken side). This module decides,
 * I/O-free, whether the third consecutive ci-red failure should still bury the
 * task or HOLD it for one more cycle so it can retry when main heals.
 *
 * Pure rules + detail parsing only: no network, no git, no fs, no timers —
 * unit tests import it directly (P2-327 lesson: decision logic lives in a
 * module free of side effects, with stable reason strings).
 */

/** The infra kind this hold path applies to (audit.ts InfraFailureKind "ci-red"
 * — duplicated as a plain string check so this module stays import-free:
 * pulling audit.ts in would drag node:fs into the unit battery, P3-400). */
export const CI_RED_KIND = "ci-red";

/** Check conclusions that mean "red" — mirrors the CHECK_RED set in
 * pipeline.ts mergeReadiness so the main probe built from this list and the
 * PR readiness verdict can never drift apart. */
export const CI_RED_CONCLUSIONS = [
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "ERROR",
] as const;

/**
 * Red check names carried in a mergeReadiness ci-red detail (pipeline.ts, the
 * two call sites):
 *   `CI red: ci-gate aggregate failed (verify=FAILURE, win=TIMED_OUT)` — the
 *   P3-405 aggregate form; the aggregate itself is already named by the
 *   sentence and is never a job, the parenthesized siblings are the red jobs.
 *   `CI red: verify=FAILURE, win=FAILURE` — the legacy per-job form.
 * Tolerant by design: non-string input, empty detail, a detail without names
 * (aggregate with no jobs) or unrelated text all return [] — callers then take
 * the conservative block path instead of guessing.
 */
export function redChecksFromDetail(detail: unknown): string[] {
  if (typeof detail !== "string") return [];
  const m = /CI red: ([^\n]*)/.exec(detail);
  if (!m || m[1] === undefined) return [];
  const rest = m[1].trim();
  let body = rest;
  if (rest.startsWith("ci-gate aggregate failed")) {
    const parens = /\(([^)]*)\)\s*$/.exec(rest);
    if (!parens || parens[1] === undefined) return []; // aggregate named no jobs — no names to compare
    body = parens[1];
  }
  const names: string[] = [];
  for (const seg of body.split(",")) {
    const i = seg.indexOf("=");
    if (i <= 0) continue; // no name part / empty segment
    const name = seg.slice(0, i).trim();
    if (name && name !== CI_RED_KIND) names.push(name); // the aggregate is never a job
  }
  return [...new Set(names)];
}

/** Verdict for the infra-starvation hard-failure path (index.ts). Rules are
 * normative in this order — the first matching one wins:
 *   1. kind other than ci-red is a real hard failure → block;
 *   2. either name list empty (unreadable evidence) → block, preserving the
 *      pre-P2-334 behavior exactly;
 *   3. no common red check between the task PR and main → the defect belongs
 *      to the task → block;
 *   4. the one shared-defect hold per task is already spent → block;
 *   5. only then: hold — main is red on the same check, retry next cycle. */
export function ciRedStarvationPlan(
  kind: string,
  streak: number,
  taskRed: readonly string[],
  mainRed: readonly string[],
  holdsUsed: number,
): { action: "block" | "hold"; reason: string } {
  if (kind !== CI_RED_KIND) {
    return {
      action: "block",
      reason: `infra "${kind}" failed ${streak}x in a row on this task — treated as a hard failure instead of an endless free retry`,
    };
  }
  if (!taskRed.length || !mainRed.length) {
    return {
      action: "block",
      reason: `ci-red failed ${streak}x in a row: ${!taskRed.length ? "task" : "main"} red check names not resolved — no shared-defect evidence, blocking`,
    };
  }
  const mainSet = new Set(mainRed);
  const common = taskRed.filter((n) => mainSet.has(n));
  if (!common.length) {
    return {
      action: "block",
      reason: `ci-red failed ${streak}x in a row: task red checks (${taskRed.join(", ")}) share no red check with main (${mainRed.join(", ")}) — the defect belongs to the task, blocking`,
    };
  }
  const names = common.join(", ");
  if (holdsUsed > 0) {
    return {
      action: "block",
      reason: `ci-red failed ${streak}x in a row: main is red on the same check(s) (${names}) but the shared-defect hold was already used — blocking`,
    };
  }
  return {
    action: "hold",
    reason: `ci-red failed ${streak}x in a row: main is red on the same check(s) (${names}) — task held out of ## Blocked; the next cycle retries when main heals`,
  };
}
