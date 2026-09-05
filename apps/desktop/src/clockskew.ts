// P2-214: clock-skew classifier for the macOS first-boot pairing journey. A
// machine whose clock is far ahead of or behind the truth makes the phone's
// browser refuse the hosted relay's certificate (the validity window no
// longer covers the phone's "now"), closes the P2-190 pairing window at an
// unpredictable local-clock instant and skews every timestamp the phone is
// shown — all with no line explaining why, the same class of late, mute
// failure the P2-197/P2-199/P2-211 verdicts closed on other layers. This
// module compares the machine's clock against the Date response header of the
// SAME answer the P2-197 reach probe already obtained — no new request, no
// time server, no clock fixing.
//
// Same module hygiene as webreach.ts / relaylink.ts / installloc.ts: NO
// electron, NO node:fs, no fetch, no I/O — main.ts performs the real probe
// and reads the real clock at runtime and scripts/unit.test.ts exercises
// every branch in plain Node. Messages are static, actionable pt-BR with no
// file paths, no URL schemes and no secrets (the P2-140 bar).
//
// Scope note (by design): the verdict only ever explains and points at the
// automatic date/time action. It never calls a clock-setting API, never
// queries a time server and — crucially — NEVER blocks pairing nor hides the
// QR: a wrong clock does not stop pairing from working right now.

/**
 * Documented base tolerance for the comparison. Consumer-grade clocks drift
 * by seconds; a machine off by more than this is wrong in the way that breaks
 * certificate validity windows. The classifier widens it by half the probe's
 * elapsed ms (see skewVerdict) so network latency is never mistaken for a
 * wrong clock.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 120_000;

export type ClockSkewState = "ok" | "ahead" | "behind" | "unknown";

export interface ClockSkewVerdict {
  state: ClockSkewState;
  /** Short actionable pt-BR phrase — static, never carries a path or URL. */
  message: string;
  /** Signed offset local − server reference in ms (positive = the local
   * clock is ahead). null when there was no reference to compare against. */
  skewMs: number | null;
}

/** Static copy per state, reused verbatim by the pairing payload, the test
 * hatch and the diagnostics line so every surface says the same sentence. */
export function clockSkewMessage(state: ClockSkewState): string {
  switch (state) {
    case "ok":
      return "o relógio desta máquina está no trilho — nada a fazer";
    case "ahead":
      return "o relógio desta máquina está adiantado — ative o ajuste automático de data e hora nas configurações do sistema e reabra o app";
    case "behind":
      return "o relógio desta máquina está atrasado — ative o ajuste automático de data e hora nas configurações do sistema e reabra o app";
    case "unknown":
      return "não deu para conferir o relógio desta máquina — o app segue funcionando normalmente";
  }
}

/**
 * Compare the local clock against the raw Date response header of the reach
 * probe's own answer. Deterministic and secret-free.
 *
 * - Missing, empty or unparseable header → unknown with neutral wording that
 *   never accuses a failure (an absent reference is not evidence of one).
 * - The offset is local − server; the probe's elapsed ms is added to the
 *   tolerance at half weight because the header is written when the server
 *   handles the request, so a slow round trip biases the offset by up to the
 *   return leg — a slow probe must read as ok, never as a wrong clock.
 */
export function skewVerdict(localNowMs: number, rawDateHeader: string | null, elapsedMs: number): ClockSkewVerdict {
  const headerText = typeof rawDateHeader === "string" ? rawDateHeader.trim() : "";
  const headerMs = headerText === "" ? NaN : Date.parse(headerText);
  if (!Number.isFinite(headerMs)) {
    return { state: "unknown", message: clockSkewMessage("unknown"), skewMs: null };
  }
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  const offsetMs = localNowMs - headerMs;
  const tolerance = CLOCK_SKEW_TOLERANCE_MS + elapsed / 2;
  if (offsetMs > tolerance) {
    return { state: "ahead", message: clockSkewMessage("ahead"), skewMs: offsetMs };
  }
  if (offsetMs < -tolerance) {
    return { state: "behind", message: clockSkewMessage("behind"), skewMs: offsetMs };
  }
  return { state: "ok", message: clockSkewMessage("ok"), skewMs: offsetMs };
}
