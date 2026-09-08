/**
 * P2-278: pure verdict module for the action-pinning gate.
 *
 * Every third-party action of the pipeline was referenced by a mutable
 * version tag, so whoever controlled that tag could execute code inside the
 * job that signs and publishes the user's package (stage 5 of
 * docs/VISION.md) — the next run picked the moved tag with no PR in this
 * repository and no review line, while P2-271 already bounded the token
 * power and P2-269 the dependency advisories. The verdict lives here, as
 * pure logic: no file system access, no process spawning, no network — the
 * caller (scripts/check-action-pins.ts) reads the real workflows,
 * normalizes the action references by indentation and injects them already
 * normalized, the same hygiene as workflowperms.ts, auditverdict.ts and
 * ci-scope.ts, so the unit battery can pin every branch with synthetic
 * fixtures.
 *
 * The rules below are applied IN THIS ORDER; the first rule that matches
 * decides, and the final outcome is the worst line seen:
 *
 * 1. An absent input, an empty reference list, or a list marked as a failed
 *    read becomes WARN — never approve. Checking zero references is exactly
 *    the same as having no gate, and a renamed workflow file must never
 *    turn into a silent approval.
 * 2. A non-finite current instant is REJECTED instead of guessed: with no
 *    trustworthy clock the exemption dates cannot be evaluated, so the gate
 *    refuses rather than pretending.
 * 3. A reference to an action local to this very repository is ignored and
 *    never becomes a problem.
 * 4. A reference whose owner is outside the documented first-party list and
 *    that is not pinned to a forty-hex-digit commit SHA becomes REJECT
 *    before any other consideration — this is the case the gate exists to
 *    prevent. An exemption whose validity date has already passed stops
 *    applying and the reference counts in full again, landing here: an
 *    eternal exemption is the same as having no gate.
 * 5. An exemption still valid downgrades the reference to WARN and it never
 *    disappears from the report.
 * 6. A first-party reference pinned only by a tag (or branch — anything but
 *    a full commit SHA) becomes WARN.
 * 7. Only the remainder becomes APPROVE.
 *
 * The result is identical for the same input in two calls, with stable
 * ordering by workflow file, job name and action name.
 */

/** The three possible gate outcomes, worst last. */
export type ActionPinsOutcome = "approve" | "warn" | "reject";

/** A full commit SHA: exactly forty hexadecimal digits, as git writes them. */
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export interface ActionRef {
  /** Workflow file the reference belongs to (e.g. "ci.yml"). */
  file: string;
  /** Job id the step belongs to (e.g. "verify"). */
  job: string;
  /** Action owner as written before the "/" ("" for a local "./..." ref). */
  owner: string;
  /** Action name as written after the "/" (the path for a local ref). */
  action: string;
  /** The written reference after "@" (tag, branch or commit SHA). */
  ref: string;
  /** True when the workflow file could not be read or parsed. */
  readFailed?: boolean;
}

/** A documented, deadlined exemption for one still-unpinned reference. */
export interface ActionExemption {
  /** Reference identifier being exempted, as "owner/action". */
  id: string;
  /** One-sentence motive, human-written. */
  reason: string;
  /** ISO 8601 instant; the exemption counts only while strictly in the future. */
  expiresAt: string;
}

export interface ActionPinsReport {
  outcome: ActionPinsOutcome;
  /** Static report lines in deterministic order (file, job, action). */
  lines: string[];
}

/** Stable (file, job, action) ordering for the whole report. */
function byFileJobAction(a: ActionRef, b: ActionRef): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.job !== b.job) return a.job < b.job ? -1 : 1;
  if (a.action !== b.action) return a.action < b.action ? -1 : 1;
  return 0;
}

/** A reference to an action inside this repository ("./..." or "../..."). */
function isLocal(entry: ActionRef): boolean {
  return entry.owner === "" || entry.owner === "." || entry.owner === "..";
}

/** True only for inputs that are absent or carry no reference at all. */
function isMissing(refs: readonly ActionRef[] | null | undefined): boolean {
  return (
    refs === null || refs === undefined || !Array.isArray(refs) || refs.length === 0
  );
}

