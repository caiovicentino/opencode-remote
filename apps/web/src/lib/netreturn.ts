/**
 * P3-425: decision module for the browser `online` event on the PWA client.
 *
 * Leaving the subway or switching Wi-Fi → 4G used to wait out the reconnect
 * backoff (up to 15 s), and a zombie socket still marked "paired" after the
 * network change only died on the 20–60 s heartbeat. This module keeps every
 * judgement pure: no DOM, no sockets, no timers. The client applies the
 * verdict through the same primitives the other recovery paths already use
 * (sendControl ping, forceReconnect, retryNow).
 */

/** What the client should do when the network comes back. */
export type NetworkReturnAction =
  | "retry-now" // not paired with a backoff pending — dial at once
  | "probe" // paired and recently seen — one ping to confirm liveness
  | "force-reconnect" // paired but stale — the socket is presumed dead
  | "ignore"; // intentional close, or a dial already in flight

/** A paired session silent for longer than this is presumed dead on return. */
export const NETWORK_RETURN_STALE_MS = 30_000;

export interface NetworkReturnInput {
  /** Current client status ("paired", "connecting", …). */
  status: string;
  /** Whether a reconnect backoff timer is armed (retryNow's precondition). */
  reconnectPending: boolean;
  /** The client closed on purpose (close/expire/reject/abandon) — never dial. */
  intentionalClose: boolean;
  /** Milliseconds elapsed since the last sealed frame from the daemon. */
  msSinceLastSeen: number;
}

/**
 * Fixed-order verdict, one cause per return:
 * 1. intentional close → ignore (a terminated client never dials again)
 * 2. paired + lastSeen above 30 s → force-reconnect (zombie socket)
 * 3. paired + fresh lastSeen → probe (ping with awaitingPong)
 * 4. not paired + pending backoff → retry-now (anticipate it)
 * 5. not paired without a timer (a dial is already in flight) → ignore
 */
export function networkReturnAction(input: NetworkReturnInput): NetworkReturnAction {
  if (input.intentionalClose) return "ignore";
  if (input.status === "paired") {
    return input.msSinceLastSeen > NETWORK_RETURN_STALE_MS ? "force-reconnect" : "probe";
  }
  return input.reconnectPending ? "retry-now" : "ignore";
}
