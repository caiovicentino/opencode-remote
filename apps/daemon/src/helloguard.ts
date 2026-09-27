// RT-390: handshake freshness. Before this guard a captured hello was worth
// forever: the token sealed only a static { clientPub }, so replaying the
// recorded frame re-opened a session with a zeroed replay guard (lastSeq = 0)
// and the recorded op frames after it were re-executed — exactly the
// capability of the hostile relay the project tolerates. Two independent,
// fail-closed checks, each with its own verdict (lesson P3-356: never collapse
// causes into one boolean):
//   1. freshness — the hello token now carries an authenticated creation
//      instant (sealed inside the token, crypto.ts); outside ±5 min → refused.
//   2. dedupe — the hello nonce (the client-chosen HKDF salt) is admitted
//      once per window; a second hello with the same nonce is a replay.
//
// Pure on purpose — no fs, http, crypto, ws or fetch imports — because
// index.ts runs main() on import and unit tests must never boot a daemon
// (same hygiene as pairwindow.ts / reauth.ts). `now` is always injected; the
// module never reads the clock.

/** Maximum age/future drift of a hello token, in milliseconds (±5 min). */
export const HELLO_MAX_SKEW_MS = 300_000;

/** Nonce cache ceiling: the newest 4096 hellos by insertion instant. */
export const HELLO_SEEN_CAP = 4096;

export type HelloFreshness = "fresh" | "no-timestamp" | "stale" | "future";

/**
 * First check: is the token's creation instant plausible? `ts` null (missing
 * or non-numeric — e.g. a PWA cached from before RT-390) is refused, not
 * tolerated; too old is "stale"; too far ahead is "future" (torto clock, and
 * a future stamp must never widen the window). Exactly at the boundary the
 * hello is still fresh; one millisecond beyond it is not.
 */
export function helloFreshness(
  ts: number | null,
  now: number,
  skewMs: number = HELLO_MAX_SKEW_MS,
): HelloFreshness {
  if (ts === null || !Number.isFinite(ts)) return "no-timestamp";
  if (now - ts > skewMs) return "stale";
  if (ts - now > skewMs) return "future";
  return "fresh";
}

export type HelloAdmitVerdict = "new" | "replay" | "overflow";

/**
 * Second check: bounded nonce dedupe. `admit` keeps a nonce until the token
 * that carried it can no longer be fresh, prunes expired entries on every
 * call, and — at the cap — refuses the NEWCOMER instead of evicting the
 * oldest (fail-closed: an attacker's flood must not buy room for a replay by
 * pushing entries out).
 *
 * eval-12 (routed from eval-14): the entry used to expire `skew` after
 * ADMISSION on the daemon's clock, but helloFreshness keeps a future-dated
 * token fresh until `ts + skew`. With the client clock δ ahead (δ ≤ skew) the
 * identical hello was accepted again inside (t0 + skew, t0 + skew + δ]. The
 * token's authenticated `ts` now only EXTENDS retention — expiry is
 * max(now, ts) + skew, never earlier than the daemon-clock bound — and
 * freshness already caps ts at now + skew, so retention stays ≤ 2 × skew.
 */
export class HelloSeen {
  /** nonce → expiry instant (daemon clock, ms) */
  private readonly seen = new Map<string, number>();

  constructor(private readonly cap: number = HELLO_SEEN_CAP) {}

  admit(
    nonce: string,
    now: number,
    skewMs: number = HELLO_MAX_SKEW_MS,
    ts: number | null = null,
  ): HelloAdmitVerdict {
    for (const [key, expiresAt] of this.seen) {
      if (now > expiresAt) this.seen.delete(key);
    }
    if (this.seen.has(nonce)) return "replay";
    if (this.seen.size >= this.cap) return "overflow";
    const issuedAt = typeof ts === "number" && Number.isFinite(ts) ? Math.max(now, ts) : now;
    this.seen.set(nonce, issuedAt + skewMs);
    return "new";
  }

  size(): number {
    return this.seen.size;
  }
}

export type HelloVerdict =
  | "accept"
  | "no-timestamp"
  | "stale"
  | "future"
  | "replay"
  | "overflow";

/**
 * Combinator: exactly one cause per refusal. The admit thunk is only invoked
 * when the hello is fresh, so a flood of stale hellos never consumes cache
 * capacity. Non-"accept" verdicts are terminal: the caller must return before
 * any sessions.set/saveAllowlist so a live session's replay guard survives.
 */
export function helloVerdict(
  freshness: HelloFreshness,
  admit: () => HelloAdmitVerdict,
): HelloVerdict {
  if (freshness !== "fresh") return freshness;
  const admitted = admit();
  if (admitted === "replay") return "replay";
  if (admitted === "overflow") return "overflow";
  return "accept";
}
