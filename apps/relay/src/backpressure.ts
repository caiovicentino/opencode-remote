/**
 * Send-side backpressure (P2-217): a per-socket ceiling on the bytes the relay
 * has already handed to a target's WebSocket but that have not left the
 * process yet (`bufferedAmount`), so a peer that stops reading — a phone on a
 * frozen TCP window, a suspended tab — cannot grow its outgoing buffer without
 * bound inside the relay process and take every room's conversations down with
 * it. This is the accumulated-bytes counterpart of the per-frame
 * RELAY_MAX_FRAME_BYTES cap (P2-141): that one bounds a single frame, this one
 * bounds the sum queued on one slow socket.
 *
 * Pure decision module — imports nothing (no node/http, node/fs, node/net nor
 * ws) so the wiring in index.ts stays thin and the decisions stay
 * unit-testable — same pattern as limits.ts, knobs.ts, loglevel.ts and
 * webbudget.ts, including the `problems` format they established
 * (P2-132/P2-141).
 *
 * Why the default is 4 MiB (4194304 bytes): roughly four of the largest
 * routable frames (1 MB, P2-141). A healthy peer drains its socket buffer in
 * milliseconds and never approaches it; a dead peer costs the process at most
 * those 4 MiB instead of unbounded memory, and gets closed and replaced by its
 * own reconnect (daemons and phones dial again with backoff and resend state,
 * P1-053), so nothing is lost that the endpoints do not already recover.
 *
 * Why the ceiling is 64 MiB (67108864 bytes): the knob only needs to catch
 * obvious misconfigurations — extra zeros, pasted pixel counts — before the
 * relay serves with them; values that large per socket only serve memory
 * abuse, never a legitimate consumer.
 *
 * Fail-closed in the P2-114 spirit: a present-but-non-numeric, zero, negative,
 * fractional or above-ceiling RELAY_BUFFER_CAP_BYTES is a problem. Any problem
 * means the relay must not open its listener: index.ts logs every reason once
 * at boot and exits 1 instead of silently falling back to the default. An
 * absent or blank variable is the only case that keeps the documented
 * default, so an empty env reproduces the pre-P2-217 behavior exactly.
 *
 * The verdict never drops a frame, and this is deliberate, not an omission:
 * the relay is a blind router that cannot read, decrypt or re-send what it
 * forwards, so silently discarding a frame would corrupt the E2E stream while
 * both ends still believe they are healthy — an unrecoverable hole with no
 * error on either side. Closing the slow socket is the honest alternative: the
 * endpoints see the disconnect, reconnect on their own and resend state. The
 * verdict also fails OPEN on purpose when the accumulated count is missing,
 * negative or non-finite: a socket implementation without that accounting
 * must never have its (healthy) connection closed because of it.
 *
 * The relay stays blind here too: only byte counts flow through this module —
 * no plaintext, no key material, no room ids, no addresses, no payload
 * excerpts. The close reason is a fixed short string with no file path, no
 * URL, no room identifier and no secret.
 */

/** Env variable for the per-socket accumulated-bytes ceiling. */
export const BUFFER_CAP_ENV = "RELAY_BUFFER_CAP_BYTES";

/**
 * Default per-socket cap in bytes: 4 MiB, ~4 of the largest routable frames
 * (P2-141). See the module header for the reasoning.
 */
export const BUFFER_CAP_DEFAULT = 4_194_304;

/**
 * Documented ceiling for the knob. It does not make the cap harmless — it
 * only catches values that are obviously misconfigurations before the relay
 * serves with them (same rationale as the knobs.ts ceilings).
 */
export const BUFFER_CAP_CEILING = 67_108_864;

/** Close code used for a slow consumer: 1013 "Try Again Later". */
export const SLOW_CONSUMER_CLOSE_CODE = 1013;

/**
 * Fixed close reason, also the warn-line reason the verdict returns: short,
 * Portuguese, and free of file paths, URLs, room identifiers, addresses,
 * payload excerpts and secrets.
 */
