/**
 * eval-01 (routed by eval-02): the pilot's self-watchdog killed a healthy
 * process right after long SYNCHRONOUS calls. judgeGate runs the signed judge
 * with execFileSync (timeout 30 min) on the event loop, so while it runs
 * nothing can touch the heartbeat and the 60s interval cannot fire; the moment
 * the call returns, the overdue tick reads a >3-min-old heartbeat and exits —
 * every in-flight slot dies with it (pilot.log: "watchdog: heartbeat stale"
 * right after "reviewers start" on 2026-09-23 12:44 and 2026-09-24 04:19).
 *
 * A tick that arrives late proves the loop was BLOCKED (a sync call) or the
 * machine slept — not that it is hung: a truly wedged loop never ticks at all,
 * and a stuck await leaves the loop free, so its ticks stay on time and the
 * stale heartbeat still exits exactly as before. Pure verdict; the caller owns
 * fs, the heartbeat touch and process.exit.
 */

/** Interval of the self-watchdog tick. */
export const WATCHDOG_INTERVAL_MS = 60_000;

export type SelfWatchVerdict = "ok" | "blocked" | "exit";

export function selfWatchVerdict(input: {
  /** Now minus the last heartbeat (NaN when unreadable — never an exit). */
  silentMs: number;
  /** Now minus the previous tick of the watchdog itself. */
  tickGapMs: number;
  maxSilenceMs: number;
  intervalMs: number;
}): SelfWatchVerdict {
  if (input.tickGapMs > input.intervalMs * 2) return "blocked";
  return input.silentMs > input.maxSilenceMs ? "exit" : "ok";
}
