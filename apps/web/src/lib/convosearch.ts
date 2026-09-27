// eval-20: conversation CONTENT search — the client slice of P3-400. The
// daemon has served GET /__ocr/search since 2026-09-10 (the pure matcher in
// apps/daemon/src/searchindex.ts), but no screen consumed it: the sidebar
// search and the ⌘K palette only matched titles (lib/sessionFilter.ts), so a
// discussion was unreachable unless its title said the word. This module is
// the pure part of the wiring — term gating, fail-closed parsing of the
// daemon answer, snippet segments that keep the match visible in a one-line
// row, and the de-duplication against the title matches already on screen.
// No React, no DOM, no fetch: scripts/convosearch.test.ts drives it directly.

/** Terms shorter than this never leave the device. Mirrors SEARCH_MIN_TERM
 * in apps/daemon/src/searchindex.ts (parity pinned by the test) — the route
 * answers 400 below it. */
export const CONTENT_SEARCH_MIN = 2;

/** Typing pause before the request fires: one scan per settled term, not one
 * per keystroke (each scan reads up to 200 conversations on the host). */
export const CONTENT_SEARCH_DEBOUNCE_MS = 250;

/** Budget for one search round-trip through the tunnel. The daemon's own
 * scan budget is 1.5s; the rest is relay latency on a phone. */
export const CONTENT_SEARCH_TIMEOUT_MS = 8_000;

/** Characters of context kept before the match in a one-line row, so the
 * occurrence is never pushed behind the row's ellipsis. */
export const SNIPPET_LEAD_ROWS = 24;
export const SNIPPET_LEAD_PALETTE = 40;

export interface ContentHit {
  id: string;
  title: string;
  /** recency instant, ms since the epoch (0 when unknown) */
  instant: number;
  snippet: string;
  matchStart: number;
  matchEnd: number;
}

export type ContentAnswer =
  | { kind: "ok"; hits: ContentHit[]; truncated: boolean }
  /** the host predates the route (older daemon) — search titles only */
  | { kind: "unsupported" }
  | { kind: "error" };

export interface SnippetSegment {
  text: string;
  mark: boolean;
}

/** The trimmed term to search for, or null when the query is too short. */
export function contentSearchTerm(query: unknown): string | null {
  if (typeof query !== "string") return null;
  const term = query.trim();
  return term.length >= CONTENT_SEARCH_MIN ? term : null;
}

function isInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n);
}

/** One hit from the wire, or null when it cannot be rendered honestly. */
function sanitizeHit(raw: unknown): ContentHit | null {
  if (typeof raw !== "object" || raw === null) return null;
  const h = raw as Record<string, unknown>;
  if (typeof h.id !== "string" || h.id === "") return null;
  if (typeof h.snippet !== "string") return null;
  const snippet = h.snippet;
  let start = isInt(h.matchStart) ? h.matchStart : -1;
  let end = isInt(h.matchEnd) ? h.matchEnd : -1;
  // offsets outside the snippet cannot highlight anything true: render the
  // snippet unmarked instead of dropping a real hit
  if (start < 0 || end <= start || end > snippet.length) {
    start = 0;
    end = 0;
  }
  const title = typeof h.title === "string" && h.title.trim() !== "" ? h.title : h.id;
  const instant = typeof h.instant === "number" && Number.isFinite(h.instant) ? h.instant : 0;
  return { id: h.id, title, instant, snippet, matchStart: start, matchEnd: end };
}

/**
 * Parse one GET /__ocr/search answer, fail-closed. 404 means the host runs a
 * daemon older than the route (title search keeps working, the section says
 * so once); any other non-200, or a body that is not the documented shape,
 * is an error — never a fabricated empty result. Malformed entries inside a
 * well-formed answer are skipped, and one conversation appears once.
 */
export function parseContentAnswer(status: unknown, body: unknown): ContentAnswer {
  if (status === 404) return { kind: "unsupported" };
  if (status !== 200) return { kind: "error" };
  if (typeof body !== "object" || body === null) return { kind: "error" };
  const b = body as { results?: unknown; truncated?: unknown };
  if (!Array.isArray(b.results)) return { kind: "error" };
  const seen = new Set<string>();
  const hits: ContentHit[] = [];
  for (const raw of b.results) {
    const hit = sanitizeHit(raw);
    if (!hit || seen.has(hit.id)) continue;
    seen.add(hit.id);
    hits.push(hit);
  }
  return { kind: "ok", hits, truncated: b.truncated === true };
}

/** Content hits not already on screen as title matches, server order kept
 * (the daemon sorts by recency). */
export function freshHits(hits: readonly ContentHit[], shownIds: Iterable<string>): ContentHit[] {
  const shown = new Set(shownIds);
  return hits.filter((h) => !shown.has(h.id));
}

/**
 * Split a hit's snippet into plain/marked segments for a one-line row. The
 * leading context is cut to at most `lead` characters (at a word boundary
 * when one exists in that window) and prefixed with an ellipsis, so the
 * match always lands inside the visible start of an ellipsized row. Runs of
 * whitespace collapse to one space in the plain segments (a snippet can span
 * line breaks); the marked text is kept verbatim. A hit without a valid
 * match range renders as one plain segment.
 */
export function snippetSegments(hit: Pick<ContentHit, "snippet" | "matchStart" | "matchEnd">, lead: number): SnippetSegment[] {
  const { snippet, matchStart, matchEnd } = hit;
  const collapse = (s: string) => s.replace(/\s+/g, " ");
  if (!(matchEnd > matchStart) || matchStart < 0 || matchEnd > snippet.length) {
    const text = collapse(snippet).trim();
    return text ? [{ text, mark: false }] : [];
  }
  let before = snippet.slice(0, matchStart);
  const safeLead = Math.max(0, Math.floor(lead));
  if (before.length > safeLead) {
    let cut = before.slice(before.length - safeLead);
    const space = cut.search(/\s/);
    if (space !== -1 && space < cut.length - 1) cut = cut.slice(space + 1);
    before = `…${cut.trimStart()}`;
  }
  const out: SnippetSegment[] = [];
  const pre = collapse(before).trimStart();
  if (pre) out.push({ text: pre, mark: false });
  out.push({ text: snippet.slice(matchStart, matchEnd), mark: true });
  const post = collapse(snippet.slice(matchEnd)).trimEnd();
  if (post) out.push({ text: post, mark: false });
  return out;
}

/**
 * Request bookkeeping for the debounced fetch: every issued request gets the
 * next sequence number and only the answer to the LATEST one may land — a
 * slow scan for "ro" must never overwrite the answer for "rollback".
 */
export function createSearchSequence() {
  let issued = 0;
  return {
    next(): number {
      issued += 1;
      return issued;
    },
    isCurrent(seq: number): boolean {
      return seq === issued;
    },
  };
}
