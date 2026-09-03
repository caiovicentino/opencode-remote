/**
 * P1-007 — Experience memory (IER): docs/EXPERIENCE.md stores one-line
 * engineering lessons distilled by the SCRIBE role after every successful
 * merge. Pure functions here (parse/match/append/prune) so the eval battery
 * can pin the format; the fs wrappers at the bottom only touch the workspace.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { doneTaskIds } from "./backlog";
import { landMetaCommit } from "./metapush";
import type { FailureLesson } from "./failureLessons";
import { nowLocalISO } from "./log";

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

/** P1-075: semantic-duplicate threshold over tokenize() — pinned by the battery. */
export const JACCARD_DUPE = 0.6;

/** Jaccard similarity of two token sets (|A∩B| / |A∪B|); 0 when either is empty. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Tokens of a lesson line with the provenance tag stripped (copies re-tagged). */
function lessonTokens(lesson: string): Set<string> {
  return tokenize(lesson.replace(/\(fonte:[^)]*\)/g, " "));
}

/** P1-075: a paraphrased re-landing of the same lesson. Jaccard over short
 * lessons (< 5 tokens) is noisy, so only exact-key matches apply there. */
function semanticDupe(a: Set<string>, b: Set<string>): boolean {
  return a.size >= 5 && b.size >= 5 && jaccard(a, b) >= JACCARD_DUPE;
}

/** P1-075: process/harness vocabulary — the class of lessons the nightly pass
 * may archive once their fonte task is done (product-code lessons never are). */
const HARNESS_RE =
  /\b(pilot|pipeline|builder|reviewer|scribe|gate|gatekeeper|backlog|planner|slot|refresh|checkpoint|worktree|eval battery)\b/i;

export function isHarnessLesson(lesson: string): boolean {
  return HARNESS_RE.test(lesson);
}

/** The `(fonte: ID)` provenance of a lesson line ("" when absent). */
export function lessonFonte(lesson: string): string {
  return /\(fonte:\s*([^)]+)\)/.exec(lesson)?.[1]?.trim() ?? "";
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
 * Append new lessons (deduped against the file and against each other — exact
 * key OR semantic Jaccard match — capped at `max`). Returns the updated file
 * content plus the lessons actually added.
 */
export function appendLessons(
  md: string,
  lessons: string[],
  sourceId: string,
  max = 3,
): { md: string; added: string[] } {
  const known = parseLessons(md).map((l) => ({ key: lessonKey(l), tokens: lessonTokens(l) }));
  const added: string[] = [];
  for (const raw of lessons) {
    if (added.length >= max) break;
    const line = normalizeLesson(raw, sourceId);
    if (!line) continue;
    const key = lessonKey(line);
    const tokens = lessonTokens(line);
    if (known.some((k) => k.key === key || semanticDupe(tokens, k.tokens))) continue;
    known.push({ key, tokens });
    added.push(line);
  }
  if (!added.length) return { md, added };
  // keep the FULL history: existing lessons first, new ones appended —
  // splicing with only `added` was wiping the whole section every merge
  const kept = parseLessons(md).filter((l) => !added.includes(l));
  return { md: spliceLessonsSection(md, [...kept, ...added]), added };
}

/**
 * Nightly red-team maintenance (P1-007 + P1-075): when the file is above the
 * cap, dedupe (newest wording wins — exact key OR semantic Jaccard match) and
 * prune to the `cap` most recent lessons with a score: harness lessons whose
 * fonte task is in `done` are archived (returned in `archived`), product-code
 * lessons have priority and are dropped last; within a class, oldest first.
 */
export function dedupeAndPrune(
  md: string,
  cap = EXPERIENCE_CAP,
  done: Set<string> = new Set(),
): { md: string; removed: number; archived: string[] } {
  const lessons = parseLessons(md);
  if (lessons.length <= cap) return { md, removed: 0, archived: [] };
  const seenKeys = new Set<string>();
  const seenTokens: Set<string>[] = [];
  const deduped: string[] = [];
  for (let i = lessons.length - 1; i >= 0; i--) {
    const lesson = lessons[i]!;
    const key = lessonKey(lesson);
    const tokens = lessonTokens(lesson);
    if (seenKeys.has(key) || seenTokens.some((t) => semanticDupe(tokens, t))) continue;
    seenKeys.add(key);
    seenTokens.push(tokens);
    deduped.unshift(lesson); // unshift newest-kept order back
  }
  // P1-075 scored prune: harness lessons whose bug already shipped (fonte in
  // `done`) are archived; if still above cap, drop oldest-first within class —
  // harness first, product lessons last (product has priority).
  const archived: string[] = [];
  const dropped = new Set<number>();
  const pool = deduped.map((l, i) => ({ l, i }));
  while (pool.length - dropped.size > cap) {
    const idx = pool.findIndex(({ l, i }) => !dropped.has(i) && isHarnessLesson(l) && done.has(lessonFonte(l)));
    if (idx < 0) break;
    archived.push(pool[idx]!.l);
    dropped.add(pool[idx]!.i);
  }
  if (pool.length - dropped.size > cap) {
    const alive = pool.filter(({ i }) => !dropped.has(i));
    const harness = alive.filter(({ l }) => isHarnessLesson(l));
    const product = alive.filter(({ l }) => !isHarnessLesson(l));
    let drop = alive.length - cap;
    for (const { i } of [...harness, ...product]) {
      if (drop <= 0) break;
      dropped.add(i);
      drop--;
    }
  }
  const kept = pool.filter(({ i }) => !dropped.has(i)).map(({ l }) => l);
  const removed = lessons.length - kept.length;
  return { md: spliceLessonsSection(md, kept), removed, archived };
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

/**
 * Red-team nightly pass (P1-007 + P1-075): dedupe + prune when above
 * EXPERIENCE_CAP. Harness lessons whose fonte task is already `## Done` in the
 * workspace BACKLOG.md are archived (returned) instead of silently deleted.
 */
export function maintainExperienceFile(
  ws: string,
  done: Set<string> = new Set(),
): { changed: boolean; removed: number; lessons: number; archived: string[] } {
  const file = join(ws, EXPERIENCE_FILE);
  let md = "";
  try {
    md = readFileSync(file, "utf8");
  } catch {
    return { changed: false, removed: 0, lessons: 0, archived: [] };
  }
  const { md: next, removed, archived } = dedupeAndPrune(md, EXPERIENCE_CAP, done);
  const changed = next !== md;
  if (changed) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, next);
  }
  return { changed, removed, lessons: parseLessons(next).length, archived };
}

