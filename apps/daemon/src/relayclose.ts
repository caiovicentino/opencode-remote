// P2-156: close-code triage for the daemon's relay socket. Pure module — no
// ws/net imports on purpose, because index.ts runs main() on import and unit
// tests must never boot a daemon (same pattern as relayretry.ts / relayurl.ts).
//
// The relay refuses sockets with distinct close codes (apps/relay/src: 1013
// "server busy" / "too many connections" / "room full", 4029 "rate limited",
// 1001 on drain) but the close handler used to fold every code into the same
// 2s backoff, hammering a saturated relay as if the network had dropped. The
// verdict here guides the reconnect pacing: a capacity close floors the wait
// so the daemon stops kicking a full relay, while a transient drop keeps the
// P2-129 jittered curve untouched.
//
// The short pt-BR hints are operator-facing log/health copy: no paths, no
// URLs, no tokens, no room ids — and the raw close reason never leaves this
// module.

export type RelayCloseKind = "capacity" | "rate-limited" | "draining" | "normal" | "transient";

/** Codes the relay actually emits (apps/relay/src). */
export const RELAY_CLOSE_CAPACITY_CODE = 1013;
export const RELAY_CLOSE_RATE_LIMITED_CODE = 4029;
export const RELAY_CLOSE_DRAINING_CODE = 1001;
export const RELAY_CLOSE_NORMAL_CODE = 1000;

/** Minimum wait before re-dialing, per kind. Transient keeps the P2-129 curve. */
export const RELAY_CLOSE_FLOOR_MS: Record<RelayCloseKind, number> = {
  capacity: 30_000,
  "rate-limited": 60_000,
  draining: 0,
  normal: 0,
  transient: 0,
};

const HINTS: Record<RelayCloseKind, string> = {
  capacity: "relay lotado: aguardando vaga antes de reconectar",
  "rate-limited": "relay limitando o ritmo: reconexão espaçada",
  draining: "relay em desligamento: reconexão quando voltar",
  normal: "conexão encerrada pelo relay",
  transient: "queda de conexão com o relay: tentando de novo",
};

export interface RelayCloseVerdict {
  kind: RelayCloseKind;
  /** Minimum wait in ms before the next dial (0 = follow the retry schedule). */
  floorMs: number;
  /** Short pt-BR hint for logs — no path, URL, token or room id. */
  hint: string;
}

/**
 * Classify a relay socket close. The code decides; the reason text is
 * corroboration only (empty or unknown reasons still classify by code), so
 * the raw reason is never needed beyond this call. A missing/abnormal code
 * (1006-style abrupt drop) is transient.
 */
export function classifyRelayClose(code: number | undefined, _reason?: string): RelayCloseVerdict {
  let kind: RelayCloseKind;
  switch (code) {
    case RELAY_CLOSE_CAPACITY_CODE:
      kind = "capacity";
      break;
    case RELAY_CLOSE_RATE_LIMITED_CODE:
      kind = "rate-limited";
      break;
    case RELAY_CLOSE_DRAINING_CODE:
      kind = "draining";
      break;
    case RELAY_CLOSE_NORMAL_CODE:
      kind = "normal";
      break;
    default:
      kind = "transient";
      break;
  }
  return { kind, floorMs: RELAY_CLOSE_FLOOR_MS[kind], hint: HINTS[kind] };
}

/**
 * Effective reconnect delay: the retry schedule (jittered P2-129 curve) never
 * shortens below the kind's floor, and a floor of 0 defers entirely to it.
 */
export function effectiveRetryDelayMs(jitteredMs: number, verdict: RelayCloseVerdict): number {
  return Math.max(jitteredMs, verdict.floorMs);
}
