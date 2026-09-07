/**
 * Room-rejection breakdown (P2-293) — pure observation module.
 *
 * Today the relay counts every refused room in one opaque total
 * (`m.roomsRejected` in index.ts), so the hosted operator watching the
 * documented probe (docs/RELAY-HOSTING.md, docs/VISION.md stage 4) sees a
 * number going up and cannot tell legitimate phones hitting the configured
 * per-connection ceiling — the decision being "buy capacity" — from a
 * single malformed origin in a loop — the decision being "block it". This
 * module splits that total by the reason the refusal happened, feeding the
 * observability surfaces with zero new policy: the additive /healthz
 * fields and the /metrics counter lines.
 *
 * The closed table of reasons. A refusal reason outside it MUST NOT reach
 * any surface: adding one means editing this table (and the docs) first.
 * Today there are exactly two, matching the two existing increment points
 * in index.ts:
 *
 *   - `invalid-room-id` — the frame's room id failed the roomid.ts grammar
 *     (P2-019);
 *   - `socket-room-cap` — the frame asked for a new room while the socket
 *     already holds MAX_ROOMS_PER_SOCKET.
 *
 * THE RELAY STAYS BLIND (boundary): no exported field, metric line or
 * reason name ever carries a room identifier, a socket/connection id, an
 * address, an IP, a port or any envelope content — only the fixed short
 * reason names above and whole counter values.
 *
 * The rules rejectionBreakdown() applies, IN THIS ORDER (the order is
 * load-bearing and covered by tests):
 *
 *   1. An absent input or a non-object input returns the empty set — and
 *      NEVER an invented set of zeros: publishing zeros nobody measured is
 *      how a monitor ends up asserting a health nobody verified.
 *   2. A documented slot whose value is absent or non-numeric withholds
 *      the whole set (fail-closed): a counters object the relay cannot
 *      fully trust must not publish a possibly-misleading subset, because
 *      assigning a refusal to the wrong reason is worse than not
 *      reporting.
 *   3. A reason outside the table never becomes a field and is NEVER summed
 *      into another reason — an unknown refusal stays unpublished instead
 *      of being misattributed.
 *   4. A documented counter that is negative, non-finite or non-integer
 *      publishes as zero — the slot exists and is numeric, so the field is
 *      real, but such a count cannot be taken literally.
 *   5. Every documented slot present and numeric publishes exactly one
 *      field, in table order — the same input therefore produces an
 *      identical result on every call, whatever order the keys came in.
 *
 * The published sum can never exceed the already-published total: index.ts
 * feeds each per-reason counter at exactly the same statement that
 * increments `m.roomsRejected`, and nowhere else, so the breakdown is a
 * strict re-labelling of the very same refusals. The total field
 * (`roomsRejected` / `rooms_rejected` / `relay_rooms_rejected`) stays
 * byte-for-byte what it was.
 *
 * Pure module — imports nothing (no node:fs, node:http nor fetch, no I/O,
 * no timers), same hygiene as healthz.ts, roombudget.ts and ipcap.ts, so
 * the unit battery can load it without booting anything.
 */

/** One documented refusal reason with its public names on each surface. */
export interface RoomRejectReasonSpec {
  /** Canonical key of the per-reason counter inside the relay process. */
  reason: string;
  /** Additive camelCase field on the /healthz body. */
  field: string;
  /** Additive snake_case field on the /metrics JSON payload. */
  json: string;
  /** Prometheus counter line name on the /metrics endpoint. */
  metric: string;
}

/**
 * The closed, documented table of room-rejection reasons, in publishing
 * order. See the module header for the boundary and the rules.
 */
export const ROOM_REJECT_REASONS = [
  {
    reason: "invalid-room-id",
    field: "roomsRejectedInvalidRoomId",
    json: "rooms_rejected_invalid_room_id",
    metric: "relay_rooms_rejected_invalid_room_id",
  },
  {
    reason: "socket-room-cap",
    field: "roomsRejectedSocketRoomCap",
    json: "rooms_rejected_socket_room_cap",
    metric: "relay_rooms_rejected_socket_room_cap",
  },
] as const;

/** The canonical per-reason counter keys, derived from the closed table. */
export type RoomRejectReason = (typeof ROOM_REJECT_REASONS)[number]["reason"];

/** Per-reason counters as the relay process holds them. */
export type RoomRejectCounters = Record<RoomRejectReason, number>;

/**
 * A fresh, all-zero counter set keyed by the closed table — the shape
 * index.ts holds and feeds its two increment points with.
 */
export function emptyRejectCounts(): RoomRejectCounters {
  const counts = {} as RoomRejectCounters;
  for (const r of ROOM_REJECT_REASONS) counts[r.reason] = 0;
  return counts;
}

/**
 * Normalize the per-reason counters into exactly the additive fields to
 * publish, in table order (see the header rules, applied in that order).
 * Never mutates the input, never invents a zero, never misattributes an
 * out-of-table reason, and never publishes a set wider than the total it
 * re-labels.
 */
export function rejectionBreakdown(counters: unknown): Record<string, number> {
  // rule 1: absent or non-object input — empty set, never invented zeros
  if (typeof counters !== "object" || counters === null) return {};
  const slots = counters as Record<string, unknown>;
  // rule 2: a documented slot that is absent or non-numeric withholds the
  // whole set (fail-closed)
  for (const r of ROOM_REJECT_REASONS) {
    if (typeof slots[r.reason] !== "number") return {};
  }
  // rule 4: negative, non-finite or non-integer counts publish as zero
  const clamp = (v: number): number =>
    Number.isFinite(v) && Number.isInteger(v) && v > 0 ? v : 0;
  // rules 3+5: table keys only, table order, one field per documented reason
  const out: Record<string, number> = {};
  for (const r of ROOM_REJECT_REASONS) {
    out[r.field] = clamp(slots[r.reason] as number);
  }
  return out;
}
