// P2-254: automatic backup copy of the identity file. Pure module — no
// node:fs, node:path, node:child_process or fetch imports on purpose, because
// index.ts runs main() on import and unit tests must never boot a daemon
// (same pattern as identityfile.ts / statefile.ts; lessons P2-149 and
// P2-228). All I/O lives in the index.ts caller.
//
// Why this exists: the P2-234 refusal sentence asks the owner to restore a
// good copy of daemon.json — but nothing in the daemon ever wrote one, so a
// stage-3 user (docs/VISION.md) hit by a full disk, a defective volume or a
// failed manual edit had exactly one real way out: wipe everything and pair
// every phone again. This module plans a second, recoverable copy that the
// caller writes through the same atomic 0600 write as the main file, right
// after each successful state persistence.
//
// WHERE THE COPY MUST NEVER LIVE: always a sibling of the original in the
// state directory (via backupName + the caller's join). Never a temp
// directory, never uploads/, artifacts/ or clips/ — those directories are
// served for download by the daemon's local API and to the phone, and the
// copy carries the machine's private keys. A copy placed there would turn
// the identity file into a downloadable artifact. This reason is the whole
// point of backupName returning a bare sibling name.
//
// RULE-ORDER CONTRACT for backupWritePlan (the unit-test gate depends on
// this order):
//   1. content that would not pass the same criterion the identity verdict
//      already applies is NEVER copied — overwriting the only good copy with
//      garbage destroys the single chance of recovery;
//   2. a nonexistent backup is always written (rule 1 still wins: see the
//      gate case where both hold at once and the result is skip);
//   3. a backup newer than the minimum interval is skipped (at most one
//      copy per interval — no timers, the caller decides per persistence);
//   4. only the remaining case writes.
// Edge instants: a non-finite instant is refused (skip) instead of guessed;
// an instant in the future is treated as now, so the age is never negative.
//
// RULE-ORDER CONTRACT for identityRecoveryPlan (the unit-test gate depends
// on this order):
//   1. a usable main file wins over everything — the copy is never even
//      consulted;
//   2. a filesystem READ FAILURE of the main file NEVER restores — a
//      transient failure must never replace good bytes (the same reason the
//      P2-234 header records: refusing keeps the bytes where they are until
//      a human looks);
//   3. a missing main file stays a first run and never restores;
//   4. ONLY a refusal caused by illegible content consults the copy — and
//      restores only when the copy itself would be usable; any other case
//      refuses with the message the main verdict already carries.

import { identityVerdict, type IdentityVerdict } from "./identityfile.js";

/**
 * Derive the backup file name from the original one. Always a bare sibling
 * name: any directory components in the input are stripped (the caller joins
 * the result with the state directory), the result is never empty and never
 * equals the original. The copy must never live in temp/uploads/artifacts/
 * clips: those are served for download and the copy carries the private key
 * (see the header).
 */
export function backupName(original: string): string {
  const parts = original
    .trim()
    .split(/[\\/]+/)
    .filter((p) => p.length > 0 && p !== "." && p !== "..");
  const name = parts.pop() ?? "daemon.json";
  return `${name}.backup`;
}

export type BackupWriteDecision = "write" | "skip";

export interface BackupWritePlan {
  decision: BackupWriteDecision;
  /** Static reason code — safe to log, no paths, no content. */
  reason: "unusable-content" | "no-backup-yet" | "non-finite-instant" | "backup-fresh" | "backup-stale";
}

export interface BackupWritePlanInput {
  /** Whether the freshly persisted content passes the identity-verdict criterion. */
  contentUsable: boolean;
  /** Whether the backup copy already exists. */
  backupExists: boolean;
  /** Last-copy instant (mtime) when it exists, null otherwise. */
  lastBackupAt: number | null;
  now: number;
  minIntervalMs: number;
}

/**
 * Decide whether a fresh backup copy should be written. Rules in THIS order
 * (see the header contract): unusable content is never copied, a nonexistent
 * backup is always written, a backup newer than the minimum interval is
 * skipped, and only the rest writes. Non-finite instants refuse instead of
 * guessing; a future instant is treated as now, so the age is never negative.
 */
export function backupWritePlan(input: BackupWritePlanInput): BackupWritePlan {
  if (!input.contentUsable) {
    // Rule 1 — wins over rule 2 on purpose: garbage never replaces the
    // only good copy, even when no copy exists yet.
    return { decision: "skip", reason: "unusable-content" };
  }
  if (!input.backupExists) {
    return { decision: "write", reason: "no-backup-yet" };
  }
  if (
    input.lastBackupAt === null ||
    !Number.isFinite(input.now) ||
    !Number.isFinite(input.lastBackupAt)
  ) {
    return { decision: "skip", reason: "non-finite-instant" };
  }
  const age = Math.max(0, input.now - input.lastBackupAt);
  if (age < input.minIntervalMs) {
    return { decision: "skip", reason: "backup-fresh" };
  }
  return { decision: "write", reason: "backup-stale" };
}

export type IdentityRecoveryPlan = "use-main" | "first-run" | "restore-from-backup" | "refuse";

/**
 * Decide how the boot treats the main identity file given the verdict the
 * caller already obtained for it, whether the backup copy exists and the
 * verdict for the copy's content (null when there is no copy). Returns
 * exactly one outcome — use the main file, first run, restore from the copy
 * or refuse — under the rule-order contract documented in the header.
 */
export function identityRecoveryPlan(
  main: IdentityVerdict,
  backupExists: boolean,
  backupVerdict: IdentityVerdict | null,
): IdentityRecoveryPlan {
  if (main.plan === "use") return "use-main";
  if (main.plan === "refuse" && !main.quarantine) return "refuse";
  if (main.plan === "first-run") return "first-run";
  // Content refusal — the only case that ever consults the copy.
  if (backupExists && backupVerdict?.plan === "use") return "restore-from-backup";
  return "refuse";
}

/** One static, log-safe line for the restore path (P2-182: no paths, no content, no secrets). */
export const IDENTITY_BACKUP_RESTORED_LOG =
  "Cópia de segurança da identidade restaurada — pareamentos preservados.";

/**
 * The verdict for the backup copy's content, with the exact same criterion
 * the identity verdict applies to the main file. A thin pure wrapper so the
 * caller never re-derives usability by hand.
 */
export function backupContentVerdict(content: string | null): IdentityVerdict {
  return identityVerdict(content !== null, content, null);
}
