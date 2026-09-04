// Daemon port fallback picker (P2-143). Pure and side-effect-free by design:
// no UI runtime, no socket, no HTTP imports — the caller injects the probes
// (see pickDaemonPort) so scripts/unit.test.ts can exercise every decision in
// plain Node and the real probes live in daemon.ts. Same structural-injection
// pattern as sidecarexit.ts / upstream.ts.

/** Canonical first choice for the daemon API port (see daemon.ts). */
export const DEFAULT_DAEMON_PORT = 8792;
/** Size of the deterministic fallback span: 8792..8796. */
export const DAEMON_PORT_SPAN = 5;

/**
 * The preferred port followed by up to DAEMON_PORT_SPAN - 1 deterministic
 * alternatives inside the 8792–8796 span, no duplicates, preferred always
 * first. A preferred port OUTSIDE the span (a documented env override, for
 * example) disables the fallback by construction: only that port is returned.
 */
export function candidatePorts(preferred: number): number[] {
  const first = DEFAULT_DAEMON_PORT;
  const last = DEFAULT_DAEMON_PORT + DAEMON_PORT_SPAN - 1;
  if (preferred < first || preferred > last) return [preferred];
  const rest: number[] = [];
  for (let p = first; p <= last; p++) {
    if (p !== preferred) rest.push(p);
  }
  return [preferred, ...rest];
}

/** Why a candidate port was picked (or why none was). */
export type DaemonPortReason = "reused" | "preferred" | "fallback" | "none";

export interface DaemonPortPick {
  port: number;
  reason: DaemonPortReason;
}

/**
 * Walk the candidates in order and return the first one that either already
 * runs OUR daemon (proven identity → "reused", the caller adopts it instead of
 * spawning) or is free to bind ("preferred" for the first candidate,
 * "fallback" otherwise). Probe failures only discard the candidate — they are
 * never propagated. When every candidate fails, the preferred port is returned
 * with reason "none" so the caller spawns on it and the existing EADDRINUSE
 * diagnosis (P2-140) keeps explaining the outcome.
 */
export async function pickDaemonPort(
  ports: number[],
  isFree: (p: number) => Promise<boolean>,
  isOurDaemon: (p: number) => Promise<boolean>,
): Promise<DaemonPortPick> {
  for (const port of ports) {
    try {
      // Identity first, and isFree is not even consulted for it: a port our
      // daemon already owns is NOT free, but adopting it beats spawning.
      if (await isOurDaemon(port)) return { port, reason: "reused" };
      if (await isFree(port)) {
        return { port, reason: port === ports[0] ? "preferred" : "fallback" };
      }
    } catch {
      // A probe that throws (EACCES, aborted fetch, …) only discards the
      // candidate; the walk continues.
    }
  }
  return { port: ports[0] ?? DEFAULT_DAEMON_PORT, reason: "none" };
}
