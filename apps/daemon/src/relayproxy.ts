// P2-303: machine-proxy verdict for the daemon's relay dial. Pure module —
// no node:fs, no node:net, no fetch, no I/O of any kind on purpose, because
// index.ts runs main() on import and unit tests must never boot a daemon
// (same pattern as relayurl.ts / relaydialerror.ts / relayretry.ts — lessons
// P2-149, P2-194 and P2-288).
//
// On a corporate or university machine the only way out to the internet is a
// proxy, and until now the daemon never read that configuration: the relay
// socket never came up and the phone simply could not find the machine. This
// module owns the DECISION — given the machine's proxy environment (already
// normalized by the caller) plus the relay URL, it returns exactly one of:
//   - "tunnel": dial the relay through the proxy with an HTTP CONNECT
//     tunnel (host + port + static pt-BR reason), or
//   - "direct": dial exactly like today (static pt-BR reason).
//
// RULE ORDER CONTRACT — rules apply in THIS order, and the order is part of
// the contract the table tests pin:
//   1. a relay URL that does not parse yields "direct" — this module never
//      guesses where traffic goes (the boot preflight in relayurl.ts already
//      disables the dial upstream; this is the same fail-closed trade);
//   2. a loopback relay is ALWAYS direct — the local install has no proxy in
//      the path and must keep working byte-for-byte like today;
//   3. a relay host that matches NO_PROXY is direct — the operator's bypass
//      list precedes any proxy address;
//   4. the proxy address is picked by precedence: the daemon's own
//      OCR_RELAY_PROXY first (the shell injects the owner's fixed choice
//      there), then the scheme-matched variable (HTTPS_PROXY for a wss relay,
//      HTTP_PROXY for ws), then ALL_PROXY;
//   5. an address that carries a non-textual value, a scheme outside the
//      http/https list, or that does not parse is DISCARDED — it fails
//      closed to "direct", never to a guessed proxy. An embedded credential
//      no longer discards the address (P2-311): the credential splits off
//      into an opaque, already-encoded secret (proxyauth.ts) and only a
//      malformed one fails closed to no secret at all;
//   6. no address at all is "direct" — exactly today's behavior;
//   7. only the remaining valid address becomes "tunnel". The result is
//      identical for the same input on every call.
//
// PRIVACY BOUNDARY: no returned value contains the proxy address, a user, a
// password or the raw environment — the tunnel's host/port and the encoded
// authorization secret ride the verdict for the dial only and never reach
// /api/health, whose relayProxyReason is static pt-BR copy and whose new
// relayProxyAuth (P2-311) is a presence-only flag, "none" or "basic" (same
// spirit as the P2-285 / P2-232 wording discipline).

import { isLoopbackHost } from "./relayurl.js";
import { parseProxyAuthority } from "./proxyauth.js";

export type RelayProxyState = "tunnel" | "direct";

/** P2-311: presence-only authorization flag — never the secret itself. */
export type RelayProxyAuth = "none" | "basic";

export interface RelayProxyTunnel {
  state: "tunnel";
  /** Proxy host for the HTTP CONNECT request — credential-free by contract. */
  host: string;
  /** Proxy port for the HTTP CONNECT request (1–65535). */
  port: number;
  /** True when the proxy address is https:// — the CONNECT leg itself is
   * tunneled over TLS to the proxy (honored, never downgraded). */
  secure: boolean;
  /** P2-311: "basic" only when a usable credential exists — presence only,
   * never the secret. */
  auth: RelayProxyAuth;
  /** P2-311: the ready Proxy-Authorization value (opaque, already encoded by
   * proxyauth.ts) or null. Rides the verdict for the dial only — never
   * logged, never in an error message, never in /api/health. */
  secret: string | null;
  /** Short static pt-BR phrase for /api/health — never the address. */
  reason: string;
}

export interface RelayProxyDirect {
  state: "direct";
  /** P2-311: a direct dial never carries proxy authorization. */
  auth: "none";
  /** Short static pt-BR phrase for /api/health — never the address. */
  reason: string;
}

export type RelayProxyVerdict = RelayProxyTunnel | RelayProxyDirect;

/** The documented proxy variables, already normalized by the caller. */
export interface RelayProxyEnv {
  HTTPS_PROXY?: unknown;
  HTTP_PROXY?: unknown;
  ALL_PROXY?: unknown;
  NO_PROXY?: unknown;
  OCR_RELAY_PROXY?: unknown;
}

