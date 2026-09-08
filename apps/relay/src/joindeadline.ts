/**
 * Join-deadline reaper for the relay (P2-230): closes sockets that connected
 * but never entered any room.
 *
 * The bug this bounds: the ws pong is emitted by the browser protocol layer
 * automatically, with no action from the client, and the liveness sweep
 * (liveness.ts) judges staleness by ping/pong silence only. A peer that opens
 * the connection and never sends a single frame therefore stays "alive"
 * forever — while holding one slot of the process-wide socket capacity
 * (P2-227) and of the per-IP cap (P2-025). On the hosted multi-tenant relay
 * (docs/VISION.md stage 4) a handful of such idle sockets closes the door on
 * real phones with not a single line explaining why: exactly the exhaustion
 * class P2-227 closed by count and P2-217 by memory.
 *
 * Why the default deadline is 60000 ms (one minute): a first frame needs one
 * ws round-trip after the handshake; even a cold phone radio, a fresh TLS
 * handshake and a captive-portal detour finish well inside a few seconds.
 * One minute is orders of magnitude above the legitimate latency, so no real
 * peer is ever reaped, while an idle socket's occupation of the global and
 * per-IP caps is bounded to a minute instead of forever.
 *
 * Why the ceiling is 3600000 ms (one hour): same philosophy as the
 * RELAY_PING_INTERVAL_S ceiling — a join deadline longer than an hour stops
 * protecting the capacity slots at all and only serves misconfiguration
 * (extra zeros, pasted durations in other units).
 *
 * Why the documented disable value is -1: an operator running a private,
 * allowlisted relay where every peer provably joins may want the reaper off
 * entirely. Zero and generic negatives stay refused (a "zero seconds"
 * deadline is nonsense and would close mid-admission sockets), so an explicit
 * -1 is the only value that means "off" — opt-in, never the default, because
 * a hosted multi-tenant relay needs this bound on by default.
 *
 * Pure decision module — imports nothing (no ws, node:net, node:http,
 * node:fs) so the wiring in index.ts stays thin and the decisions stay
 * unit-testable — same pattern as liveness.ts, capacity.ts, limits.ts and
 * knobs.ts, including the `problems` format they established (P2-132/P2-141).
 *
 * Fail-closed in the P2-114 spirit: a present-but-non-numeric, zero,
 * negative, fractional or above-ceiling value is a problem. Any problem means
 * the relay must not open its listener: index.ts logs every reason once at
 * boot and exits 1 instead of silently falling back to the default. An absent
 * or blank variable keeps the documented default. Every rule is checked
 * independently, so one value that violates several rules reports all its
 * reasons at once instead of short-circuiting on the first.
 *
 * The relay stays blind here too: only timestamps and durations flow through
 * this module — no plaintext, no key material, no room ids, no addresses, no
 * payload excerpts. The close reason is a fixed short string with no file
 * path, no URL, no room identifier and no secret.
 */

/** Env variable for the join deadline in milliseconds. */
export const JOIN_DEADLINE_MS_ENV = "RELAY_JOIN_DEADLINE_MS";

/** Default deadline: 60s. See the module header for the reasoning. */
export const JOIN_DEADLINE_MS_DEFAULT = 60_000;

/** Documented ceiling for the knob (one hour). See the module header. */
export const JOIN_DEADLINE_MS_CEILING = 3_600_000;

/** The only value that disables the reaper entirely. See the module header. */
export const JOIN_DEADLINE_MS_DISABLED = -1;

/** Close code for a socket reaped before its first room join (policy 4xxx). */
export const JOIN_UNJOINED_CLOSE_CODE = 4001;

/**
 * Fixed close reason, also the warn-line reason: short, Portuguese, and free
 * of file paths, URLs, room identifiers, addresses, payload excerpts and
 * secrets — same privacy shape as the P2-217/P2-227 reasons.
 */
export const JOIN_UNJOINED_CLOSE_REASON = "socket ocioso: nunca entrou em quarto";

/** Minimal shape the verdict needs from a peer. */
export interface JoinDeadlinePeer {
  /** ms timestamp of the connection being accepted (undefined = never stamped). */
  openedAt?: number;
  /** true once the socket entered its first room (index.ts marks it in join()). */
  joinedRoom?: boolean;
}

