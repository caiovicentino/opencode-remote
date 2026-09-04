/** P2-112: first-boot degraded journey decision logic. Pure on purpose —
 * scripts/unit.test.ts asserts the exact copy/title each branch produces,
 * so a dead daemon on first boot can never regress into a dead-end or an
 * accusatory red alert for a daemon the machine has never met. */

export type DegradedKind = "none" | "first-contact" | "reconnecting" | "down";

/** Narrow view of the shell's PairingState (apps/desktop/src/preload.ts) that
 * the degraded journey reasons about. */
export interface DegradedState {
  reconnecting?: boolean;
  daemonDown?: boolean;
  /** Healthy and mismatch polls carry the live daemon's version. */
  daemonVersion?: string | null;
  versionMismatch?: boolean;
  mode?: "local" | "remote";
}

/** True once a live daemon answered at least one health poll on this machine
 * (healthy probe, mismatch verdict or a proved local auto-connect). Decides
 * whether a later outage is an incident (red, "daemon fell") or still a first
 * contact (calm, non-accusatory copy). */
export function sawHealthyDaemon(state: DegradedState | null): boolean {
  return (
    !!state &&
    (state.daemonVersion != null || state.versionMismatch === true || state.mode === "local")
  );
}

/** Which degraded journey the unpaired desktop shell should show. An adopted
 * daemon going missing is always reconnecting (the watchdog never gives up);
 * a sidecar that exhausted its respawn budget is "down" — an incident only if
 * the daemon was ever seen, otherwise still a first contact. */
export function degradedKind(state: DegradedState | null, everSeen: boolean): DegradedKind {
  if (state?.reconnecting) return "reconnecting";
  if (state?.daemonDown) return everSeen ? "down" : "first-contact";
  return "none";
}
