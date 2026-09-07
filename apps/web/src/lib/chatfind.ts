// P2-281: in-conversation search over the already-loaded bubbles. Pure module
// — no DOM, no fetch, no network: it receives the messages the ChatView
// already holds plus the user's term and returns the occurrences in
// conversation order. The term is NEVER interpreted as regex (plain indexOf
// over folded text) and matching ignores case and accents ("Café" matches
// "cafe", "NÃO" matches "nao").

export interface ChatHit {
  /** index into the messages array (conversation order) */
  bubble: number;
  /** char offsets into the bubble's raw text (UTF-16 code units) */
  start: number;
  end: number;
}

export interface ChatSegment {
  text: string;
  hit: boolean;
  /** position of this hit inside the hits array (only when hit) */
  hitIndex?: number;
}

const COMBINING = /[\u0300-\u036f]/g;

/** fold a single char: strip diacritics, lowercase, strip again — one
 * lowercase step can itself introduce a combining mark (İ → i̇ → i) */
function foldChar(c: string): string {
  const once = c.normalize("NFD").replace(COMBINING, "").toLowerCase();
  return once.normalize("NFD").replace(COMBINING, "");
}

/** accent- and case-folded text; lengths may differ from the input */
export function foldText(s: string): string {
  let out = "";
  for (const c of s) out += foldChar(c);
  return out;
}

interface Folded {
  text: string;
  /** folded position -> original index of the char that produced it */
  orig: number[];
  /** original char start -> UTF-16 length of that char (sparse) */
  len: number[];
}

/** fold keeping a map back to the original offsets so hits can be
 * highlighted on the raw bubble text (the bubble renders the raw string) */
function foldWithMap(text: string): Folded {
  let out = "";
  const orig: number[] = [];
  const len: number[] = [];
  let i = 0;
  for (const c of text) {
    const f = foldChar(c);
    out += f;
    for (let k = 0; k < f.length; k++) orig.push(i);
    len[i] = c.length;
    i += c.length;
  }
  return { text: out, orig, len };
}

/**
 * All occurrences of `term` across the loaded messages, oldest conversation
 * position first (bubble order, then reading order inside each bubble).
 * Empty/whitespace-only terms return [] — the calm "no matches" state — and
 * regex metacharacters in the term are literal text, never a pattern.
 */
export function findHits(messages: readonly { text: string }[], term: string): ChatHit[] {
  const raw = term.trim();
  if (!raw) return [];
  const needle = foldText(raw);
  if (!needle) return [];
  const hits: ChatHit[] = [];
  for (let b = 0; b < messages.length; b++) {
    const text = messages[b]?.text ?? "";
    if (!text) continue;
    const { text: hay, orig, len } = foldWithMap(text);
    let at = hay.indexOf(needle);
    while (at !== -1) {
      const lastFolded = at + needle.length - 1;
      const startOrig = orig[at]!;
      const endOrig = orig[lastFolded]! + (len[orig[lastFolded]!] ?? 1);
      hits.push({ bubble: b, start: startOrig, end: endOrig });
      at = hay.indexOf(needle, at + needle.length);
    }
  }
  return hits;
}

/** split a bubble's raw text at the hit boundaries for inline <mark> render */
export function segmentsFor(text: string, hits: ChatHit[]): ChatSegment[] {
  const out: ChatSegment[] = [];
  let cursor = 0;
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]!;
    if (h.start > cursor) out.push({ text: text.slice(cursor, h.start), hit: false });
    out.push({ text: text.slice(h.start, h.end), hit: true, hitIndex: i });
    cursor = h.end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false });
  return out;
}

const RISKY_MD = /[`*_[#~<]|https?:\/\//;
const LIST_LINE = /^\s*(?:[-*]|\d+\.)\s/;
const FILE_LINE = /^\[file: .+\]$/;

/**
 * Inline <mark> highlighting is only byte-safe when the bubble is plain
 * prose: any markdown trigger (bold/italic/code/headings/links/lists/file
 * markers) makes the rendered text drift from the raw offsets, so those
 * bubbles fall back to the bubble-level highlight instead.
 */
export function canHighlightInline(text: string): boolean {
  if (RISKY_MD.test(text)) return false;
  for (const line of text.split("\n")) {
    if (LIST_LINE.test(line) || FILE_LINE.test(line.trim())) return false;
  }
  return true;
}
