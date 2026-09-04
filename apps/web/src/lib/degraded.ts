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

/** P2-138: tolerant view of the daemon's /api/health `opencode` object (the
 * P2-135 classifier verdict). Fields are validated, never trusted — a legacy
 * daemon omits the object entirely. */
export interface UpstreamHealth {
  state?: unknown;
  reason?: unknown;
  hint?: unknown;
  checkedAt?: unknown;
}

export type UpstreamNoticeTone = "warn" | "info";

/** One upstream notice: tone (drives the accent of the single in-card block),
 * i18n keys for headline + suggested action, and the daemon's own reason/hint
 * as SECONDARY detail — plain strings rendered by React as text, never HTML. */
export interface UpstreamNotice {
  tone: UpstreamNoticeTone;
  titleKey: string;
  actionKey: string;
  reason: string;
  hint: string;
}

/** Map the P2-135 classifier state to a user-facing notice. Returns null for
 * `ok` (nothing to say), `unknown` (first probe pending), an absent object
 * (legacy daemon) and any malformed payload — silence is always safe. The
 * classifier has exactly five states; the four non-ok ones map to notices. */
export function upstreamNotice(health: UpstreamHealth | null | undefined): UpstreamNotice | null {
  const state = typeof health?.state === "string" ? health.state : "";
  const reason = typeof health?.reason === "string" ? health.reason : "";
  const hint = typeof health?.hint === "string" ? health.hint : "";
  switch (state) {
    case "unauthorized":
      return { tone: "warn", titleKey: "upstreamUnauthorizedTitle", actionKey: "upstreamUnauthorizedAction", reason, hint };
    case "unreachable":
      return { tone: "info", titleKey: "upstreamUnreachableTitle", actionKey: "upstreamUnreachableAction", reason, hint };
    case "timeout":
      return { tone: "warn", titleKey: "upstreamTimeoutTitle", actionKey: "upstreamTimeoutAction", reason, hint };
    case "unhealthy":
      return { tone: "warn", titleKey: "upstreamUnhealthyTitle", actionKey: "upstreamUnhealthyAction", reason, hint };
    default:
      return null;
  }
}
