/**
 * Per-IP live-connection cap for the relay (P2-025).
 *
 * MAX_SOCKETS bounds the global pool, but a single host can open every
 * slot and deny admission to all other peers (DoS de admissão on a public
 * relay). IpCap bounds how many live connections one source IP may hold:
 * admit() on every connection attempt, release() when the socket dies,
 * counts() for observability. Like the token bucket it is pure decision
 * logic (no ws/node imports), so the handler wiring stays testable.
 *
 * limit <= 0 disables the cap entirely: every admit is accepted and no
 * state is kept.
 */
export class IpCap {
  private readonly live = new Map<string, number>();

  constructor(readonly limit: number) {}

  /** Take one live slot for `ip`; false means the IP is over budget. */
  admit(ip: string): boolean {
    if (this.limit <= 0) return true;
    const n = this.live.get(ip) ?? 0;
    if (n >= this.limit) return false;
    this.live.set(ip, n + 1);
    return true;
  }

  /** Give back the slot held by one admitted connection of `ip`. */
  release(ip: string): void {
    if (this.limit <= 0) return;
    const n = this.live.get(ip) ?? 0;
    if (n <= 1) this.live.delete(ip);
    else this.live.set(ip, n - 1);
  }

  /** Live connection counts per source IP. */
  counts(): Record<string, number> {
    return Object.fromEntries(this.live);
  }
}
