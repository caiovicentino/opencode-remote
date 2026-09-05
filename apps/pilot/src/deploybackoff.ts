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
