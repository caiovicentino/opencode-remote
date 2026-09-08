/**
 * P3-345: stop a child process and wait for its REAL exit.
 *
 * reconnect.test.ts used to `daemon.kill("SIGTERM")`, sleep a fixed 1s and
 * spawn the replacement. The daemon's graceful shutdown drains for up to
 * DRAIN_MS = 3s (apps/daemon/src/shutdown.ts), so for up to ~2s TWO daemons
 * sat in the same relay room and the relay — a blind round-robin router —
 * split one client's frames between them: the upload landed on the new
 * daemon, the message post on the old one, which answered 410 "attachment
 * expired" (CI run 34281044412, 2026-09-08 21:33Z). This helper replaces the
 * sleep with the `exit` event, escalating to SIGKILL after `graceMs` so a
 * wedged process can never hang the gate. Pure over the injected child: no
 * spawn, no fs, no globals beyond timers — the unit battery drives it with a
 * fake child.
 */

/** The slice of ChildProcess this helper needs (a fake is trivial). */
export interface Stoppable {
  exitCode: number | null;
  signalCode: string | null;
  once(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: string): boolean;
}

export interface StopOutcome {
  /** true when the process only left after the SIGKILL escalation */
  forced: boolean;
  code: number | null;
  signal: string | null;
}

/** Default grace between the polite signal and SIGKILL. */
export const STOP_GRACE_MS = 10_000;

/**
 * Send `signal` (default SIGTERM), resolve when the child reports `exit`.
 * Escalates to SIGKILL after `graceMs`; if the child is STILL alive `graceMs`
 * after that, rejects (a stuck kernel-level process is a test bug worth a
 * loud failure, never a silent pass). A child that already exited resolves
 * immediately without signalling.
 */
export function stopAndAwaitExit(
  child: Stoppable,
  opts: { signal?: string; graceMs?: number } = {},
): Promise<StopOutcome> {
  const signal = opts.signal ?? "SIGTERM";
  const graceMs = opts.graceMs ?? STOP_GRACE_MS;
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ forced: false, code: child.exitCode, signal: child.signalCode });
  }
  return new Promise<StopOutcome>((resolve, reject) => {
    let forced = false;
    const killer = setTimeout(() => {
      forced = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone: the exit listener below still fires
      }
      hard = setTimeout(() => reject(new Error(`process still alive ${graceMs}ms after SIGKILL`)), graceMs);
    }, graceMs);
    let hard: ReturnType<typeof setTimeout> | null = null;
    child.once("exit", (code, sig) => {
      clearTimeout(killer);
      if (hard) clearTimeout(hard);
      resolve({ forced, code, signal: sig });
    });
    try {
      child.kill(signal);
    } catch {
      // kill() throwing means the process is gone or unkillable — the exit
      // listener or the SIGKILL escalation decides
    }
  });
}
