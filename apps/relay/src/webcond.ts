/**
 * Conditional-request validators (P2-200) for the static PWA route (P2-188):
 * the phone's browser has no way to ask whether what it already cached is
 * still valid, so every reload of the entry document — which by contract
 * cannot be cached immutably — re-downloaded the whole bundle through the
 * same process that routes everyone's sealed E2E frames. With a strong
 * validator on every 200 and an `if-none-match` comparison on the way in,
 * a revalidation is answered 304 with no body, no read and no compression.
 *
 * Pure decision module — imports nothing from node/http, node/fs, node/zlib
 * nor ws (only a type from the equally pure webencoding.ts) so the wiring in
 * healthz.ts stays thin and the decisions stay unit-testable — same pattern
 * as webencoding.ts and webheaders.ts.
 *
 * The relay stays blind here too: the decision reads a request header and
 * compares it against a validator derived from public file metadata — no
 * plaintext, no key material, no room ids ever flow through this module.
 */

import type { WebContentEncoding } from "./webencoding.js";

/**
 * FNV-1a 64-bit over the canonical input string. Hand-rolled instead of a
 * node:crypto digest so this module stays import-free like its pure peers:
 * determinism across processes is all a validator needs (the same size,
 * mtime and encoding must always hash to the same opaque tag), and the
 * input space — file size, file mtime, one of two encodings — is server
 * controlled, so the digest faces no adversary.
 */
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MODULUS = 1n << 64n;

function fnv1a64(input: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * FNV_PRIME) % FNV_MODULUS;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * The strong validator for one static response: size in bytes, mtime in
 * milliseconds (the same stat the P2-198 encoding decision already took —
 * no extra disk access) and the already-chosen encoding. Stable across
 * processes for the same input and necessarily different between the gzip
 * and identity variants, so a shared cache can never serve compressed bytes
 * to a client that asked for identity. Opaque and quoted per RFC 7232; the
 * encoding participates in the digest, it is not a visible suffix.
 */
export function etagFor(sizeBytes: number, mtimeMs: number, encoding: WebContentEncoding): string {
  return `"${fnv1a64(`${encoding}\u0000${sizeBytes}\u0000${mtimeMs}`)}"`;
}

/** The two outcomes of a conditional request: answer 304 or send the body. */
export type ConditionalVerdict = "not-modified" | "send";

/**
 * RFC 7232 weak comparison: a leading `W/` is ignored on both sides, the
 * rest must match byte for byte. The relay only ever issues strong
 * validators, but a client may echo the weak form back.
 */
function stripWeakPrefix(tag: string): string {
  return tag.startsWith("W/") ? tag.slice(2) : tag;
}

/**
 * Decide a static request by its raw `if-none-match` header.
 *
 * - A missing, non-string, empty or whitespace-only header is `send`.
 * - The value may be a comma-separated list; whitespace around elements is
 *   ignored and extra commas are tolerated. Any element that compares equal
 *   under the weak comparison — or the `*` wildcard, which always matches
 *   because the caller only invokes this for an existing file — is
 *   `not-modified`.
 * - Anything else — including a malformed element, which can simply never
 *   compare equal — is `send`: a conditional may only ever make the answer
 *   cheaper, never change a body into no body.
 */
export function conditionalVerdict(rawIfNoneMatch: unknown, current: string): ConditionalVerdict {
  if (typeof rawIfNoneMatch !== "string") return "send";
  const header = rawIfNoneMatch.trim();
  if (header === "") return "send";
  const currentTag = stripWeakPrefix(current);
  for (const element of header.split(",")) {
    const token = element.trim();
    if (token === "") continue; // tolerate extra commas
    if (token === "*") return "not-modified";
    if (stripWeakPrefix(token) === currentTag) return "not-modified";
  }
  return "send";
}
