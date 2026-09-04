// P2-161: staged update-feed port resolution at serve time. Pure module — no
// node:fs and no node:http imports on purpose, because index.ts runs main() on
// import and unit tests must never boot a daemon (same pattern as
// relayclose.ts / relayurl.ts).
//
// feed.json is a Squirrel.Mac pointer document ({url, name, notes, pub_date})
// whose `url` field is ABSOLUTE:
// http://127.0.0.1:<port>/__ocr/updates/<version>/<file>. That port is
// recorded when the release is staged, but since P2-143 the daemon may boot on
// a fallback port (8793..8796) — the desktop resolves the feed by its own
// fallback-aware getter (apps/desktop/src/update.ts), announces the new
// version, and then fails the download against the dead recorded address with
// no signal to the user. The fix is to resolve the port when the route serves
// the document: the loopback URL is rewritten to the actually-bound port.
//
// Fail-closed by design: ANY doubt returns the original body untouched —
// invalid JSON, missing url field, unparseable or non-http url, non-loopback
// host, path outside the updates route, or an invalid/zero bound port. The
// rewrite is one-field port surgery on the raw text; nothing else in the
// document moves, and latest.yml is never seen here (its `path` field is
// relative to the feed's own address, so it needs no rewrite).

import { isLoopbackHost } from "./relayurl.js";

/** Path prefix of the daemon's staged update route (apps/daemon/src/index.ts). */
export const FEED_UPDATES_ROUTE = "/__ocr/updates/";

export interface FeedPortResult {
  /** Body to serve: the rewritten feed, or the input text untouched. */
  body: string;
  /** True when the port surgery actually happened. */
  rewritten: boolean;
  /** Why the body is what it is — log-safe: no paths, no tokens. */
  reason: string;
}

/**
 * Rewrite the port of the feed's absolute loopback URL to the actually-bound
 * daemon port. The input text is treated as immutable: preserved cases come
 * back byte-for-byte, and a rewrite replaces exactly the url substring, so
 * formatting and every other field survive untouched.
 */
export function rewriteFeedPort(feedText: string, boundPort: number): FeedPortResult {
  if (!Number.isInteger(boundPort) || boundPort < 1 || boundPort > 65535) {
    return { body: feedText, rewritten: false, reason: "invalid-port" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(feedText);
  } catch {
    return { body: feedText, rewritten: false, reason: "invalid-json" };
  }
  const doc = parsed as { url?: unknown } | null;
  if (doc === null || typeof doc !== "object" || typeof doc.url !== "string" || doc.url.length === 0) {
    return { body: feedText, rewritten: false, reason: "no-url" };
  }
  let target: URL;
  try {
    target = new URL(doc.url);
  } catch {
    return { body: feedText, rewritten: false, reason: "invalid-url" };
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return { body: feedText, rewritten: false, reason: "non-http" };
  }
  if (!isLoopbackHost(target.hostname)) {
    return { body: feedText, rewritten: false, reason: "non-loopback" };
  }
  if (!target.pathname.startsWith(FEED_UPDATES_ROUTE)) {
    return { body: feedText, rewritten: false, reason: "foreign-path" };
  }
  if (target.port === "") {
    return { body: feedText, rewritten: false, reason: "no-port" };
  }
  if (target.port === String(boundPort)) {
    return { body: feedText, rewritten: false, reason: "port-current" };
  }
  // Textual port surgery: swap ONLY the port digits inside the raw url
  // substring. Rebuilding via URL normalization would percent-encode
  // characters the staged feed legitimately contains (artifact names with
  // spaces) and change bytes that are not ours to touch.
  const schemeEnd = doc.url.indexOf("://");
  const authStart = schemeEnd === -1 ? -1 : schemeEnd + 3;
  const pathStart = authStart === -1 ? -1 : doc.url.indexOf("/", authStart);
  const authority =
    authStart === -1 ? "" : pathStart === -1 ? doc.url.slice(authStart) : doc.url.slice(authStart, pathStart);
  const portMatch = /:(\d+)$/.exec(authority);
  if (!portMatch) {
    return { body: feedText, rewritten: false, reason: "no-port" };
  }
  const beforePort = doc.url.slice(0, authStart + portMatch.index);
  const afterPort = doc.url.slice(authStart + authority.length);
  const replaced = feedText.replace(doc.url, `${beforePort}:${boundPort}${afterPort}`);
  if (replaced === feedText) {
    // The parsed url is not verbatim in the text (escaped slashes, say) —
    // fail closed rather than claim a rewrite that never landed.
    return { body: feedText, rewritten: false, reason: "url-not-verbatim" };
  }
  return { body: replaced, rewritten: true, reason: "rewritten" };
}
