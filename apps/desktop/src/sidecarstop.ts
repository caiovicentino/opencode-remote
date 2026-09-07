// P2-315: pure stop planner for the desktop shell's daemon sidecar. Windows
// has no real signals — child.kill("SIGTERM") there is an immediate, unclean
// process termination — so quitting the app on Windows left the daemon dead
// without ever running the graceful drain (ws close 1001, state log, settle)
// that apps/daemon/src/shutdown.ts implements, and the phone hung on a
// connection nobody closed until the relay timed it out. The stop sequence is
// decided HERE, in one closed plan, and executed by daemon.ts. With the IPC
// message channel open (it is opened at every spawn since P2-315) the plan is
// the graceful one on BOTH platforms — identical steps, so the pipeline
// running on macOS exercises the exact code Windows uses; without a channel
// the plan degrades to today's fixed signal walk (SIGTERM → grace → SIGKILL).
//
// Same module hygiene as sidecarexit.ts / proxyplan.ts / wakeplan.ts: NO
// electron, no node:fs, no node:child_process, no node:net, no fetch, no I/O
// of any kind — scripts/unit.test.ts evaluates this module in plain Node and
// asserts the purity against the real source file.
//
// CLOSED CONTRACT (the executor in daemon.ts depends on it):
//  1. a child not provably alive yields NO steps at all — nothing is
//     signalled, no grace is waited;
//  2. the grace wait is always SIDECAR_STOP_GRACE_MS — today's 3s backstop,
//     untouched;
//  3. with a connected channel the graceful request rides the IPC message
//     pipe (a local socketpair/named pipe — no port bound, no network
//     listener added) and the force signal only ever fires after the grace;
//  4. without a channel there is no graceful path: the fixed signal walk runs
//     exactly as before, on both platforms;
//  5. the plan never branches on the platform — the platform travels in the
//     input for provenance and tests only, so any value there (even a
//     non-textual one) still yields the graceful plan;
//  6. any unreadable input (non-object, or childAlive not exactly true)
//     yields no steps; nothing ever throws, and the same input yields the
//     exact same plan on every call.

/** The grace window before the force signal — the same 3s backstop the shell
 * always applied between SIGTERM and SIGKILL. */
export const SIDECAR_STOP_GRACE_MS = 3000;

/** The one message the shell may send over the sidecar IPC channel. The
 * daemon accepts it via isSidecarStopMessage (apps/daemon/src/shutdown.ts) —
 * the two sides must agree on this shape. */
export interface SidecarStopMessage {
  type: "shutdown";
}

/** One ordered step of the stop sequence. "message" asks the daemon to shut
 * down gracefully; "wait" holds the grace window; "signal" is a fallback/
 * escalation kill. */
export type SidecarStopStep =
  | { kind: "message"; payload: SidecarStopMessage }
  | { kind: "wait"; ms: number }
  | { kind: "signal"; signal: "SIGTERM" | "SIGKILL" };

export interface SidecarStopInput {
  /** process.platform of the shell — provenance only, never a branch (5). */
  platform?: unknown;
  /** True only when the child has a connected IPC message channel. Anything
   * else degrades to the signal walk (4). */
  channelConnected?: unknown;
  /** True only when the child is provably still alive. Anything else yields
   * no steps (1, 6). */
  childAlive?: unknown;
}

/**
 * The one pure decision of this module: the ordered, closed sequence of stop
 * steps for the daemon sidecar. Deterministic — the same input yields the
 * exact same steps on every call — and nothing is ever thrown.
 */
export function planSidecarStop(input?: unknown): SidecarStopStep[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return [];
  const { channelConnected, childAlive } = input as SidecarStopInput;
  if (childAlive !== true) return [];
  // No channel → no graceful path: today's fixed walk, unchanged. On Windows
  // SIGTERM is itself the immediate termination; on macOS the daemon's own
  // SIGTERM handler still drains it gracefully.
  if (channelConnected !== true) {
    return [
      { kind: "signal", signal: "SIGTERM" },
      { kind: "wait", ms: SIDECAR_STOP_GRACE_MS },
      { kind: "signal", signal: "SIGKILL" },
    ];
  }
  // Graceful path, identical on every platform: request the drain over the
  // IPC pipe, hold the grace, then force. Fresh objects every call — callers
  // may mutate their copy of the plan without crossing calls.
  return [
    { kind: "message", payload: { type: "shutdown" } },
    { kind: "wait", ms: SIDECAR_STOP_GRACE_MS },
    { kind: "signal", signal: "SIGKILL" },
  ];
}