export const SLOW_CONSUMER_CLOSE_REASON = "consumidor lento: buffer de saida acima do teto";

export interface BufferCapPlan {
  /** Resolved per-socket accumulated-bytes ceiling in bytes. */
  cap: number;
  /** Non-empty means the boot must NOT open the listener (fail-closed). */
  problems: string[];
}

/**
 * Resolve the per-socket backpressure cap from the process env.
 *
 * An absent or blank RELAY_BUFFER_CAP_BYTES keeps the 4 MiB default — an
 * empty env reproduces the pre-P2-217 behavior (no cap) as closely as the
 * new knob allows. Every rule below is checked independently and each one
 * appends its own problem, so a single value that violates several rules
 * reports every reason at once instead of short-circuiting on the first.
 * A problematic value resolves to the default, which is never served: the
 * boot refuses to start on any problem.
 */
export function parseBufferCap(env: Record<string, string | undefined>): BufferCapPlan {
  const problems: string[] = [];
  const raw = env[BUFFER_CAP_ENV];
  if (raw === undefined || raw.trim() === "") return { cap: BUFFER_CAP_DEFAULT, problems };
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    problems.push(
      `${BUFFER_CAP_ENV}=${JSON.stringify(raw)} is not a numeric value: ` +
        "refusing to start with an unvalidated cap (fail-closed)",
    );
  } else {
    if (v === 0) {
      problems.push(
        `${BUFFER_CAP_ENV}=${JSON.stringify(raw)} is not accepted: zero would disable ` +
          "the backpressure cap outright — unset the variable to keep the default " +
          `${BUFFER_CAP_DEFAULT} (fail-closed)`,
      );
    }
    if (v < 0) {
      problems.push(
        `${BUFFER_CAP_ENV}=${JSON.stringify(raw)} must be a positive number: ` +
          "a negative byte cap is meaningless (fail-closed)",
      );
    }
    if (!Number.isInteger(v)) {
      problems.push(
        `${BUFFER_CAP_ENV}=${JSON.stringify(raw)} must be a whole number of bytes: ` +
          "a fractional cap cannot be applied (fail-closed)",
      );
    }
    if (v > BUFFER_CAP_CEILING) {
      problems.push(
        `${BUFFER_CAP_ENV}=${JSON.stringify(raw)} is above the ${BUFFER_CAP_CEILING} ceiling: ` +
          "a per-socket buffer this large only serves memory abuse (fail-closed)",
      );
    }
  }
  return { cap: problems.length > 0 ? BUFFER_CAP_DEFAULT : v, problems };
}

export type SendVerdict =
  | { action: "send" }
  | { action: "close-slow"; reason: string };

const SEND: SendVerdict = { action: "send" };
const CLOSE_SLOW: SendVerdict = { action: "close-slow", reason: SLOW_CONSUMER_CLOSE_REASON };

/**
 * Decide whether one outbound frame may be queued on a target socket.
 *
 * - `pendingBytes` is the target's own accumulated outgoing bytes (the
 *   WebSocket `bufferedAmount` the socket already exposes); `frameBytes` is
 *   the serialized frame about to be queued; `cap` is the resolved ceiling.
 * - pending + frame exactly at the cap still sends — only strictly above it
 *   closes, so the documented limit itself stays serviceable.
 * - Missing, negative or non-finite accumulated bytes send (fail-open): a
 *   socket without that accounting must never have a good connection closed.
 * - The verdict NEVER drops a frame — see the module header for why the
 *   only two possible outcomes are send and close-slow.
 */
export function sendVerdict(pendingBytes: unknown, frameBytes: number, cap: number): SendVerdict {
  if (typeof pendingBytes !== "number" || !Number.isFinite(pendingBytes) || pendingBytes < 0) {
    return SEND;
  }
  if (pendingBytes + frameBytes > cap) return CLOSE_SLOW;
  return SEND;
}
