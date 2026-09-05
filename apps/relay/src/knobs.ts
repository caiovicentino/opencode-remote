/**
 * Relay tuning knobs (P2-171): the per-connection rate limit, the per-IP
 * admission cap, the trusted proxy-hop count and the liveness sweep interval.
 *
 * Pure decision module — imports nothing (no node/fs, node/http, ws) so the
 * wiring in index.ts stays thin and the decisions stay unit-testable — same
 * pattern as limits.ts and metricsbind.ts and the `problems` format they
 * established (P2-132/P2-141).
 *
 * Fail-closed in the P2-114 spirit: a present-but-non-numeric, negative,
 * fractional or zero value (zero is legitimate only for
 * RELAY_TRUST_PROXY_HOPS, the documented direct-exposure default), or a value
 * above the knob's documented ceiling, is a problem. Any problem means the
 * relay must not open its listener: index.ts logs every reason once at boot
 * and exits 1 instead of silently booting with the default — on a public host
 * a typo used to change the rate ceiling, the per-IP cap or the proxy-hop
 * count without a single warning line. An absent or blank variable keeps the
 * default, so an empty env reproduces the pre-P2-171 behavior exactly.
 *
 * The relay stays blind here too: only envelope-counter knobs are resolved —
 * no plaintext, no key material, no room ids ever flow through this module.
 */

export interface RelayKnobs {
  /** Sustained message frames per minute, per connection (RELAY_RATE_PER_MIN). */
  ratePerMin: number;
  /** Token-bucket burst capacity, per connection (RELAY_RATE_BURST). */
  rateBurst: number;
  /** Live-connection cap per source IP (RELAY_MAX_PER_IP). */
  maxPerIp: number;
  /** Trusted x-forwarded-for layers in front of the relay (RELAY_TRUST_PROXY_HOPS). */
  trustProxyHops: number;
  /** Liveness sweep interval in seconds (RELAY_PING_INTERVAL_S). */
  pingIntervalS: number;
  /** Non-empty means the boot must NOT open the listener (fail-closed). */
  problems: string[];
}

/** Defaults sized to pass the daemon's worst-case chunked transfer. */
export const RATE_PER_MIN_DEFAULT = 600;
export const RATE_BURST_DEFAULT = 1000;
export const MAX_PER_IP_DEFAULT = 20;
export const TRUST_PROXY_HOPS_DEFAULT = 0;
export const PING_INTERVAL_S_DEFAULT = 30;

/**
 * Documented per-knob ceilings. They do not make a knob harmless — they only
 * catch values that are obviously misconfigurations (extra zeros, pasted
 * milliseconds, pasted byte counts) before the relay serves with them.
 */
export const RATE_PER_MIN_CEILING = 60_000;
export const RATE_BURST_CEILING = 100_000;
export const MAX_PER_IP_CEILING = 1_000;
/** x-forwarded-for chains longer than this are never a legitimate layout. */
export const TRUST_PROXY_HOPS_CEILING = 8;
/** A sweep rarer than an hour never reaps a socket before the cap does. */
export const PING_INTERVAL_S_CEILING = 3_600;

/**
 * Resolve the tuning knobs from the process env.
 *
 * - RELAY_RATE_PER_MIN: sustained frames/minute per connection, default 600.
 * - RELAY_RATE_BURST: token-bucket burst per connection, default 1000.
 * - RELAY_MAX_PER_IP: live-connection cap per source IP, default 20.
 * - RELAY_TRUST_PROXY_HOPS: trusted proxy layers, default 0 (direct exposure).
 * - RELAY_PING_INTERVAL_S: liveness sweep interval, default 30.
 *
 * An absent or blank variable keeps the default. A present value must be a
 * whole, non-negative number at or below the knob's ceiling — and positive
 * for every knob except the proxy hops, where 0 is the legitimate default.
 * Anything else is a problem and the boot refuses to start.
 */
