// P3-344: client fingerprint + reject-log throttling. Pure module — no
// node:fs, node:http or ws imports on purpose, because index.ts runs main()
// on import and unit tests must never boot a daemon (same pattern as
// devicetouch.ts / pairwindow.ts).
//
// Two problems this module owns:
//
// - pubFingerprint(): every log/audit line used to identify a client by
//   `pub.slice(0, 16)` — but the first 16 base64 chars of a DER SPKI blob are
//   the constant ASN.1 header of ANY P-256 key, so every device logged the
//   exact same string and nothing was identifiable. The fingerprint is the
//   sha-256 of the decoded DER bytes (first 16 lowercase hex chars instead),
//   which is stable per device and distinct across devices.
// - rejectLogDecision()/noteRejectWarn(): a zombie client (old PWA tab with a
//   revoked identity, auto-reconnecting every ~8s) must never flood the daemon
//   log or rotate the ~1 MB audit.log with one line per reconnect — the warn
//   + audit pair is throttled to once per interval per fingerprint, while the
//   metrics counter keeps ticking on every rejection.

import { createHash } from "node:crypto";

/** Documented gap between two warn/audit emissions for the same client fp. */
export const REJECT_WARN_INTERVAL_MS = 60_000;

/**
 * Stable, personal-data-free fingerprint of a client public key: sha-256 over
 * the DER bytes the base64 encodes, first 16 lowercase hex chars. Input that
 * is not a string, is empty, or decodes to zero bytes → "unknown" — a
 * malformed pub must never throw inside the handshake path.
 */
export function pubFingerprint(pub: unknown): string {
  if (typeof pub !== "string" || pub.length === 0) return "unknown";
  let der: Uint8Array;
  try {
    const decoded = Buffer.from(pub, "base64");
    if (decoded.length === 0) return "unknown";
    der = new Uint8Array(decoded);
  } catch {
    return "unknown";
  }
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

export type RejectLogDecision = "warn" | "silent";

/**
 * Should this rejection emit the warn log line + audit event? Pure: `now` is
 * injected, never read from the clock. Fixed rule order:
 * (a) missing/non-numeric `lastWarnAt` → warn (first sighting of this fp);
 * (b) `lastWarnAt` in the future (clock moved back) → silent, never spam;
 * (c) `now - lastWarnAt >= REJECT_WARN_INTERVAL_MS` → warn;
 * (d) otherwise → silent.
 */
export function rejectLogDecision(
  lastWarnAt: number | undefined,
  now: number,
): RejectLogDecision {
  if (typeof lastWarnAt !== "number" || !Number.isFinite(lastWarnAt)) return "warn";
  if (lastWarnAt > now) return "silent";
  if (now - lastWarnAt >= REJECT_WARN_INTERVAL_MS) return "warn";
  return "silent";
}

/**
 * Record a warn emission for `fp` at time `now`, keeping the map bounded:
 * once more than `max` fingerprints are tracked, the oldest entries are
 * evicted so a stranger cycling fresh pubs cannot grow the map without limit.
 */
export function noteRejectWarn(
  state: Map<string, number>,
  fp: string,
  now: number,
  max = 64,
): void {
  state.set(fp, now);
  if (state.size <= max) return;
  const oldest = [...state.entries()].sort((a, b) => a[1] - b[1]);
  for (const [key] of oldest.slice(0, state.size - max)) state.delete(key);
}
