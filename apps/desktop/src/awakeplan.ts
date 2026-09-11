// P3-409: pure keep-awake planner for the desktop shell. A long run requested
// from the phone dies when the machine drifts into idle sleep mid-turn — the
// shell never held the machine awake (nothing in apps/desktop used
// powerSaveBlocker) and wakeplan.ts (P2-209) only reacts AFTER the machine
// comes back. This module decides WHEN the shell should hold the machine
// awake (powerSaveBlocker "prevent-app-suspension", applied by main.ts) and
// when it must let go.
//
// Same module hygiene as wakeplan.ts / sidecarexit.ts: NO electron, no
// node:fs, no fetch, no I/O of any kind — main.ts owns every blocker call and
// scripts/unit.test.ts exercises every rule in plain Node. The reason is a
// short, static pt-BR string with no file paths, no URL schemes and no
// secrets (the P2-140 bar).
//
// Rule order — evaluated exactly in this order, and the gate depends on it:
//   1. A hermetic test session ALWAYS releases. Consulted FIRST, before any
//      other consideration (P1-081/P2-221 lesson: tools/desktop.mjs and
//      test:desktop-flow run on the operator's machine and a test session
//      must never hold it awake). main.ts ALSO re-checks its test-session
//      flag before powerSaveBlocker.start — pinned by a source-reading
//      assertion in scripts/unit.test.ts.
//   2. Invalid input ALWAYS releases — never hold on doubt. A lost
//      nap-prevention is cheap; a machine that suspends mid-run because a
//      malformed push said "hold" is the exact failure this exists to kill.
//   3. The owner's choice (tray checkbox) off releases.
//   4. Zero busy sessions release.
//   5. The documented ceiling of 4 continuous hours of one busy period
//      releases — until the NEXT idle→busy transition. The caller owns
//      busySince and resets it exactly on that transition; this module never
//      resets it, so a run longer than the ceiling holds nothing and the
//      next run starts a fresh period.
//   6. Otherwise hold.

/** Documented continuous-hold ceiling (ms): after 4 hours of one busy period
 * the shell releases the blocker until the next idle→busy transition. A
 * backstop against a stuck count or a vanished renderer — never a feature. */
export const AWAKE_HOLD_CEILING_MS = 4 * 60 * 60 * 1000;

/** Documented inclusive upper bound of the busy count the shell accepts. */
export const AWAKE_COUNT_MAX = 999;

export type AwakeAction = "hold" | "release";

export interface AwakeVerdict {
  action: AwakeAction;
  /** Short pt-BR motive — static, path-free, scheme-free, secret-free. */
  reason: string;
}

export interface AwakeInput {
  /** Busy-session count as the renderer pushed it (validated here). */
  busyCount: unknown;
  /** Hermetic harness-session flag (OCR_DESKTOP_SESSION). */
  testSession: unknown;
  /** The owner's tray choice: "keep awake while the agent works". */
  ownerEnabled: unknown;
  /** Instant (ms) the current busy period began; null while idle. Must never
   * be in the future relative to `now` — that is invalid input (rule 2). */
  busySince: unknown;
  /** The current instant (ms). */
  now: unknown;
}

function isInt(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && Number.isInteger(n);
}

/** The same 0..999 integer validation the ocr:busy handler applies before
 * the verdict is ever consulted. */
export function sanitizeBusyCount(raw: unknown): number | null {
  if (!isInt(raw) || raw < 0 || raw > AWAKE_COUNT_MAX) return null;
  return raw;
}

/**
 * Decide whether the shell should hold the machine awake. Rules 1-6 from the
 * header apply in order; the function is pure and deterministic.
 */
export function awakePlan(input: AwakeInput): AwakeVerdict {
  // Rule 1 — the test session comes FIRST and always releases.
  if (input.testSession === true) {
    return { action: "release", reason: "sessão de teste — nunca segura a suspensão" };
  }
  // Rule 2 — invalid input releases; never hold on doubt.
  if (typeof input.testSession !== "boolean" || typeof input.ownerEnabled !== "boolean") {
    return { action: "release", reason: "entrada inválida — liberando por segurança" };
  }
  const count = sanitizeBusyCount(input.busyCount);
  const now = input.now;
  if (count === null || !isInt(now)) {
    return { action: "release", reason: "entrada inválida — liberando por segurança" };
  }
  const since = input.busySince;
  if (since !== null && (!isInt(since) || since > now)) {
    return { action: "release", reason: "entrada inválida — liberando por segurança" };
  }
  // Rule 3 — the owner's choice wins.
  if (!input.ownerEnabled) {
    return { action: "release", reason: "escolha do dono desligada — suspensão liberada" };
  }
  // Rule 4 — nothing busy, nothing to hold.
  if (count === 0) {
    return { action: "release", reason: "nenhum agente trabalhando — nada a segurar" };
  }
  // Rule 5 — the 4h ceiling of one continuous busy period: release until the
  // next idle→busy transition. A positive count with no recorded start is
  // just as unverifiable — release (rule 2's spirit, documented in rule 5).
  if (since === null || now - since >= AWAKE_HOLD_CEILING_MS) {
    return { action: "release", reason: "teto de 4 horas contínuas atingido — liberando até a próxima transição" };
  }
  // Rule 6 — the agent is working: hold.
  return { action: "hold", reason: "agente trabalhando — segurando a suspensão" };
}
