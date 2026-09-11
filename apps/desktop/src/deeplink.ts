// Deep-link validation for the opencode-remote:// protocol (P3-014). The OS
// hands the shell a raw string (macOS open-url, Windows second-instance argv)
// that must never reach the renderer unvalidated: this module accepts ONLY a
// pair URI — opencode-remote://pair?v=2&... — with a ≤4KB query and a safe
// charset, and returns null for everything else. Kept free of electron
// imports so scripts/unit.test.ts can exercise it directly (same pattern as
// window-state.ts); main.ts injects the OS-supplied raw value at runtime.

export const DEEP_LINK_SCHEME = "opencode-remote";
export const DEEP_LINK_HOST = "pair";
export const DEEP_LINK_VERSION = "2";
/** Ceiling on the query string (the `?v=2&...` part, `?` included). */
export const DEEP_LINK_QUERY_MAX = 4 * 1024;

/**
 * RFC 3986 allowed characters (unreserved + sub-delims + ":@/?#" + % for
 * percent-escapes). Anything else — spaces, control characters, quotes,
 * angle brackets — fails the link outright, whatever the URL parser would
 * make of it. Percent-escape correctness is left to parsePairingUri, whose
 * decodeURIComponent throws on invalid sequences.
 */
const SAFE_URI_CHARS = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/?#%]*$/;

/**
 * Validates a raw deep-link string. Returns the URI unchanged when it is a
 * well-formed pair link (the renderer re-parses it with parsePairingUri —
 * no crypto or decoding happens here), null otherwise.
 */
export function parseDeepLink(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const uri = raw.trim();
  if (!uri || !SAFE_URI_CHARS.test(uri)) return null;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
  // Opaque hosts keep their case (WHATWG URL only normalizes special
  // schemes), so compare case-insensitively.
  if (url.host.toLowerCase() !== DEEP_LINK_HOST) return null;
  // "opencode-remote://pair?v=2&..." only: no path suffix, no fragment.
  if (url.pathname !== "" && url.pathname !== "/") return null;
  if (url.hash !== "") return null;
  if (url.search.length > DEEP_LINK_QUERY_MAX) return null;
  if (url.searchParams.get("v") !== DEEP_LINK_VERSION) return null;
  return uri;
}

/**
 * Pulls a deep link out of the second-instance argv (Windows: the OS spawns a
 * second process whose argv carries the URL; the single-instance winner sees
 * it). Returns the first validated link, or null when argv holds none.
 */
export function deepLinkFromArgv(argv: unknown): string | null {
  if (!Array.isArray(argv)) return null;
  for (const arg of argv) {
    if (typeof arg === "string" && arg.startsWith(`${DEEP_LINK_SCHEME}://`)) {
      const uri = parseDeepLink(arg);
      if (uri) return uri;
    }
  }
  return null;
}

/**
 * P2-329 — the cold-start plan: an invite link clicked with the app CLOSED
 * (Windows) makes the OS launch the shell itself with the URI in argv, so
 * main.ts consults this once at boot and hands the result to handleDeepLink.
 * The rules are evaluated in EXACTLY this order, first match wins:
 *   1. a harness session (OCR_DESKTOP_SESSION) never consumes a link — the
 *      hermetic e2e shell must not pair off the operator's machine argv;
 *   2. a non-packaged (dev) build never claims the OS protocol handler, so a
 *      dev argv carrying a URI is noise, not an invite;
 *   3. any platform other than win32 returns null — macOS delivers the link
 *      through open-url, which main.ts already wires to handleDeepLink;
 *   4. only then is deepLinkFromArgv consulted on the raw argv.
 * Pure and electron-free like the rest of this module — scripts/unit.test.ts
 * and scripts/deeplink-coldstart.test.ts pin every branch plus the wiring.
 */
export interface ColdStartDeepLinkInput {
  /** True under the hermetic e2e harness (OCR_DESKTOP_SESSION in main.ts). */
  harnessSession: boolean;
  /** Packaged (installer) build indicator — app.isPackaged in main.ts. */
  packaged: boolean;
  /** The running shell's process.platform. */
  platform: string;
  /** The launching process argv (process.argv on a Windows cold start). */
  argv: unknown;
}

export function coldStartDeepLink(input: ColdStartDeepLinkInput): string | null {
  if (input.harnessSession) return null;
  if (!input.packaged) return null;
  if (input.platform !== "win32") return null;
  return deepLinkFromArgv(input.argv);
}