/**
 * The verdict for one normalized reference against the ordered rules above.
 * Internal helper — the rule order lives in the caller's loop.
 */
function refLine(
  entry: ActionRef,
  firstParty: ReadonlySet<string>,
  exempt: ReadonlyMap<string, ActionExemption>,
  now: number,
): { line: string; outcome: Exclude<ActionPinsOutcome, "approve"> | "approve" } {
  const id = `${entry.owner}/${entry.action}`;
  const pinned = COMMIT_SHA_PATTERN.test(entry.ref);
  // Rule 4: an owner outside the first-party list that is not pinned to a
  // full commit SHA rejects before any other consideration — unless a
  // still-valid exemption downgrades it (rule 5); an expired one stopped
  // applying and lands here in full.
  if (!firstParty.has(entry.owner) && !pinned) {
    const exemption = exempt.get(id);
    if (exemption !== undefined && Date.parse(exemption.expiresAt) > now) {
      return {
        line: `action-pins: WARN ${entry.file}/${entry.job} ${id}@${entry.ref} exempt until ${exemption.expiresAt}`,
        outcome: "warn",
      };
    }
    return {
      line: `action-pins: REJECT ${entry.file}/${entry.job} ${id}@${entry.ref} — third-party action not pinned to a full commit SHA`,
      outcome: "reject",
    };
  }
  // Rule 6: first-party actions are trusted but mutable — a tag-pinned one
  // still warns, because a moved tag would change what runs.
  if (!pinned) {
    return {
      line: `action-pins: WARN ${entry.file}/${entry.job} ${id}@${entry.ref} — first-party action pinned only by a mutable ref`,
      outcome: "warn",
    };
  }
  return {
    line: `action-pins: APPROVE ${entry.file}/${entry.job} ${id}@${entry.ref.slice(0, 10)}…`,
    outcome: "approve",
  };
}

/**
 * The verdict for the whole normalized reference list, with the static
 * report lines in deterministic order. See the module header for the rule
 * order; the outcome is the worst line seen, where reject > warn > approve.
 */
export function actionPinsVerdict(
  refs: readonly ActionRef[] | null | undefined,
  firstPartyOwners: readonly string[],
  exemptions: readonly ActionExemption[],
  now: number,
): ActionPinsReport {
  // Rule 1: an absent, empty or failed-read input warns and never approves
  // — checking zero references is exactly the same as having no gate.
  if (isMissing(refs)) {
    return {
      outcome: "warn",
      lines: [
        "action-pins: WARN no action references were collected — an empty check is an open gate",
      ],
    };
  }
  const list = [...(refs as readonly ActionRef[])].sort(byFileJobAction);
  const unreadable = list.filter((entry) => entry.readFailed === true);
  if (unreadable.length > 0) {
    return {
      outcome: "warn",
      lines: unreadable.map(
        (entry) =>
          `action-pins: WARN ${entry.file}/${entry.job} workflow unreadable or unparseable — action references unverifiable`,
      ),
    };
  }
  // Rule 2: without a finite clock the exemption dates are unevaluable —
  // refuse instead of guessing.
  if (!Number.isFinite(now)) {
    return {
      outcome: "reject",
      lines: [
        "action-pins: REJECT the current instant is not a finite number — the gate refuses instead of guessing",
      ],
    };
  }
  const firstParty = new Set(firstPartyOwners);
  const exempt = new Map(exemptions.map((e) => [e.id, e]));
  const lines: string[] = [];
  let outcome: ActionPinsOutcome = "approve";
  for (const entry of list) {
    // Rule 3: a local action of this very repository is never a problem.
    if (isLocal(entry)) continue;
    const { line, outcome: lineOutcome } = refLine(entry, firstParty, exempt, now);
    lines.push(line);
    if (lineOutcome === "reject") outcome = "reject";
    else if (lineOutcome === "warn" && outcome === "approve") outcome = "warn";
  }
  return { outcome, lines };
}
