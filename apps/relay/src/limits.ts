/**
 * Relay admission limits (P2-141).
 *
 * Pure decision module: which ceiling applies to total sockets, per-room
 * peers and frame bytes, and whether the configured combination is valid at
 * all. Imports nothing (no node/http, no ws) so the wiring in index.ts stays
 * thin and the decisions stay unit-testable — same pattern as metricsbind.ts
 * and the `problems` format it established (P2-132).
 *
 * Fail-closed in the P2-114 spirit: a non-numeric, zero or negative value, a
 * per-room cap larger than the socket cap, or a frame cap above the protocol
 * ceiling are all problems. Any problem means the relay must not open its
 * listener: index.ts logs every reason once at boot and exits 1 instead of
 * serving with an absurd or unvalidated cap.
 *
 * The relay stays blind here too: only envelope-counter ceilings are
 * resolved — no plaintext, no key material, no room ids ever flow through
 * this module.
 */

export interface RelayLimits {
  /** Concurrent websocket ceiling (RELAY_MAX_SOCKETS). */
  maxSockets: number;
  /** Peer ceiling per room (RELAY_MAX_PER_ROOM). */
  maxPerRoom: number;
  /** Largest accepted frame in bytes (RELAY_MAX_FRAME_BYTES, ws maxPayload). */
  maxFrame: number;
  /** Drain grace before sockets close on shutdown (RELAY_DRAIN_GRACE_MS, P2-145). */
  drainGraceMs: number;
  /** Non-empty means the boot must NOT open the listener (fail-closed). */
  problems: string[];
}

/** Default frame cap in bytes; sealed op payloads are far smaller. */
export const MAX_FRAME = 1_000_000;

/** ws maxPayload is an int32; 16777216 == 0x00FFFFFF is the protocol ceiling. */
export const MAX_FRAME_CEILING = 16_777_216;

/**
 * P2-145: RELAY_DRAIN_GRACE_MS ceiling. The hard DRAIN_MS window (3000ms)
 * must keep covering grace + stopListeners + the 250ms settle, so the grace
 * alone may never reach the full drain budget.
 */
export const DRAIN_GRACE_MS_CEILING = 2000;

const DEFAULTS = { maxSockets: 1000, maxPerRoom: 10, maxFrame: MAX_FRAME, drainGraceMs: 0 } as const;

/**
 * Resolve the admission ceilings from the process env.
 *
 * - RELAY_MAX_SOCKETS: total concurrent websockets, default 1000.
 * - RELAY_MAX_PER_ROOM: peers per room, default 10.
 * - RELAY_MAX_FRAME_BYTES: frame cap in bytes, default 1000000.
 * - RELAY_DRAIN_GRACE_MS: LB-drain grace before sockets close, default 0 (P2-145).
 *
 * An absent or blank variable keeps the default — an empty env reproduces
 * the pre-P2-141 limits exactly. A present-but-invalid value never falls
 * back silently: it is reported as a problem so the boot can refuse to
 * start, unlike the soft envNum() fallbacks elsewhere in the relay.
 */
export function relayLimits(env: Record<string, string | undefined>): RelayLimits {
  const problems: string[] = [];
  const maxSockets = resolveLimit(env.RELAY_MAX_SOCKETS, DEFAULTS.maxSockets, "RELAY_MAX_SOCKETS", problems);
  const maxPerRoom = resolveLimit(env.RELAY_MAX_PER_ROOM, DEFAULTS.maxPerRoom, "RELAY_MAX_PER_ROOM", problems);
  const maxFrame = resolveLimit(env.RELAY_MAX_FRAME_BYTES, DEFAULTS.maxFrame, "RELAY_MAX_FRAME_BYTES", problems);
  const drainGraceMs = resolveDrainGrace(env.RELAY_DRAIN_GRACE_MS, problems);

  if (maxPerRoom > maxSockets) {
    problems.push(
      `RELAY_MAX_PER_ROOM=${maxPerRoom} is larger than RELAY_MAX_SOCKETS=${maxSockets}: ` +
        "a room can never legitimately hold more peers than the whole socket pool (fail-closed)",
    );
  }
  if (maxFrame > MAX_FRAME_CEILING) {
    problems.push(
      `RELAY_MAX_FRAME_BYTES=${maxFrame} is above the ${MAX_FRAME_CEILING} ceiling: ` +
        "ws maxPayload is an int32 and oversized frames only serve memory abuse (fail-closed)",
    );
  }
  return { maxSockets, maxPerRoom, maxFrame, drainGraceMs, problems };
}

/**
 * Resolve one numeric ceiling: unset/blank keeps the default, anything that
 * is not a finite positive number is a problem (recorded once per variable).
 */
function resolveLimit(raw: string | undefined, dflt: number, name: string, problems: string[]): number {
  if (raw === undefined || raw.trim() === "") return dflt;
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    problems.push(
      `${name}=${JSON.stringify(raw)} is not a numeric value: ` +
        "refusing to start with an unvalidated limit (fail-closed)",
    );
    return dflt;
  }
  if (v <= 0) {
    problems.push(
      `${name}=${JSON.stringify(raw)} must be a positive number: ` +
        "zero or negative would disable admission control outright (fail-closed)",
    );
    return dflt;
  }
  return v;
}

/**
 * P2-145: resolve the drain grace. Unlike the admission ceilings, zero is the
 * valid default here (it disables the grace and keeps the pre-P2-145
 * shutdown sequence); a negative value or anything above
 * DRAIN_GRACE_MS_CEILING is a problem — grace + settle must stay inside the
 * 3000ms DRAIN_MS hard window.
 */
function resolveDrainGrace(raw: string | undefined, problems: string[]): number {
  if (raw === undefined || raw.trim() === "") return DEFAULTS.drainGraceMs;
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    problems.push(
      "RELAY_DRAIN_GRACE_MS=" +
        JSON.stringify(raw) +
        " is not a numeric value: refusing to start with an unvalidated limit (fail-closed)",
    );
    return DEFAULTS.drainGraceMs;
  }
  if (v < 0) {
    problems.push(
      "RELAY_DRAIN_GRACE_MS=" +
        JSON.stringify(raw) +
        " must be a non-negative number: a negative grace would close sockets before the LB sees /healthz 503 (fail-closed)",
    );
    return DEFAULTS.drainGraceMs;
  }
  if (v > DRAIN_GRACE_MS_CEILING) {
    problems.push(
      "RELAY_DRAIN_GRACE_MS=" +
        JSON.stringify(raw) +
        ` is above the ${DRAIN_GRACE_MS_CEILING} ceiling: grace + settle must stay inside the 3000ms hard drain window (fail-closed)`,
    );
    return DEFAULTS.drainGraceMs;
  }
  return v;
}