export interface JoinDeadlinePlan {
  /** Resolved deadline in ms; JOIN_DEADLINE_MS_DISABLED when disabled. */
  deadlineMs: number;
  /** Non-empty means the boot must NOT open the listener (fail-closed). */
  problems: string[];
}

/**
 * Resolve the join deadline from the process env.
 *
 * An absent or blank RELAY_JOIN_DEADLINE_MS keeps the 60000 ms default — an
 * empty env reproduces the pre-P2-230 behavior exactly (no deadline). The
 * documented disable value (-1) is accepted verbatim, checked before the
 * negative rule. Every other rule is checked independently and each one
 * appends its own problem, so a single value that violates several rules
 * reports every reason at once instead of short-circuiting on the first. A
 * problematic value resolves to the default, which is never served: the boot
 * refuses to start on any problem.
 */
export function parseJoinDeadline(env: Record<string, string | undefined>): JoinDeadlinePlan {
  const problems: string[] = [];
  const raw = env[JOIN_DEADLINE_MS_ENV];
  if (raw === undefined || raw.trim() === "") return { deadlineMs: JOIN_DEADLINE_MS_DEFAULT, problems };
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    problems.push(
      `${JOIN_DEADLINE_MS_ENV}=${JSON.stringify(raw)} is not a numeric value: ` +
        "refusing to start with an unvalidated deadline (fail-closed)",
    );
    return { deadlineMs: JOIN_DEADLINE_MS_DEFAULT, problems };
  }
  if (v === JOIN_DEADLINE_MS_DISABLED) return { deadlineMs: v, problems };
  if (v === 0) {
    problems.push(
      `${JOIN_DEADLINE_MS_ENV}=${JSON.stringify(raw)} is not accepted: zero would close ` +
        "mid-admission sockets — use the documented disable value " +
        `${JOIN_DEADLINE_MS_DISABLED} to turn the reaper off (fail-closed)`,
    );
  }
  if (v < 0) {
    problems.push(
      `${JOIN_DEADLINE_MS_ENV}=${JSON.stringify(raw)} must be a positive number: ` +
        "a negative deadline is meaningless (fail-closed)",
    );
  }
  if (!Number.isInteger(v)) {
    problems.push(
      `${JOIN_DEADLINE_MS_ENV}=${JSON.stringify(raw)} must be a whole number of milliseconds: ` +
        "a fractional deadline cannot be applied (fail-closed)",
    );
  }
  if (v > JOIN_DEADLINE_MS_CEILING) {
    problems.push(
      `${JOIN_DEADLINE_MS_ENV}=${JSON.stringify(raw)} is above the ${JOIN_DEADLINE_MS_CEILING} ceiling: ` +
        "a deadline this long stops protecting the capacity slots (fail-closed)",
    );
  }
  return { deadlineMs: problems.length > 0 ? JOIN_DEADLINE_MS_DEFAULT : v, problems };
}

/**
 * Return the peers that must be closed: connected, never joined any room,
 * and open for strictly more than deadlineMs — in iteration order.
 *
 * - A non-positive deadline disables the verdict entirely (empty list), the
 *   same shape as decideStale's intervalS <= 0; parseJoinDeadline never
 *   produces one (the only accepted non-positive is the documented -1).
 * - A peer that already joined a room is never returned: an established
 *   conversation is not this verdict's business, no matter how long ago it
 *   opened.
 * - A peer without an open stamp is never returned: it is either
 *   mid-admission or already closing (index.ts stamps openedAt only after
 *   every admission check passes) — the same prudence liveness.ts applies to
 *   an undefined lastSeen.
 * - The deadline bound is strict: open exactly deadlineMs survives, one
 *   millisecond more does not.
 */
export function idleUnjoined<T extends JoinDeadlinePeer>(
  now: number,
  peers: Iterable<T>,
  deadlineMs: number,
): T[] {
  if (deadlineMs <= 0) return [];
  const idle: T[] = [];
  for (const p of peers) {
    if (p.joinedRoom) continue;
    if (p.openedAt === undefined) continue;
    if (now - p.openedAt > deadlineMs) idle.push(p);
  }
  return idle;
}
