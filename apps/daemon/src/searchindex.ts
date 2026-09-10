// P3-400: server-side conversation search. Pure module — no node:fs, no
// network, no timers (same hygiene as chatfind.ts / artifactretention.ts):
// index.ts runs main() on import and unit tests must never boot a daemon, and
// a search that answers one request has no business keeping state between
// requests. Two layers live here:
//
//   1. searchConversations — the matcher. Receives the term plus ALREADY
//      MATERIALIZED conversations (id, title, instant, texts) and returns
//      results sorted by recency, one per conversation, each carrying a short
//      snippet around the occurrence. Matching reuses the exact fold of
//      apps/web/src/lib/chatfind.ts (accent- and case-insensitive), the term
//      is NEVER interpreted as regex, and empty / too-short / malformed input
//      fails closed to [].
//
//   2. runConversationSearch — the request orchestrator the daemon route
//      drives. The origin (the local opencode server, read through the same
//      /session and /session/<id>/message endpoints the existing passthrough
//      serves) is INJECTED, so tests replace it wholesale. Hard caps, all
//      enforced here before any result is produced:
//
//        SEARCH_MAX_SESSIONS              — at most this many of the most
//                                           recent conversations are scanned
//        SEARCH_MAX_MESSAGES_PER_SESSION  — at most this many messages per
//                                           conversation are searched (the
//                                           most recent ones)
//        SEARCH_TIME_BUDGET_MS            — total wall-clock budget for the
//                                           whole scan; past it the scan
//                                           exits early
//
//      Any cap hit or budget overrun marks the response `truncated: true` —
//      the caller is told the answer is partial, never silently incomplete.
//      An origin failure never throws: the caller gets an empty, truncated
//      result (originFailed flag) and logs one coarse line. No new port, no
//      new listener, no periodic timer anywhere in this slice — the search
//      only runs while a GET /__ocr/search is in flight.

// P3-400: the SAME accent/case fold the in-conversation find bar uses, so a
// term that matches inside the open chat also matches here ("Café" matches
// "cafe", "NÃO" matches "nao").
import { foldText } from "../../web/src/lib/chatfind";

// --- matcher ceilings ---------------------------------------------------------

/** Terms shorter than this (after trim) fail closed: too little signal. */
export const SEARCH_MIN_TERM = 2;

/** At most this many conversations come back (most recent win). */
export const SEARCH_MAX_RESULTS = 40;

/** Snippet length ceiling in UTF-16 code units. */
export const SEARCH_SNIPPET_CHARS = 120;

// --- scan ceilings ( enforced by runConversationSearch) -----------------------

/** At most this many of the most recent conversations are scanned. */
export const SEARCH_MAX_SESSIONS = 200;

/** At most this many messages per conversation are searched (the newest). */
export const SEARCH_MAX_MESSAGES_PER_SESSION = 200;

/** Total wall-clock budget for one search request; past it the scan exits early. */
export const SEARCH_TIME_BUDGET_MS = 1_500;

export interface SearchConversation {
  id: string;
  title?: string;
  /** recency instant, ms since the epoch */
  instant: number;
  /** message texts already materialized (no I/O here) */
  texts: readonly string[];
}

export interface SearchHit {
  id: string;
  title: string;
  instant: number;
  /** short raw-text window around the occurrence, ≤ SEARCH_SNIPPET_CHARS */
  snippet: string;
  /** match boundaries inside the snippet (for client-side highlight) */
  matchStart: number;
  matchEnd: number;
}

/** A folded search over one candidate string: first match in raw offsets. */
function firstHit(
  text: string,
  needle: string,
): { start: number; end: number } | null {
  let folded = "";
  const orig: number[] = [];
  const len: number[] = [];
  let i = 0;
  for (const c of text) {
    const f = foldText(c);
    folded += f;
    for (let k = 0; k < f.length; k++) orig.push(i);
    len[i] = c.length;
    i += c.length;
  }
  const at = folded.indexOf(needle);
  if (at === -1) return null;
  const lastFolded = at + needle.length - 1;
  const startOrig = orig[at] ?? 0;
  const endOrig = (orig[lastFolded] ?? startOrig) + (len[orig[lastFolded] ?? 0] ?? 1);
  return { start: startOrig, end: endOrig };
}

/** A short raw window around [start,end), ≤ SEARCH_SNIPPET_CHARS, with the
 * match boundaries remapped into the window. A match longer than the cap
 * keeps the whole window inside the match — the offsets are clamped to the
 * snippet (never negative), so what they highlight is always the visible
 * part of the occurrence. */
function snippetFor(text: string, start: number, end: number): {
  snippet: string;
  matchStart: number;
  matchEnd: number;
} {
  const room = Math.max(0, Math.floor((SEARCH_SNIPPET_CHARS - (end - start)) / 2));
  let from = Math.max(0, start - room);
  let to = Math.min(text.length, from + SEARCH_SNIPPET_CHARS);
  if (end > to) {
    from = Math.max(0, end - SEARCH_SNIPPET_CHARS);
    to = Math.min(text.length, from + SEARCH_SNIPPET_CHARS);
  }
  return {
    snippet: text.slice(from, to),
    matchStart: Math.max(0, start - from),
    matchEnd: Math.min(end, to) - from,
  };
}

function isSearchConversation(v: unknown): v is SearchConversation {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Partial<SearchConversation>;
  return typeof c.id === "string" && c.id !== "" && Array.isArray(c.texts);
}

