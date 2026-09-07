/**
 * P2-271: pure verdict module for the workflow permissions gate.
 *
 * Until now every CI job executed branch-influenced code with whatever token
 * permissions the repository default grants — no workflow file ever declared
 * what each job may do, so the pipeline's real power was invisible in the
 * repository and could change without any PR (stage 5 of docs/VISION.md
 * depends on only the release touching published content, signed packages
 * and the image registry). The verdict lives here, as pure logic: no file
 * system access, no process spawning, no network — the caller
 * (scripts/check-workflow-perms.ts) reads the real workflows, normalizes the
 * jobs by indentation and injects them already normalized, the same hygiene
 * as auditverdict.ts, ci-scope.ts and portablecoverage.ts, so the unit
 * battery can pin every branch with synthetic fixtures.
 *
 * The rules below are applied IN THIS ORDER; the first rule that matches
 * decides, and the final outcome is the worst line seen:
 *
 * 1. An absent input, an empty job list, or a job whose workflow file is
 *    marked as a failed read becomes WARN — never approve. Checking zero
 *    jobs is exactly the same as having no gate, and a renamed workflow file
 *    must never turn into a silent approval.
 * 2. A job whose effective declaration includes the broad write permission
 *    (`write-all`, every scope writable) becomes REJECT before any other
 *    consideration — this is the case the gate exists to prevent, and no
 *    allowlist entry can ever legitimize it.
 * 3. A job with no declaration of its own and nothing inherited from the
 *    top of its file becomes REJECT: the repository default lives in no
 *    reviewed file and changes without any PR.
 * 4. A declaration present only at the top of the file counts as declared,
 *    and the report marks it as inherited.
 * 5. A declared scope outside the documented allowlist for that job becomes
 *    REJECT (scripts/workflow-scopes.json).
 * 6. Only the remainder becomes APPROVE.
 *
 * The result is identical for the same input in two calls, with stable
 * ordering by workflow file and job name.
 */

/** The three possible gate outcomes, worst last. */
export type WorkflowPermOutcome = "approve" | "warn" | "reject";

/** The GitHub broad-write declaration: every scope writable at once. */
export const BROAD_WRITE_SCOPE = "write-all";

export interface WorkflowJobPerms {
  /** Workflow file the job belongs to (e.g. "ci.yml"). */
  file: string;
  /** Job id as declared under `jobs:` (e.g. "verify"). */
  job: string;
  /** Scopes declared in the job's own permissions block ("contents:read"). */
  jobScopes: readonly string[];
  /** Scopes declared in the top-level permissions block of the same file. */
  fileScopes: readonly string[];
  /** True when the workflow file could not be read or parsed. */
  readFailed?: boolean;
}

/** Documented allowlist: "file/job" → scopes that job may declare. */
export type WorkflowScopeAllowlist = Readonly<Record<string, readonly string[]>>;

export interface WorkflowPermsReport {
  outcome: WorkflowPermOutcome;
  /** Static report lines in deterministic order (file, then job name). */
  lines: string[];
}

/** True only for inputs that are absent or carry no job at all. */
function isMissing(jobs: readonly WorkflowJobPerms[] | null | undefined): boolean {
  return jobs === null || jobs === undefined || !Array.isArray(jobs) || jobs.length === 0;
}

/** Effective scopes of a job: its own block wins; otherwise it inherits. */
function effectiveScopes(entry: WorkflowJobPerms): readonly string[] {
  return entry.jobScopes.length > 0 ? entry.jobScopes : entry.fileScopes;
}

/** Stable (file, job) ordering for the whole report. */
function byFileAndJob(a: WorkflowJobPerms, b: WorkflowJobPerms): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.job !== b.job) return a.job < b.job ? -1 : 1;
  return 0;
}

/**
 * The single verdict for one readable job against the ordered rules above.
 * Internal helper — the rule order lives in the caller's loop.
 */
function jobLine(
  entry: WorkflowJobPerms,
  allowed: readonly string[] | undefined,
): { line: string; outcome: Exclude<WorkflowPermOutcome, "approve" | "warn"> } {
  const effective = effectiveScopes(entry);
  const sorted = [...effective].sort();
  // Rule 2: the broad write permission rejects before any other
  // consideration — no allowlist can legitimize `write-all`.
  if (sorted.includes(BROAD_WRITE_SCOPE)) {
    return {
      line: `workflow-perms: REJECT ${entry.file}/${entry.job} ${BROAD_WRITE_SCOPE} — every scope writable is never acceptable`,
      outcome: "reject",
    };
  }
  // Rule 3: no own declaration and nothing inherited — the invisible
  // repository default applies.
  if (effective.length === 0) {
    return {
      line: `workflow-perms: REJECT ${entry.file}/${entry.job} — no permissions declaration; the repository default applies unseen`,
      outcome: "reject",
    };
  }
  const allowedSet = new Set(allowed ?? []);
  const outside = sorted.filter((scope) => !allowedSet.has(scope));
  // Rule 5: a declared scope the job was never documented to need.
  if (outside.length > 0) {
    return {
      line: `workflow-perms: REJECT ${entry.file}/${entry.job} ${outside.join(" ")} — scope outside the documented allowlist`,
      outcome: "reject",
    };
  }
  // Rule 4: a top-only declaration is reported as inherited.
  if (entry.jobScopes.length === 0) {
    return {
      line: `workflow-perms: APPROVE ${entry.file}/${entry.job} ${sorted.join(" ")} (inherited from the workflow top)`,
      outcome: "approve",
    };
  }
  return {
    line: `workflow-perms: APPROVE ${entry.file}/${entry.job} ${sorted.join(" ")}`,
    outcome: "approve",
  };
}

/**
 * The verdict for the whole normalized job list, with the static report
 * lines in deterministic order. See the module header for the rule order;
 * the outcome is the worst line seen, where reject > warn > approve.
 */
export function workflowPermsVerdict(
  jobs: readonly WorkflowJobPerms[] | null | undefined,
  allowlist: WorkflowScopeAllowlist,
): WorkflowPermsReport {
  // Rule 1: an absent or empty input warns and never approves — checking
  // zero jobs is exactly the same as having no gate.
  if (isMissing(jobs)) {
    return {
      outcome: "warn",
      lines: [
        "workflow-perms: WARN no workflow jobs were collected — an empty check is an open gate",
      ],
    };
  }
  const list = [...(jobs as readonly WorkflowJobPerms[])].sort(byFileAndJob);
  // Rule 1 (continued): a file marked as a failed read keeps the whole
  // verdict at WARN — a renamed or unparseable file must never become a
  // silent approval, and the unreadable entries are the only report lines.
  const unreadable = list.filter((entry) => entry.readFailed === true);
  if (unreadable.length > 0) {
    return {
      outcome: "warn",
      lines: unreadable.map(
        (entry) =>
          `workflow-perms: WARN ${entry.file}/${entry.job} workflow unreadable or unparseable — permissions unverifiable`,
      ),
    };
  }
  const lines: string[] = [];
  let outcome: WorkflowPermOutcome = "approve";
  for (const entry of list) {
    const { line, outcome: lineOutcome } = jobLine(
      entry,
      allowlist[`${entry.file}/${entry.job}`],
    );
    lines.push(line);
    if (lineOutcome === "reject") outcome = "reject";
  }
  return { outcome, lines };
}