/** Static pt-BR copy — no address, no credential, no raw environment. */
export const RELAY_PROXY_REASONS = {
  relayUrl: "endereço do relay ilegível — conexão direta, sem proxy",
  loopback: "o relay responde em loopback — conexão direta, sem proxy",
  noProxy: "o relay está na lista NO_PROXY — conexão direta, sem proxy",
  noProxyUnreadable: "lista NO_PROXY ilegível — conexão direta, sem proxy",
  none: "nenhum proxy configurado no ambiente — conexão direta, sem proxy",
  nonTextual: "valor de proxy não textual no ambiente — conexão direta, sem proxy",
  scheme: "proxy com esquema fora da lista http e https — conexão direta, sem proxy",
  unparseable: "endereço de proxy ilegível no ambiente — conexão direta, sem proxy",
  tunnel: "o relay atravessa o proxy desta máquina via túnel HTTP CONNECT",
  tunnelTls: "o relay atravessa o proxy desta máquina por TLS via túnel HTTP CONNECT",
} as const;

/**
 * Normalize a raw process-like environment into the documented variable set:
 * the documented uppercase names win over their lowercase twins — but an
 * EMPTY uppercase value never shadows a nonempty lowercase one (an exported
 * `HTTPS_PROXY=""` is an absence, not a choice). Pure — the caller passes
 * whatever it read; nothing here touches process.env itself.
 */
export function normalizeProxyEnv(env: unknown): RelayProxyEnv {
  if (typeof env !== "object" || env === null) return {};
  const rec = env as Record<string, unknown>;
  const blank = (v: unknown) => typeof v === "string" && v.trim() === "";
  const pick = (name: string): unknown => {
    const upper = rec[name];
    const lower = rec[name.toLowerCase()];
    if (blank(upper) && !blank(lower)) return lower;
    return upper ?? lower;
  };
  return {
    HTTPS_PROXY: pick("HTTPS_PROXY"),
    HTTP_PROXY: pick("HTTP_PROXY"),
    ALL_PROXY: pick("ALL_PROXY"),
    NO_PROXY: pick("NO_PROXY"),
    OCR_RELAY_PROXY: rec.OCR_RELAY_PROXY,
  };
}

/**
 * Parse one proxy address against the documented vocabulary (http/https only
 * — the CONNECT tunnel is an HTTP dial). Returns the credential-free proxy
 * endpoint WITH its scheme (a bare address defaults to http — the scheme
 * decides whether the CONNECT leg is tunneled over TLS) plus the opaque
 * authorization secret when the address carries a usable credential
 * (P2-311), or null when the address is discarded: a scheme outside the
 * list, path/query/fragment material, or anything that does not parse as
 * [credential@]host[:port]. Pure string work — the credential split itself
 * lives in proxyauth.ts.
 */
