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

/**
 * Prompt block carrying the `max` most recent failure lessons (chronological,
 * newest last). Empty string when there is nothing to inject — the strategist
 * prompt must stay clean until the first block actually happens.
 */
export function failureLessonsBlock(lessons: FailureLesson[], max = 10): string {
  const recent = lessons.slice(-max);
  if (!recent.length) return "";
  return `\nFAILURE LESSONS — the ${recent.length} most recent blocked tasks (draft/refine tasks so they do NOT repeat these failure patterns):\n${recent
    .map((l) => formatFailureLesson(l))
    .join("\n")}\n`;
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
