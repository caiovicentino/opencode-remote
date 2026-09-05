// P2-190: time-boxed bootstrap pairing window. Pure module — no node:fs,
// node:http or ws imports on purpose, because index.ts runs main() on import
// and unit tests must never boot a daemon (same pattern as relayurl.ts /
// bodylimit.ts).
//
// The first client that completes a handshake on a virgin daemon (empty
// allowlist) is auto-persisted. That bootstrap trust used to be unlimited in
// time: a daemon that sat unpaired for days trusted whoever arrived first,
// forever. Harmless on today's loopback relay, dangerous once the room lives
// on a hosted relay — the room id travels on a QR that ends up in photos,
// screen shares and support screenshots. The window is fail-closed: it opens
// at boot, re-arms on every authenticated pairing-screen read (exactly the
// period the QR is on screen), and once closed unknown clients are refused
// until the operator reopens the pairing screen or restarts the daemon.

/** Default bootstrap window: 15 minutes from boot (or last pairing-screen read). */
export const DEFAULT_PAIR_WINDOW_MS = 15 * 60_000;

/** Documented maximum anyone may set OCR_PAIR_WINDOW_MS to: 24 hours. */
export const PAIR_WINDOW_CEILING_MS = 24 * 60 * 60_000;

export interface PairWindow {
  /** Resolved window in milliseconds. Only meaningful when problems is empty. */
  windowMs: number;
  /** Non-empty means the boot must fail closed (exit 1, no listener). */
  problems: string[];
}

/**
 * Resolve the OCR_PAIR_WINDOW_MS env var. Missing or blank keeps the default
 * with no problem — the ONLY case that does. Non-numeric, non-positive,
 * fractional and above-ceiling values are all problems: the daemon must die
 * at boot rather than run with a window the operator never asked for.
 */
export function pairWindow(env: Record<string, string | undefined>): PairWindow {
  const raw = env.OCR_PAIR_WINDOW_MS;
  if (raw === undefined || raw.trim() === "") {
    return { windowMs: DEFAULT_PAIR_WINDOW_MS, problems: [] };
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return {
      windowMs: DEFAULT_PAIR_WINDOW_MS,
      problems: [
        `OCR_PAIR_WINDOW_MS=${JSON.stringify(raw)} is not a number: refusing to start the daemon (fail-closed)`,
      ],
    };
  }
  if (parsed <= 0) {
    return {
      windowMs: DEFAULT_PAIR_WINDOW_MS,
      problems: [
        `OCR_PAIR_WINDOW_MS=${JSON.stringify(raw)} must be a positive number of milliseconds: refusing to start the daemon (fail-closed)`,
      ],
    };
  }
  if (!Number.isInteger(parsed)) {
    return {
      windowMs: DEFAULT_PAIR_WINDOW_MS,
      problems: [
        `OCR_PAIR_WINDOW_MS=${JSON.stringify(raw)} must be a whole number of milliseconds: refusing to start the daemon (fail-closed)`,
      ],
    };
  }
  if (parsed > PAIR_WINDOW_CEILING_MS) {
    return {
      windowMs: DEFAULT_PAIR_WINDOW_MS,
      problems: [
        `OCR_PAIR_WINDOW_MS=${JSON.stringify(raw)} is above the documented ceiling of ${PAIR_WINDOW_CEILING_MS} ms: refusing to start the daemon (fail-closed)`,
      ],
    };
  }
  return { windowMs: parsed, problems: [] };
}

export type BootstrapDecision = "allow" | "reject-expired" | "reject-not-allowlisted";

/**
 * Decide what a completed handshake may do on a daemon bootstrapping its
 * allowlist. Pure: `now` is injected, never read from the clock.
 *
 * - A non-empty allowlist never bootstraps: unknown clients are rejected on
 *   the regular not-allowlisted path, inside or outside the window.
 * - An empty allowlist pairs the first client only while the window is open
 *   (`0 <= now - openedAt < windowMs`, strictly above the ceiling is closed).
 * - A future open instant (clock jumped ahead) counts as NOT extended, so an
 *   early clock can never widen the window — recovery is documented: reopen
 *   the pairing screen to re-arm with a fresh timestamp.
 * - `openedAt = 0` (window never opened) is already expired: fail-closed.
 */
export function bootstrapDecision(
  allowlistSize: number,
  openedAt: number,
  now: number,
  windowMs: number = DEFAULT_PAIR_WINDOW_MS,
): BootstrapDecision {
  if (allowlistSize !== 0) return "reject-not-allowlisted";
  const elapsed = now - openedAt;
  if (elapsed < 0) return "reject-expired";
  if (elapsed < windowMs) return "allow";
  return "reject-expired";
}
