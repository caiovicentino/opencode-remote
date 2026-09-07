/**
 * Certificate hot-reload verdict for the relay (P2-306).
 *
 * Pure decision module: given the impression of the TLS pair in service
 * (size and mtime of each file plus the two validity instants) and the
 * impression of the pair as read from disk right now, it returns exactly
 * one of three verdicts — keep, adopt or refuse — plus a short static
 * reason phrase. Imports nothing (no node/fs, no node/tls, no node/http,
 * no network of any kind) so the wiring in index.ts stays thin and the
 * rules stay unit-testable — same hygiene as certexpiry.ts and tlsconfig.ts.
 *
 * The rules below are evaluated IN THIS ORDER (the order is load-bearing
 * and covered by tests):
 *
 *   1. Identical impressions mean nothing changed: keep, and the caller
 *      never even re-read the files for this case (it compares file stats
 *      first and only reads the pair when they moved).
 *   2. A fresh pair whose validity instants are missing or non-finite is
 *      illegible or carries no readable validity window: refuse — an
 *      unusable window can never be proven to cover the current moment.
 *   3. A non-finite current instant cannot be judged against: refuse.
 *   4. A fresh pair expired beyond the documented clock tolerance refuses —
 *      the relay never swaps the material in service for a worse one.
 *   5. A fresh pair not yet valid beyond the same tolerance refuses for the
 *      same reason.
 *   6. Only the remainder is adopted: valid, readable material for the
 *      following handshakes. Inside the tolerance at either end the pair is
 *      usable — the same documented 24 h clock tolerance that keeps a skewed
 *      host clock from taking a healthy relay down (certexpiry.ts rule 4).
 *
 * Adopting never closes a socket: the swap reaches only the handshakes that
 * happen after it. The relay stays blind here too: every phrase is static,
 * in the same grammar as the certexpiry.ts phrases, and never contains a
 * file path, host, port, serial number, subject, issuer, fingerprint or any
 * certificate or key material — no certificate material ever flows through
 * this module, only the two impressions it was handed.
 */

/** The exactly-three outcomes the relay can reach for a renewed pair. */
export type CertReloadVerdict = "keep" | "adopt" | "refuse";

/**
 * What the relay knows about one state of the TLS pair: the size and mtime
 * of each file plus the two validity instants extracted from the
 * certificate. An unreadable or unparseable pair has non-finite fields.
 */
export interface CertPairImpression {
  certSize: number;
  certMtimeMs: number;
  keySize: number;
  keyMtimeMs: number;
  notBefore: number;
  notAfter: number;
}

export interface CertReloadOutcome {
  verdict: CertReloadVerdict;
  /** Short static phrase; safe for logs by construction (see header). */
  reason: string;
}

function sameField(a: number, b: number): boolean {
  return a === b || (Number.isNaN(a) && Number.isNaN(b));
}

function sameImpression(a: CertPairImpression, b: CertPairImpression): boolean {
  return (
    sameField(a.certSize, b.certSize) &&
    sameField(a.certMtimeMs, b.certMtimeMs) &&
    sameField(a.keySize, b.keySize) &&
    sameField(a.keyMtimeMs, b.keyMtimeMs) &&
    sameField(a.notBefore, b.notBefore) &&
    sameField(a.notAfter, b.notAfter)
  );
}

/**
 * Decide what the relay should do with the pair just read from disk.
 * Deterministic: the same inputs always produce the same outcome. The
 * tolerance thresholds use strict comparisons, mirroring certexpiry.ts —
 * a fresh pair deviating exactly at the tolerance edge is still usable.
 */
export function certReloadVerdict(
  inService: CertPairImpression,
  fresh: CertPairImpression,
  nowMs: number,
  clockToleranceMs: number,
): CertReloadOutcome {
  // rule 1: nothing changed — the pair in service is the pair on disk
  if (sameImpression(inService, fresh)) {
    return {
      verdict: "keep",
      reason: "relay certificate pair is unchanged: keeping the material already in service",
    };
  }
  // rule 2: the fresh pair is illegible or carries no readable validity window
  if (!Number.isFinite(fresh.notBefore) || !Number.isFinite(fresh.notAfter)) {
    return {
      verdict: "refuse",
      reason:
        "relay certificate renewal is illegible or carries no readable validity window: keeping the material in service instead of guessing validity (fail-closed)",
    };
  }
  // rule 3: a non-finite current instant cannot be judged against
  if (!Number.isFinite(nowMs)) {
    return {
      verdict: "refuse",
      reason:
        "relay certificate renewal cannot be judged at the current instant: keeping the material in service instead of guessing validity (fail-closed)",
    };
  }
  // rule 4: the fresh pair is expired beyond the clock tolerance — never swap
  // the material in service for a worse one
  if (nowMs - fresh.notAfter > clockToleranceMs) {
    return {
      verdict: "refuse",
      reason:
        "relay certificate renewal is expired beyond the clock tolerance: keeping the material in service instead of swapping to an expired certificate (fail-closed)",
    };
  }
  // rule 5: the fresh pair is not yet valid beyond the same tolerance
  if (fresh.notBefore - nowMs > clockToleranceMs) {
    return {
      verdict: "refuse",
      reason:
        "relay certificate renewal starts beyond the clock tolerance: keeping the material in service instead of swapping to a not-yet-valid certificate (fail-closed)",
    };
  }
  // rule 6: usable material — adopt it for the following handshakes
  return {
    verdict: "adopt",
    reason:
      "relay certificate renewal is valid and readable: adopting the new material for the following handshakes",
  };
}
