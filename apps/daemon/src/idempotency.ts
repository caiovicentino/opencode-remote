// Prompt-idempotency guard: the PWA replays in-flight ops on every reconnect
// (WS drop, iOS tab suspension). Since the client keeps the same op id across
// replays, this cache lets the daemon recognize a re-issued prompt send and
// answer it without prompting the agent twice.

export class IdempotencyCache {
  private entries = new Map<string, number>();

  constructor(
    private ttlMs = 10 * 60_000,
    private cap = 1024,
  ) {}

  /** Whether `key` was remembered within the TTL. */
  seen(key: string): boolean {
    const at = this.entries.get(key);
    if (at === undefined) return false;
    if (Date.now() - at > this.ttlMs) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  /** Mark `key` as seen now (refresh LRU order, evict expired/overflow). */
  remember(key: string): void {
    this.entries.delete(key);
    this.entries.set(key, Date.now());
    const now = Date.now();
    for (const [k, at] of this.entries) if (now - at > this.ttlMs) this.entries.delete(k);
    while (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
