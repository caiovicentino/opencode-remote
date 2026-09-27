/**
 * Pending-deploy refusal backoff.
 *
 * The pending-deploy self-heal retries every idle cycle (~5s) while prod is
 * behind a verified merge. When deploy() keeps REFUSING for the same
 * non-sha reason (prod checkout dirty, disk low, prod ahead of the target)
 * nothing changes between cycles — retrying only floods the log and the
 * supervisor notify. After DEPLOY_REFUSAL_BACKOFF_AFTER consecutive refusals
 * of the same kind the loop holds off for DEPLOY_REFUSAL_BACKOFF_MS. A real
 * attempt, a different refusal kind or a process restart resets the streak
 * (in-memory by design: the state is cheap to rebuild and a restart is a
 * reasonable moment to look again). Pure — the battery pins every rule.
 */
import type { DeployRefusal } from "./deploy";

/** Consecutive same-kind refusals that arm the hold. */
export const DEPLOY_REFUSAL_BACKOFF_AFTER = 5;
/** How long the pending-deploy path stays quiet once armed. */
export const DEPLOY_REFUSAL_BACKOFF_MS = 30 * 60_000;

export interface DeployBackoff {
  reason: DeployRefusal;
  /** Consecutive refusals of `reason`. */
  count: number;
  /** Epoch ms until which the pending path holds off; 0 = not armed. */
  until: number;
}

/**
 * Fold one refusal into the streak. Sha-guard refusals never arm a hold: the
 * pending path resolves its target through the verified list, so a sha
 * refusal there is a fail-closed no-op rather than a stuck environment.
 */
export function noteDeployRefusal(
  prev: DeployBackoff | null,
  reason: DeployRefusal,
  now: number,
  opts: { after?: number; backoffMs?: number } = {},
): DeployBackoff | null {
  if (reason === "sha-guard") return null;
  const after = opts.after ?? DEPLOY_REFUSAL_BACKOFF_AFTER;
  const backoffMs = opts.backoffMs ?? DEPLOY_REFUSAL_BACKOFF_MS;
  const count = prev?.reason === reason ? prev.count + 1 : 1;
  const until = count >= after ? now + backoffMs : 0;
  return { reason, count, until };
}

/** Milliseconds the pending path must still hold off (0 = free to try). */
export function deployBackoffRemaining(b: DeployBackoff | null, now: number): number {
  if (!b || b.until <= 0) return 0;
  return Math.max(0, b.until - now);
}

// ── Rollback hold: no new information, no new attempt ────────────────────────

/**
 * After a rolled-back deploy the pending path used to fire again on the very
 * next idle cycle, walking down to the next-newest verified sha with nothing
 * learned: 2026-09-11 08:33/08:39/08:44 burned three deploys (and quarantined
 * three good shas) on the same environmental failure. The pending path now
 * holds until NEW information arrives — a merge the gatekeeper recorded after
 * the rollback (possibly the fix) — or this long passes.
 */
export const DEPLOY_ROLLBACK_HOLD_MS = 2 * 60 * 60_000;

export interface RollbackHold {
  /** Sha whose deploy rolled back (quarantined by deploy()). */
  sha: string;
  /** Newest gate-verified merge recorded when the rollback happened. */
  tip: string | null;
  /** Epoch ms after which the pending path may try again regardless. */
  until: number;
}

export function noteDeployRollback(sha: string, verifiedTip: string | null, now: number, holdMs = DEPLOY_ROLLBACK_HOLD_MS): RollbackHold {
  return { sha, tip: verifiedTip, until: now + holdMs };
}

/**
 * Milliseconds the pending path must still hold after a rollback (0 = free):
 * released early the moment the verified list's tip moves (a new merge landed).
 * The merge path (launchDeploy) never consults it — a fresh merge IS the new
 * information.
 */
export function rollbackHoldRemaining(h: RollbackHold | null, verifiedTipNow: string | null, now: number): number {
  if (!h) return 0;
  if (verifiedTipNow !== h.tip) return 0;
  return Math.max(0, h.until - now);
}
