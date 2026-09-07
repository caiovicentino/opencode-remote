import type { CertExpiryVerdict } from "./certexpiry.js";

/**
 * Certificate-expiry metrics for the relay (P2-294) — pure observation
 * module.
 *
 * P2-290 put the certificate verdict on the /healthz probe body, but the
 * hosted operator's alerting (docs/VISION.md stage 4) is built on metric
 * scraping — the Prometheus text format — not on JSON parsing, so the one
 * surface able to wake someone at 3am stayed silent. This module turns the
 * verdict the P2-259 runtime revalidation already maintains (and the
 * /healthz getter already publishes) into exactly the additive /metrics
 * lines to publish, with zero new policy: no new timer, no new route, no
 * new request, no boot-refusal change. index.ts spreads the result into the
 * existing Prometheus lines array, evaluated per scrape from values already
 * in memory.
 *
 * The rules certExpiryMetrics() applies, IN THIS ORDER (the order is
 * load-bearing and covered by tests):
 *
 *   1. A missing, non-textual or out-of-table verdict returns the empty set
 *      — and a healthy-certificate line is NEVER invented. Fail-closed:
 *      publishing a certificate health nobody measured is worse than
 *      staying silent. Out-of-table includes every name the table does not
 *      own — inherited property names like "constructor" or "toString"
 *      never reach a published line through the prototype chain.
 *   2. The no-certificate mode (plain ws://, no TLS pair) therefore also
 *      returns the empty set — never an invented set of zeros.
 *   3. A remaining-seconds value that is negative or non-finite publishes
 *      as zero (the floor); a fractional one publishes as whole seconds.
 *   4. The closed certexpiry.ts verdict table becomes a numeric state
 *      gauge, documented line by line below — never a textual label, because
 *      a new label would create new cardinality in the operator's series
 *      base:
 *
 *        relay_cert_expiry_state  meaning
 *        -----------------------  -----------------------------------------
 *        0                        use — validity window comfortable
 *        1                        warn — inside the clock tolerance or the
 *                                                 warning window
 *        2                        refuse-expired
 *        3                        refuse-not-yet-valid
 *
 *   5. The result is deterministic: identical inputs produce identical
 *      lines in identical order on every call.
 *
 * THE RELAY STAYS BLIND (boundary): no returned line ever carries a
 * subject, issuer, serial number, fingerprint, file path, host, address or
 * any other certificate or key material — only the two fixed metric names
 * above and whole numbers derived from the verdict table and the seconds
 * count the caller already holds.
 *
 * Pure module — imports nothing at runtime (no node:fs, node:http,
 * node:crypto nor fetch, no I/O, no timers), same hygiene as healthz.ts,
 * rejectreasons.ts and roombudget.ts, so the unit battery can load it
 * without booting anything.
 */

/**
 * The closed verdict table as a numeric state gauge (rule 4). Keys outside
 * it never reach a published line — see rule 1.
 */
const CERT_EXPIRY_STATES: Record<CertExpiryVerdict, number> = {
  use: 0,
  warn: 1,
  "refuse-expired": 2,
  "refuse-not-yet-valid": 3,
};

/**
 * Exactly the additive Prometheus lines for the current certificate verdict
 * and the seconds left before expiry — see the header rules, applied in
 * that order. Never mutates anything, never invents a healthy verdict,
 * never carries certificate material.
 */
export function certExpiryMetrics(verdict: unknown, secondsLeft: number): string[] {
  // rules 1+2: an absent, non-textual or out-of-table verdict (the no-cert
  // mode included) publishes nothing at all — never a healthy line, never
  // invented zeros. The table lookup is an own-property check on purpose:
  // inherited names like "constructor", "toString" or "__proto__" resolve
  // through a plain object's prototype chain and would otherwise slip past
  // an undefined guard as a garbage "state" nobody measured.
  if (typeof verdict !== "string") return [];
  if (!Object.hasOwn(CERT_EXPIRY_STATES, verdict)) return [];
  const state = CERT_EXPIRY_STATES[verdict as CertExpiryVerdict];
  // rule 3: negative or non-finite remainder floors at zero
  const seconds = Number.isFinite(secondsLeft) ? Math.max(0, Math.floor(secondsLeft)) : 0;
  // rules 4+5: the numeric state gauge and the seconds gauge, always in
  // this order, with the same TYPE headers every other line uses
  return [
    "# TYPE relay_cert_expiry_state gauge",
    `relay_cert_expiry_state ${state}`,
    "# TYPE relay_cert_expiry_seconds gauge",
    `relay_cert_expiry_seconds ${seconds}`,
  ];
}
