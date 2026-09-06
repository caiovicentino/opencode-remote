/**
 * P2-269: pure verdict module for the dependency advisory gate.
 *
 * Until now the only dependency-security check in the repo was the Electron
 * CVE list of electron-vuln.ts — a known vulnerability in any other runtime
 * dependency could ride silently inside the signed installer (stage 5 of
 * docs/VISION.md) with the whole pipeline green. The verdict for that gate
 * lives here, as pure logic: no file system access, no process spawning, no
 * network — the caller (scripts/audit-deps.ts) collects the raw advisory data
 * and injects it already normalized, the same hygiene as ci-scope.ts and
 * portablecoverage.ts, so the unit battery can pin every branch with
 * synthetic fixtures.
 *
 * The rules below are applied IN THIS ORDER; the first rule that matches
 * decides the line, and the final outcome is the worst line seen:
 *
 * 1. An absent input, an input without a normalized advisory list, or a
 *    collection explicitly marked as failed becomes WARN — never reject.
 *    The advisory registry is an external service and a network outage must
 *    never turn a healthy release into a blocked one (the same reason
 *    P2-263 warns instead of refusing the boot). A healthy collection that
 *    simply found nothing is the approve case below, not this one.
 * 2. An advisory that reaches only development dependencies becomes WARN:
 *    it does not travel inside the signed package.
 * 3. An exemption whose validity date has already passed stops counting and
 *    the advisory counts in full again — an eternal exemption is the same
 *    as having no gate at all.
 * 4. An exemption still valid downgrades its advisory to WARN and the
 *    advisory never disappears from the report.
 * 5. A severity below the documented floor becomes WARN.
 * 6. Only the remainder becomes REJECT.
 *
 * The result is identical for the same input in two calls, with stable
 * ordering by advisory identifier.
 */

/** The npm audit severity scale, low < moderate < high < critical. */
export type AuditSeverity = "low" | "moderate" | "high" | "critical";

/** The documented severity floor: high and critical runtime advisories block CI. */
export const AUDIT_SEVERITY_FLOOR: AuditSeverity = "high";

const SEVERITY_RANK: Record<AuditSeverity, number> = {
  low: 0,
  moderate: 1,
  high: 2,
  critical: 3,
};

export interface AuditAdvisory {
  /** Stable advisory identifier (e.g. "GHSA-w5hq-g745-h8pq"). */
  id: string;
  /** Name of the affected package. */
  package: string;
  /** Advisory severity on the npm scale. */
  severity: AuditSeverity;
  /** True when the advisory reaches only development dependencies. */
  devOnly: boolean;
}

export interface AuditExemption {
  /** Advisory identifier being exempted. */
  id: string;
  /** One-sentence motive, human-written. */
  reason: string;
  /** ISO 8601 instant; the exemption counts only while strictly in the future. */
  expiresAt: string;
}

/** The collection result handed over by the collector. */
export interface AuditCollection {
  /** False when the collection itself failed (execution, empty or non-JSON output). */
  ok: boolean;
  /** Normalized advisories, possibly partial when ok is false. */
  advisories: readonly AuditAdvisory[];
}

export type AuditOutcome = "approve" | "warn" | "reject";

export interface AuditReport {
  outcome: AuditOutcome;
  /** Static report lines in deterministic order (sorted by advisory id). */
  lines: string[];
}

/** True only for collections that explicitly failed or carry no usable list. */
function collectionFailed(
  collection: AuditCollection | null | undefined,
): boolean {
  return (
    collection === null ||
    collection === undefined ||
    collection.ok !== true ||
    !Array.isArray(collection.advisories)
  );
}

/**
 * The verdict for one normalized advisory against the ordered rules above.
 * Internal helper — the rule order lives in the caller's loop.
 */
function advisoryLine(
  advisory: AuditAdvisory,
  exemption: AuditExemption | undefined,
  now: number,
  floorRank: number,
): { line: string; outcome: Exclude<AuditOutcome, "approve"> } {
  const rank = SEVERITY_RANK[advisory.severity] ?? SEVERITY_RANK.critical;
  // Rule 2: dev-only dependencies never travel inside the signed package.
  if (advisory.devOnly) {
    return {
      line: `audit-deps: WARN ${advisory.id} ${advisory.package} ${advisory.severity} dev-only — does not travel inside the signed package`,
      outcome: "warn",
    };
  }
  // Rules 3 and 4: a still-valid exemption downgrades to warn; an expired
  // one falls through and the advisory counts in full again.
  const validExpiry =
    exemption !== undefined && Date.parse(exemption.expiresAt) > now;
  if (validExpiry) {
    return {
      line: `audit-deps: WARN ${advisory.id} ${advisory.package} ${advisory.severity} exempt until ${exemption.expiresAt}`,
      outcome: "warn",
    };
  }
  // Rule 5: below the documented floor only warns.
  if (rank < floorRank) {
    return {
      line: `audit-deps: WARN ${advisory.id} ${advisory.package} ${advisory.severity} below floor`,
      outcome: "warn",
    };
  }
  // Rule 6: the remainder rejects.
  return {
    line: `audit-deps: REJECT ${advisory.id} ${advisory.package} ${advisory.severity}`,
    outcome: "reject",
  };
}

/**
 * The single verdict for the whole advisory collection, with the static
 * report lines in deterministic order. See the module header for the rule
 * order; the outcome is the worst line seen, where reject > warn > approve.
 */
export function auditVerdict(
  collection: AuditCollection | null | undefined,
  exemptions: readonly AuditExemption[],
  now: number,
  floor: AuditSeverity,
): AuditReport {
  // Rule 1: a failed, absent or shapeless collection warns and never blocks.
  if (collectionFailed(collection)) {
    return {
      outcome: "warn",
      lines: [
        "audit-deps: WARN advisory collection failed or unavailable — release not blocked",
      ],
    };
  }
  const advisories = collection.advisories;
  // A healthy collection that found nothing approves.
  if (advisories.length === 0) {
    return {
      outcome: "approve",
      lines: ["audit-deps: APPROVE no known advisories in the dependency tree"],
    };
  }
  const floorRank = SEVERITY_RANK[floor] ?? SEVERITY_RANK.critical;
  const exempt = new Map(exemptions.map((e) => [e.id, e]));
  const sorted = [...advisories].sort((a, b) => {
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    if (a.package !== b.package) return a.package < b.package ? -1 : 1;
    return 0;
  });
  const lines: string[] = [];
  let outcome: AuditOutcome = "approve";
  for (const advisory of sorted) {
    const { line, outcome: lineOutcome } = advisoryLine(
      advisory,
      exempt.get(advisory.id),
      now,
      floorRank,
    );
    lines.push(line);
    if (lineOutcome === "reject") outcome = "reject";
    else if (lineOutcome === "warn" && outcome === "approve") outcome = "warn";
  }
  return { outcome, lines };
}
