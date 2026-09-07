/**
 * P2-322: pure verifier for job-level workflow timeouts.
 *
 * The thirteen jobs of .github/workflows/ci.yml and
 * .github/workflows/release.yml used to declare no job-level
 * `timeout-minutes` at all — every timeout in the tree was a STEP timeout,
 * and GitHub's default for a job without one is 360 minutes. A hung
 * dependency install, a stuck image download or a wedged disk mount then
 * held a runner for six hours without aborting or reporting — exactly the
 * failure mode the P2-126, P2-164 and P2-245 step-timeout lessons taught us
 * to avoid, leaving the stage-5 release of docs/VISION.md dependent on a
 * pipeline that could go mute.
 *
 * The verdict lives here as pure logic: no file system access, no process
 * access, no network — the caller (scripts/check-job-timeouts.ts) reads the
 * real workflow files and injects the already-normalized job list, the same
 * hygiene as auditverdict.ts and alertrules.ts, so the unit battery can pin
 * every branch with synthetic fixtures and the real-repo assertion fails the
 * gate the moment a job loses its declaration.
 *
 * The rules below are applied IN THIS ORDER per job, with no short-circuit
 * across jobs — every cause is reported, one problem per line, in a fixed
 * order that is stable for the same input:
 *
 *   1. A job whose declaration is a failed read (file missing, unreadable
 *      or not shaped like a workflow) becomes its own fail-closed problem —
 *      a read failure must never become a silent approval.
 *   2. A job with no `timeout-minutes` declared at job level becomes the
 *      missing-timeout problem (GitHub would silently apply its
 *      360-minute default).
 *   3. A declared timeout that is not a positive whole number of minutes
 *      (zero, negative, fractional, non-numeric) becomes the
 *      not-a-positive-integer problem.
 *   4. A declared timeout above the documented JOB_TIMEOUT_CEILING_MINUTES
 *      becomes the above-the-ceiling problem — a ceiling far above every
 *      legitimate job but well below GitHub's default catches absurd values
 *      before they can quietly waste a runner-day.
 *
 * The result is deterministic: the same input produces the same problems in
 * the same order on every call, and no problem ever embeds a file path from
 * the input beyond the workflow label itself.
 */

/** The documented job-timeout ceiling in minutes (docs/security.md). */
export const JOB_TIMEOUT_CEILING_MINUTES = 120;

/**
 * The normalized job-level timeout declaration of one workflow job. The
 * collector produces it from the raw workflow text; `invalid` carries the
 * offending raw text bounded to a short single-line snippet.
 */
export type JobTimeoutDeclaration =
  | { kind: "absent" }
  | { kind: "invalid"; raw: string }
  | { kind: "minutes"; minutes: number }
  | { kind: "unreadable"; reason: string };

/** One normalized job handed over by the collector. */
export interface JobTimeoutFacts {
  /** Workflow label the job belongs to (the file name, e.g. "ci.yml"). */
  file: string;
  /** Job key as declared in the workflow. */
  job: string;
  /** The normalized job-level declaration. */
  timeout: JobTimeoutDeclaration;
}

/**
 * The problems for a whole normalized job list: one problem per cause,
 * applied in the rule order of the module header with no short-circuit, so
 * every offending job is reported in a single run. An empty (or absent) list
 * yields zero problems — the collector alone decides what a failed read
 * means, and it always hands over an explicit unreadable entry for one.
 */
export function jobTimeoutProblems(jobs: readonly JobTimeoutFacts[] | null | undefined): string[] {
  if (!Array.isArray(jobs) || jobs.length === 0) return [];
  const problems: string[] = [];
  for (const entry of jobs) {
    const where = `${entry.file}: job "${entry.job}"`;
    const timeout = entry.timeout;
    // Rule 1: a failed read fails closed with its own problem.
    if (timeout && timeout.kind === "unreadable") {
      problems.push(
        `job-timeouts: ${entry.file}: workflow missing, unreadable or not shaped like a workflow (${timeout.reason}) — fail closed instead of silently approving`,
      );
      continue;
    }
    // Rule 2: no declaration means GitHub's 360-minute default.
    if (!timeout || timeout.kind === "absent") {
      problems.push(
        `job-timeouts: ${where} declares no job-level timeout-minutes — a hung step would hold the runner for GitHub's 360-minute default; declare a whole number of minutes from 1 to ${JOB_TIMEOUT_CEILING_MINUTES}`,
      );
      continue;
    }
    // Rule 3: only a positive whole number of minutes is a valid declaration.
    if (timeout.kind === "invalid" || !Number.isInteger(timeout.minutes) || timeout.minutes < 1) {
      const raw = timeout.kind === "invalid" ? timeout.raw : String(timeout.minutes);
      problems.push(
        `job-timeouts: ${where} declares timeout-minutes "${raw.slice(0, 40)}", which is not a positive integer — declare a whole number of minutes from 1 to ${JOB_TIMEOUT_CEILING_MINUTES}`,
      );
      continue;
    }
    // Rule 4: above the documented ceiling.
    if (timeout.minutes > JOB_TIMEOUT_CEILING_MINUTES) {
      problems.push(
        `job-timeouts: ${where} declares timeout-minutes ${timeout.minutes}, above the documented ${JOB_TIMEOUT_CEILING_MINUTES}-minute ceiling — lower it so a hung job cannot hold the runner`,
      );
    }
  }
  return problems;
}
