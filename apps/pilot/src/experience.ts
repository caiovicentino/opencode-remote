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
import type { ArchivedLesson } from "./failureLessons";
import { jaccard, QUERY_BOILERPLATE, queryTokens, tokenize } from "./lessontext";
import { nowLocalISO } from "./log";

export const EXPERIENCE_FILE = "docs/EXPERIENCE.md";
/** Red-team nightly duty (P1-007): dedupe + prune once the file grows past this.
 * Eval 05: 60 held under one day of lessons (~27 merges/day, the nightly pass
 * dropped 47–92 per night — median lesson lifetime 27h in a replay of the
 * real 09-01..24 scribe stream); 150 (the pool size the matcher was measured
 * on) gives ~68h with the 0–2 lessons/merge + refresh policy. */
export const EXPERIENCE_CAP = 150;
/** Hard ceiling of a stored lesson line (before the fonte tag); longer text is clipped. */
export const LESSON_MAX_CHARS = 240;
/** Budget the scribe prompt asks for — below LESSON_MAX_CHARS so a compliant
 * lesson is never clipped (2026-09-27: 64/69 stored lessons ended in "…"). */
export const SCRIBE_LESSON_BUDGET = 200;
/** New lessons one merge may add (the scribe emitted 3 in 427/434 merges and
 * the nightly prune then dropped 47–92 lessons per night at cap 60). */
export const SCRIBE_MAX_LESSONS = 2;

