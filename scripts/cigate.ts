/**
 * P3-352 (eval r4): pure verdict of the `ci-gate` aggregate job.
 *
 * Every pilot merge of 2026-09-08 landed 4-5s after `gh pr create`, before the
 * first check of its own run had started (PR #891: merged 21:57:07Z, first
 * check 21:57:08Z); three of the four turned a check red AFTER landing
 * (#879 verify + verify-win, #884 and #891 desktop-package-win). Two things
 * made that possible: the branch protection of main requires no status check
 * at all (`required_status_checks.contexts: []`), and "green" had to be
 * reconstructed from six per-job contexts, four of them scope-gated — absent
 * or SKIPPED on most PRs — so neither GitHub nor the pilot had one stable
 * name to wait for. `ci-gate` is that name: the last job of ci.yml, it always
 * runs, `needs` every other job and turns their results into one verdict
 * through this module.
 *
 * Pure: no file system, no process, no network. The collector
 * (scripts/check-ci-gate.ts) reads `toJSON(needs)` from the job and injects
 * it here; the unit battery pins every branch with synthetic fixtures and the
 * real-workflow assertions (scripts/workflow-yaml.test.ts) prove ci.yml wires
 * the job exactly as this spec expects.
 *
 * Rules, applied per expected job IN THIS ORDER with no short-circuit — every
 * cause is reported, one line per job, stable for the same input:
 *
 *   1. A job of the spec missing from `needs`, or carrying a non-string
 *      result, is RED (a graph edit that drops an edge must never approve).
 *   2. An unconditional job (no `if:` — verify, scope) is green only on
 *      `success`; `skipped` there means the run was cancelled or the graph
 *      broke, so it is RED like failure/cancelled/timed_out.
 *   3. A scope-gated job is green on `success` OR `skipped` — skipped is the
 *      scope job's own decision that the diff cannot affect that surface;
 *      any other result is RED.
 *   4. A job present in `needs` but absent from the spec is reported as a
 *      warning line and never decides the verdict (a new job must be added
 *      to the spec deliberately).
 *
 * The verdict is `green` only when every spec job produced a green line.
 * Unreadable input (not an object, null, array) is RED with a single line —
 * a failed read is never an approval.
 */

/** Result strings GitHub exposes in the `needs.<job>.result` context. */
export type NeedResult = "success" | "failure" | "cancelled" | "skipped";

/** One job the gate expects to find in `needs`. */
export interface CiGateJob {
  /** Job key as declared in the workflow. */
  name: string;
  /** true when the job carries an `if:` on the scope outputs — skipped passes. */
  scopeGated: boolean;
  /** P3-348: advisory while a known flake is open — a failure here warns
   * instead of gating the verdict, until this ISO date (inclusive). Rot-proof:
   * an expired advisory falls back to the hard gate (fail-closed). */
  advisoryUntil?: string;
}

/** The ci.yml graph as of P3-352 — the real-workflow assertion pins it. */
export const CI_GATE_SPEC: readonly CiGateJob[] = [
  { name: "verify", scopeGated: false },
  { name: "scope", scopeGated: false },
  { name: "desktop-package", scopeGated: true },
  // P3-348: the Windows smoke boot hangs the runner (~11min, then the job
  // timeout) with no repo-side signal — 5+ merges blocked on it in one day
  // while every repo-level check stayed green. Advisory until the flake is
  // fixed; the job keeps running and its failure stays visible in the log.
  { name: "desktop-package-win", scopeGated: true, advisoryUntil: "2026-10-01" },
  { name: "verify-win", scopeGated: true },
  { name: "relay-image", scopeGated: true },
];

/** The aggregate job's own key in ci.yml — the context to require on main. */
export const CI_GATE_JOB = "ci-gate";

export interface CiGateVerdict {
  verdict: "green" | "red";
  /** One line per spec job (plus one per unexpected job), stable order. */
  lines: string[];
}

/**
 * Decide the aggregate verdict from the raw `toJSON(needs)` value: an object
 * keyed by job name whose values carry `result` (and `outputs`, ignored).
 */
export function ciGateVerdict(needs: unknown, spec: readonly CiGateJob[] = CI_GATE_SPEC, now = new Date()): CiGateVerdict {
  if (!needs || typeof needs !== "object" || Array.isArray(needs)) {
    return { verdict: "red", lines: ["ci-gate: RED — needs context unreadable (not an object)"] };
  }
  const map = needs as Record<string, unknown>;
  const lines: string[] = [];
  let red = false;
  for (const job of spec) {
    const entry = map[job.name];
    const result = entry && typeof entry === "object" ? (entry as { result?: unknown }).result : undefined;
    if (typeof result !== "string" || result.length === 0) {
      lines.push(`ci-gate: RED ${job.name} — missing from needs (graph edge dropped?)`);
      red = true;
      continue;
    }
    const green = result === "success" || (job.scopeGated && result === "skipped");
    if (green) {
      lines.push(`ci-gate: ok ${job.name}=${result}${result === "skipped" ? " (scope-gated, skipped by the scope job)" : ""}`);
    } else if (job.advisoryUntil && new Date(`${job.advisoryUntil}T23:59:59Z`) >= now) {
      // P3-348: advisory failure — loud, but it does not gate the verdict.
      lines.push(`ci-gate: WARN ${job.name}=${result} — advisory until ${job.advisoryUntil} (known flake, does not gate)`);
    } else {
      lines.push(`ci-gate: RED ${job.name}=${result}${!job.scopeGated && result === "skipped" ? " (unconditional job skipped — cancelled run or broken graph)" : ""}`);
      red = true;
    }
  }
  const known = new Set(spec.map((j) => j.name));
  for (const name of Object.keys(map).sort()) {
    if (!known.has(name)) lines.push(`ci-gate: WARN ${name} is in needs but not in the gate spec — add it to CI_GATE_SPEC deliberately`);
  }
  return { verdict: red ? "red" : "green", lines };
}
