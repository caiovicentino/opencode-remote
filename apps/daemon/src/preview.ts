// P1-072: auto-preview detection. Pure helpers (same pattern as localws.ts:
// index.ts runs main() on import, so testable logic lives in its own module).
// When the agent mentions a loopback http(s) URL with an explicit port in an
// assistant message, the daemon emits a synthetic `ocr.preview` event so the
// desktop app can open its Browser pane on that URL by itself.

/** The daemon's own metrics/API port never triggers a preview (self-loop). */
export const PREVIEW_DAEMON_PORT = 8792;

const MAX_URL_LENGTH = 2048;
const MAX_URLS_PER_CALL = 4;
/** Upper bound on scanned text per part (CPU bound; agent parts are far smaller). */
const MAX_TEXT_LENGTH = 100_000;
export const PREVIEW_DEDUPE_TTL_MS = 10 * 60_000;
export const PREVIEW_DEDUPE_CAP = 100;

/** Loopback http(s) URLs with an explicit port, e.g. http://localhost:3000/x. */
const CANDIDATE_RE = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)+(?:\/[^\s"'<>`]*)?/gi;

/** Trailing punctuation that is almost never part of the URL in prose. */
const TRAILING_NOISE = /[.,;:!?'"]+$/;

function trimCandidate(raw: string): string {
  let s = raw.replace(TRAILING_NOISE, "");
  // "(http://localhost:3000)" — a closing paren only belongs to the URL when
  // the match also opened one; otherwise it is sentence punctuation.
  if (s.endsWith(")") && !s.includes("(")) s = s.slice(0, -1);
  return s;
}

/**
 * Deterministic extraction of loopback preview URLs from free text:
 * - only http(s) on localhost/127.0.0.1 with an EXPLICIT port (1..65535);
 * - the daemon's own port (8792) is ignored so previews never self-trigger;
 * - non-loopback hosts ("https://example.com") and portless localhost never match;
 * - each URL is capped at 2048 chars and at most 4 URLs per call, in order.
 */
export function extractLocalUrls(text: string): string[] {
  if (!text || typeof text !== "string" || text.length > MAX_TEXT_LENGTH) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(CANDIDATE_RE)) {
    const candidate = trimCandidate(match[0] ?? "");
    if (!candidate || candidate.length > MAX_URL_LENGTH) continue;
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      continue; // invalid port (>65535), malformed host, etc.
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") continue;
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    if (port === PREVIEW_DAEMON_PORT) continue;
    const href = parsed.toString();
    if (seen.has(href)) continue;
    seen.add(href);
    out.push(href);
    if (out.length >= MAX_URLS_PER_CALL) break;
  }
  return out;
}

/**
 * Dedupe of emitted previews per session: the same sessionID:url within the
 * TTL window is dropped (the agent repeats the URL on every streamed token);
 * the map is capped so a long-lived daemon never grows without bound.
 */
export class PreviewDedupe {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = PREVIEW_DEDUPE_TTL_MS,
    private readonly cap: number = PREVIEW_DEDUPE_CAP,
  ) {}

  /** True when sessionID:url was NOT emitted inside the TTL window yet. */
  firstSeen(sessionID: string, url: string, now: number = Date.now()): boolean {
    const key = `${sessionID}\u0000${url}`;
    const prev = this.seen.get(key);
    if (prev !== undefined && now - prev < this.ttlMs) return false;
    if (this.seen.size >= this.cap && prev === undefined) {
      for (const [k, ts] of this.seen) {
        if (now - ts >= this.ttlMs) this.seen.delete(k);
      }
      while (this.seen.size >= this.cap) {
        const oldest = this.seen.keys().next().value;
        if (oldest === undefined) break;
        this.seen.delete(oldest);
      }
    }
    this.seen.set(key, now);
    return true;
  }
}
