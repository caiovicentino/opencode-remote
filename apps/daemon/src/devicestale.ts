// P2-268: stale-device classifier. Pure module — no node:fs, node:http,
// node:crypto, ws or fetch imports on purpose, because index.ts runs main()
// on import and unit tests must never boot a daemon (same hygiene as
// devicetouch.ts, pairwindow.ts and relayurl.ts).
//
// The allowlist already stores an approximate last-seen stamp per client
// (devicetouch.ts, P2-194), but nothing ever compared that stamp to the
// present — a phone lost months ago looked exactly like the one used every
// day, and the owner had to read dates by eye to decide what to revoke. This
// module classifies each paired device from its stamps alone; the devices
// route (index.ts) attaches the verdict + a short static pt-BR phrase to each
// entry as additive fields.
//
// CONSTITUTION BOUNDARY: classification is derived, read-only insight. This
// module NEVER revokes, NEVER writes daemon.json and NEVER touches the
// handshake, the fresh allowlist read, the pairing window or replay
// protection — the allowlist is a constitution-protected surface. Revoking
// stays an explicit owner action through the existing route.
//
// Rules, evaluated in THIS order (the order is the contract):
//  1. Missing, empty, non-textual or unparseable stamp → "nunca visto",
//     fail-closed and never active: treating the unknown as active would hide
//     exactly the forgotten device this classifier exists to reveal. The
//     pairing instant is received (and deliberately not consulted) so a
//     recent pairing can never rescue an illegible stamp.
//  2. A non-finite `now` is refused (TypeError), never guessed.
//  3. A stamp in the future is treated as now: a host clock ahead of itself
//     (a real failure, see P2-214) must never turn yesterday's phone into
//     "dormente". This also guarantees the age is never negative.
//  4. Age above the long window → "dormente"; above the short window →
//     "ocioso"; only the remainder → "ativo" (exactly at a threshold is still
//     the fresher verdict: the windows flip strictly above).
//  5. Pure and deterministic: the same inputs produce the same verdict and
//     the same phrase on every call.
//
// Phrases are static pt-BR sentences and never contain a public key, key
// prefix, device label, address, port, file path or secret (P2-140/P2-182).

/** Seen within the last 24h → "ativo". Documented module constant, not an env knob. */
export const DEVICE_STALE_SHORT_WINDOW_MS = 24 * 60 * 60_000;

/** Seen within the last 30 days (but past the short window) → "ocioso". Documented module constant, not an env knob. */
export const DEVICE_STALE_LONG_WINDOW_MS = 30 * 24 * 60 * 60_000;

export type StaleVerdict = "ativo" | "ocioso" | "dormente" | "nunca visto";

export interface StaleVerdictReport {
  verdict: StaleVerdict;
  phrase: string;
}

const NEVER_SEEN: StaleVerdictReport = { verdict: "nunca visto", phrase: "Nenhum acesso registrado." };
const ACTIVE: StaleVerdictReport = { verdict: "ativo", phrase: "Visto recentemente." };
const IDLE: StaleVerdictReport = { verdict: "ocioso", phrase: "Faz tempo que não é visto." };
const DORMANT: StaleVerdictReport = {
  verdict: "dormente",
  phrase: "Muito tempo sem acesso — considere revogar.",
};

/**
 * Classify a paired device from its stamps. Pure: `now` and both windows are
 * injected, never read from the clock; `lastSeenAt` may be anything the
 * allowlist happened to store. See the header for the rule order.
 */
export function deviceStaleVerdict(
  lastSeenAt: unknown,
  addedAt: unknown,
  now: number,
  shortWindowMs: number,
  longWindowMs: number,
): StaleVerdictReport {
  // Rule 1: an illegible stamp is "nunca visto" regardless of anything else —
  // `addedAt` is received precisely to make explicit that a recent pairing
  // never rescues it.
  void addedAt;
  const stamp = typeof lastSeenAt === "string" && lastSeenAt.trim() !== "" ? Date.parse(lastSeenAt) : Number.NaN;
  if (!Number.isFinite(stamp)) return NEVER_SEEN;
  // Rule 2: refuse to guess on a broken clock instead of inventing a verdict.
  if (!Number.isFinite(now)) {
    throw new TypeError("deviceStaleVerdict: non-finite 'now' refused (fail-closed)");
  }
  // Rule 3: future stamp (clock ahead of itself) counts as just-seen.
  const age = Math.max(0, now - stamp);
  // Rule 4: strictly-above flips, exactly-at stays on the fresher side.
  if (age > longWindowMs) return DORMANT;
  if (age > shortWindowMs) return IDLE;
  return ACTIVE;
}
