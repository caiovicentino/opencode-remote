// P2-193: the combined pair link — the app address the phone opens with the
// pairing credential moved from the opencode-remote:// URI into the URL
// FRAGMENT of the #/pair hash route. One QR instead of the two-step
// scan-open-scan dance: the phone's camera opens the app already paired.
//
// Fragments are the one place a browser never ships to a server, so the
// hosted relay stays a blind router (docs/security.md). The app wipes the
// fragment with history.replaceState the moment it consumes the link.
//
// Same module hygiene as webappurl.ts / relaysetting.ts: NO electron, NO
// node:fs, no I/O — main.ts injects the resolved app address and the raw
// pairing URI at runtime, and scripts/unit.test.ts exercises every branch
// without booting a shell.
//
// Byte-a-byte rule: the URI query is sliced, never re-parsed through
// URL/URLSearchParams (they re-encode "+" and "%2F" and would corrupt the
// base64url key material — the same reason parsePairingUri hand-splits).

import { DEEP_LINK_QUERY_MAX } from "./deeplink";

/** Hash route the web app consumes (apps/web/src/App.tsx applyHash). */
export const PAIR_LINK_HASH_ROUTE = "#/pair?";

/**
 * Documented ceiling on the FINAL link length (app address + fragment).
 * Tighter than the 4KB query ceiling — QR density is the real constraint:
 * a link a phone camera cannot reliably scan is worse than no link.
 */
export const PAIR_LINK_MAX_LEN = 2048;

/** Scheme + host prefix a pairing URI must start with (compared lowercase —
 * the P2-178 lesson: never compare schemes case-sensitively). */
const SCHEME_HOST = "opencode-remote://pair";

/** The app-address side of the inputs; shape of resolveWebAppUrl's result. */
export interface PairLinkApp {
  url: string;
  origin: string;
  problems: string[];
}

export interface PairLinkResult {
  /** The combined link ("" when problems is non-empty — fail-closed). */
  url: string;
  /** Empty means valid. Messages are English, log-safe and never echo the
   * credential (the URI query may embed key material). */
  problems: string[];
}

/**
 * Build the combined pair link from an already-resolved app address
 * (resolveWebAppUrl's result) plus the raw opencode-remote://pair?... URI.
 * Every problem is fail-closed: with a non-empty problems array the url is
 * "" and the caller must keep today's two-QR fallback — a problem-bearing
 * link is never rendered as a QR.
 */
export function buildPairLink(app: PairLinkApp, rawUri: unknown): PairLinkResult {
  const problems: string[] = [];

  // App-address side. "stored"/"derived" are the only usable origins —
  // anything else ("unavailable", "stored-invalid", garbage) means the phone
  // has no address to open. Comparison stays lowercase and defensive.
  const appUrl = typeof app?.url === "string" ? app.url : "";
  const origin = typeof app?.origin === "string" ? app.origin.toLowerCase() : "";
  if (origin !== "stored" && origin !== "derived") {
    problems.push(
      `the app address is not usable (origin ${JSON.stringify(origin)}) — the phone has nothing to open`,
    );
  }
  if (Array.isArray(app?.problems)) problems.push(...app.problems);
  if (appUrl === "") problems.push("the app address is empty");
  if (appUrl.includes("#")) problems.push("the app address already carries a fragment");

  // Pairing-URI side: raw string, sliced — never URL-parsed.
  const uri = typeof rawUri === "string" ? rawUri : "";
  if (uri === "") {
    problems.push("no pairing URI is available yet");
  } else {
    const lower = uri.toLowerCase();
    if (!lower.startsWith(SCHEME_HOST)) {
      problems.push("the pairing URI does not start with opencode-remote://pair");
    } else if (uri.length > SCHEME_HOST.length && uri[SCHEME_HOST.length] !== "?") {
      problems.push("the pairing URI carries an unexpected path before the query");
    }
    if (uri.includes("#")) problems.push("the pairing URI already carries a fragment");
    const qIdx = uri.indexOf("?");
    const query = qIdx === -1 ? "" : uri.slice(qIdx + 1);
    if (query.length + 1 > DEEP_LINK_QUERY_MAX) {
      problems.push(
        `the pairing URI query is longer than the documented ceiling of ${DEEP_LINK_QUERY_MAX} characters`,
      );
    }
    // Protocol version — keys/values decoded exactly like parsePairingUri
    // decodes them (decodeURIComponent, hand-split on & and the first =).
    try {
      let v: string | null = null;
      for (const part of query.split("&")) {
        if (!part) continue;
        const eq = part.indexOf("=");
        const key = decodeURIComponent(eq === -1 ? part : part.slice(0, eq));
        if (key === "v") {
          v = decodeURIComponent(eq === -1 ? "" : part.slice(eq + 1));
          break;
        }
      }
      if (v !== "2") problems.push("the pairing URI is not protocol version 2");
    } catch {
      problems.push("the pairing URI has malformed percent-encoding");
    }
    // The link itself: app address + hash route + the query byte a byte.
    const link = `${appUrl}${PAIR_LINK_HASH_ROUTE}${query}`;
    if (link.length > PAIR_LINK_MAX_LEN) {
      problems.push(
        `the combined pair link is longer than the documented ceiling of ${PAIR_LINK_MAX_LEN} characters`,
      );
    }
    return { url: problems.length === 0 ? link : "", problems };
  }
  return { url: "", problems };
}
