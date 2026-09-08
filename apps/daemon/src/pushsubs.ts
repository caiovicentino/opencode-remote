// P2-272: push-subscription admission verdicts and endpoint redaction. Pure
// module — no node:fs, node:http, node:crypto, ws or fetch imports on purpose,
// because index.ts runs main() on import and unit tests must never boot a
// daemon (same hygiene as devicestale.ts, pairwindow.ts and relayurl.ts,
// lessons P2-149/P2-228).
//
// Why this exists (docs/VISION.md stages 3-4): a web-push endpoint is a BEARER
// credential — whoever holds the URL can notify that phone with no other key.
// The old POST accepted any object carrying an endpoint and the two keys, the
// list grew without a ceiling, and the push diagnostics screen echoed the
// whole endpoint back — handing out the credential on exactly the screen that
// should only describe state.
//
// CONSTITUTION BOUNDARY: this module and its wiring NEVER touch the paired
// phones allowlist, the handshake, the pairing window, replay protection or
// the VAPID keys — those are constitution-protected surfaces. The only state
// it shapes is the push subscription list persisted in subscriptions.json.
//
// Rules, evaluated in THIS order (the order is the contract):
//  1. Signature absent (not an object) → "recusar".
//  2. No textual endpoint, or the p256dh/auth keys missing → "recusar".
//  3. Endpoint not an absolute https:// URL → "recusar", fail-closed: a
//     clear-text scheme would hand the bearer credential to the network, and
//     an unknown scheme is never guessed.
//  4. Endpoint above the documented maximum length → "recusar", BEFORE any
//     comparison against the list: comparing an unbounded string against the
//     whole list is itself a memory-exhaustion vector.
//  5. Endpoint already in the list → "substituir" (refresh the keys, never
//     duplicate).
//  6. List at the documented ceiling with a NEW endpoint → "recusar" instead
//     of silently evicting the oldest entry — evicting would silently stop
//     notifications for a working phone and nobody would ever know.
//  7. Anything else → "acrescentar".
//
// Pure and deterministic: the same inputs produce the same verdict and reason
// on every call. Limits are documented module constants, not env knobs.

/** Maximum phones/subscriptions kept at once. Documented module constant, not an env knob. */
export const PUSH_SUBSCRIPTIONS_MAX = 10;

/** Maximum endpoint URL length accepted. Documented module constant, not an env knob. */
export const PUSH_SUBSCRIPTION_MAX_ENDPOINT_LENGTH = 512;

export type PushSubscriptionVerdict = "recusar" | "substituir" | "acrescentar";

/** Structural subset the daemon persists (subscriptions.json entries). */
export interface PushSubscriptionLike {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushSubscriptionVerdictReport {
  verdict: PushSubscriptionVerdict;
  /** Static reason — never interpolates endpoint content or list data. */
  reason: string;
}

const REASON_MISSING = "assinatura ausente";
const REASON_NO_ENDPOINT = "endpoint textual ausente";
const REASON_NO_KEYS = "chaves p256dh/auth ausentes";
const REASON_SCHEME = "endpoint precisa ser URL absoluta https";
const REASON_TOO_LONG = "endpoint acima do tamanho maximo";
const REASON_FULL = "lista de assinaturas no teto";
const REASON_KNOWN = "endpoint ja presente";
const REASON_NEW = "novo endpoint";

/**
 * Fixed-length display suffix: 8 hex chars from a pure FNV-1a over the whole
 * endpoint — two subscriptions on the same host differ without ever revealing
 * their paths.
 */
function fnv1aHex8(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Decide what to do with a received push subscription against the current
 * (already normalized) list. Pure and fail-closed; see the header for the
 * rule order. `maxSubscriptions` and `maxEndpointLength` are injectable so
 * tests pin the documented thresholds explicitly.
 */
export function pushSubscriptionVerdict(
  sub: unknown,
  current: readonly PushSubscriptionLike[],
  maxSubscriptions: number = PUSH_SUBSCRIPTIONS_MAX,
  maxEndpointLength: number = PUSH_SUBSCRIPTION_MAX_ENDPOINT_LENGTH,
): PushSubscriptionVerdictReport {
  // Rule 1: the signature itself is absent.
  if (typeof sub !== "object" || sub === null) {
    return { verdict: "recusar", reason: REASON_MISSING };
  }
  const s = sub as { endpoint?: unknown; keys?: unknown };
  // Rule 2: shape — a textual endpoint and both keys, or nothing is stored.
  if (typeof s.endpoint !== "string" || s.endpoint === "") {
    return { verdict: "recusar", reason: REASON_NO_ENDPOINT };
  }
  if (typeof s.keys !== "object" || s.keys === null) {
    return { verdict: "recusar", reason: REASON_NO_KEYS };
  }
  const k = s.keys as { p256dh?: unknown; auth?: unknown };
  if (typeof k.p256dh !== "string" || k.p256dh === "" || typeof k.auth !== "string" || k.auth === "") {
    return { verdict: "recusar", reason: REASON_NO_KEYS };
  }
  // Rule 3: https-only, fail-closed — the endpoint IS the credential.
  let url: URL;
  try {
    url = new URL(s.endpoint);
  } catch {
    return { verdict: "recusar", reason: REASON_SCHEME };
  }
  if (url.protocol !== "https:") {
    return { verdict: "recusar", reason: REASON_SCHEME };
  }
  // Rule 4: size ceiling BEFORE any comparison with the list.
  if (s.endpoint.length > maxEndpointLength) {
    return { verdict: "recusar", reason: REASON_TOO_LONG };
  }
  // Rule 5: known endpoint refreshes its keys — never duplicated.
  if (current.some((entry) => entry?.endpoint === s.endpoint)) {
    return { verdict: "substituir", reason: REASON_KNOWN };
  }
  // Rule 6: ceiling — refuse a new phone rather than silently evicting one.
  if (current.length >= maxSubscriptions) {
    return { verdict: "recusar", reason: REASON_FULL };
  }
  // Rule 7: the remainder joins the list.
  return { verdict: "acrescentar", reason: REASON_NEW };
}

/** Label shown when the endpoint cannot be safely described at all. */
const UNPARSEABLE_ENDPOINT_LABEL = "endpoint";

/**
 * Short display label for a push endpoint: ONLY the host plus a fixed-length
 * suffix — never the path, never the query, never the whole endpoint (the
 * endpoint is a bearer credential). Deterministic: the same endpoint always
 * yields the same label; an unparseable/absent endpoint never throws and
 * yields the static fallback label.
 */
export function redactPushEndpoint(endpoint: unknown): string {
  if (typeof endpoint !== "string" || endpoint === "") return UNPARSEABLE_ENDPOINT_LABEL;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return UNPARSEABLE_ENDPOINT_LABEL;
  }
  const host = url.hostname;
  if (host === "") return UNPARSEABLE_ENDPOINT_LABEL;
  return `${host} (${fnv1aHex8(endpoint)})`;
}
