// P2-129: pure retry-backoff state for the daemon's relay connection. No ws/net
// imports on purpose — index.ts runs main() on import, so unit tests pin the
// schedule here without booting a daemon (same pattern as localws.ts).

export const RELAY_RETRY_BASE_MS = 2_000;
export const RELAY_RETRY_CAP_MS = 30_000;

export type Random = () => number;

/** Uncapped exponential backoff of a 1-based retry attempt (1st retry = base). */
export function rawBackoffMs(attempt: number, baseMs: number = RELAY_RETRY_BASE_MS): number {
  return baseMs * 2 ** Math.max(0, attempt - 1);
}

/**
 * Full jitter: uniform in [0, min(cap, base * 2^(attempt-1))]. The random is
 * injected so tests can pin the whole schedule deterministically.
 */
export function nextDelayMs(
  attempt: number,
  random: Random = Math.random,
  baseMs: number = RELAY_RETRY_BASE_MS,
  capMs: number = RELAY_RETRY_CAP_MS,
): number {
  return Math.floor(random() * Math.min(capMs, rawBackoffMs(attempt, baseMs)));
}

export interface RelayRetrySnapshot {
  /** retry currently scheduled (0 = connected / no retry pending) */
  attempt: number;
  /** wait in ms of the currently scheduled retry (0 when none pending) */
  nextDelayMs: number;
}

export interface RelayRetryOptions {
  random?: Random;
  baseMs?: number;
  capMs?: number;
}

export function createRelayRetry(opts: RelayRetryOptions = {}) {
  const random = opts.random ?? Math.random;
  const baseMs = opts.baseMs ?? RELAY_RETRY_BASE_MS;
  const capMs = opts.capMs ?? RELAY_RETRY_CAP_MS;
  let attempt = 0;
  let pendingMs = 0;

  return {
    get attempt(): number {
      return attempt;
    },
    get nextDelayMs(): number {
      return pendingMs;
    },
    /** Advance to the next retry attempt; returns the jittered wait in ms. */
    schedule(): number {
      attempt += 1;
      pendingMs = nextDelayMs(attempt, random, baseMs, capMs);
      return pendingMs;
    },
    /** Successful (re)connect: back to attempt zero. */
    reset(): void {
      attempt = 0;
      pendingMs = 0;
    },
    /** Shape /api/health exposes as `relayRetry` (null when connected). */
    snapshot(): RelayRetrySnapshot {
      return { attempt, nextDelayMs: pendingMs };
    },
  };
}

export type RelayRetry = ReturnType<typeof createRelayRetry>;
