/**
 * P2-283: pure verdict module for the lockfile integrity gate.
 *
 * The package-lock.json is the only file that decides which third-party code
 * `npm ci` installs inside the job that packages the notarized DMG and the
 * signed installer (stage 5 of docs/VISION.md) — yet nothing verified where
 * each package came from, so a dependency swapped to a git repository or to
 * an arbitrary tarball traveled to the user's machine without ever crossing
 * a verification line. The verdict lives here, as pure logic: no file system
 * access, no process spawning, no network — the caller
 * (scripts/check-lock-integrity.ts) reads the real lockfile, normalizes the
 * entries and injects them already normalized, the same hygiene as
 * actionpins.ts, workflowperms.ts and auditverdict.ts, so the unit battery
 * can pin every branch with synthetic fixtures.
 *
 * The rules below are applied IN THIS ORDER; the first rule that matches
 * decides, and the final outcome is the worst line seen:
 *
 * 1. An absent input, an empty entry list, or a list marked as a failed read
 *    becomes WARN — never approve. Checking zero packages is exactly the
 *    same as having no gate, and a renamed lockfile must never turn into a
 *    silent approval.
 * 2. A non-finite current instant is REJECTED instead of guessed: with no
 *    trustworthy clock the exemption dates cannot be evaluated, so the gate
 *    refuses rather than pretending.
 * 3. A package of this very repository (the root, a workspace directory or
 *    the node_modules link to one) is ignored and never becomes a problem or
 *    a report line. An origin counts as this repository's own only when it
 *    is provably a repo-relative path (isInternalOrigin): any other shape —
 *    a scheme'd URL, a protocol-relative "//host/path", an scp-style
 *    "git@host:owner/repo", a "host:owner/repo" prefix, an absolute path or
 *    a parent escape — fails closed and crosses the registry checks.
 * 4. An origin outside the documented public registries becomes REJECT
 *    before any other consideration — a git dependency, an arbitrary tarball
 *    or a missing origin — this is the case the gate exists to prevent.
 * 5. An origin inside an accepted registry without a declared integrity hash
 *    becomes REJECT.
 * 6. A hash present whose algorithm differs from the documented one becomes
 *    WARN.
 * 7. An exemption whose validity date has already passed stops applying and
 *    the entry counts in full again — an eternal exemption is the same as
 *    having no gate.
 * 8. An exemption still valid downgrades the entry to WARN and it never
 *    disappears from the report.
 * 9. Only the remainder becomes APPROVE.
 *
 * The result is identical for the same input in two calls, with stable
 * ordering by entry path.
 */

/** The three possible gate outcomes, worst last. */
export type LockIntegrityOutcome = "approve" | "warn" | "reject";

/**
 * The documented integrity algorithm every third-party registry package
 * must declare (npm writes `sha512-<base64>`).
 */
export const INTEGRITY_ALGORITHM = "sha512";

export interface LockEntry {
  /** Lockfile path of the entry (e.g. "node_modules/left-pad"). */
  path: string;
  /** The origin as written in the lockfile ("" when none was written). */
  resolved: string;
  /** The declared integrity hash ("" when none was declared). */
  integrity: string;
  /** True for a package of this very repository (root, workspace or link). */
  internal: boolean;
  /** True when the lockfile could not be read or parsed. */
  readFailed?: boolean;
}

/** A documented, deadlined exemption for one lockfile entry. */
export interface LockExemption {
  /** Lockfile entry path being exempted (e.g. "node_modules/left-pad"). */
  id: string;
  /** One-sentence motive, human-written. */
  reason: string;
  /** ISO 8601 instant; the exemption counts only while strictly in the future. */
  expiresAt: string;
}

export interface LockIntegrityReport {
  outcome: LockIntegrityOutcome;
  /** Static report lines in deterministic order (sorted by entry path). */
  lines: string[];
}

/** True only for inputs that are absent or carry no entry at all. */
function isMissing(entries: readonly LockEntry[] | null | undefined): boolean {
  return (
    entries === null ||
    entries === undefined ||
    !Array.isArray(entries) ||
    entries.length === 0
  );
}

/** Stable ordering by entry path (then origin, for degenerate fixtures). */
function byPath(a: LockEntry, b: LockEntry): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.resolved !== b.resolved) return a.resolved < b.resolved ? -1 : 1;
  return 0;
}

/** True when the written origin points at a documented public registry. */
export function originAccepted(origin: string, registries: readonly string[]): boolean {
  return registries.some((r) => {
    if (typeof r !== "string" || r === "") return false;
    const base = r.endsWith("/") ? r : `${r}/`;
    return origin === r || origin.startsWith(base);
  });
}

/** The algorithm prefix of an `alg-hash` integrity string ("" when absent). */
function algorithmOf(integrity: string): string {
  const dash = integrity.indexOf("-");
  // Both halves must exist: "sha512" and "sha512-" declare no hash material
  // at all, so they are no hash — never a documented-algorithm hash.
  if (dash <= 0) return "";
  const algorithm = integrity.slice(0, dash);
  if (algorithm === "" || integrity.slice(dash + 1) === "") return "";
  return algorithm;
}

