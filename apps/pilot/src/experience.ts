/**
 * P1-007 — Experience memory (IER): docs/EXPERIENCE.md stores one-line
 * engineering lessons distilled by the SCRIBE role after every successful
 * merge. Pure functions here (parse/match/append/prune) so the eval battery
 * can pin the format; the fs wrappers at the bottom only touch the workspace.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const EXPERIENCE_FILE = "docs/EXPERIENCE.md";
/** Red-team nightly duty (P1-007): dedupe + prune once the file grows past this. */
export const EXPERIENCE_CAP = 60;

export function experienceTemplate(): string {
  return `# Experience memory (IER)

Lições destiladas pelo pipeline (role SCRIBE) após cada merge bem-sucedido.
Cada lição é uma linha \`- When <situação>, do <ação> (fonte: <ID>)\`. Os prompts
de planner, builder e strategist recebem o top-5 de lições relevantes (keyword-match,
mais recentes primeiro); o red team noturno deduplica e poda acima de
${EXPERIENCE_CAP} lições.

## Lessons
`;
}

/** Lesson lines (with the `- ` prefix) inside the `## Lessons` section. */
export function parseLessons(md: string): string[] {
  const start = md.search(/^## Lessons$/m);
  if (start < 0) return [];
  const rest = md.slice(start);
  const end = rest.search(/^## (?!Lessons)/m); // next section, if any
  const body = end >= 0 ? rest.slice(0, end) : rest;
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^- \S/.test(l));
}

/** Dedupe key: case/punctuation-insensitive, provenance tag ignored. */
export function lessonKey(lesson: string): string {
  return lesson
    .replace(/\(fonte:[^)]*\)/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

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

/** Title hits weigh 2, spec hits 1 — titles carry the intent of the task. */
export function lessonScore(lesson: string, titleTokens: Set<string>, specTokens: Set<string>): number {
  // provenance tag excluded from matching + word-boundary tokens (no "app"-in-"happen")
  const words = tokenize(lesson.replace(/\(fonte:[^)]*\)/g, " "));
  let score = 0;
  for (const w of titleTokens) if (words.has(w)) score += 2;
  for (const w of specTokens) if (words.has(w)) score += 1;
  return score;
}

/**
 * Top-`max` lessons keyword-matched against title+spec, best score first and
 * most recent first on ties (the file is append-ordered, last = newest).
 * Lessons with no keyword overlap are not "relevant" and are not injected.
 */
export function pickRelevantLessons(md: string, title: string, spec: string, max = 5): string[] {
  if (max <= 0) return [];
  const lessons = parseLessons(md);
  const titleTokens = tokenize(title);
  const specTokens = tokenize(spec);
  const scored = lessons
    .map((text, i) => ({ text, i, score: lessonScore(text, titleTokens, specTokens) }))
    .filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score || b.i - a.i);
  return scored.slice(0, max).map((s) => s.text);
}

/** Normalize an agent lesson line: single line, `- ` prefix, trusted fonte tag. */
export function normalizeLesson(raw: string, sourceId: string, maxLen = 240): string {
  const text = raw.replace(/\s+/g, " ").trim().replace(/^-\s+/, "").replace(/\s*\(fonte:[^)]*\)\s*$/, "").trim();
  if (text.length < 15) return "";
  const clipped = text.length > maxLen ? text.slice(0, maxLen - 1).trimEnd() + "…" : text;
  return `- ${clipped} (fonte: ${sourceId})`;
}

/** Rewrite the `## Lessons` section, creating it when missing. */
function spliceLessonsSection(md: string, lessons: string[]): string {
  const start = md.search(/^## Lessons$/m);
  if (start < 0) {
    const base = md.trimEnd();
    return `${base}\n\n## Lessons\n${lessons.join("\n")}\n`;
  }
  const rest = md.slice(start);
  const end = rest.search(/^## (?!Lessons)/m);
  const after = end >= 0 ? "\n" + rest.slice(end) : "";
  const before = md.slice(0, start);
  return `${before}## Lessons\n${lessons.join("\n")}\n${after}`;
}

/**
 * Append new lessons (deduped against the file and against each other, capped
 * at `max`). Returns the updated file content plus the lessons actually added.
 */
export function appendLessons(
  md: string,
  lessons: string[],
  sourceId: string,
  max = 3,
): { md: string; added: string[] } {
  const known = new Set(parseLessons(md).map(lessonKey));
  const added: string[] = [];
  for (const raw of lessons) {
    if (added.length >= max) break;
    const line = normalizeLesson(raw, sourceId);
    if (!line) continue;
    const key = lessonKey(line);
    if (known.has(key)) continue;
    known.add(key);
    added.push(line);
  }
  if (!added.length) return { md, added };
  // keep the FULL history: existing lessons first, new ones appended —
  // splicing with only `added` was wiping the whole section every merge
  const kept = parseLessons(md).filter((l) => !added.includes(l));
  return { md: spliceLessonsSection(md, [...kept, ...added]), added };
}

/**
 * Nightly red-team maintenance (P1-007): only when the file is above the cap,
 * dedupe (newest wording wins) and prune to the `cap` most recent lessons.
 */
export function dedupeAndPrune(md: string, cap = EXPERIENCE_CAP): { md: string; removed: number } {
  const lessons = parseLessons(md);
  if (lessons.length <= cap) return { md, removed: 0 };
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (let i = lessons.length - 1; i >= 0; i--) {
    const key = lessonKey(lessons[i]!);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.unshift(lessons[i]!); // unshift newest-kept order back
  }
  const kept = deduped.slice(-cap);
  const removed = lessons.length - kept.length;
  return { md: spliceLessonsSection(md, kept), removed };
}

// ── fs wrappers (workspace-scoped) ───────────────────────────────────────────

export function readExperienceFile(ws: string): string {
  try {
    return readFileSync(join(ws, EXPERIENCE_FILE), "utf8");
  } catch {
    return "";
  }
}

/** SCRIBE commit path: append lessons to the workspace file, creating it if needed. */
export function appendLessonsToWorkspace(ws: string, lessons: string[], sourceId: string): number {
  const file = join(ws, EXPERIENCE_FILE);
  const md = existsSync(file) ? readFileSync(file, "utf8") : experienceTemplate();
  const { md: next, added } = appendLessons(md, lessons, sourceId);
  if (added.length) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, next);
  }
  return added.length;
}

/** Red-team nightly pass: dedupe + prune when above EXPERIENCE_CAP. */
export function maintainExperienceFile(ws: string): { changed: boolean; removed: number; lessons: number } {
  const file = join(ws, EXPERIENCE_FILE);
  let md = "";
  try {
    md = readFileSync(file, "utf8");
  } catch {
    return { changed: false, removed: 0, lessons: 0 };
  }
  const { md: next, removed } = dedupeAndPrune(md);
  const changed = next !== md;
  if (changed) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, next);
  }
  return { changed, removed, lessons: parseLessons(next).length };
}
