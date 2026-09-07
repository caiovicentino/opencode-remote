// P2-321: pure wedge verdict for the desktop shell's daemon sidecar — answers
// WHAT TO DO about a child that is still alive but stopped answering health
// probes (event loop pinned, port still bound). The existing supervision only
// sees a child that EXITS; a wedged daemon never exits, never triggers a
// respawn and is never noticed, leaving the phone hanging on a connection
// nothing will revive. The decision is made HERE, in one closed verdict set,
// and executed by daemon.ts (which owns the timers, the probing and the
// recovery through the existing respawn path).
//
// Same module hygiene as sidecarstop.ts / sidecarexit.ts: NO electron, no
// Node builtins, no timers, no fetch, no I/O of any kind — the unit tests
// evaluate this module in plain Node and assert the purity against the real
// file.
//
// CLOSED CONTRACT (the executor in daemon.ts depends on it):
//  1. the verdict is one of exactly four kinds — "observe" (keep watching),
//     "degraded" (report it, keep watching), "restart" (recover through the
//     existing respawn path) and "give-up" (stop recovering) — each with a
//     short static pt-BR message carrying no path, no port, no identifier
//     and no secret;
//  2. any unreadable input (non-object, missing, negative or non-numeric
//     counts, non-boolean flags) degrades to "observe" — garbage can never
//     trigger a destructive action, and nothing is ever thrown;
//  3. a stop or respawn already in flight is never interrupted: that is
//     always "observe", no matter how many probes failed;
//  4. a child that is not provably alive belongs to the exit/respawn path,
//     never to the wedge ladder — always "observe";
//  5. the ladder for a live, unanswered child is: fewer than
//     SIDECAR_WEDGE_PROBES_FOR_RESTART failed probes → "degraded"; at the
//     threshold with recoveries left → "restart"; with the budget spent →
//     "give-up";
//  6. the same input yields the exact same verdict on every call (pure —
//     no state, no clock, no randomness).

/** Health probes without an answer before the shell may attempt one
 * automatic recovery. With the executor's 10s probe interval this is ≥30s
 * of unresponsiveness — longer than any normal daemon boot. */
export const SIDECAR_WEDGE_PROBES_FOR_RESTART = 3;

/** Documented ceiling of CONSECUTIVE automatic recoveries: after one
 * wedge-driven recovery that does not bring a healthy daemon back, the shell
 * gives up instead of restart-looping against a wedged child. The counter
 * zeroes on the first healthy probe (executor side), so a recovery followed
 * by a genuinely healthy daemon starts a fresh budget. */
export const SIDECAR_WEDGE_MAX_RECOVERIES = 1;

export type SidecarWedgeKind = "observe" | "degraded" | "restart" | "give-up";

export interface SidecarWedgeVerdict {
  kind: SidecarWedgeKind;
  /** short static pt-BR phrase (desktop.log / pairing payload copy) */
  message: string;
}

export interface SidecarWedgeInput {
  /** consecutive health probes answered with silence */
  failedProbes?: unknown;
  /** true only when the child process is still running */
  childAlive?: unknown;
  /** true while an intentional stop or a respawn is already in flight */
  transitionInFlight?: unknown;
  /** consecutive wedge recoveries already spent (zeroed on first healthy probe) */
  recoveriesUsed?: unknown;
}

const OBSERVE: SidecarWedgeVerdict = {
  kind: "observe",
  message: "sonda de saúde do daemon local sem novidade; seguindo observando",
};
const DEGRADED: SidecarWedgeVerdict = {
  kind: "degraded",
  message: "daemon local demora a responder; seguindo observando de perto",
};
const RESTART: SidecarWedgeVerdict = {
  kind: "restart",
  message: "daemon local parou de responder; reiniciando automaticamente",
};
const GIVE_UP: SidecarWedgeVerdict = {
  kind: "give-up",
  message: "daemon local segue sem responder; reinício automático suspenso até reabrir o app",
};

/** Whole, non-negative integer — anything else (missing, negative,
 * non-numeric, fractional, NaN, Infinity) disqualifies the input. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * The one pure decision of this module. Deterministic and total: the same
 * input yields the exact same verdict on every call, and nothing is ever
 * thrown — every malformed shape degrades to "observe".
 */
export function planSidecarWedge(input?: unknown): SidecarWedgeVerdict {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return OBSERVE;
  const { failedProbes, childAlive, transitionInFlight, recoveriesUsed } = input as SidecarWedgeInput;
  if (!isCount(failedProbes)) return OBSERVE;
  if (typeof childAlive !== "boolean") return OBSERVE;
  if (typeof transitionInFlight !== "boolean") return OBSERVE;
  if (!isCount(recoveriesUsed)) return OBSERVE;
  // Never interrupt a stop or a respawn already in flight, and never act on
  // a child the exit path already owns — both stay "observe" forever.
  if (transitionInFlight) return OBSERVE;
  if (!childAlive) return OBSERVE;
  // Healthy probe (or nothing to react to yet): keep watching.
  if (failedProbes === 0) return OBSERVE;
  if (failedProbes < SIDECAR_WEDGE_PROBES_FOR_RESTART) return DEGRADED;
  if (recoveriesUsed < SIDECAR_WEDGE_MAX_RECOVERIES) return RESTART;
  return GIVE_UP;
}
