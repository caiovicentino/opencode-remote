/**
 * Liveness sweep for the relay (P2-067): ws-level ping/pong reaper.
 *
 * A client that vanishes without a close frame — phone loses wifi, laptop
 * sleeps — keeps its ws socket open forever: it stays in wss.clients and in
 * every room it joined, corroding MAX_SOCKETS and the per-IP cap (P2-025)
 * until a manual restart. The sweep pings every socket on a timer, refreshes
 * a lastSeen stamp on every pong (and on connection open), and terminates
 * peers that stayed silent for more than one full ping interval plus the
 * grace period. Termination goes through socket.terminate(), which fires the
 * normal close path: rooms and the per-IP slot release exactly as if the
 * peer had hung up.
 *
 * Like ipcap.ts/ratelimit.ts this module is pure decision logic — no ws or
 * node imports — so the wiring in index.ts stays thin and the policy is
 * unit-testable.
 */

/** Minimal shape the sweep needs from a peer. Sockets not yet stamped
 * (lastSeen undefined) are never swept: they are either mid-admission or
 * already closing, and killing them would only add noise. */
export interface LivenessPeer {
  lastSeen?: number;
}

/**
 * Return the peers allowed to be swept: those silent for strictly more than
 * intervalS + graceS seconds. The sum guarantees every peer gets one full
 * ping/pong round-trip before the grace window even starts. intervalS <= 0
 * disables the sweep entirely — an empty list, never a verdict.
 */
export function decideStale<T extends LivenessPeer>(
  now: number,
  peers: Iterable<T>,
  intervalS: number,
  graceS: number,
): T[] {
  if (intervalS <= 0) return [];
  const budget = (intervalS + graceS) * 1000;
  const stale: T[] = [];
  for (const p of peers) {
    if (p.lastSeen !== undefined && now - p.lastSeen > budget) stale.push(p);
  }
  return stale;
}