export function relayKnobs(env: Record<string, string | undefined>): RelayKnobs {
  const problems: string[] = [];
  const ratePerMin = resolveGuard(
    env.RELAY_RATE_PER_MIN,
    "RELAY_RATE_PER_MIN",
    RATE_PER_MIN_DEFAULT,
    RATE_PER_MIN_CEILING,
    "zero would disable the per-connection rate limit outright",
    problems,
  );
  const rateBurst = resolveGuard(
    env.RELAY_RATE_BURST,
    "RELAY_RATE_BURST",
    RATE_BURST_DEFAULT,
    RATE_BURST_CEILING,
    "zero would disable the burst budget outright",
    problems,
  );
  const maxPerIp = resolveGuard(
    env.RELAY_MAX_PER_IP,
    "RELAY_MAX_PER_IP",
    MAX_PER_IP_DEFAULT,
    MAX_PER_IP_CEILING,
    "zero would disable the per-IP admission cap outright",
    problems,
  );
  const trustProxyHops = resolveHops(env.RELAY_TRUST_PROXY_HOPS, problems);
  const pingIntervalS = resolveGuard(
    env.RELAY_PING_INTERVAL_S,
    "RELAY_PING_INTERVAL_S",
    PING_INTERVAL_S_DEFAULT,
    PING_INTERVAL_S_CEILING,
    "zero would disable the stale-socket sweep outright",
    problems,
  );
  return { ratePerMin, rateBurst, maxPerIp, trustProxyHops, pingIntervalS, problems };
}

/**
 * Resolve one guard knob: unset/blank keeps the default; a non-numeric,
 * negative, fractional, zero or above-ceiling value is a problem (recorded
 * once per variable) and the default is returned — the boot refuses to start
 * on any problem, so the fallback value is never served.
 */
function resolveGuard(
  raw: string | undefined,
  name: string,
  dflt: number,
  ceiling: number,
  whyNotZero: string,
  problems: string[],
): number {
  if (raw === undefined || raw.trim() === "") return dflt;
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    problems.push(
      `${name}=${JSON.stringify(raw)} is not a numeric value: ` +
        "refusing to start with an unvalidated knob (fail-closed)",
    );
    return dflt;
  }
  if (v < 0) {
    problems.push(
      `${name}=${JSON.stringify(raw)} must be a positive number: a negative knob is meaningless ` +
        "(fail-closed)",
    );
    return dflt;
  }
  if (!Number.isInteger(v)) {
    problems.push(
      `${name}=${JSON.stringify(raw)} must be a whole number: a fractional knob cannot be applied ` +
        "(fail-closed)",
    );
    return dflt;
  }
  if (v === 0) {
    problems.push(
      `${name}="0" is not accepted: ${whyNotZero} — ` +
        `unset the variable to keep the default ${dflt} (fail-closed)`,
    );
    return dflt;
  }
  if (v > ceiling) {
    problems.push(
      `${name}=${JSON.stringify(raw)} is above the ${ceiling} ceiling: ` +
        "values this large only serve misconfiguration (fail-closed)",
    );
    return dflt;
  }
  return v;
}

/**
 * Resolve RELAY_TRUST_PROXY_HOPS. Unlike the guard knobs, zero is the
 * legitimate default here (direct exposure, x-forwarded-for ignored), so only
 * non-numeric, negative, fractional or above-ceiling values are problems.
 */
function resolveHops(raw: string | undefined, problems: string[]): number {
  if (raw === undefined || raw.trim() === "") return TRUST_PROXY_HOPS_DEFAULT;
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    problems.push(
      `RELAY_TRUST_PROXY_HOPS=${JSON.stringify(raw)} is not a numeric value: ` +
        "refusing to start with an unvalidated knob (fail-closed)",
    );
    return TRUST_PROXY_HOPS_DEFAULT;
  }
  if (v < 0) {
    problems.push(
      `RELAY_TRUST_PROXY_HOPS=${JSON.stringify(raw)} must be a non-negative number: ` +
        "a negative hop count is meaningless (fail-closed)",
    );
    return TRUST_PROXY_HOPS_DEFAULT;
  }
  if (!Number.isInteger(v)) {
    problems.push(
      `RELAY_TRUST_PROXY_HOPS=${JSON.stringify(raw)} must be a whole number: ` +
        "a fractional hop count cannot select an x-forwarded-for entry (fail-closed)",
    );
    return TRUST_PROXY_HOPS_DEFAULT;
  }
  if (v > TRUST_PROXY_HOPS_CEILING) {
    problems.push(
      `RELAY_TRUST_PROXY_HOPS=${JSON.stringify(raw)} is above the ${TRUST_PROXY_HOPS_CEILING} ceiling: ` +
        "a chain this deep lets clients rotate the selected entry and its per-IP budget (fail-closed)",
    );
    return TRUST_PROXY_HOPS_DEFAULT;
  }
  return v;
}
