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
import { queryTokens, tokenize } from "./lessontext";

export interface FailureLesson {
  kind: "failure";
  /** local timestamp (GMT-3), nowLocalISO() format. */
  ts: string;
  task: string;
  /** backlog title of the blocked task — absent on rows written before eval 05. */
  title?: string;
  attempts: number;
  /** failing step: a gatekeeper step name, "review" (review-round burnout) or "pipeline" fallback. */
  step: string;
  /** last failure reason carried by the pipeline result. */
  findings: string;
  /** tail of the gatekeeper/review output for the task ("" when unavailable). */
  tail: string;
}

/** P1-075: an EXPERIENCE lesson pruned by the nightly maintenance, kept as a
 * record in the same jsonl. Its own kind — it is a SUCCESS lesson, and the
 * legacy failure-shaped rows (step "archived") polluted every failure reader. */
export const ARCHIVED_KIND = "experience-archived";

export interface ArchivedLesson {
  kind: typeof ARCHIVED_KIND;
  ts: string;
  /** the lesson's `(fonte: ID)` task. */
  task: string;
  lesson: string;
}

/** The jsonl lives outside the repo, next to the pilot state (gate-fail, shots). */
export function defaultLessonsFile(): string {
  return join(homedir(), ".opencode-remote", "pilot", "lessons.jsonl");
}

/** Hard caps keep one noisy failure from flooding the file (and the prompts). */
export const FAILURE_FINDINGS_CAP = 500;
export const FAILURE_TAIL_CAP = 1200;
export const FAILURE_TITLE_CAP = 160;

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
        ...(typeof raw.title === "string" && raw.title ? { title: raw.title } : {}),
        attempts: typeof raw.attempts === "number" ? raw.attempts : 0,
        step: typeof raw.step === "string" ? raw.step : "",
        findings: typeof raw.findings === "string" ? raw.findings : "",
        tail: typeof raw.tail === "string" ? raw.tail : "",
      });
    } catch {}
  }
  return out;
}

/** P1-075 legacy: rows written before eval 05 carried archived EXPERIENCE
 * lessons as kind:"failure" with this step (and 0 attempts). */
export const ARCHIVED_STEP = "archived";

/**
 * A real blocked-task failure: the stop-loss burned attempts on it. Legacy
 * archived rows (success lessons, 0 attempts) are not — 2026-09-27 they were
 * 192 of the 207 kind:"failure" rows and the whole planner/strategist block.
 */
export function isBlockedFailure(l: FailureLesson): boolean {
  return l.attempts > 0 && l.step !== ARCHIVED_STEP;
}

/**
 * The `max` most recent blocked failures, one per task (a re-queued task that
 * blocks again keeps only its newest row, at its newest position), in
 * chronological order — newest last.
 */
export function latestBlockedFailures(lessons: FailureLesson[], max = 10): FailureLesson[] {
  if (max <= 0) return [];
  const latest = new Map<string, FailureLesson>();
  for (const l of lessons) {
    if (!isBlockedFailure(l)) continue;
    latest.delete(l.task);
    latest.set(l.task, l);
  }
  return [...latest.values()].slice(-max);
}

// audit.ts infraStarvationReason, before and after eval-03 (which adds the
// " (red: <jobs>)" list and a ci-red-specific no-detail hypothesis)
const INFRA_STARVATION_RE =
  /^infra "([^"]+)" failed (\d+)x in a row on this task( \(red: [^)]*\))? — treated as a hard failure instead of an endless free retry(?: \((?:read-only remote, dead gh, or unreachable API\?|remote CI checks red on the task PR)\))?(?: — last detail: )?/;

/** The failure reason minus the stop-loss boilerplate (~110 chars that ate
 * the render budget and cut the CI job name off at "CI red: ci-ga"). */
export function compactFindings(findings: string): string {
  const m = INFRA_STARVATION_RE.exec(findings);
  if (!m) return findings;
  const rest = findings.slice(m[0].length).trim();
  return `infra "${m[1]}" ${m[2]}x in a row${m[3] ?? ""}${rest ? `: ${rest}` : ""}`;
}

