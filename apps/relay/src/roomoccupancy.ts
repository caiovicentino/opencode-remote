/**
 * Room occupancy split for the relay metrics (P3-461) — pure observation
 * module.
 *
 * The hosted operator's most confusing failure mode is the silent pairing
 * trap (docs/RELAY-HOSTING.md, P3-401): two replicas behind one public
 * address each admit one side of a conversation, so every replica shows
 * perfectly normal `relay_rooms_active` numbers and no alert fires, while
 * no frame ever routes. The aggregate room count cannot denounce this —
 * the signal is the SHAPE of the rooms, not their total: a replica that
 * serves only one half of each conversation holds rooms with exactly one
 * participant. This module turns the sizes of the rooms the caller already
 * holds (the live `rooms` map, read at scrape time) into exactly the three
 * buckets the operator needs, with zero new policy: no new timer, no new
 * route, no new request, no new dependency, and no limit, admission,
 * refusal or socket close may ever read them.
 *
 * The rules roomOccupancyCounts() applies, IN THIS ORDER (the order is
 * load-bearing and covered by tests):
 *
 *   1. Only whole positive sizes classify: 1 → single, 2 → paired, more
 *      than 2 → crowded. An entry that is missing, not a number, not
 *      finite, fractional, negative or zero is skipped ENTIRELY — never
 *      guessed into a bucket, never coerced. (A zero-size room cannot
 *      exist in the relay's map — rooms die with their last peer — but a
 *      size the caller hands over that describes nobody is honest about
 *      nothing: publishing it in any bucket would be an invention.)
 *   2. Every published count is a whole number ≥ 0, and for a list of
 *      whole positive sizes the three buckets always sum to the list
 *      length — the operator's arithmetic stays honest:
 *      `single + paired + crowded` ≤ `relay_rooms_active`.
 *   3. The result is deterministic: identical inputs produce identical
 *      counts in identical order on every call, whatever order the sizes
 *      came in (counting is order-insensitive by construction).
 *
 * THE RELAY STAYS BLIND (boundary): no returned value ever carries a room
 * id, an address, an IP, a port, a token or any other identifiable
 * material — only the three whole counts the caller already holds. The
 * classification is by size alone; nothing else about a room is ever
 * inspected, so the module cannot become a leak no matter what the caller
 * feeds it.
 *
 * Pure module — imports nothing at all (no node:fs, node:http, no fetch,
 * no I/O, no timers), same hygiene as certmetrics.ts, procmetrics.ts and
 * rejectreasons.ts, so the unit battery can load it without booting
 * anything. The caller samples the rooms map; this module only counts.
 */

/** The three occupancy buckets, in publishing order. */
export interface RoomOccupancyCounts {
  /** Rooms holding exactly one participant — the split-replica symptom. */
  single: number;
  /** Rooms holding exactly two participants — the healthy pairing shape. */
  paired: number;
  /** Rooms holding more than two participants — legitimate group shapes. */
  crowded: number;
}

/**
 * Exactly the occupancy buckets for the room sizes the caller holds — see
 * the header rules, applied in that order. Never mutates the input, never
 * invents a bucket, never carries identifiable material.
 */
export function roomOccupancyCounts(sizes: readonly unknown[]): RoomOccupancyCounts {
  let single = 0;
  let paired = 0;
  let crowded = 0;
  for (const size of sizes) {
    // rule 1: only a whole positive size classifies; everything else is
    // skipped entirely — never guessed, never coerced
    if (typeof size !== "number" || !Number.isFinite(size) || !Number.isInteger(size) || size <= 0) continue;
    if (size === 1) single++;
    else if (size === 2) paired++;
    else crowded++;
  }
  return { single, paired, crowded };
}