/**
 * True only when the written origin is provably a repo-relative path into
 * this very repository (a workspace link such as "apps/web"). Everything
 * else fails closed: a scheme'd URL ("https://…", "file:…"), a
 * protocol-relative origin ("//host/path"), an scp-style remote
 * ("git@host:owner/repo"), a "host:owner/repo" prefix, an absolute path or
 * a parent escape is an origin the gate cannot prove internal, so it must
 * cross the registry checks like any third-party origin.
 */
export function isInternalOrigin(origin: string): boolean {
  if (origin === "") return false;
  if (origin.includes("//")) return false; // scheme'd or protocol-relative URL
  if (origin.includes("git@")) return false; // scp-style git remote
  // Any "scheme:"-style prefix — including a bare "host:" one such as
  // "github.com:owner/repo" — is not a plain repo-relative path.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(origin)) return false;
  if (origin.startsWith("/") || origin.startsWith("~/")) return false; // absolute paths
  if (origin.startsWith("../")) return false; // escapes the repository root
  return true;
}

/**
 * The verdict for one normalized entry against the ordered rules above.
 * Internal helper — the rule order lives in the caller's loop. A "" line
 * means the entry approved and stays out of the report.
 */
function entryLine(
  entry: LockEntry,
  registries: readonly string[],
  exempt: ReadonlyMap<string, LockExemption>,
  now: number,
): { line: string; outcome: Exclude<LockIntegrityOutcome, "approve"> } | { line: "" } {
  const shown = entry.resolved === "" ? "(no origin written)" : entry.resolved;
  // Rule 4: an origin outside the documented public registries rejects
  // before any other consideration — a still-valid exemption cannot save it.
  if (!originAccepted(entry.resolved, registries)) {
    return {
      line: `lock-integrity: REJECT ${entry.path} ${shown} — origin outside the documented public registries`,
      outcome: "reject",
    };
  }
  // Rules 7 and 8: a still-valid exemption downgrades a hashless registry
  // entry to warn; an expired one stopped applying and lands here in full.
  // An integrity string that declares no usable hash material ("", "sha512",
  // "sha512-", "-abc") is exactly the same as no hash at all.
  const algorithm = algorithmOf(entry.integrity);
  if (entry.integrity === "" || algorithm === "") {
    const exemption = exempt.get(entry.path);
    if (exemption !== undefined && Date.parse(exemption.expiresAt) > now) {
      return {
        line: `lock-integrity: WARN ${entry.path} ${shown} — no integrity hash declared, exempt until ${exemption.expiresAt}`,
        outcome: "warn",
      };
    }
    return {
      line: `lock-integrity: REJECT ${entry.path} ${shown} — no integrity hash declared`,
      outcome: "reject",
    };
  }
  // Rule 6: a hash from another algorithm only warns — the origin is a
  // documented registry and a hash is declared, but the gate cannot verify
  // the documented algorithm was the one applied.
  if (algorithm !== INTEGRITY_ALGORITHM) {
    return {
      line: `lock-integrity: WARN ${entry.path} ${shown} — integrity algorithm ${algorithm} differs from the documented ${INTEGRITY_ALGORITHM}`,
      outcome: "warn",
    };
  }
  return { line: "" };
}

/**
 * The verdict for the whole normalized entry list, with the static report
 * lines in deterministic order. See the module header for the rule order;
 * the outcome is the worst line seen, where reject > warn > approve.
 */
export function lockIntegrityVerdict(
  entries: readonly LockEntry[] | null | undefined,
  registries: readonly string[],
  exemptions: readonly LockExemption[],
  now: number,
): LockIntegrityReport {
  // Rule 1: an absent, empty or failed-read input warns and never approves
  // — checking zero packages is exactly the same as having no gate.
  if (isMissing(entries)) {
    return {
      outcome: "warn",
      lines: [
        "lock-integrity: WARN no lockfile entries were collected — an empty check is an open gate",
      ],
    };
  }
  const list = [...(entries as readonly LockEntry[])];
  const failed = list.filter((e) => e !== null && e !== undefined && e.readFailed === true);
  if (failed.length > 0) {
    return {
      outcome: "warn",
      lines: failed.map(
        (e) =>
          `lock-integrity: WARN ${e.path} unreadable or unparseable — package origins unverifiable`,
      ),
    };
  }
  // Rule 2: without a finite clock the exemption dates are unevaluable —
  // refuse instead of guessing.
  if (!Number.isFinite(now)) {
    return {
      outcome: "reject",
      lines: [
        "lock-integrity: REJECT the current instant is not a finite number — the gate refuses instead of guessing",
      ],
    };
  }
  const exempt = new Map(exemptions.map((e) => [e.id, e]));
  const lines: string[] = [];
  let outcome: LockIntegrityOutcome = "approve";
  for (const entry of [...list].sort(byPath)) {
    // Rule 3: a package of this very repository is never a problem and
    // never becomes a report line.
    if (entry === null || entry === undefined || entry.internal) continue;
    const verdict = entryLine(entry, registries, exempt, now);
    if (verdict.line === "") continue;
    lines.push(verdict.line);
    if (verdict.outcome === "reject") outcome = "reject";
    else if (verdict.outcome === "warn" && outcome === "approve") outcome = "warn";
  }
  return { outcome, lines };
}
