// P1-064: light server-side paging for GET /session/<id>/message.
//
// Pilot sessions carry MBs of tool output; the integral JSON used to overflow
// the relay's 1MB frame and leave the phone on an eternal loading skeleton.
// These helpers slice the tail of the history into bounded pages. They are
// pure so scripts/unit.test.ts can exercise them without a daemon.

/** just under the relay's MAX_FRAME (1_000_000) with seal/JSON overhead slack */
export const PAGE_MAX_BYTES = 800_000;
export const PAGE_LIMIT_MAX = 200;
export const PAGE_LIMIT_DEFAULT = 50;

export interface HistoryRowLike {
  info?: { id?: string; role?: string };
  parts?: unknown[];
}

export interface MessagePage {
  rows: HistoryRowLike[];
  hasMore: boolean;
  /** id of the oldest row in this page — the `before` cursor for the next one */
  oldest: string | null;
  total: number;
}

/** GET /session/<id>/message only short-circuits the passthrough when the
 * client explicitly asked for a page; without params the body stays a plain
 * array exactly as before (export/handoff/internal syncs depend on it). */
export function shouldPaginateMessages(
  method: string,
  path: string,
  query?: Record<string, string>,
): boolean {
  if (method !== "GET") return false;
  if (!/^\/session\/[^/]+\/message$/.test(path)) return false;
  return query?.limit !== undefined || query?.before !== undefined;
}

export function parsePageLimit(raw: string | undefined): number {
  const n = Number(raw ?? PAGE_LIMIT_DEFAULT);
  if (!Number.isFinite(n)) return PAGE_LIMIT_DEFAULT;
  return Math.min(Math.max(Math.floor(n), 1), PAGE_LIMIT_MAX);
}

/**
 * Take the LAST `limit` rows, optionally stopping at `before` (exclusive).
 * Rows arrive oldest->newest from the opencode server; the tail is what a
 * chat opening wants to paint first.
 */
export function sliceMessagePage(
  rows: HistoryRowLike[],
  limit: number,
  before?: string,
): MessagePage {
  const total = rows.length;
  let end = total;
  if (before !== undefined) {
    let idx = -1;
    for (let i = total - 1; i >= 0; i--) {
      if (rows[i]?.info?.id === before) {
        idx = i;
        break;
      }
    }
    // `before` that no longer exists (rewind/unrevert): serve from the tail
    // that is actually available instead of failing the page
    if (idx >= 0) end = idx;
  }
  const start = Math.max(0, end - limit);
  const pageRows = rows.slice(start, end);
  return {
    rows: pageRows,
    hasMore: start > 0,
    oldest: pageRows[0]?.info?.id ?? null,
    total,
  };
}

/** exact UTF-8 wire size — the relay frame limit is bytes, not JS chars */
function pageBytes(rows: HistoryRowLike[]): number {
  try {
    return Buffer.byteLength(JSON.stringify(rows), "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER; // unserializable row -> shrink the page
  }
}

// a page is served as one sealed op response, so every row must fit the
// relay frame even on its own. Oversized fields are degraded gracefully:
// tool output is shown as the last ~400 chars in the UI anyway, and huge
// inline data URLs are dropped (the client skips them without crashing).
const SLIM_OUTPUT_TAIL = 2000;
const SLIM_TEXT_TAIL = 100_000;
const SLIM_URL_MAX = 100_000;

function slimRow(row: HistoryRowLike, maxBytes: number): HistoryRowLike | null {
  let cloned: HistoryRowLike;
  try {
    cloned = JSON.parse(JSON.stringify(row)) as HistoryRowLike;
  } catch {
    return null; // unserializable row: cannot ship it through the frame
  }
  for (const part of cloned.parts ?? []) {
    const p = part as {
      type?: string;
      text?: string;
      url?: string;
      state?: { output?: string };
    };
    if (typeof p.state?.output === "string" && p.state.output.length > SLIM_OUTPUT_TAIL) {
      p.state.output = p.state.output.slice(-SLIM_OUTPUT_TAIL);
    }
    if (typeof p.url === "string" && p.url.length > SLIM_URL_MAX) p.url = "";
    if (p.type === "text" && typeof p.text === "string" && p.text.length > SLIM_TEXT_TAIL) {
      p.text = `…${p.text.slice(-SLIM_TEXT_TAIL)}`;
    }
  }
  return pageBytes([cloned]) <= maxBytes ? cloned : null;
}

/**
 * Slice then shrink until the serialized page fits the relay frame budget
 * measured in exact UTF-8 bytes (CJK/emoji tool output costs 3-4 bytes per
 * char). Downsides gracefully per row — truncate tool output, drop huge
 * inline media, clip giant text — and only a single row that STILL cannot
 * fit is dropped, because overflowing the frame kills the whole connection.
 */
export function capMessagePage(
  rows: HistoryRowLike[],
  limit: number,
  before: string | undefined,
  maxBytes = PAGE_MAX_BYTES,
): MessagePage {
  let lim = Math.min(Math.max(1, limit), PAGE_LIMIT_MAX);
  let page = sliceMessagePage(rows, lim, before);
  while (page.rows.length > 1 && pageBytes(page.rows) > maxBytes) {
    lim = Math.max(1, Math.floor(lim / 2));
    page = sliceMessagePage(rows, lim, before);
  }
  if (page.rows.length === 1 && pageBytes(page.rows) > maxBytes) {
    const slim = slimRow(page.rows[0]!, maxBytes);
    if (slim) return { ...page, rows: [slim] };
    // pathological row (cannot be made to fit): serve the rest of the page.
    // hasMore=false so the client never loops on an empty page.
    return { rows: [], hasMore: false, oldest: null, total: page.total };
  }
  return page;
}