export function experienceTemplate(): string {
  return `# Experience memory (IER)

Lições destiladas pelo pipeline (role SCRIBE) após cada merge bem-sucedido.
Cada lição é uma linha \`- When <situação>, do <ação> — <porquê> (fonte: <ID>)\`. Os prompts
de planner, builder e strategist recebem até 5 lições relevantes (palavras em comum com a
task pesadas pela raridade; nenhuma quando nada é relevante); uma lição aprendida de novo
é renovada no lugar de duplicada, e a manutenção noturna deduplica e poda acima de
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

// tokenizer + similarity live in the import-free lessontext.ts (shared with
// failureLessons.ts); re-exported here for existing callers
export { jaccard, QUERY_BOILERPLATE, queryTokens, tokenize };

/** P1-075: semantic-duplicate threshold over tokenize() — pinned by the battery.
 * Calibrated 2026-09-27 on three real 144–152-lesson snapshots (~33k pairs):
 * every pair at >= 0.30 was the same lesson re-derived by another scribe
 * (16/16; e.g. the `ws.on("message")` async-handler lesson landed 3x at
 * 0.42–0.50), 0.20–0.30 was mixed, and the old 0.6 never fired (max 0.50). */
export const JACCARD_DUPE = 0.3;

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

/** A lesson must share at least this many informative tokens with the task. */
export const LESSON_MIN_MATCHED = 2;
/** ...and score at least this many "lesson-unique spec token" units (idf of a
 * token only one lesson carries) — one generic overlap is not relevance. */
export const LESSON_MIN_EVIDENCE = 2.5;

/**
 * Top-`max` lessons relevant to a task, best score first and most recent
 * first on ties (the file is append-ordered, last = newest). Title hits weigh
 * 2, spec hits 1 — titles carry the intent of the task; the provenance tag is
 * never matched and tokens are whole words (no "app"-in-"happen").
 *
 * 2026-09-27 replay of the last 60 merges: plain keyword overlap (score > 0)
 * filled all 5 slots for 58/60 tasks, with the same "hub" lessons everywhere
 * (two of them in 23/60 prompts) — ~5% of the injected lines were relevant.
 * So: tokens are weighted by their rarity in the lesson pool (idf), the
 * query drops spec boilerplate, a lesson needs LESSON_MIN_MATCHED shared
 * tokens AND LESSON_MIN_EVIDENCE worth of score, and a paraphrase of a lesson
 * already picked is skipped. No relevant lesson → nothing is injected.
 */
export function pickRelevantLessons(md: string, title: string, spec: string, max = 5): string[] {
  if (max <= 0) return [];
  const lessons = parseLessons(md);
  const docs = lessons.map(lessonTokens);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log((lessons.length + 1) / ((df.get(t) ?? 0) + 0.5));
  const titleTokens = queryTokens(title);
  const specTokens = queryTokens(spec);
  const floor = LESSON_MIN_EVIDENCE * Math.log((lessons.length + 1) / 1.5);
  const scored: { text: string; i: number; score: number }[] = [];
  lessons.forEach((text, i) => {
    let score = 0;
    let matched = 0;
    for (const t of docs[i]!) {
      if (titleTokens.has(t)) score += 2 * idf(t);
      else if (specTokens.has(t)) score += idf(t);
      else continue;
      matched++;
    }
    if (matched >= LESSON_MIN_MATCHED && score >= floor) scored.push({ text, i, score });
  });
  scored.sort((a, b) => b.score - a.score || b.i - a.i);
  const picked: typeof scored = [];
  for (const s of scored) {
    if (picked.length >= max) break;
    if (picked.some((p) => semanticDupe(docs[p.i]!, docs[s.i]!))) continue;
    picked.push(s);
  }
  return picked.map((s) => s.text);
}

/**
 * The stored lessons a SCRIBE must see before writing new ones (so it stops
 * re-deriving them): matched against the task plus the diff's touched paths
 * and added lines — the diff speaks the lessons' (English, code) vocabulary,
 * the pt-BR backlog title rarely does.
 */
export function lessonsNearDiff(md: string, title: string, spec: string, diff: string, max = 5): string[] {
  const paths = [...diff.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]).join(" ");
  const added = diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .join("\n")
    .slice(0, 6_000);
  return pickRelevantLessons(md, title, `${spec}\n${paths}\n${added}`, max);
}

/** Normalize an agent lesson line: single line, `- ` prefix, trusted fonte tag.
 * Overlong text is clipped at a word boundary (never mid-word) when one sits
 * in the last quarter of the budget. */
export function normalizeLesson(raw: string, sourceId: string, maxLen = LESSON_MAX_CHARS): string {
  const text = raw.replace(/\s+/g, " ").trim().replace(/^-\s+/, "").replace(/\s*\(fonte:[^)]*\)\s*$/, "").trim();
  if (text.length < 15) return "";
  let clipped = text;
  if (text.length > maxLen) {
    const hard = text.slice(0, maxLen - 1);
    const space = hard.lastIndexOf(" ");
    clipped = (space >= Math.floor(maxLen * 0.75) ? hard.slice(0, space) : hard).replace(/[\s,;:—-]+$/, "") + "…";
  }
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
 * key OR semantic Jaccard match — at most `max` new ones). Returns the updated
 * file content, the lessons actually added and the ones refreshed.
 *
 * A lesson that re-lands (another merge re-derived it) REFRESHES the stored
 * one: the newest wording moves to the end of the file, so the nightly
 * oldest-first prune keeps what keeps recurring instead of aging it out.
 */
export function appendLessons(
  md: string,
  lessons: string[],
  sourceId: string,
  max = SCRIBE_MAX_LESSONS,
): { md: string; added: string[]; refreshed: string[] } {
  // keep the FULL history: existing lessons first, new ones appended —
  // splicing with only `added` was wiping the whole section every merge
  let current = parseLessons(md);
  const added: string[] = [];
  const refreshed: string[] = [];
  for (const raw of lessons) {
    if (added.length >= max) break;
    const line = normalizeLesson(raw, sourceId);
    if (!line) continue;
    const key = lessonKey(line);
    const tokens = lessonTokens(line);
    const dupe = current.findIndex((l) => lessonKey(l) === key || semanticDupe(tokens, lessonTokens(l)));
    if (dupe < 0) {
      current = [...current, line];
      added.push(line);
      continue;
    }
    const stored = current[dupe]!;
    // a dupe of a line this batch already wrote, or the identical newest line
    if (added.includes(stored) || refreshed.includes(stored)) continue;
    if (stored === line && dupe === current.length - 1) continue;
    current = [...current.slice(0, dupe), ...current.slice(dupe + 1), line];
    refreshed.push(line);
  }
  if (!added.length && !refreshed.length) return { md, added, refreshed };
  return { md: spliceLessonsSection(md, current), added, refreshed };
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

/** SCRIBE commit path: append lessons to the workspace file, creating it if
 * needed. Returns the lessons written (added + refreshed) — 0 = nothing to commit. */
export function appendLessonsToWorkspace(ws: string, lessons: string[], sourceId: string): number {
  const file = join(ws, EXPERIENCE_FILE);
  const md = existsSync(file) ? readFileSync(file, "utf8") : experienceTemplate();
  const { md: next, added, refreshed } = appendLessons(md, lessons, sourceId);
  if (added.length || refreshed.length) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, next);
  }
  return added.length + refreshed.length;
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
  appendLesson: (file: string, lesson: ArchivedLesson) => boolean;
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
    // audit integrity: "refused" means the landing was REJECTED by the guard
    // (potential tampering) and "failed" means unconfirmed — only a confirmed
    // merge may be reported as a commit.
    committed = result === "pushed";
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
    // its own kind, never kind:"failure" — the 192 legacy failure-shaped rows
    // filled the planner/strategist FAILURE LESSONS block and the doctor's
    // "top failure steps" with merged tasks' success lessons
    const landed = io.appendLesson(io.lessonsFile, {
      kind: "experience-archived",
      ts: nowLocalISO(),
      task: lessonFonte(lesson) || "unknown",
      lesson,
    });
    if (landed) archivedLanded++;
    else log("warn", "archived lesson could not land in lessons.jsonl");
  }
  st.expMaintLast = today;
  return { changed: maint.changed, removed: maint.removed, lessons: maint.lessons, archived: archivedLanded, committed };
}
