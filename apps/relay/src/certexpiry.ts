/**
 * Certificate expiry preflight for the relay (P2-259).
 *
 * Pure decision module: given a certificate's validity window (start and
 * end instants), the current instant, a documented clock tolerance and a
 * documented warning window, it returns exactly one of four verdicts —
 * use, warn, refuse-expired or refuse-not-yet-valid — plus a short static
 * reason phrase. Imports nothing (no node/fs, no node/crypto, no node/http,
 * no network of any kind) so the wiring in index.ts stays thin and the rules
 * stay unit-testable — same hygiene as tlsconfig.ts, knobs.ts and limits.ts.
 *
 * The rules below are evaluated IN THIS ORDER (the order is load-bearing and
 * covered by tests):
 *
 *   1. A missing or non-finite instant (start, end or now) refuses the boot
 *      fail-closed instead of guessing validity: an unreadable validity
 *      window can never be proven to cover the current moment. An unusable
 *      END instant maps to refuse-expired (validity cannot be proven to
 *      continue); any other unusable instant maps to refuse-not-yet-valid
 *      (validity cannot be proven to have begun).
 *   2. Expired beyond the clock tolerance refuses (refuse-expired).
 *   3. Not yet valid beyond the same tolerance refuses
 *      (refuse-not-yet-valid).
 *   4. A deviation within the tolerance at either end warns and NEVER
 *      refuses. The tolerance exists because P2-214 proved that a wrong
 *      machine clock is a real, recurring failure: taking a healthy relay
 *      down over the host's own clock would be an outage that would not
 *      exist otherwise.
 *   5. An end of validity inside the warning window warns — renew the
 *      certificate before the refusal becomes real.
 *   6. Only the remainder is a plain use.
 *
 * The relay stays blind here too: every phrase is static, in the same
 * language as the tlsconfig.ts and knobs.ts problem messages, and never
 * contains a file path, host, port, serial number, subject, issuer,
 * fingerprint or any certificate or key material — no certificate material
 * ever flows through this module, only the two instants it was handed.
 */

/** The exactly-four outcomes the relay can reach for a validity window. */
export type CertExpiryVerdict = "use" | "warn" | "refuse-expired" | "refuse-not-yet-valid";

export interface CertExpiryOutcome {
  verdict: CertExpiryVerdict;
  /** Short static phrase; safe for logs by construction (see header). */
  reason: string;
}

/** Host-clock tolerance (24 h): deviations inside it warn, never refuse. */
export const CERT_CLOCK_TOLERANCE_MS = 86_400_000;
/** Warning window (14 days): expiry inside it warns ahead of time. */
export const CERT_WARN_WINDOW_MS = 1_209_600_000;

/**
 * Decide what the relay should do with the given validity window at the
 * given instant. Deterministic: the same inputs always produce the same
 * outcome. Thresholds use strict comparisons — an expiry exactly at the
 * tolerance edge is a warn (rule 4), one strictly beyond it is a refusal
 * (rule 2); an end exactly at the warning-window edge is a warn (rule 5).
 */
export function certExpiryVerdict(
  notBefore: number,
  notAfter: number,
  now: number,
  clockToleranceMs: number,
  warnWindowMs: number,
): CertExpiryOutcome {
  const unreadable: CertExpiryOutcome = {
    verdict: Number.isFinite(notAfter) ? "refuse-not-yet-valid" : "refuse-expired",
    reason: "relay certificate validity window is missing or unreadable: refusing to serve instead of guessing validity (fail-closed)",
  };
  // rule 1: never guess validity from an unusable instant
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || !Number.isFinite(now)) {
    return unreadable;
  }
  // rule 2: expired beyond the clock tolerance
  if (now - notAfter > clockToleranceMs) {
    return {
      verdict: "refuse-expired",
      reason: "relay certificate validity ended beyond the clock tolerance: refusing to boot with an expired certificate (fail-closed)",
    };
  }
  // rule 3: not yet valid beyond the same clock tolerance
  if (notBefore - now > clockToleranceMs) {
    return {
      verdict: "refuse-not-yet-valid",
      reason: "relay certificate validity starts beyond the clock tolerance: refusing to boot with a not-yet-valid certificate (fail-closed)",
    };
  }
  // rule 4: inside the tolerance at either end — warn, never refuse
  if (notAfter < now) {
    return {
      verdict: "warn",
      reason: "relay certificate validity ended within the clock tolerance: serving anyway so a skewed host clock never takes the relay down",
    };
  }
  if (notBefore > now) {
    return {
      verdict: "warn",
      reason: "relay certificate validity starts within the clock tolerance: serving anyway so a skewed host clock never takes the relay down",
    };
  }
  // rule 5: the end of validity is inside the warning window
  if (notAfter - now <= warnWindowMs) {
    return {
      verdict: "warn",
      reason: "relay certificate validity ends within the warning window: renew the certificate before the relay refuses to boot",
    };
  }
  // rule 6: comfortable window
  return {
    verdict: "use",
    reason: "relay certificate validity window is comfortable: serving normally",
  };
}
