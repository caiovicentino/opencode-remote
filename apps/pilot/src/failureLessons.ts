/**
 * P2-031 — Failure scribe: when the stop-loss (P1-014) moves a task to
 * ## Blocked, the pipeline records one structured lesson in
 * ~/.opencode-remote/pilot/lessons.jsonl (kind:"failure"). This complements
 * the IER (P1-007), which only distills lessons from successful merges.
 * Pure functions here (parse/format) so the eval battery can pin the format;
 * the fs wrappers at the bottom only touch the lessons file.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface FailureLesson {
  kind: "failure";
  /** local timestamp (GMT-3), nowLocalISO() format. */
  ts: string;
  task: string;
  attempts: number;
  /** failing step: a gatekeeper step name, "review" (review-round burnout) or "pipeline" fallback. */
  step: string;
  /** last failure reason carried by the pipeline result. */
  findings: string;
  /** tail of the gatekeeper/review output for the task ("" when unavailable). */
  tail: string;
}

/** The jsonl lives outside the repo, next to the pilot state (gate-fail, shots). */
export function defaultLessonsFile(): string {
  return join(homedir(), ".opencode-remote", "pilot", "lessons.jsonl");
}

/** Hard caps keep one noisy failure from flooding the file (and the prompts). */
export const FAILURE_FINDINGS_CAP = 500;
export const FAILURE_TAIL_CAP = 1200;

/**
 * Parse a lessons.jsonl content: returns only valid kind:"failure" lines in
 * file (chronological) order, tolerating corrupt/partial lines — a bad write
 * must never make the whole file unreadable.
 */
export function parseFailureLessons(jsonl: string): FailureLesson[] {
  const out: FailureLesson[] = [];
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const raw = JSON.parse(t) as Partial<FailureLesson>;
      if (raw?.kind !== "failure" || typeof raw.task !== "string" || !raw.task) continue;
      out.push({
        kind: "failure",
        ts: typeof raw.ts === "string" ? raw.ts : "",
        task: raw.task,
        attempts: typeof raw.attempts === "number" ? raw.attempts : 0,
        step: typeof raw.step === "string" ? raw.step : "",
        findings: typeof raw.findings === "string" ? raw.findings : "",
        tail: typeof raw.tail === "string" ? raw.tail : "",
      });
    } catch {}
  }
  return out;
}

/** One-line rendering for prompts: whitespace-collapsed and bounded per part. */
export function formatFailureLesson(l: FailureLesson, maxPart = 200): string {
  const part = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, maxPart);
  const tail = l.tail ? ` | gate tail: ${part(l.tail)}` : "";
  return `- [${l.task}] (${l.attempts} attempt(s), step: ${l.step || "unknown"}) ${part(l.findings) || "(no findings recorded)"}${tail}`;
}

/** P1-075: entries with this `step` are archived EXPERIENCE lessons (harness
 * lessons whose fonte task is done) — background context, never majority. */
export const ARCHIVED_STEP = "archived";

/** P1-075: archived entries fill at most 3 of the prompt block's slots. */
export const ARCHIVED_BLOCK_CAP = 3;

/**
 * Prompt block carrying the `max` most recent failure lessons (chronological,
 * newest last). Empty string when there is nothing to inject — the strategist
 * prompt must stay clean until the first block actually happens.
 *
 * P1-075: archived experience lessons ride the same jsonl but are background —
 * they fill at most 3 of the `max` slots, real blocked-task failures keep the
 * rest (≥ 7 of 10 whenever that many real failures exist).
 */
export function failureLessonsBlock(lessons: FailureLesson[], max = 10): string {
  const picked = capArchived(lessons.slice(-max), lessons, max);
  if (!picked.length) return "";
  return `\nFAILURE LESSONS — the ${picked.length} most recent blocked tasks (draft/refine tasks so they do NOT repeat these failure patterns):\n${picked
    .map((l) => formatFailureLesson(l))
    .join("\n")}\n`;
}

/** P1-075: enforce the archived-entries cap inside a picked window, backfilling
 * with the most recent real failures from outside it (chronological order). */
function capArchived(window: FailureLesson[], all: FailureLesson[], max: number): FailureLesson[] {
  const archivedCount = window.filter((l) => l.step === ARCHIVED_STEP).length;
  if (archivedCount <= ARCHIVED_BLOCK_CAP) return window;
  let excess = archivedCount - ARCHIVED_BLOCK_CAP;
  const dropped = new Set<FailureLesson>();
  for (const l of window) {
    // oldest archived first — newest archived wording survives
    if (excess > 0 && l.step === ARCHIVED_STEP) {
      dropped.add(l);
      excess--;
    }
  }
  const kept = window.filter((l) => !dropped.has(l));
  const windowSet = new Set(window);
  const backfill: FailureLesson[] = [];
  for (let i = all.length - max - 1; i >= 0 && kept.length + backfill.length < max; i--) {
    const l = all[i]!;
    if (l.step !== ARCHIVED_STEP && !windowSet.has(l)) backfill.unshift(l);
  }
  return [...backfill, ...kept];
}

/** Append one lesson as a JSONL line (creating parent dirs). Best-effort. */
export function appendFailureLesson(file: string, lesson: FailureLesson): boolean {
  try {
    const bounded = {
      ...lesson,
      findings: lesson.findings.slice(0, FAILURE_FINDINGS_CAP),
      tail: lesson.tail.slice(0, FAILURE_TAIL_CAP),
    };
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(bounded)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** The `max` most recent failure lessons; [] when the file is missing/unreadable. */
export function readRecentFailureLessons(file: string, max = 10): FailureLesson[] {
  let jsonl = "";
  try {
    jsonl = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return parseFailureLessons(jsonl).slice(-max);
}
