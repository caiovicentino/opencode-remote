/**
 * Process-wide socket capacity for the relay (P2-227).
 *
 * A hosted stage-4 relay is multi-tenant: many room pairs share one process,
 * and every live websocket holds one file descriptor. Until now the only
 * connection ceiling was per identity (RELAY_MAX_PER_IP, knobs.ts) — a
 * handful of distinct addresses, or a misconfigured proxy funneling thousands
 * of clients through one trusted hop, could push the process to its
 * file-descriptor exhaustion point and kill every tenant's conversations at
 * once, with no log line explaining why. This module is the missing global
 * bound: the same exhaustion class P2-217 closed for per-socket memory and
 * P2-195 closed for static-request volume.
 *
 * Pure decision module — imports nothing (no ws, node:net, node:http,
 * node:fs) so the wiring in index.ts stays thin and the decisions stay
 * unit-testable — same pattern as limits.ts, knobs.ts and backpressure.ts,
 * including the `problems` format they established (P2-132/P2-141).
 *
 * Why the default is 1000: it matches the documented RELAY_MAX_SOCKETS
 * default, so an operator who never touched a knob gets the same process
 * footprint as before — the difference is that the count is now refused
 * honestly at admission (close 1013 + counter + warn line) instead of being
 * exceeded into descriptor exhaustion. The ws-level RELAY_MAX_SOCKETS cap
 * (limits.ts) stays untouched and keeps bounding the pool one level later.
 *
 * Why the ceiling is 10000: the knob only needs to catch obvious
 * misconfigurations — extra zeros, pasted port numbers — before the relay
 * serves with them. One Node process holding more than ten thousand live
 * websockets is beyond any instance sizing this relay targets and above every
 * hardened file-descriptor limit a host would pair it with; values that large
 * only serve abuse, never a legitimate deployment.
 *
 * Fail-closed in the P2-114 spirit: a present-but-non-numeric, zero, negative,
 * fractional or above-ceiling RELAY_MAX_SOCKETS_GLOBAL is a problem. Any
 * problem means the relay must not open its listener: index.ts logs every
 * reason once at boot and exits 1 instead of silently falling back to the
 * default. An absent or blank variable keeps the documented default.
 *
 * The admission verdict fails OPEN on purpose when the live count is missing,
 * negative or non-finite: a broken or unavailable accounting must never
 * refuse a good connection — the cap exists to protect the process from
 * overload, not to turn a counting bug into an outage of its own. Every
 * other count is compared against the ceiling strictly: a live count AT the
 * ceiling is already a refusal (the ceiling is the first refused count, not
 * the last admitted one).
 *
 * The relay stays blind here too: only counts flow through this module — no
 * plaintext, no key material, no room ids, no addresses, no payload excerpts.
 * The refusal reason is a fixed short string with no file path, no URL scheme
 * and no room identifier.
 */

/** Env variable for the process-wide live-socket ceiling. */
export const MAX_SOCKETS_GLOBAL_ENV = "RELAY_MAX_SOCKETS_GLOBAL";

/**
 * Default process-wide ceiling on live sockets. See the module header for
 * the reasoning.
 */
export const MAX_SOCKETS_GLOBAL_DEFAULT = 1000;

/**
 * Documented ceiling for the knob. It does not make the cap harmless — it
 * only catches values that are obviously misconfigurations before the relay
 * serves with them (same rationale as the knobs.ts ceilings).
 */
export const MAX_SOCKETS_GLOBAL_CEILING = 10_000;

/**
 * Fixed refusal reason, also the warn-line reason the verdict returns: short,
 * Portuguese, and free of file paths, URL schemes, room identifiers,
 * addresses, payload excerpts and secrets.
 */
export const CAPACITY_REFUSE_REASON = "teto global de sockets atingido";

export interface CapacityPlan {
  /** Resolved process-wide live-socket ceiling. */
  maxSockets: number;
  /** Non-empty means the boot must NOT open the listener (fail-closed). */
  problems: string[];
}

/**
 * Resolve the process-wide socket capacity from the process env.
 *
 * An absent or blank RELAY_MAX_SOCKETS_GLOBAL keeps the 1000 default — an
 * empty env keeps today's footprint. Every rule below is checked
 * independently and each one appends its own problem, so a single value that
 * violates several rules reports every reason at once instead of
 * short-circuiting on the first. A problematic value resolves to the default,
 * which is never served: the boot refuses to start on any problem.
 */
export function parseMaxSockets(env: Record<string, string | undefined>): CapacityPlan {
  const problems: string[] = [];
  const raw = env[MAX_SOCKETS_GLOBAL_ENV];
  if (raw === undefined || raw.trim() === "") return { maxSockets: MAX_SOCKETS_GLOBAL_DEFAULT, problems };
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    problems.push(
      `${MAX_SOCKETS_GLOBAL_ENV}=${JSON.stringify(raw)} is not a numeric value: ` +
        "refusing to start with an unvalidated cap (fail-closed)",
    );
  } else {
    if (v === 0) {
      problems.push(
        `${MAX_SOCKETS_GLOBAL_ENV}=${JSON.stringify(raw)} is not accepted: zero would disable ` +
          "the process-wide capacity gate outright — unset the variable to keep the default " +
          `${MAX_SOCKETS_GLOBAL_DEFAULT} (fail-closed)`,
      );
    }
    if (v < 0) {
      problems.push(
        `${MAX_SOCKETS_GLOBAL_ENV}=${JSON.stringify(raw)} must be a positive number: ` +
          "a negative socket cap is meaningless (fail-closed)",
      );
    }
    if (!Number.isInteger(v)) {
      problems.push(
        `${MAX_SOCKETS_GLOBAL_ENV}=${JSON.stringify(raw)} must be a whole number of sockets: ` +
          "a fractional cap cannot be applied (fail-closed)",
      );
    }
    if (v > MAX_SOCKETS_GLOBAL_CEILING) {
      problems.push(
        `${MAX_SOCKETS_GLOBAL_ENV}=${JSON.stringify(raw)} is above the ${MAX_SOCKETS_GLOBAL_CEILING} ceiling: ` +
          "a live count this large only serves descriptor exhaustion (fail-closed)",
      );
    }
  }
  return { maxSockets: problems.length > 0 ? MAX_SOCKETS_GLOBAL_DEFAULT : v, problems };
}

export type CapacityVerdict =
  | { action: "accept" }
  | { action: "refuse"; reason: string };

const ACCEPT: CapacityVerdict = { action: "accept" };
const REFUSE: CapacityVerdict = { action: "refuse", reason: CAPACITY_REFUSE_REASON };

/**
 * Decide whether one more websocket may be accepted by the process.
 *
 * - `liveSockets` is the process's current live-socket count (in index.ts,
 *   the WebSocketServer set already includes the candidate socket when the
 *   admission handler runs); `cap` is the resolved ceiling.
 * - A live count AT or ABOVE the cap refuses — the ceiling is the first
 *   refused count, not the last admitted one.
 * - Missing, negative or non-finite counts accept (fail-open, deliberate —
 *   see the module header): a broken count must never refuse a good
 *   connection.
 */
export function acceptVerdict(liveSockets: unknown, cap: number): CapacityVerdict {
  if (typeof liveSockets !== "number" || !Number.isFinite(liveSockets) || liveSockets < 0) {
    return ACCEPT;
  }
  if (liveSockets >= cap) return REFUSE;
  return ACCEPT;
}
