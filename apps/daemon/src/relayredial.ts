// P2-327: pure redial planner for the daemon's relay reconnect. No I/O, no
// ws/net/tls, no timers, no node:fs — index.ts runs main() on import, so unit
// tests must never boot a daemon (same pattern as relayclose.ts /
// relaydialerror.ts / relayretry.ts).
//
// The daemon schedules its relay reconnection with a plain setTimeout and no
// dial-in-flight flag, so nothing could anticipate the wait: a Mac that wakes
// without DNS leaves the phone waiting out the full dial-error floor (60s for
// an unresolved name, a refusal or a timeout — relaydialerror.ts) or the
// jittered P2-129 backoff, even though the machine is already awake. The
// desktop shell now asks the daemon to redial (POST /__ocr/relay/redial) and
// relayRedialPlan decides whether that is safe. The rules are consulted in
// THIS order:
//   1. a disabled relay never redials (connectRelay would refuse anyway);
//   2. a connected relay has nothing to anticipate;
//   3. a dial already in flight must never become a second socket;
//   4. with no retry scheduled there is no timer to clear — redialing would
//      mint a duplicate socket;
//   5. a floor that came from a relay CLOSE code (1013 capacity / 4029
//      rate-limited — relayclose.ts) is ALWAYS honored: the relay itself asked
//      for backoff, and no client may hammer it through this route;
//   6. the endpoint is throttled to one anticipation per
//      RELAY_REDIAL_THROTTLE_MS;
//   7. only then a pending plain-backoff wait or a LOCAL dial-error floor is
//      anticipated (redial-now).
// Reasons are stable strings: they ride the HTTP response and the desktop
// log verbatim (action + reason, nothing else).

/** Which floor the currently scheduled reconnect wait carries. */
export type RelayFloorSource = "none" | "dial-error" | "relay-close";

/** Documented throttle window between two anticipations (10s). */
export const RELAY_REDIAL_THROTTLE_MS = 10_000;

export interface RelayRedialInput {
  /** RELAY_URL failed boot validation — connectRelay refuses to dial. */
  relayDisabled: boolean;
  /** The relay socket is open. */
  connected: boolean;
  /** A WebSocket was created and has not reached open or close yet. */
  dialInFlight: boolean;
  /** A reconnect timer is scheduled. */
  retryPending: boolean;
  /** Which floor the scheduled wait carries (a relay-close floor is honored). */
  floorSource: RelayFloorSource;
  /** ms since the last anticipation (null = never redialed in this boot). */
  msSinceLastRedial: number | null;
}

export type RelayRedialAction = "redial-now" | "noop";

export type RelayRedialReason =
  | "disabled"
  | "connected"
  | "dialing"
  | "nothing-pending"
  | "relay-asked-backoff"
  | "throttled"
  | "retry-anticipated";

export interface RelayRedialVerdict {
  action: RelayRedialAction;
  reason: RelayRedialReason;
}

export function relayRedialPlan(input: RelayRedialInput): RelayRedialVerdict {
  if (input.relayDisabled) return { action: "noop", reason: "disabled" };
  if (input.connected) return { action: "noop", reason: "connected" };
  if (input.dialInFlight) return { action: "noop", reason: "dialing" };
  if (!input.retryPending) return { action: "noop", reason: "nothing-pending" };
  if (input.floorSource === "relay-close") return { action: "noop", reason: "relay-asked-backoff" };
  if (input.msSinceLastRedial !== null && input.msSinceLastRedial < RELAY_REDIAL_THROTTLE_MS) {
    return { action: "noop", reason: "throttled" };
  }
  return { action: "redial-now", reason: "retry-anticipated" };
}

export interface RelayRedialGateInput {
  /** HTTP method of the incoming request. */
  method: string | undefined;
  /** Raw Authorization header of the incoming request. */
  authorization: string | undefined;
  /** The daemon's apiToken from the 0600 state file. */
  apiToken: string;
}

export type RelayRedialGateVerdict = "ok" | "unauthorized" | "method-not-allowed";

/**
 * The route's HTTP contract, pure so unit tests pin it without booting a
 * daemon: Bearer apiToken or 401 — a session cookie NEVER counts, the gate
 * only ever sees the Authorization header, mirroring POST /api/session —
 * then 405 for any method other than POST.
 */
export function relayRedialGate(req: RelayRedialGateInput): RelayRedialGateVerdict {
  if (req.authorization !== `Bearer ${req.apiToken}`) return "unauthorized";
  if (req.method !== "POST") return "method-not-allowed";
  return "ok";
}
