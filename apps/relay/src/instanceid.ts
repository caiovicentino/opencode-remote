/**
 * Opaque per-instance identity for the hosted relay (P3-401).
 *
 * The room map lives in the process's memory (index.ts), so two replicas
 * behind one public address split every room in half: the Mac joins its room
 * on replica A, the phone joins the same room on replica B, no frame ever
 * routes, and the pairing screen waits for a peer that never arrives —
 * indistinguishable from a dead daemon. The first diagnostic the operator
 * needs is an answer to "how many distinct instances are answering this
 * address right now?", which is what the `instanceId` field on /healthz is
 * for. Two different values in a row mean more than one replica is serving
 * the address and pairing is broken in silence.
 *
 * This module derives that identity. It is pure in the knobnames.ts/
 * iptag.ts spirit — no imports at all: never node:fs, never the network,
 * never a timer — so the unit battery exercises it without booting a relay.
 *
 * What the identity can be:
 *   - the value of RELAY_INSTANCE_ID, when the operator set one that passes
 *     the grammar below (a hosting platform's replica id, for example);
 *   - otherwise a value generated from random bytes injected by index.ts
 *     (fresh per boot, so distinct replicas differ and one replica stays
 *     stable for its whole process lifetime).
 *
 * What the identity is never: a secret (it is published on a public probe),
 * an address or port (no host material is ever accepted as input), or a room
 * id (the input is only the operator's env value and the injected random
 * bytes — the relay's room state never flows through here). Fail-closed: a
 * value that is absent, empty, oversized or carries a character outside the
 * safe set never reaches the probe — the generated value answers instead,
 * and a value is never invented from partial input.
 */

/** The env variable the operator (or hosting platform) sets, documented in
 *  docs/RELAY-HOSTING.md and registered in knobnames.ts. */
export const INSTANCE_ID_ENV = "RELAY_INSTANCE_ID";

/** Longest accepted operator value; longer ones fall back to the generated id. */
export const INSTANCE_ID_MAX_LENGTH = 64;

/** The whole accepted grammar: letters, digits and dashes. Anything else —
 *  spaces, underscores, dots, slashes, control bytes, non-ASCII — is unsafe
 *  for a public probe field and falls back to the generated id. */
export const INSTANCE_ID_PATTERN = /^[A-Za-z0-9-]+$/;

/** Minimum entropy of the injected random bytes backing the generated id:
 *  eight bytes (64 bits) keep two replicas from colliding in practice while
 *  staying short enough for a probe field and a log line. */
export const INSTANCE_ID_RANDOM_BYTES = 8;

/** Prefix marking a generated (not operator-chosen) id, so an operator who
 *  sees `relay-i-…` on the probe knows the env variable is unset. */
export const GENERATED_INSTANCE_ID_PREFIX = "relay-i-";

/**
 * Whether `raw` is an acceptable instance id exactly as-is: a non-empty
 * string within INSTANCE_ID_MAX_LENGTH whose every character is in the safe
 * set. No trimming, no case folding, no partial adoption — an id either is
 * fully inside the grammar or is rejected whole (fail-closed).
 */
export function isValidInstanceId(raw: unknown): raw is string {
  return (
    typeof raw === "string" &&
    raw.length > 0 &&
    raw.length <= INSTANCE_ID_MAX_LENGTH &&
    INSTANCE_ID_PATTERN.test(raw)
  );
}

/**
 * Derive the generated id from random bytes injected once by the caller
 * (index.ts passes fresh randomBytes). Encodes the first
 * INSTANCE_ID_RANDOM_BYTES bytes as lowercase hex after the
 * GENERATED_INSTANCE_ID_PREFIX — opaque, address-free, room-free,
 * secret-free. Throws on an unusable injection (a programming error in the
 * caller, not a runtime condition): a relay that cannot randomize must not
 * publish a constant id that would make two replicas look like one.
 */
export function generateInstanceId(random: Uint8Array): string {
  if (!random || random.byteLength < INSTANCE_ID_RANDOM_BYTES) {
    throw new TypeError(
      `generateInstanceId: at least ${INSTANCE_ID_RANDOM_BYTES} random bytes are required, got ${random?.byteLength ?? 0}`,
    );
  }
  let hex = "";
  for (let i = 0; i < INSTANCE_ID_RANDOM_BYTES; i++) {
    hex += (random[i] ?? 0).toString(16).padStart(2, "0");
  }
  return GENERATED_INSTANCE_ID_PREFIX + hex;
}

/**
 * The one boot-time decision: the operator value when it passes the grammar,
 * the generated value in every other case. Called exactly once per process
 * by index.ts, so the id is stable for the process lifetime; two calls with
 * the same inputs agree, two replicas with different randoms never do.
 */
export function resolveInstanceId(envValue: unknown, random: Uint8Array): string {
  return isValidInstanceId(envValue) ? envValue : generateInstanceId(random);
}
