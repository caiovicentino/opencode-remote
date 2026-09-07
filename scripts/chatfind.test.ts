/**
 * P2-281 unit tests: lib/chatfind — the pure in-conversation search module.
 * Covers accents, case, empty term, zero results, ordering, literal
 * (never-regex) terms and raw-offset round-trips.
 * Run: npx tsx scripts/chatfind.test.ts
 */
import { canHighlightInline, findHits, foldText, segmentsFor } from "../apps/web/src/lib/chatfind";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const msgs = (...texts: string[]) => texts.map((text) => ({ text }));

// --- accents + case ----------------------------------------------------------
const acc = findHits(msgs("Café da manhã", "depois do CAFÉ", "o café tá pronto"), "cafe");
check("accents: matches every accented/case variant", acc.length === 3, JSON.stringify(acc));
check("accents: first hit is in bubble 0", acc[0]?.bubble === 0 && acc[0]?.start === 0, JSON.stringify(acc));
check("accents: raw offsets slice back to the exact word", acc.every((h) => {
  const list = msgs("Café da manhã", "depois do CAFÉ", "o café tá pronto");
  return list[h.bubble]!.text.slice(h.start, h.end).toLowerCase() === "café";
}), JSON.stringify(acc));

check("foldText: strips diacritics and lowercases", foldText("ÁÉÍÓÚ ÃÕÇ") === "aeiou aoc", foldText("ÁÉÍÓÚ ÃÕÇ"));
check("foldText: decomposed term matches precomposed text", findHits(msgs("nação"), "nacao").length === 1);

// --- empty term --------------------------------------------------------------
check("empty term: no hits", findHits(msgs("anything"), "").length === 0);
check("whitespace term: no hits", findHits(msgs("anything"), "   \t ").length === 0);

// --- zero results ------------------------------------------------------------
check("zero results: calm empty array", findHits(msgs("hello", "world"), "zzz").length === 0);
check("zero results: empty conversation", findHits([], "hello").length === 0);

// --- ordering ----------------------------------------------------------------
const ord = findHits(msgs("alpha beta alpha", "alpha"), "alpha");
check(
  "order: bubble order then reading order",
  JSON.stringify(ord) === JSON.stringify([
    { bubble: 0, start: 0, end: 5 },
    { bubble: 0, start: 11, end: 16 },
    { bubble: 1, start: 0, end: 5 },
  ]),
  JSON.stringify(ord),
);

// --- literal terms: never regex ----------------------------------------------
const lit = findHits(msgs("a.b axb a.b"), "a.b");
check("regex chars are literal: a.b matches only 'a.b' twice", lit.length === 2, JSON.stringify(lit));
check(
  "regex chars are literal: offsets are exact",
  lit.every((h) => h.end - h.start === 3),
  JSON.stringify(lit),
);
const pattern = findHits(msgs("foo (x) foo"), "(x)");
check("parens are literal text", pattern.length === 1 && pattern[0]?.start === 4, JSON.stringify(pattern));

// --- overlapping-adjacent and repeated matches -------------------------------
const rep = findHits(msgs("aaaa"), "aa");
check("repeats: non-overlapping scan", rep.length === 2, JSON.stringify(rep));

// --- multi-unit characters keep offsets valid --------------------------------
const emoji = findHits(msgs(" Vaccine 👍izada done, vaccine again"), "vaccine");
check(
  "surrogate-safe: emoji before the match keeps offsets exact",
  emoji.length === 2 && emoji.every((h) => h.end - h.start === "vaccine".length),
  JSON.stringify(emoji),
);

// --- segments ----------------------------------------------------------------
const segs = segmentsFor("Café com café", findHits(msgs("Café com café"), "cafe"));
check(
  "segments: hit / plain / hit split on raw text",
  JSON.stringify(segs) ===
    JSON.stringify([
      { text: "Café", hit: true, hitIndex: 0 },
      { text: " com ", hit: false },
      { text: "café", hit: true, hitIndex: 1 },
    ]),
  JSON.stringify(segs),
);
check(
  "segments: no hits -> a single plain segment",
  segmentsFor("nothing here", findHits(msgs("nothing here"), "zzz")).length === 1 &&
    segmentsFor("nothing here", []).length === 1,
);

// --- inline-highlight safety -------------------------------------------------
check("inline: plain prose is safe", canHighlightInline("combustível no tanque?"));
check("inline: markdown bold is NOT inline-safe", !canHighlightInline("**bold** match"));
check("inline: code fence is NOT inline-safe", !canHighlightInline("run `npm run build`"));
check("inline: heading is NOT inline-safe", !canHighlightInline("# Title\nmatch"));
check("inline: list line is NOT inline-safe", !canHighlightInline("- buy milk"));
check("inline: link is NOT inline-safe", !canHighlightInline("see https://x.com now"));

if (failures > 0) {
  console.error(`FAILURES: ${failures}`);
  process.exit(1);
}
console.log("chatfind: all green");
