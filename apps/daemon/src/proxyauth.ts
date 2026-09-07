// P2-311: credential split for the machine-proxy address. Pure module — no
// node:fs, no node:net, no fetch, no I/O of any kind on purpose, because
// index.ts runs main() on import and unit tests must never boot a daemon
// (same hygiene as relayproxy.ts / relayurl.ts — lessons P2-149, P2-288).
//
// P2-303 discarded any proxy address carrying embedded credentials, so the
// most common corporate machine — the one whose proxy demands a user and a
// password — stayed permanently without a relay. This module owns the split:
// given the raw proxy address it returns the credential-free host and port
// plus an OPAQUE, ALREADY-ENCODED authorization secret (the ready
// `Proxy-Authorization` header value, base64 like any HTTP Basic client), or
// no secret at all. The caller never sees the user or the password.
//
// FAIL-CLOSED CONTRACT — the secret is null (and never guessed) whenever:
//   1. the raw value is not textual (there is nothing to parse either);
//   2. user and password are both empty — no "@" at all, or an empty
//      userinfo like "@host"; the address simply dials unauthenticated;
//   3. the authority carries more than one "@" — the userinfo is ambiguous,
//      so no credential is derived (the host after the LAST "@" still
//      parses);
//   4. the user or the password holds invalid percent-encoding ("%" not
//      followed by two hex digits) — the credential can never be decoded
//      deterministically, so it is never sent.
// The percent-decoding happens AFTER the user:password split (a percent
// sequence never creates a delimiter), and the decoded pair only feeds the
// base64 encoder — the header value is pure base64, so a decoded control
// character can never smuggle itself into the CONNECT request.

export type ProxyAuthorityVerdict =
  | {
      ok: true;
      /** Credential-free proxy host. */
      host: string;
      /** Proxy port (1–65535); a bare authority defaults to 80 — the exact
       * default relayproxy.ts applied before P2-311. */
      port: number;
      /** The ready `Proxy-Authorization` value ("Basic …"), or null when no
       * usable credential exists (see the fail-closed contract above). */
      secret: string | null;
    }
  | { ok: false; why: "non-textual" | "authority" };

/**
 * Split one raw proxy address into a credential-free authority plus an
 * optional opaque authorization secret. An optional scheme prefix is stripped
 * tolerantly — the scheme POLICY (http/https only) belongs to the caller
 * (relayproxy.ts), never here. Deterministic: the same input yields the exact
 * same verdict on every call, and nothing is ever thrown.
 */
export function parseProxyAuthority(raw: unknown): ProxyAuthorityVerdict {
  if (typeof raw !== "string") return { ok: false, why: "non-textual" };
  const value = raw.trim();
  if (value === "" || /\s/.test(value)) return { ok: false, why: "authority" };
  const schemeMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(value);
  const authority = schemeMatch ? value.slice(schemeMatch[0].length) : value;
  if (/[/?#]/.test(authority)) return { ok: false, why: "authority" };

  // Userinfo split at the LAST "@" (URL semantics): everything before it is
  // credential material, everything after it is the host:port to dial.
  const at = authority.lastIndexOf("@");
  const hostPart = at === -1 ? authority : authority.slice(at + 1);
  const rawUserinfo = at === -1 ? "" : authority.slice(0, at);
  // More than one "@": the userinfo itself is ambiguous — fail closed to no
  // secret, while the host after the last "@" still parses.
  const userinfo = rawUserinfo.includes("@") ? null : rawUserinfo;

  let secret: string | null = null;
  if (userinfo !== null) {
    const colon = userinfo.indexOf(":");
    const rawUser = colon === -1 ? userinfo : userinfo.slice(0, colon);
    const rawPass = colon === -1 ? "" : userinfo.slice(colon + 1);
    try {
      const user = decodeURIComponent(rawUser);
      const pass = decodeURIComponent(rawPass);
      if (user !== "" || pass !== "") {
        secret = `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
      }
    } catch {
      // invalid percent-encoding — the credential can never be decoded
      // deterministically; fall through with no secret (host/port stay valid)
    }
  }

  // host:port — byte-for-byte the parser relayproxy.ts used before P2-311.
  let host = hostPart;
  let port = 80;
  let bracketed = false;
  if (hostPart.startsWith("[")) {
    const close = hostPart.indexOf("]");
    if (close === -1) return { ok: false, why: "authority" };
    host = hostPart.slice(1, close);
    bracketed = true;
    const after = hostPart.slice(close + 1);
    if (after !== "" && !after.startsWith(":")) return { ok: false, why: "authority" };
    const portText = after.slice(1);
    if (portText !== "") port = Number(portText);
  } else {
    const colon = hostPart.lastIndexOf(":");
    if (colon !== -1) {
      host = hostPart.slice(0, colon);
      const portText = hostPart.slice(colon + 1);
      if (!/^\d{1,5}$/.test(portText)) return { ok: false, why: "authority" };
      port = Number(portText);
    }
  }
  // A bare unbracketed IPv6 literal carries more colons than a host:port
  // split can disambiguate — fail closed instead of guessing.
  if (host === "" || (!bracketed && host.includes(":"))) return { ok: false, why: "authority" };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, why: "authority" };
  return { ok: true, host, port, secret };
}
