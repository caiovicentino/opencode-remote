// P2-307: the apply-decision for a freshly saved machine-proxy choice. Until
// now the choice only took effect on the next app start (one English log line
// was its only proof), while the relay address beside it applied instantly —
// on a corporate machine the owner just said where the internet exits and the
// running session kept the old proxy anyway, leaving the P2-303 relay link
// dead with no explanation. This module owns the DECISION of what a save
// means RIGHT NOW: nothing (keep), the session rule only (apply-session) or
// the session rule plus a sidecar restart (apply-session-and-restart) so the
// daemon re-dials through the new proxy.
//
// Same module hygiene as proxyplan.ts / updateguard.ts: NO electron, no
// node:fs, no node:child_process, no fetch, no I/O of any kind — main.ts
// feeds it the verdict in effect (remembered since boot) and the verdict
// resolved from the freshly saved choice, both computed by proxyplan.ts on
// the SAME boot path, and scripts/unit.test.ts exercises every transition in
// plain Node.
//
// FAIL-CLOSED: an input that is missing, not a plain object or carrying a
// field outside the documented shape is a keep — NOTHING is applied and the
// sidecar is NOT restarted. Restarting the sidecar without need drops the
// phone's live conversation, so an unreadable state must never be a reason
// to act. The result is identical for the same input on every call and
// nothing is ever thrown.
//
// PRIVACY BOUNDARY: the reasons are static pt-BR phrases — no address, no
// rule text, no environment variable, no path ever appears in a reason (the
// P2-182 redaction bar; the log line built from it is safe by construction).

/** The three possible answers. "keep" changes nothing, "apply-session"
 * reconfigures only the running Electron session, "apply-session-and-restart"
 * ALSO restarts the daemon sidecar (the address it dials with changed). */
export type ProxyApplyKind = "keep" | "apply-session" | "apply-session-and-restart";

export interface ProxyApplyVerdict {
  kind: ProxyApplyKind;
  /** Short static pt-BR phrase for the decision — log-safe by contract. */
  reason: string;
}

/** What main.ts remembers per verdict: the session-facing proxyplan.ts fields
 * that feed setProxy (mode, rule, exceptions) plus the address that rides to
 * every sidecar spawn (OCR_RELAY_PROXY), or null when none applies. Fields
 * are typed unknown on purpose — the input may come from any state the main
 * process holds, so nothing is trusted. */
export interface ProxyApplySnapshot {
  mode?: unknown;
  rule?: unknown;
  exceptions?: unknown;
  /** The sidecar-facing address (string) or null — the P2-303 semantics live
   * in the caller; here it is just the compared value. */
  relayProxy?: unknown;
}

const REASON_KEEP = "escolha de proxy igual à que já está em vigor — sessão e sidecar seguem como estão";
const REASON_APPLY_SESSION = "escolha de proxy nova aplicada na sessão em execução";
const REASON_APPLY_RESTART = "escolha de proxy nova aplicada na sessão e sidecar reiniciado para enxergar o novo endereço";
const REASON_UNREADABLE = "estado de proxy ilegível — nada é aplicado agora para não derrubar a conversa em andamento";

/** Compact one side snapshot into the exact compared shape, or null when the
 * state is unreadable (fail-closed → keep): the input must be a plain object
 * with a textual mode and rule, a string-list exceptions array and a
 * relayProxy that is a string or null. */
function snapshot(raw: unknown): { mode: string; rule: string; exceptions: string; relayProxy: string | null } | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const s = raw as ProxyApplySnapshot;
  if (typeof s.mode !== "string" || s.mode === "") return null;
  if (typeof s.rule !== "string") return null;
  if (!Array.isArray(s.exceptions) || !s.exceptions.every((entry) => typeof entry === "string")) return null;
  if (s.relayProxy !== null && typeof s.relayProxy !== "string") return null;
  return {
    mode: s.mode,
    rule: s.rule,
    exceptions: JSON.stringify(s.exceptions),
    relayProxy: s.relayProxy,
  };
}

/**
 * The one pure decision of this module. Deterministic: the same inputs yield
 * the exact same verdict on every call, and nothing is ever thrown. The
 * sidecar surface wins: when the address traveling to the sidecar changes the
 * answer is apply-session-and-restart even if the session rule also changed —
 * the session is re-applied alongside the restart by the caller.
 */
export function proxyApplyDecision(inEffect: unknown, resolved: unknown): ProxyApplyVerdict {
  const before = snapshot(inEffect);
  const after = snapshot(resolved);
  if (!before || !after) {
    return { kind: "keep", reason: REASON_UNREADABLE };
  }
  const sessionChanged =
    before.mode !== after.mode || before.rule !== after.rule || before.exceptions !== after.exceptions;
  const sidecarChanged = before.relayProxy !== after.relayProxy;
  if (sidecarChanged) return { kind: "apply-session-and-restart", reason: REASON_APPLY_RESTART };
  if (sessionChanged) return { kind: "apply-session", reason: REASON_APPLY_SESSION };
  return { kind: "keep", reason: REASON_KEEP };
}
