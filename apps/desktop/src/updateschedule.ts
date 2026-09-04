// P2-155: periodic update recheck plan. Pure module — no GUI-framework import,
// same pattern as tray.ts/badge.ts/closehint.ts — so the unit battery can
// exercise every branch. main.ts turns the returned delay into a setTimeout
// and re-feeds each resolved status back in; this file only does the math.
//
// Why: since P2-152 closing the window keeps the app alive indefinitely, so a
// user who never opens the tray menu would stay pinned to the installed
// version forever. The recheck keeps the P1-050 consent flow intact: nothing
// here installs anything, and a pending "update-downloaded" offer is never
// re-scheduled (only a restart applies it).
import type { UpdateStatus } from "./update";

/** Base interval between rechecks: 6 h. */
export const UPDATE_RECHECK_BASE_MS = 6 * 60 * 60_000;
/** Hard floor for every returned delay: 5 min, no combination can go below. */
export const UPDATE_RECHECK_MIN_MS = 5 * 60_000;
/** First failure retry: 15 min, doubling per consecutive failure (capped at the base). */
export const UPDATE_RECHECK_BACKOFF_START_MS = 15 * 60_000;
/** ±10% jitter around the base so fleets of clients don't check in unison. */
export const UPDATE_RECHECK_JITTER = 0.1;

/**
 * Delay in ms until the next update check for the given resolved status, or
 * null when no recheck should be scheduled. `random` is injected (Math.random
 * in production) and only read on the healthy path — the backoff branch is
 * fully deterministic. The counter of consecutive feed failures is normalized:
 * anything non-integer or not positive counts as 0.
 */
export function nextCheckDelayMs(
  status: UpdateStatus,
  consecutiveFailures: number,
  random: () => number,
): number | null {
  // No update surface (no feed configured): zero network, zero timers.
  // update-downloaded: the P1-050 consent was already offered and only a
  // restart applies it — re-checking would just re-offer a decided release.
  if (status === "disabled" || status === "update-downloaded") return null;
  const failures = Number.isInteger(consecutiveFailures) && consecutiveFailures > 0 ? consecutiveFailures : 0;
  let delay: number;
  if (status === "feed-unreachable" || status === "unrecognized-feed") {
    // Dead/broken feed: exponential backoff 15 min → 6 h, doubling per
    // consecutive failure, saturated by the Math.min at the base interval.
    delay = Math.min(UPDATE_RECHECK_BASE_MS, UPDATE_RECHECK_BACKOFF_START_MS * 2 ** Math.max(0, failures - 1));
  } else {
    // Healthy resolutions (update-not-available / update-available /
    // update-available-manual): base interval with ±10% jitter.
    delay = UPDATE_RECHECK_BASE_MS * (1 - UPDATE_RECHECK_JITTER + random() * 2 * UPDATE_RECHECK_JITTER);
  }
  // A hostile/broken random (NaN, ±Infinity) collapses to the plain base —
  // and the floor below holds for every combination of random and counter.
  if (!Number.isFinite(delay)) delay = UPDATE_RECHECK_BASE_MS;
  return Math.max(UPDATE_RECHECK_MIN_MS, Math.round(delay));
}
