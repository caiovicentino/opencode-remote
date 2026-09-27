/**
 * Shared, dependency-free text helpers for the two lesson memories — the IER
 * (docs/EXPERIENCE.md, experience.ts) and the failure lessons
 * (lessons.jsonl, failureLessons.ts). Kept import-free so the light modules
 * (failureLessons, audit) never pull the runner/metapush graph in.
 */

const STOPWORDS = new Set([
  "when", "the", "and", "for", "with", "that", "this", "than", "then", "from",
  "into", "onto", "over", "under", "after", "before", "just", "only", "also",
  "all", "any", "are", "was", "were", "has", "have", "had", "not", "but", "can",
  "may", "will", "shall", "must", "should", "would", "could", "your", "you",
  "our", "its", "their", "they", "them", "there", "here", "what", "which",
  "how", "why", "where", "fonte", "spec", "task", "new", "use", "uses",
  "por", "para", "com", "que", "uma", "sem", "mais", "como", "sobre", "entre",
]);

/** Lowercase alphanumeric tokens (≥3 chars, stopwords dropped). */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 3 && !STOPWORDS.has(raw)) out.add(raw);
  }
  return out;
}

/** Jaccard similarity of two token sets (|A∩B| / |A∪B|); 0 when either is empty. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Query-side noise: tokens present in most backlog specs (acceptance
 * boilerplate and path segments — measured 2026-09-27 over 400 `## Done`
 * lines: evidence 78%, apps 76%, unit 74%, typecheck 72%, src 67%, test 64%,
 * build 64%, real 61%, output 56%, scripts 53%). They match every lesson that
 * mentions a test or a path, so they say nothing about relevance.
 */
export const QUERY_BOILERPLATE = new Set([
  "evidence", "apps", "unit", "typecheck", "src", "test", "tests", "build", "real",
  "output", "scripts", "json", "docs", "readme", "package", "node", "index", "lint",
  "screenshot", "screenshots", "green", "pilot", "merged", "area", "tsx",
]);

/** tokenize() minus QUERY_BOILERPLATE — the informative words of a task query. */
export function queryTokens(text: string): Set<string> {
  const out = tokenize(text);
  for (const t of QUERY_BOILERPLATE) out.delete(t);
  return out;
}
