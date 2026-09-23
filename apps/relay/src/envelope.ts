/**
 * Envelope shape validation for the relay (RT-455).
 *
 * The relay is a blind router: `from` and `seq` are envelope metadata an
 * unauthenticated peer fully controls. Before RT-455 they passed unvalidated
 * into JSON.stringify — whose recursion is unbounded — so a single frame
 * whose `from` (or `seq`) was a deeply nested structure threw
 * `RangeError: Maximum call stack size exceeded` inside the message listener
 * and killed the whole multi-tenant process: every room of every tenant
 * dies, repeatable at will by anyone who can open a socket.
 *
 * The fix is the same shape-only shallow check room ids already get: every
 * field is type- and bounds-checked BEFORE anything touches the rebuild, and
 * the frame is dropped otherwise — the same silent treatment an invalid JSON
 * frame already received. Deeply nested values can never reach
 * JSON.stringify again because only shallow strings and safe integers are
 * ever re-serialized.
 *
 * Pure module (the house pattern of roomid.ts): no imports, no I/O, no
 * clock, no logging — the verdict is fully testable without the relay, and
 * the relay stays blind: no field value ever flows through here, only types
 * and lengths.
 */

/**
 * Upper bound for a self-declared sender id: the same ceiling as ROOM_ID_MAX
 * (the daemon uses a room id as its `from`; the PWA uses 8 base36 chars).
 * Declared locally — this module stays import-free on purpose.
 */
export const FROM_MAX = 128;

/** The validated subset of a wire frame the routing path may touch. */
export type EnvelopeFrame = {
  room: string;
  from: string | undefined;
  seq: number | null | undefined;
  payload: string;
};

export type EnvelopeReason = "not-object" | "bad-room" | "bad-payload" | "bad-from" | "bad-seq";

export type EnvelopeVerdict =
  | { ok: true; frame: EnvelopeFrame }
  | { ok: false; reason: EnvelopeReason };

/**
 * Shallow shape check of one wire frame.
 *
 * - The parsed value must be a non-null, non-array object (the literal
 *   `null` frame used to throw on the first `frame.room` access).
 * - `room` and `payload` must be strings (types only — the room grammar
 *   stays in isValidRoomId, this is not a duplicate).
 * - `from` absent or null → `undefined` (the caller applies its own socket
 *   id, the historical `??` fallback); a string up to FROM_MAX passes;
 *   anything else — object, array, number, boolean, oversized string —
 *   refuses the frame.
 * - `seq` absent → `undefined` (the key stays omitted in the rebuild) and
 *   null → `null` (both preserved exactly as before); a non-negative safe
 *   integer passes (the same rule as frameSeq in @ocr/protocol); anything
 *   else refuses the frame.
 */
export function envelopeVerdict(raw: unknown): EnvelopeVerdict {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "not-object" };
  }
  const { room, from, seq, payload } = raw as Record<string, unknown>;
  if (typeof room !== "string") return { ok: false, reason: "bad-room" };
  if (typeof payload !== "string") return { ok: false, reason: "bad-payload" };

  let fromOut: string | undefined;
  if (from === undefined || from === null) {
    fromOut = undefined;
  } else if (typeof from !== "string" || from.length > FROM_MAX) {
    return { ok: false, reason: "bad-from" };
  } else {
    fromOut = from;
  }

  let seqOut: number | null | undefined;
  if (seq === undefined) {
    seqOut = undefined;
  } else if (seq === null) {
    seqOut = null;
  } else if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) {
    return { ok: false, reason: "bad-seq" };
  } else {
    seqOut = seq;
  }

  return { ok: true, frame: { room, from: fromOut, seq: seqOut, payload } };
}
