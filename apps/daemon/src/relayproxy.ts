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
//   5. an address that carries a non-textual value, an embedded credential,
//      a scheme outside the http/https list, or that does not parse is
//      DISCARDED — it fails closed to "direct", never to a guessed proxy;
//   6. no address at all is "direct" — exactly today's behavior;
//   7. only the remaining valid address becomes "tunnel". The result is
//      identical for the same input on every call.
//
// PRIVACY BOUNDARY: no returned value contains the proxy address, a user, a
// password or the raw environment — the tunnel's host/port ride the verdict
// for the dial only and never reach /api/health, whose relayProxyReason is
// static pt-BR copy (same spirit as the P2-285 / P2-232 wording discipline).

import { isLoopbackHost } from "./relayurl.js";

export type RelayProxyState = "tunnel" | "direct";

export interface RelayProxyTunnel {
  state: "tunnel";
  /** Proxy host for the HTTP CONNECT request — credential-free by contract. */
  host: string;
  /** Proxy port for the HTTP CONNECT request (1–65535). */
  port: number;
  /** Short static pt-BR phrase for /api/health — never the address. */
  reason: string;
}

export interface RelayProxyDirect {
  state: "direct";
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
  credential: "proxy com credencial embutida não é suportado — conexão direta, sem proxy",
  scheme: "proxy com esquema fora da lista http e https — conexão direta, sem proxy",
  unparseable: "endereço de proxy ilegível no ambiente — conexão direta, sem proxy",
  tunnel: "o relay atravessa o proxy desta máquina via túnel HTTP CONNECT",
} as const;

/**
 * Normalize a raw process-like environment into the documented variable set:
 * the documented uppercase names win over their lowercase twins. Pure — the
 * caller passes whatever it read; nothing here touches process.env itself.
 */
export function normalizeProxyEnv(env: unknown): RelayProxyEnv {
  if (typeof env !== "object" || env === null) return {};
  const rec = env as Record<string, unknown>;
  const pick = (name: string): unknown => rec[name] ?? rec[name.toLowerCase()];
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
 * endpoint, or null when the address is discarded: a scheme outside the
 * list, embedded credentials, path/query/fragment material, a bad port or
 * anything that does not parse as host[:port]. Pure string work.
 */
export function parseRelayProxyAddress(raw: unknown):
  | { ok: true; host: string; port: number }
  | { ok: false; why: "credential" | "scheme" | "unparseable" }
  | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value === "" || /\s/.test(value)) return null;
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(value);
  let rest = value;
  if (schemeMatch) {
    const scheme = (schemeMatch[1] ?? "").toLowerCase();
    if (scheme !== "http" && scheme !== "https") return { ok: false, why: "scheme" };
    rest = value.slice(schemeMatch[0].length);
  }
  if (rest.includes("@")) return { ok: false, why: "credential" };
  if (/[/?#]/.test(rest)) return { ok: false, why: "unparseable" };
  let host = rest;
  let port = 80;
  let bracketed = false;
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close === -1) return { ok: false, why: "unparseable" };
    host = rest.slice(1, close);
    bracketed = true;
    const after = rest.slice(close + 1);
    if (after !== "" && !after.startsWith(":")) return { ok: false, why: "unparseable" };
    const portText = after.slice(1);
    if (portText !== "") port = Number(portText);
  } else {
    const colon = rest.lastIndexOf(":");
    if (colon !== -1) {
      host = rest.slice(0, colon);
      const portText = rest.slice(colon + 1);
      if (!/^\d{1,5}$/.test(portText)) return { ok: false, why: "unparseable" };
      port = Number(portText);
    }
  }
  // A bare unbracketed IPv6 literal carries more colons than a host:port
  // split can disambiguate — fail closed instead of guessing.
  if (host === "" || (!bracketed && host.includes(":"))) return { ok: false, why: "unparseable" };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, why: "unparseable" };
  return { ok: true, host, port };
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
    return { state: "direct", reason: RELAY_PROXY_REASONS.relayUrl };
  }
  // non-special schemes (ws/wss) keep the IPv6 brackets in URL.hostname
  const relayHost = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  const relayPort = url.port !== "" ? Number(url.port) : url.protocol === "wss:" ? 443 : 80;

  // Rule 2 — loopback is always direct, whatever the environment says.
  if (isLoopbackHost(relayHost)) {
    return { state: "direct", reason: RELAY_PROXY_REASONS.loopback };
  }

  // Rule 3 — the operator's NO_PROXY bypass list precedes every address.
  const covered = noProxyCovers(envObj.NO_PROXY, relayHost, relayPort);
  if (covered === true) return { state: "direct", reason: RELAY_PROXY_REASONS.noProxy };
  if (covered === null && envObj.NO_PROXY !== undefined && envObj.NO_PROXY !== "") {
    return { state: "direct", reason: RELAY_PROXY_REASONS.noProxyUnreadable };
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
      return { state: "direct", reason: RELAY_PROXY_REASONS.nonTextual };
    }
  }
  if (picked === undefined) {
    return { state: "direct", reason: RELAY_PROXY_REASONS.none };
  }

  // Rule 5 — an invalid address is discarded (direct), never guessed around.
  // `picked` is textual here by construction; a null parse is an unparseable
  // string (whitespace, empty authority), never a non-textual value.
  const parsed = parseRelayProxyAddress(picked);
  if (parsed === null || !parsed.ok) {
    const why = parsed === null ? "unparseable" : parsed.why;
    const reason =
      why === "credential"
        ? RELAY_PROXY_REASONS.credential
        : why === "scheme"
          ? RELAY_PROXY_REASONS.scheme
          : RELAY_PROXY_REASONS.unparseable;
    return { state: "direct", reason };
  }

  // Rule 7 — the remaining valid address becomes the CONNECT tunnel.
  return { state: "tunnel", host: parsed.host, port: parsed.port, reason: RELAY_PROXY_REASONS.tunnel };
}