/** Passing/progress lines, event-log JSON and build chatter — never the failure. */
const TAIL_NOISE_RE = /^(OK\s|\{"|\[\d{4}-\d{2}-\d{2}T|dist\/|\(Use `node|computing gzip|rendering chunks|✓ built|desktop flow duration)/;
const TAIL_SIGNAL_RE =
  /FAIL|Error|ERR!|never held|not a readable|without|diverges|gave up|timed? ?out|cannot|can't|missing|expected|refused|denied|reject|has been closed|✗|not ok|CI red/i;

/**
 * The part of a gate/review tail worth a prompt line: unique failure-signal
 * lines first (noise dropped), else the non-noise lines, bounded to `max`.
 * The stored tail is the LAST bytes of the step output, so a failing
 * desktop-flow tail is mostly "OK …" lines and JSON events.
 */
export function tailSignal(tail: string, max = 200): string {
  const lines = [...new Set(tail.split("\n").map((l) => l.replace(/\s+/g, " ").trim()))].filter(
    (l) => l && !TAIL_NOISE_RE.test(l),
  );
  const signal = lines.filter((l) => TAIL_SIGNAL_RE.test(l));
  return (signal.length ? signal : lines).join(" / ").slice(0, max);
}

/** Prompt-safe text: ANSI color codes dropped, the home prefix shortened to ~. */
function plain(s: string): string {
  const home = homedir();
  return (home.length > 1 ? s.split(home).join("~") : s).replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

/** One-line rendering for prompts: whitespace-collapsed and bounded per part. */
export function formatFailureLesson(l: FailureLesson, maxPart = 200): string {
  const part = (s: string) => plain(s).replace(/\s+/g, " ").trim().slice(0, maxPart);
  const title = l.title ? ` ${part(l.title).slice(0, 80)}` : "";
  const signal = tailSignal(plain(l.tail), maxPart);
  const tail = signal ? ` | gate tail: ${signal}` : "";
  return `- [${l.task}]${title} (${l.attempts} attempt(s), step: ${l.step || "unknown"}) ${part(compactFindings(l.findings)) || "(no findings recorded)"}${tail}`;
}

/**
 * Prompt block with up to `max` blocked-task failures (deduped per task).
 * With a `query` (the planner passes the task title+spec) the failures that
 * share informative words with it come first, recency breaking ties; without
 * one it is the `max` most recent. Empty string when nothing real exists —
 * the prompt stays clean until the first block actually happens.
 *
 * Eval 05 (forensic 2026-09-24 rec 6): archived EXPERIENCE lessons are never
 * injected here any more — they are success lessons, and 2026-09-27 the
 * block the planner and strategist saw was 3 of them and 0 real failures.
 */
export function failureLessonsBlock(lessons: FailureLesson[], max = 10, query = ""): string {
  if (max <= 0) return ""; // slice(-0) would hand back the whole pool
  const pool = latestBlockedFailures(lessons, Number.MAX_SAFE_INTEGER);
  let picked = pool.slice(-max);
  if (query && pool.length > max) {
    const q = queryTokens(query);
    const overlap = (l: FailureLesson) => {
      let n = 0;
      for (const t of tokenize(`${l.title ?? ""} ${l.step} ${compactFindings(l.findings)} ${tailSignal(l.tail)}`)) if (q.has(t)) n++;
      return n;
    };
    const ranked = pool.map((l, i) => ({ l, i, score: overlap(l) })).sort((a, b) => b.score - a.score || b.i - a.i);
    picked = ranked
      .slice(0, max)
      .sort((a, b) => a.i - b.i)
      .map((r) => r.l);
  }
  if (!picked.length) return "";
  const which = query && pool.length > max ? "blocked tasks closest to this task" : "most recent blocked tasks";
  return `\nFAILURE LESSONS — ${picked.length} ${which} (draft/refine tasks so they do NOT repeat these failure patterns):\n${picked
    .map((l) => formatFailureLesson(l))
    .join("\n")}\n`;
}

/** Append one lesson as a JSONL line (creating parent dirs). Best-effort. */
export function appendFailureLesson(file: string, lesson: FailureLesson): boolean {
  try {
    const bounded = {
      ...lesson,
      ...(lesson.title ? { title: lesson.title.slice(0, FAILURE_TITLE_CAP) } : {}),
      findings: lesson.findings.slice(0, FAILURE_FINDINGS_CAP),
      tail: lesson.tail.slice(0, FAILURE_TAIL_CAP),
    };
    return appendJsonl(file, bounded);
  } catch {
    return false;
  }
}

/** Append one archived EXPERIENCE lesson record (nightly maintenance). Best-effort. */
export function appendArchivedLesson(file: string, lesson: ArchivedLesson): boolean {
  return appendJsonl(file, { ...lesson, lesson: lesson.lesson.slice(0, FAILURE_FINDINGS_CAP) });
}

function appendJsonl(file: string, row: object): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(row)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** The `max` most recent BLOCKED failures (one per task, legacy archived rows
 * skipped); [] when the file is missing/unreadable. */
export function readRecentFailureLessons(file: string, max = 10): FailureLesson[] {
  let jsonl = "";
  try {
    jsonl = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return latestBlockedFailures(parseFailureLessons(jsonl), max);
}

/** Archived EXPERIENCE records (kind "experience-archived"), file order. */
export function readArchivedLessons(file: string): ArchivedLesson[] {
  let jsonl = "";
  try {
    jsonl = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: ArchivedLesson[] = [];
  for (const line of jsonl.split("\n")) {
    try {
      const raw = JSON.parse(line) as Partial<ArchivedLesson>;
      if (raw?.kind === ARCHIVED_KIND && typeof raw.task === "string" && typeof raw.lesson === "string")
        out.push({ kind: ARCHIVED_KIND, ts: typeof raw.ts === "string" ? raw.ts : "", task: raw.task, lesson: raw.lesson });
    } catch {}
  }
  return out;
}
