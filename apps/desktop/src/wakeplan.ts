// P2-209: pure wake-reaction planner for the desktop shell. A Mac that sleeps
// overnight can wake with the daemon sidecar either out of respawn budget
// (gave up) or with its next retry minutes away — and the stage-3 user holding
// the phone finds no machine, even though the app is open and paired, until
// someone walks up to the computer. This module decides WHAT the shell should
// do the moment the OS reports the machine is back: probe the daemon's health
// right away (the pairing tick's own probe), reset-and-respawn it through the
// already-exported restart, or ignore the event entirely.
//
// Same module hygiene as sidecarexit.ts / relaylink.ts: NO electron, no
// node:fs, no fetch, no I/O of any kind — main.ts reads the OS signals and
// applies the verdict, and scripts/unit.test.ts exercises every rule in plain
// Node. The reason is a short, static pt-BR string with no file paths, no URL
// schemes and no secrets (the P2-140 bar).

/** The powerMonitor events the shell reacts to: the machine came back from
 * sleep (resume) and the user unlocked the session (unlock-screen). Anything
 * else — suspend, lock-screen, on-battery, … — is outside the vocabulary and
 * is always ignored: going to sleep needs no reaction. */
export type WakeEventType = "resume" | "unlock-screen";

/** Documented vocabulary of handled system events. */
export const WAKE_EVENT_TYPES: readonly WakeEventType[] = ["resume", "unlock-screen"];

/** Documented debounce window (ms): resume and unlock-screen fire close
 * together when a laptop wakes, and each handled event costs at most one
 * probe/respawn — so a repeat inside the window is always ignored. */
export const WAKE_DEBOUNCE_MS = 10_000;

/** Documented wait ceiling (ms): when the respawn the backoff already
 * scheduled sits farther away than this, the wake reaction anticipates the
 * attempt instead of making the phone wait. Matches the shell's
 * adopted-daemon reconnect cap (P1-053) — waits beyond it are exactly the
 * "next retry minutes away" incident this reaction exists to kill. */
export const RESPAWN_WAIT_CEILING_MS = 30_000;

export type WakeAction = "probe-now" | "reset-and-respawn" | "ignore";

export interface WakePlanVerdict {
  action: WakeAction;
  /** Short pt-BR motive — static, path-free, scheme-free, secret-free. */
  reason: string;
}

/** Everything the decision needs, resolved by the caller (main.ts) at event
 * time. null means "not applicable" (no previous handled event, no pending
 * respawn). `failures` rides along as context for the caller's log line. */
export interface WakePlanInput {
  /** The OS event type as powerMonitor reported it. */
  eventType: string;
  /** True once the sidecar's respawn budget is exhausted (gave up). */
  gaveUp: boolean;
  /** Consecutive respawn failures so far (log context; never escalates). */
  failures: number;
  /** Ms until the respawn the backoff already scheduled (null when none). */
  msUntilNextRespawn: number | null;
  /** The daemon's health at the last pairing tick (true = answered 200). */
  daemonHealthy: boolean;
  /** Ms since the last event this shell actually handled (null = none yet). */
  msSinceLastHandled: number | null;
}

/** Narrow a raw OS event name against the documented vocabulary. */
export function isWakeEventType(eventType: string): eventType is WakeEventType {
  return (WAKE_EVENT_TYPES as readonly string[]).includes(eventType);
}

/**
 * Decide the shell's reaction to one wake-related OS event. Rules apply in
 * this exact order:
 *
 *  1. a repeat inside the documented debounce window is always ignored (even
 *     with an exhausted budget) — the first event already acted;
 *  2. an event type outside the documented vocabulary is ignored — going to
 *     sleep needs no reaction;
 *  3. a daemon that was healthy at the last tick only needs confirmation —
 *     probe now;
 *  4. an exhausted respawn budget is the terminal state the backoff cannot
 *     leave on its own — reset and respawn;
 *  5. a scheduled respawn farther away than the documented ceiling is worth
 *     anticipating — reset and respawn now;
 *  6. everything else (fresh crash being retried soon, adopted daemon being
 *     probed, nothing wrong at all) is covered by the next probe — probe now.
 */
export function wakePlan(input: WakePlanInput): WakePlanVerdict {
  if (input.msSinceLastHandled !== null && input.msSinceLastHandled < WAKE_DEBOUNCE_MS) {
    return { action: "ignore", reason: "evento repetido dentro da janela de debounce" };
  }
  if (!isWakeEventType(input.eventType)) {
    return { action: "ignore", reason: "evento de sistema fora do vocabulário de retorno de suspensão" };
  }
  if (input.daemonHealthy) {
    return { action: "probe-now", reason: "daemon saudável no último tick — confirmando a saúde agora" };
  }
  if (input.gaveUp) {
    return { action: "reset-and-respawn", reason: "orçamento de respawn esgotado — recomeçando o daemon" };
  }
  if (input.msUntilNextRespawn !== null && input.msUntilNextRespawn > RESPAWN_WAIT_CEILING_MS) {
    return { action: "reset-and-respawn", reason: "respawn agendado para longe — antecipando a tentativa" };
  }
  return { action: "probe-now", reason: "máquina de volta — conferindo o daemon agora" };
}
