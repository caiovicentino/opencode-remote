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

/** P3-331: the shell's local verdict is STICKY for the whole session. A poll
 * gap (state null) or a degraded push (daemon down) must never resurrect the
 * "connect to another machine" ceremony on a machine the shell already proved
 * local — only an explicit remote-pairing request (mode "remote") unsets it. */
export function nextShellLocal(current: boolean, state: DegradedState | null): boolean {
  if (state?.mode === "local") return true;
  if (state?.mode === "remote") return false;
  return current;
}

/** P3-331: when may the renderer (re-)run the local auto-connect? The mount
 * run and the P1-053 recovery watcher share this decision. "unpaired" keeps
 * the legacy arms (local verdict or a past outage — the manual pairing wall
 * dissolving on daemon recovery included); "error" is new and guarded: a
 * failed manual paste (pairManual/addingMachine) is never yanked mid-edit,
 * only the failed AUTO-connect retries once the daemon answers again. */
export function autoConnectAllowed(
  phase: "unpaired" | "connecting" | "paired" | "error",
  opts: { localMode: boolean; sawOutage: boolean; pairManual: boolean; addingMachine: boolean; hasStoredPairing: boolean },
): boolean {
  if (phase === "paired" || phase === "connecting") return false;
  if (opts.hasStoredPairing) return false;
  // Round 2 (review): an explicit manual request — the degraded journey's
  // "pair manually" escape or the add-machine screen — must never be yanked
  // by the auto-connect loop on the next 3s poll (P3-332's dead-end class).
  if (opts.pairManual || opts.addingMachine) return false;
  if (phase === "unpaired") return opts.localMode || opts.sawOutage;
  return opts.localMode;
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

/** P2-140: tolerant view of the shell's `sidecarExit` object (the desktop's
 * daemon-sidecar exit verdict). Fields are validated, never trusted — absent
 * before the first unintentional exit. */
export interface SidecarExitHealth {
  kind?: unknown;
  reason?: unknown;
  hint?: unknown;
}

/** One sidecar-exit warning: i18n keys for headline + suggested action, so
 * the copy goes through useT (pt-BR + en) and never includes file paths,
 * tokens or secrets — the classifier's reason/hint stay in the desktop log.
 * Rendered ONLY inside the degraded calm card (P2-108 single-surface rule). */
export interface SidecarExitNotice {
  titleKey: string;
  actionKey: string;
}

/** Map the P2-140 exit kind to a user-facing warning. Returns null for an
 * absent/malformed object — silence is always safe. All five kinds map to a
 * notice: the shell only attaches the object when the daemon actually died. */
export function sidecarExitNotice(exit: SidecarExitHealth | null | undefined): SidecarExitNotice | null {
  const kind = typeof exit?.kind === "string" ? exit.kind : "";
  switch (kind) {
    case "port-busy":
      return { titleKey: "sidecarPortBusyTitle", actionKey: "sidecarPortBusyAction" };
    case "entry-missing":
      return { titleKey: "sidecarEntryMissingTitle", actionKey: "sidecarEntryMissingAction" };
    case "runtime-error":
      return { titleKey: "sidecarRuntimeErrorTitle", actionKey: "sidecarRuntimeErrorAction" };
    case "killed":
      return { titleKey: "sidecarKilledTitle", actionKey: "sidecarKilledAction" };
    case "unknown":
      return { titleKey: "sidecarUnknownTitle", actionKey: "sidecarUnknownAction" };
    default:
      return null;
  }
}
