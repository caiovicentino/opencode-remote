/**
 * Token bucket rate limiting for relay message frames.
 *
 * The relay is blind: the only sender identity visible in a RelayFrame is
 * the envelope's `from` field, which a sender can rotate at will. Buckets
 * are therefore enforced per connection (one device session) — they cannot
 * be evaded by identity rotation and die with the socket, so no shared
 * state grows unbounded.
 */

/** Continuous-refill token bucket. One token = one forwarded message frame. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly now: () => number;

  constructor(
    readonly capacity: number,
    readonly refillPerMin: number,
    now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
    this.now = now;
  }

  /** Consume one token; false means the sender is over budget. */
  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((t - this.last) * this.refillPerMin) / 60_000,
    );
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