export function parseRelayProxyAddress(raw: unknown):
  | { ok: true; host: string; port: number; scheme: "http" | "https"; secret: string | null }
  | { ok: false; why: "scheme" | "unparseable" }
  | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value === "" || /\s/.test(value)) return null;
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(value);
  let rest = value;
  let scheme: "http" | "https" = "http";
  if (schemeMatch) {
    scheme = (schemeMatch[1] ?? "").toLowerCase() as "http" | "https";
    if (scheme !== "http" && scheme !== "https") return { ok: false, why: "scheme" };
    rest = value.slice(schemeMatch[0].length);
  }
  if (/[/?#]/.test(rest)) return { ok: false, why: "unparseable" };
  // P2-311: the credential-bearing authority is no longer a discard —
  // proxyauth.ts splits userinfo from host:port and yields the opaque secret
  // (or none, failing closed on ambiguous or undecodable credentials).
  const authority = parseProxyAuthority(value);
  if (!authority.ok) return { ok: false, why: "unparseable" };
  return {
    ok: true,
    host: authority.host,
    port: authority.port,
    scheme,
    secret: authority.secret,
  };
}

/** True when the relay host:port is covered by a NO_PROXY entry: "*" matches
 * everything, otherwise exact host or host:port equality, a leading-dot
 * entry or a bare-domain suffix match (subdomains included). */
export function noProxyCovers(raw: unknown, host: string, port: number): boolean | null {
  if (typeof raw !== "string") return null; // unreadable list — caller fails closed
  const hostLower = host.toLowerCase();
  const hostPort = `${hostLower}:${port}`;
  for (const piece of raw.split(",")) {
    const entry = piece.trim().toLowerCase();
    if (entry === "") continue;
    if (entry === "*") return true;
    const bare = entry.startsWith(".") ? entry.slice(1) : entry;
    if (bare === "") continue;
    if (entry === hostLower || entry === hostPort) return true;
    if (hostLower.endsWith(`.${bare}`)) return true;
    // a leading-dot entry also covers the bare domain (curl semantics)
    if (entry !== bare && hostLower === bare) return true;
  }
  return false;
}

/**
 * The one pure decision of this module. Deterministic: the same input yields
 * the exact same verdict on every call, and nothing is ever thrown. See the
 * RULE ORDER CONTRACT in the header.
 */
export function relayProxyVerdict(env: unknown, relayUrl: string): RelayProxyVerdict {
  const envObj = (typeof env === "object" && env !== null ? env : {}) as RelayProxyEnv;

  // Rule 1 — an unparseable relay URL never guesses a proxy (fail-closed).
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    return { state: "direct", auth: "none", reason: RELAY_PROXY_REASONS.relayUrl };
  }
  // non-special schemes (ws/wss) keep the IPv6 brackets in URL.hostname
  const relayHost = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  const relayPort = url.port !== "" ? Number(url.port) : url.protocol === "wss:" ? 443 : 80;

  // Rule 2 — loopback is always direct, whatever the environment says.
  if (isLoopbackHost(relayHost)) {
    return { state: "direct", auth: "none", reason: RELAY_PROXY_REASONS.loopback };
  }

  // Rule 3 — the operator's NO_PROXY bypass list precedes every address.
  const covered = noProxyCovers(envObj.NO_PROXY, relayHost, relayPort);
  if (covered === true) return { state: "direct", auth: "none", reason: RELAY_PROXY_REASONS.noProxy };
  if (covered === null && envObj.NO_PROXY !== undefined && envObj.NO_PROXY !== "") {
    return { state: "direct", auth: "none", reason: RELAY_PROXY_REASONS.noProxyUnreadable };
  }

  // Rule 4 — address precedence: the daemon's own variable first, then the
  // scheme-matched variable, then the all-protocol fallback.
  const secure = url.protocol === "wss:";
  const candidates: unknown[] = [
    envObj.OCR_RELAY_PROXY,
    secure ? envObj.HTTPS_PROXY : envObj.HTTP_PROXY,
    envObj.ALL_PROXY,
  ];
  let picked: unknown = undefined;
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      picked = candidate;
      break;
    }
    // rule 5, fail-closed: a present-but-non-textual value is trusted nowhere
    if (candidate !== undefined && candidate !== null && candidate !== "" && typeof candidate !== "string") {
      return { state: "direct", auth: "none", reason: RELAY_PROXY_REASONS.nonTextual };
    }
  }
  if (picked === undefined) {
    return { state: "direct", auth: "none", reason: RELAY_PROXY_REASONS.none };
  }

  // Rule 5 — an invalid address is discarded (direct), never guessed around.
  // `picked` is textual here by construction; a null parse is an unparseable
  // string (whitespace, empty authority), never a non-textual value.
  const parsed = parseRelayProxyAddress(picked);
  if (parsed === null || !parsed.ok) {
    const why = parsed === null ? "unparseable" : parsed.why;
    const reason = why === "scheme" ? RELAY_PROXY_REASONS.scheme : RELAY_PROXY_REASONS.unparseable;
    return { state: "direct", auth: "none", reason };
  }

  // Rule 7 — the remaining valid address becomes the CONNECT tunnel. An
  // https:// proxy is HONORED, not downgraded: the CONNECT leg rides a TLS
  // session to the proxy (see relaytunnel.ts), so the owner's explicit
  // TLS-to-proxy request never degrades to cleartext on a corporate network.
  const proxySecure = parsed.scheme === "https";
  return {
    state: "tunnel",
    host: parsed.host,
    port: parsed.port,
    secure: proxySecure,
    auth: parsed.secret !== null ? "basic" : "none",
    secret: parsed.secret,
    reason: proxySecure ? RELAY_PROXY_REASONS.tunnelTls : RELAY_PROXY_REASONS.tunnel,
  };
}
