/**
 * Per-process IP tag for the relay's rejection log (P2-174).
 *
 * The relay is a blind router — its whole contract is seeing as little of the
 * user as possible — yet the per-IP-cap rejection event used to carry the raw
 * client address. Until stage 4 that line stayed on the operator's machine;
 * hosted, it becomes aggregated provider log retained for months, storing a
 * user address outside their box without the product ever promising to.
 *
 * This module is the whole fix: makeIpTagger receives the salt bytes
 * generated once at boot and returns a `tag` function that maps an address to
 * the first 12 hex digits of sha256(salt || address):
 *
 * - stable within the process (same origin → same tag, so two rejections with
 *   one tag in the same process came from the same source — triage survives);
 * - different between processes (fresh random salt per boot → provider log
 *   correlation across restarts dies);
 * - irreversible (the salt is secret and random: no dictionary of candidate
 *   addresses can invert a tag after the process is gone).
 *
 * Pure in the limits.ts/knobs.ts spirit: node:crypto is the only import —
 * never node:fs, node:http nor ws — so the wiring stays in index.ts and the
 * mapping stays unit-testable. Nothing about admission, capping, rate
 * limiting or proxy handling changes: the raw address remains the IpCap key;
 * this only decides what may be written to a log line.
 */
import { createHash } from "node:crypto";

/** A derived per-process tag: exactly 12 lowercase hex digits. */
export type IpTag = string;

/** Length of the sha256 prefix kept for a real address. */
export const IP_TAG_LENGTH = 12;

/** Minimum salt entropy: a short salt would let a dictionary invert tags. */
export const IP_TAG_SALT_BYTES = 32;

/**
 * Fixed tag for an empty, absent or unknown address. Kept in the same
 * 12-hex shape (a real sha256 prefix is all-zeros with probability 2^-48, so
 * it can never be confused with a genuine tag) and deliberately NOT the hash
 * of the empty string, which would be identical in every process forever.
 */
export const UNKNOWN_IP_TAG = "000000000000";

/** The sentinel index.ts substitutes for an absent remoteAddress. */
const UNKNOWN_ADDRESS = "unknown";

/** The tag function produced by makeIpTagger. */
export type IpTagFn = (address: string | undefined | null) => IpTag;

/**
 * Build the per-boot tagger from salt bytes generated once at boot (index.ts
 * passes 32 fresh randomBytes). Throws on a salt shorter than
 * IP_TAG_SALT_BYTES — a predictable salt would make the "irreversible"
 * property a lie. The salt is copied, so later mutation of the caller's
 * array cannot silently change tags mid-process.
 */
export function makeIpTagger(salt: Uint8Array): IpTagFn {
  if (!salt || salt.byteLength < IP_TAG_SALT_BYTES) {
    throw new TypeError(
      `makeIpTagger: salt must be at least ${IP_TAG_SALT_BYTES} random bytes, got ${salt?.byteLength ?? 0}`,
    );
  }
  const secret = new Uint8Array(salt);
  return (address) => {
    if (typeof address !== "string" || address === "" || address === UNKNOWN_ADDRESS) {
      return UNKNOWN_IP_TAG;
    }
    return createHash("sha256").update(secret).update(address, "utf8").digest("hex").slice(0, IP_TAG_LENGTH);
  };
}