/**
 * All matches for `term`, most recent conversation first, capped at
 * SEARCH_MAX_RESULTS. One hit per conversation: the title is searched first,
 * then the messages in order, and the first occurrence wins. Empty,
 * whitespace-only, too-short or non-string terms return [] — the calm "no
 * matches" state; regex metacharacters in the term are literal text, never a
 * pattern; malformed conversations (non-array input, entries without a valid
 * id/texts) are skipped, never thrown.
 */
export function searchConversations(
  term: string,
  conversations: readonly SearchConversation[],
): SearchHit[] {
  if (typeof term !== "string") return [];
  if (!Array.isArray(conversations)) return [];
  const raw = term.trim();
  if (raw.length < SEARCH_MIN_TERM) return [];
  const needle = foldText(raw);
  if (!needle) return [];
  const hits: SearchHit[] = [];
  for (const conv of conversations) {
    if (!isSearchConversation(conv)) continue; // malformed entry: skipped
    const instant = Number.isFinite(conv.instant) ? conv.instant : 0;
    const title = typeof conv.title === "string" ? conv.title : "";
    const candidates: string[] = [
      ...(title ? [title] : []),
      ...conv.texts.filter((t): t is string => typeof t === "string" && t !== ""),
    ];
    for (const text of candidates) {
      const hit = firstHit(text, needle);
      if (!hit) continue;
      const { snippet, matchStart, matchEnd } = snippetFor(text, hit.start, hit.end);
      hits.push({
        id: conv.id,
        title: title || conv.id,
        instant,
        snippet,
        matchStart,
        matchEnd,
      });
      break; // one hit per conversation: the first occurrence wins
    }
  }
  hits.sort((a, b) => b.instant - a.instant); // recency, ties keep scan order
  return hits.slice(0, SEARCH_MAX_RESULTS);
}

// --- request orchestrator (injected origin) -----------------------------------

/** A session row as the origin serves it: id, title and a recency instant. */
export interface SearchSeed {
  id: string;
  title?: string;
  instant: number;
}

/**
 * The origin of truth for a search: the local opencode server, read through
 * the same endpoints the existing message passthrough serves. Every method
 * returns null on failure — the orchestrator never lets an origin error
 * become a thrown exception.
 */
export interface SearchOrigin {
  /** every session known to the origin (any order; recency is applied here) */
  sessions(): Promise<SearchSeed[] | null>;
  /** the text parts of a session's messages, conversation order */
  messages(id: string): Promise<string[] | null>;
}

export interface SearchRun {
  results: SearchHit[];
  /** true when caps/budget cut the scan short (or the origin failed) */
  truncated: boolean;
  /** true only when the origin could not be read at all — the caller logs it */
  originFailed: boolean;
}

/**
 * Orchestrate one search request against an injected origin. Sessions are
 * scanned most-recent-first under the three hard caps — conversations past
 * SEARCH_MAX_SESSIONS are never fetched, only the newest
 * SEARCH_MAX_MESSAGES_PER_SESSION messages of each conversation are searched,
 * and the whole scan (fetching AND matching) must fit SEARCH_TIME_BUDGET_MS,
 * exiting early with `truncated: true` otherwise. Never throws: a malformed
 * term fails closed to the empty answer and ANY origin failure (null or a
 * thrown error) degrades to the empty truncated answer.
 */
export async function runConversationSearch(
  term: string,
  origin: SearchOrigin,
  now: () => number = Date.now,
): Promise<SearchRun> {
  if (typeof term !== "string" || term.trim().length < SEARCH_MIN_TERM) {
    return { results: [], truncated: false, originFailed: false };
  }
  try {
    return await scanConversations(term, origin, now);
  } catch {
    return { results: [], truncated: true, originFailed: true };
  }
}

async function scanConversations(
  term: string,
  origin: SearchOrigin,
  now: () => number,
): Promise<SearchRun> {
  const seeds = await origin.sessions();
  if (!Array.isArray(seeds)) return { results: [], truncated: true, originFailed: true };
  const recent = seeds
    .filter((s) => s !== null && typeof s === "object" && typeof s.id === "string" && s.id !== "")
    .sort((a, b) => b.instant - a.instant);
  // conversations cap: everything past SEARCH_MAX_SESSIONS is not scanned —
  // and the caller is told the answer is partial
  const selected = recent.slice(0, SEARCH_MAX_SESSIONS);
  let truncated = recent.length > SEARCH_MAX_SESSIONS;
  const t0 = now();
  const hits: SearchHit[] = [];
  for (const seed of selected) {
    if (now() - t0 > SEARCH_TIME_BUDGET_MS) {
      // budget spent: return what is already matched, marked partial
      truncated = true;
      break;
    }
    const texts = await origin.messages(seed.id);
    if (!Array.isArray(texts)) return { results: [], truncated: true, originFailed: true };
    // messages cap: the newest messages are kept, the old tail is not searched
    if (texts.length > SEARCH_MAX_MESSAGES_PER_SESSION) truncated = true;
    const conv: SearchConversation = {
      id: seed.id,
      title: seed.title,
      instant: Number.isFinite(seed.instant) ? seed.instant : 0,
      texts: texts.slice(-SEARCH_MAX_MESSAGES_PER_SESSION),
    };
    // the matcher emits at most one hit per conversation
    hits.push(...searchConversations(term, [conv]));
  }
  hits.sort((a, b) => b.instant - a.instant); // recency, ties keep scan order
  return { results: hits.slice(0, SEARCH_MAX_RESULTS), truncated, originFailed: false };
}
