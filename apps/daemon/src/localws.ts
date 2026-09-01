// P1-061: pure admission helpers for the daemon's local direct-mode WebSocket
// (ws://127.0.0.1:<port>/ws). Kept in their own module because index.ts runs
// main() on import — unit tests pin these predicates without booting a daemon.

/**
 * Defense-in-depth loopback check on the upgraded socket. The metrics/API
 * server already binds 127.0.0.1, but the upgrade handler re-verifies the
 * peer address so a future bind change can never silently expose the WS.
 */
export function isLoopbackAddr(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/**
 * Loopback-Origin allowlist for the /ws upgrade. Browsers always send Origin
 * on WebSocket dials; arbitrary web pages (evil.example) must not be able to
 * hold local sockets against the daemon. Non-browser clients (tests, curl,
 * Electron's file:// renderer) send no Origin or an opaque/file one.
 */
export function localOriginAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  if (origin === "null" || origin === "file://") return true; // Electron loadFile
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Full upgrade predicate: only the exact /ws path, from loopback, with the
 * daemon's apiToken in the query, from an allowed Origin. Never log the URL
 * on rejection — the token rides in the query string.
 */
export function localUpgradeAllowed(
  pathname: string,
  token: string | null,
  remoteAddress: string | undefined,
  origin: string | undefined,
  expectedToken: string,
): boolean {
  return (
    pathname === "/ws" &&
    isLoopbackAddr(remoteAddress) &&
    localOriginAllowed(origin) &&
    token !== null &&
    token.length > 0 &&
    token === expectedToken
  );
}