// ── nightly maintenance flow (P1-075; git/lessons IO injectable) ─────────────

export interface ExpMaintResult {
  changed: boolean;
  removed: number;
  lessons: number;
  /** archived lessons that landed in the shared lessons.jsonl. */
  archived: number;
  committed: boolean;
}

/** IO the nightly maintenance needs — injected so the eval battery pins the
 * failure semantics with fakes (commit/push failures never throw). */
export interface ExpMaintIo {
  exec: (cmd: string) => { ok: boolean; output: string };
  appendLesson: (file: string, lesson: FailureLesson) => boolean;
  lessonsFile: string;
}

/**
 * P1-075: one deterministic experience-maintenance pass: dedupe + prune
 * docs/EXPERIENCE.md against the workspace BACKLOG's Done set, land archived
 * harness lessons in the shared lessons.jsonl (outside every worktree,
 * P1-037) and stamp `st.expMaintLast` — own daily guard, independent of the
 * redteam agent's fate. Best-effort by design: commit/push/fs failures are
 * logged and reported, never thrown, so the loop is never blocked. The commit
 * lands via the `pilot/meta` PR (P1-076), guarded to docs/EXPERIENCE.md.
 */
export async function maintainExperienceWorkspace(
  ws: string,
  st: { expMaintLast?: string },
  today: string,
  io: ExpMaintIo,
  log: (level: string, msg: string, data?: unknown) => void = () => {},
): Promise<ExpMaintResult> {
  if (st.expMaintLast === today) {
    return { changed: false, removed: 0, lessons: 0, archived: 0, committed: false };
  }
  let done = new Set<string>();
  try {
    done = doneTaskIds(readFileSync(join(ws, "BACKLOG.md"), "utf8"));
  } catch {}
  // P1-037 fs-first: the archive decision is computed before any git work so
  // the lessons.jsonl entries survive even when the landing fails; the apply
  // callback re-runs the dedupe against the fresh origin/main copy.
  const pre = maintainExperienceFile(ws, done);
  let maint = pre;
  const result = await landMetaCommit(
    ws,
    { exec: io.exec, sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)) },
    {
      files: [EXPERIENCE_FILE],
      message: "pilot(redteam): experience maintenance",
      guardFile: EXPERIENCE_FILE,
      apply: () => {
        maint = maintainExperienceFile(ws, done);
        if (!maint.changed) return { action: "noop" };
        return { action: "apply", message: `pilot(redteam): experience maintenance (-${maint.removed})` };
      },
    },
  );
  let committed = false;
  if (maint.changed) {
    committed = result !== "failed";
    if (result === "refused") {
      log("warn", "aux push refused — experience diff not limited to docs/EXPERIENCE.md");
    }
    log("info", "experience maintained", {
      removed: maint.removed,
      archived: maint.archived.length,
      lessons: maint.lessons,
      committed,
    });
  }
  let archivedLanded = 0;
  // On a successful landing the apply callback recomputed the pass against the
  // fresh origin/main copy — ITS archived list is what the landed commit pruned,
  // so only those lessons may reach lessons.jsonl. pre.archived (stale workspace
  // copy) covers the failed-landing case the P1-037 fs-first guarantee exists
  // for; using it on success would archive lessons the landed pass never saw.
  const archivedSource = result === "pushed" ? maint.archived : pre.archived;
  for (const lesson of archivedSource) {
    const landed = io.appendLesson(io.lessonsFile, {
      kind: "failure",
      ts: nowLocalISO(),
      task: lessonFonte(lesson) || "unknown",
      attempts: 0,
      step: "archived",
      findings: lesson,
      tail: "",
    });
    if (landed) archivedLanded++;
    else log("warn", "archived lesson could not land in lessons.jsonl");
  }
  st.expMaintLast = today;
  return { changed: maint.changed, removed: maint.removed, lessons: maint.lessons, archived: archivedLanded, committed };
}
