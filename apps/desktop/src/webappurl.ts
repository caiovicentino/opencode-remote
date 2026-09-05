// P2-189: the address the phone opens to reach the app (step one of the
// pairing journey — before this module the shell only ever showed the
// opencode-remote:// pairing URI, which presumes the app is ALREADY open on
// the phone with the scanner up; how the phone gets there in the first place
// was left for the user to guess). Same module hygiene as relaysetting.ts /
// extlink.ts: NO electron, NO node:fs, no I/O — main.ts injects the relay
// resolution and the persisted value at runtime, and scripts/unit.test.ts
// exercises every branch without booting a shell.
//
// The default address is DERIVED from the relay address (the same host that
// runs the relay serves the web app too — the documented deployment
// convention, docs/RELAY-HOSTING.md): wss:// becomes https:// and ws://
// becomes http://, host and port preserved, path and query discarded.
// Fail-closed in the P2-139 spirit, twice over:
//   - a stored value that fails webAppUrlProblems is NEVER silently replaced
//     by the derived one (the user's explicit choice wins, or nothing);
//   - a loopback relay produces origin "unavailable" with an explicit reason
//     instead of an address the phone can never reach — an address that
//     cannot work is worse than no address at all.

/** Documented ceiling for a stored app address — mirrors RELAY_URL_MAX_LEN. */
export const WEB_APP_URL_MAX_LEN = 512;

/** Where the effective address came from, surfaced verbatim in the UI. */
export type WebAppUrlOrigin = "stored" | "derived" | "unavailable";

export interface WebAppUrlResolution {
  /** The address the phone opens ("" when unavailable). */
  url: string;
  origin: WebAppUrlOrigin;
  /** Empty means valid. Non-empty means: show the reason, never a QR. */
  problems: string[];
}

/**
 * True only for provably loopback hosts — the SAME strict rule as
 * isLoopbackHost in relaysetting.ts (and in the daemon's relayurl.ts boot
 * authority). Duplicated on purpose: a workspace import would run foreign
 * main() code at import time; scripts/unit.test.ts proves parity on a shared
 * host table.
 */
export function isLoopbackHost(host: string): boolean {
  // non-special schemes keep the IPv6 brackets in URL.hostname
  const h = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (h === "localhost" || h === "::1") return true;
  const quad = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!quad) return false;
  return quad.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * Validate a raw app address (any type — the value may come from disk or from
 * the renderer over IPC, so nothing is trusted). Empty problems = valid.
 * Messages are English, log-safe and never echo the raw value (it may embed
 * credentials). P2-178 lesson: the scheme comparison is done lowercase —
 * WHATWG URL already lowercases the protocol, but the comparison stays
 * defensive so a future refactor cannot reintroduce scheme confusion.
 */
export function webAppUrlProblems(raw: unknown): string[] {
  if (typeof raw !== "string") return ["WEB_APP_URL must be a string"];
  if (raw.trim() === "") return ["WEB_APP_URL is empty"];
  if (raw.length > WEB_APP_URL_MAX_LEN) {
    return [`WEB_APP_URL is longer than the documented ceiling of ${WEB_APP_URL_MAX_LEN} characters`];
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return ["WEB_APP_URL is not a valid URL: refusing to use it (fail-closed)"];
  }
  const problems: string[] = [];
  const scheme = url.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") {
    problems.push(
      `WEB_APP_URL scheme ${JSON.stringify(scheme)} is not supported — only http:// and https:// are accepted`,
    );
  }
  if (scheme === "http:" && !isLoopbackHost(url.hostname)) {
    problems.push(
      `WEB_APP_URL points at non-loopback host ${JSON.stringify(url.host)} over plain http:// — ` +
        "serve the app over https:// on a hosted relay",
    );
  }
  if (url.username !== "" || url.password !== "") {
    problems.push("WEB_APP_URL embeds user/password credentials — remove them (fail-closed)");
  }
  return problems;
}

/**
 * Map the (already resolved and validated) relay address to the address the
 * phone opens: wss:// → https://, ws:// → http://, host and port preserved,
 * path and query discarded. Returns "" when the relay address is not a
 * parseable ws/wss URL — callers then report "unavailable" instead of
 * inventing a lie.
 */
export function deriveWebAppUrl(relayUrl: string): string {
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    return "";
  }
  const scheme = url.protocol.toLowerCase();
  if (scheme === "wss:") return `https://${url.host}`;
  if (scheme === "ws:") return `http://${url.host}`;
  return "";
}

/**
 * Which address the phone should open:
 * 1. A valid stored value ALWAYS wins — it is the operator's explicit choice
 *    (a relay host that does not serve the app on the same origin is exactly
 *    why the field exists).
 * 2. A present-but-INVALID stored value NEVER falls back silently to the
 *    derived one — origin "unavailable" with the problems filled.
 * 3. Nothing stored → derive from the relay address:
 *    - ws:// to a loopback host → unavailable with an explicit reason (the
 *      phone can never reach 127.0.0.1 — that address is worse than its
 *      absence, the P2-139 criterion);
 *    - plain ws:// to a public host → derived http:// WITH a problem (the
 *      address is returned but the caller withholds the QR — an insecure
 *      app origin must not be scannable);
 *    - wss:// → derived https://, no problems;
 *    - anything else (empty, unparseable, not ws/wss) → unavailable with an
 *      explicit reason.
 */
export function resolveWebAppUrl(
  relay: { url: string; origin: string; problems: string[] },
  stored: unknown,
): WebAppUrlResolution {
  if (typeof stored === "string") {
    const problems = webAppUrlProblems(stored);
    if (problems.length === 0) {
      return { url: stored.trim(), origin: "stored", problems: [] };
    }
    // Fail-closed: never pretend the derived address is in effect.
    return { url: "", origin: "unavailable", problems };
  }
  if (stored !== null && stored !== undefined) {
    return { url: "", origin: "unavailable", problems: webAppUrlProblems(stored) };
  }
  if (relay.url === "") {
    return { url: "", origin: "unavailable", problems: ["no relay address is configured yet"] };
  }
  let relayUrl: URL;
  try {
    relayUrl = new URL(relay.url);
  } catch {
    return { url: "", origin: "unavailable", problems: ["the relay address is not a valid URL"] };
  }
  const scheme = relayUrl.protocol.toLowerCase();
  if (scheme !== "ws:" && scheme !== "wss:") {
    return { url: "", origin: "unavailable", problems: ["the relay address is not a ws:// or wss:// URL"] };
  }
  if (scheme === "ws:" && isLoopbackHost(relayUrl.hostname)) {
    return {
      url: "",
      origin: "unavailable",
      problems: [
        "the local relay only serves this machine — the phone can never reach a loopback address; point the app at a hosted relay in Settings",
      ],
    };
  }
  const derived = deriveWebAppUrl(relay.url);
  if (derived === "") {
    return { url: "", origin: "unavailable", problems: ["the relay address could not be mapped to an app address"] };
  }
  if (scheme === "ws:") {
    return {
      url: derived,
      origin: "derived",
      problems: [
        `WEB_APP_URL points at non-loopback host ${JSON.stringify(relayUrl.host)} over plain http:// — ` +
          "serve the app over https:// on a hosted relay",
      ],
    };
  }
  return { url: derived, origin: "derived", problems: [] };
}
