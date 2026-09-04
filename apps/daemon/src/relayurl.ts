// P2-139: RELAY_URL boot validation. Pure decision logic for the daemon's
// relay dial — no ws/net imports on purpose, because index.ts runs main() on
// import and unit tests must never boot a daemon (same pattern as
// relayretry.ts / localws.ts).
//
// Fail-closed in the P2-114 spirit: a RELAY_URL with a typo, a wrong scheme,
// or plain ws:// pointed at a public host must not become a silent infinite
// reconnect loop that still hands the phone a QR it can never use. Any
// problem means the daemon does not open the relay socket, logs the reason
// once at boot, and withholds the pairing URI. Loopback ws:// stays valid so
// the default local install keeps working unchanged.

export interface RelayUrl {
  /** Normalized URL when parseable (trailing slash added); "" otherwise. */
  href: string;
  /** host[:port] from the URL; "" when unparseable. */
  host: string;
  /** True when the scheme is wss. */
  secure: boolean;
  /** Non-empty means the boot must NOT dial the relay (fail-closed). */
  problems: string[];
}

/**
 * True only for provably loopback hosts. Unknown hostnames are treated as
 * non-loopback — fail-closed beats accidentally shipping clear-text pairing
 * traffic across the network.
 */
export function isLoopbackHost(host: string): boolean {
  // non-special schemes (ws/wss) keep the IPv6 brackets in URL.hostname
  const h = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return h === "localhost" || h === "::1" || h.startsWith("127.");
}

/**
 * Validate a RELAY_URL string. Only ws:// and wss:// are accepted; ws:// on a
 * non-loopback host is a problem because room metadata and pairing traffic
 * would traverse the network without TLS. The href is the WHATWG-normalized
 * form (e.g. "ws://127.0.0.1:8787" and "ws://127.0.0.1:8787/" converge), so
 * install scripts can pass either shape.
 */
export function parseRelayUrl(raw: string): RelayUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      href: "",
      host: "",
      secure: false,
      problems: [
        `RELAY_URL=${JSON.stringify(raw)} is not a valid URL: refusing to dial the relay (fail-closed)`,
      ],
    };
  }
  const problems: string[] = [];
  const secure = url.protocol === "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    problems.push(
      `RELAY_URL scheme ${JSON.stringify(url.protocol)} is not supported — only ws:// and wss:// are accepted: ` +
        "refusing to dial the relay (fail-closed)",
    );
  }
  if (!secure && !isLoopbackHost(url.hostname)) {
    problems.push(
      `RELAY_URL points at non-loopback host ${JSON.stringify(url.host)} over plain ws://: ` +
        "room metadata and pairing traffic would cross the network without TLS — refusing to dial the relay (fail-closed)",
    );
  }
  return { href: url.href, host: url.host, secure, problems };
}
