/**
 * Metrics endpoint binding decision (P2-132).
 *
 * Pure decision logic for the optional /metrics listener: which host/port
 * to bind, whether a bearer token guards it, and whether the boot may start
 * the listener at all. Like ipcap.ts and ratelimit.ts this module imports
 * nothing (no node/http/ws), so the wiring in index.ts stays thin and the
 * decisions stay unit-testable.
 *
 * Fail-closed in the P2-114 spirit: binding a non-loopback address without
 * RELAY_METRICS_TOKEN is reported as a problem and the listener must not
 * start — an unauthenticated metrics endpoint exposed to the network is
 * never the lesser evil; the reason is logged once at boot instead. A
 * loopback bind without a token keeps the exact pre-P2-132 behavior.
 *
 * The relay stays blind here too: the endpoint exposes envelope counters
 * only — no plaintext frames, no key material, no room ids ever flow
 * through this decision or the listener it gates.
 */

export interface MetricsBinding {
  /** TCP port for the metrics listener; 0 = endpoint off. */
  port: number;
  /** Host/interface to bind; defaults to the loopback 127.0.0.1. */
  host: string;
  /** Configured bearer token; "" when the endpoint is unauthenticated. */
  token: string;
  /** Non-empty means the boot must NOT start the listener (fail-closed). */
  problems: string[];
}

export const METRICS_BIND_DEFAULT = "127.0.0.1";

/**
 * Resolve the metrics binding from the process env.
 *
 * - RELAY_METRICS_PORT: absent, zero, or non-positive-integer turns the
 *   endpoint off entirely (port 0), matching the pre-P2-132 default.
 * - RELAY_METRICS_BIND: interface to bind, default 127.0.0.1.
 * - RELAY_METRICS_TOKEN: when set, every request must carry a matching
 *   `Authorization: Bearer <token>` header or receive an empty 401.
 */
export function metricsBinding(env: Record<string, string | undefined>): MetricsBinding {
  const problems: string[] = [];
  const rawPort = env.RELAY_METRICS_PORT;
  const parsed = rawPort === undefined || rawPort.trim() === "" ? 0 : Number(rawPort);
  const port = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;

  const rawBind = env.RELAY_METRICS_BIND;
  const host = rawBind !== undefined && rawBind.trim() !== "" ? rawBind.trim() : METRICS_BIND_DEFAULT;

  // raw value, never trimmed: an operator-set token must match byte-for-byte
  const token = env.RELAY_METRICS_TOKEN ?? "";

  if (port > 0 && token === "" && !isLoopbackHost(host)) {
    problems.push(
      `RELAY_METRICS_BIND=${host} is not a loopback address and RELAY_METRICS_TOKEN is not set: ` +
        "refusing to start an unauthenticated metrics endpoint on the network (fail-closed)",
    );
  }
  return { port, host, token, problems };
}

/**
 * True only for provably loopback bind targets. Unknown hostnames are
 * treated as non-loopback so they require a token — fail-closed beats
 * accidentally exposing the endpoint.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "::1" || h.startsWith("127.");
}

/**
 * Constant-time check of the `Authorization: Bearer <token>` header against
 * the expected token. Missing or malformed headers (wrong scheme, no token
 * after the scheme) return false without comparing anything; a well-formed
 * header is compared character-by-character with no early exit, so the
 * timing does not leak how much of the guess matched. An empty expected
 * token never authenticates.
 */
export function metricsAuthOk(header: string | undefined, token: string): boolean {
  if (!token || header === undefined) return false;
  if (!header.startsWith("Bearer ")) return false;
  return ctEqual(header.slice("Bearer ".length), token);
}

/** Length-independent, early-exit-free equality of two strings. */
function ctEqual(a: string, b: string): boolean {
  const n = Math.max(a.length, b.length);
  // fold the length difference in: unequal lengths must never compare equal
  let diff = a.length ^ b.length;
  for (let i = 0; i < n; i++) {
    // charCodeAt past the end is NaN; |0 coerces it to a comparable 0
    diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  }
  return diff === 0;
}
