/**
 * P2-032 — Fever circuit breaker (audit mode): a global, self-inflicted pause
 * for the whole scheduler. Two independent triggers watch the pipeline's vital
 * signs over sliding windows held in state.json:
 *
 *  1. fever rate — >= 3 DISTINCT tasks failed within the last 10 pipeline
 *     cycles (P2-063: aggregated by task id, so one stubborn task burning
 *     through its own maxAttemptsPerTask breaker can never pause the queue);
 *  2. block burst — 2 tasks landed in ## Blocked within 30 minutes.
 *
 * While in audit mode the loop stops picking tasks from ## Ready, runs a
 * deterministic doctor pass (API health probe + aggregation of top failure
 * steps and top rejected tasks) and posts the summary to the log. It resumes
 * after external intervention (touching the `audit-clear` flag file) or after
 * 2h without a new failure. Pure functions here so the eval battery can
 * inject faults on both triggers.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { nowLocalISO } from "./log";
import { parseFailureLessons, type FailureLesson } from "./failureLessons";
import type { AuditMode, CycleSample, PilotState } from "./state";

/** Sliding-window size for the fever-rate trigger (pipeline cycles). */
export const AUDIT_WINDOW = 10;
/** P2-063: distinct tasks that must fail inside the window to trip the breaker. */
export const AUDIT_DISTINCT_TASKS = 3;
/** Block-burst window: 2 tasks blocked within 30 min trip the breaker. */
export const AUDIT_BLOCK_WINDOW_MS = 30 * 60_000;
export const AUDIT_BLOCK_TRIGGER = 2;
/** Resume automatically after 2h without a new failure. */
export const AUDIT_RESUME_MS = 2 * 60 * 60_000;

/** Operator escape hatch: touch this file to clear audit mode next cycle. */
export function auditClearFile(): string {
  return join(homedir(), ".opencode-remote", "pilot", "audit-clear");
}

/**
 * Feed one pipeline outcome into the sliding fever window (keep the most
 * recent AUDIT_WINDOW samples). `task` attributes the outcome to a task id so
 * P2-063 can aggregate failures per task; undefined for pipeline-level crashes
 * that have no task. A failure recorded while already in audit mode pushes the
 * 2h resume deadline forward.
 */
export function recordCycle(st: PilotState, ok: boolean, task?: string, now = Date.now()): void {
  const cycles = st.cycles ?? (st.cycles = []);
  cycles.push({ ok, at: now, task });
  if (cycles.length > AUDIT_WINDOW) st.cycles = cycles.slice(-AUDIT_WINDOW);
  if (!ok && st.auditMode) st.auditMode.lastFailure = now;
  // P1-095: every pipeline outcome (ok or merit-fail) refreshes the idle-window
  // timestamp that arms the nightly pass
  st.lastCycleAt = now;
}

// ── P1-074: infra-signature failures — never merit evidence ─────────────────

/** P1-074: kind of infrastructure failure behind a pipeline outcome. */
export type InfraFailureKind = "api-down" | "spawn" | "timeout" | "network";

/** Every INFRA_DOCTOR_EVERY-th infra failure wakes the doctor (a diagnostic
 * pass without entering audit mode). */
export const INFRA_DOCTOR_EVERY = 3;

/**
 * P1-094: classify a pipeline failure as infrastructure noise **only** from the
 * structured `infra` flag the failure's producer set (runner stage flags,
 * timeout-without-output) — never by scanning `detail` text, which often embeds
 * reviewer findings that may legitimately mention infra words (a merit finding
 * citing ECONNREFUSED must stay merit). Successful outcomes are never infra.
 */
export function resultInfraKind(result: { ok: boolean; infra?: InfraFailureKind }): InfraFailureKind | null {
  return result.ok ? null : result.infra ?? null;
}

/**
 * P1-074: count one infra-signature failure in the diagnostic `infraFails`
 * counter — the only record (no cycle sample, no attempt, no block). Returns
 * true every INFRA_DOCTOR_EVERY-th call, when the caller should wake the
 * doctor for a diagnosis pass.
 */
export function recordInfraFailure(st: PilotState): boolean {
  st.infraFails = (st.infraFails ?? 0) + 1;
  return st.infraFails % INFRA_DOCTOR_EVERY === 0;
}

/**
 * P1-104: bookkeeping for a thrown pipeline crash (the runSlot catch). A crash
 * never produced a merit verdict, so it must never burn a per-task attempt or
 * block the task (P1-074: bias the false-positive direction toward infra — the
 * retry is free). It still counts as fever evidence, un-attributed (P2-063:
 * each crash is its own distinct entry), so a systemic crash loop keeps
 * tripping the global breaker. Returns true when the caller should wake the
 * doctor (every INFRA_DOCTOR_EVERY-th crash).
 */
export function recordPipelineCrash(st: PilotState, now = Date.now()): boolean {
  recordCycle(st, false, undefined, now);
  return recordInfraFailure(st);
}

/**
 * Record a task block that landed on main (stop-loss P1-014) and prune the
 * 30min burst window. Counts as fresh failure evidence for the resume clock.
 */
export function recordBlockEvent(st: PilotState, now = Date.now()): void {
  const events = st.blockEvents ?? (st.blockEvents = []);
  events.push(now);
  st.blockEvents = events.filter((t) => now - t <= AUDIT_BLOCK_WINDOW_MS);
  if (st.auditMode) st.auditMode.lastFailure = now;
}

/**
 * P2-063: count the DISTINCT tasks behind the failed cycles in the fever
 * window. The old trigger counted failed cycles, so a single hard task
 * exhausting its own attempts generated several "fever" samples and paused
 * the whole queue — a per-task condition triggering a global pause. Id-less
 * failures (pipeline-level crashes, legacy pre-P2-063 samples) carry no
 * attribution; each counts as its own distinct entry, keeping the breaker
 * conservative about systemic evidence.
 */
export function distinctFailedTasks(cycles: CycleSample[]): number {
  const ids = new Set<string>();
  for (const c of cycles) {
    if (c.ok) continue;
    ids.add(c.task || `?${c.at}`);
  }
  return ids.size;
}

/**
 * The two P2-032 triggers. The fever-rate trigger needs >= AUDIT_DISTINCT_TASKS
 * different tasks failing inside the last AUDIT_WINDOW cycles (P2-063), so a
 * lone stubborn task keeps going through its normal maxAttemptsPerTask circuit
 * instead of pausing the queue; three distinct tasks failing is systemic
 * evidence strong enough on its own and trips even in a partial window.
 * Returns the reason string when the pilot is in fever, null otherwise.
 */
export function feverReason(st: PilotState, now = Date.now()): string | null {
  const cycles = st.cycles ?? [];
  const distinct = distinctFailedTasks(cycles);
  if (distinct >= AUDIT_DISTINCT_TASKS) {
    return `fever: ${distinct} distinct tasks failed in the last ${AUDIT_WINDOW} cycles (>= ${AUDIT_DISTINCT_TASKS})`;
  }
  const blocks = (st.blockEvents ?? []).filter((t) => now - t <= AUDIT_BLOCK_WINDOW_MS);
  if (blocks.length >= AUDIT_BLOCK_TRIGGER) {
    return `fever: ${blocks.length} tasks blocked in ${AUDIT_BLOCK_WINDOW_MS / 60_000}min`;
  }
  return null;
}

/** Enter audit mode once. Clears the windows so resuming starts from a clean slate. */
export function enterAuditMode(st: PilotState, reason: string, now = Date.now()): boolean {
  if (st.auditMode) return false;
  st.auditMode = { since: nowLocalISO(), reason, lastFailure: now };
  st.cycles = [];
  st.blockEvents = [];
  return true;
}

/** True when the 2h-without-failure resume deadline has been reached. */
export function auditResumeDue(audit: AuditMode, now = Date.now()): boolean {
  return now - audit.lastFailure >= AUDIT_RESUME_MS;
}

/** Leave audit mode (either resume path) and reset every breaker counter. */
export function clearAuditMode(st: PilotState): void {
  st.auditMode = null;
  st.auditDiagnosis = undefined; // P2-045: chip has no reason to outlive the pause
  st.cycles = [];
  st.blockEvents = [];
}

// ── doctor pass: deterministic diagnostic summary ────────────────────────────

export interface Diagnosis {
  /** Result of the opencode API health probe (same check the CLI doctor does). */
  api: "healthy" | "down" | "unknown";
  /** Gatekeeper/review steps failing the most, across blocked + failing tasks. */
  topSteps: Array<{ step: string; count: number }>;
  /** Tasks with the most rejections (blocked lessons merged with live attempts). */
  topTasks: Array<{ task: string; count: number }>;
}

const TOP_STEPS = 3;
const TOP_TASKS = 5;

function countMax(into: Map<string, number>, key: string, by: number) {
  into.set(key, Math.max(into.get(key) ?? 0, by));
}

function topCounts(map: Map<string, number>, max: number): Array<[string, number]> {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max);
}

/**
 * Aggregate the failure evidence into the summary posted to the log when audit
 * mode trips. Sources: the failure lessons (one per blocked task, P2-031), the
 * per-task gate-fail carryover files (latest failing step, even before a block
 * lands) and the live per-task attempt counters. Gate-fail entries for tasks
 * that already have a lesson are not double-counted.
 */
export function buildDiagnosis(opts: {
  lessonsFile: string;
  gateFailDir: string;
  attempts?: Record<string, number>;
  api?: boolean;
}): Diagnosis {
  let lessons: FailureLesson[] = [];
  try {
    lessons = parseFailureLessons(readFileSync(opts.lessonsFile, "utf8"));
  } catch {}
  const lessonTasks = new Set(lessons.map((l) => l.task));

  const steps = new Map<string, number>();
  const tasks = new Map<string, number>();
  const bump = (step: string, task: string) => {
    if (!step) return;
    steps.set(step, (steps.get(step) ?? 0) + 1);
    tasks.set(task, (tasks.get(task) ?? 0) + 1);
  };
  for (const l of lessons) bump(l.step || "pipeline", l.task);
  try {
    for (const f of readdirSync(opts.gateFailDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const g = JSON.parse(readFileSync(join(opts.gateFailDir, f), "utf8")) as { task?: string; step?: string };
        if (!g.task || lessonTasks.has(g.task)) continue;
        bump(g.step || "pipeline", g.task);
      } catch {}
    }
  } catch {}
  for (const [task, n] of Object.entries(opts.attempts ?? {})) countMax(tasks, task, n);

  return {
    api: opts.api === undefined ? "unknown" : opts.api ? "healthy" : "down",
    topSteps: topCounts(steps, TOP_STEPS).map(([step, count]) => ({ step, count })),
    topTasks: topCounts(tasks, TOP_TASKS).map(([task, count]) => ({ task, count })),
  };
}

/** One-line rendering of the diagnosis for the JSONL pilot log. */
export function formatDiagnosis(d: Diagnosis): string {
  const fmt = (list: Array<{ step?: string; task?: string; count: number }>) =>
    list.length ? list.map((x) => `${x.task ?? x.step}(${x.count})`).join(",") : "none";
  return `api=${d.api} | top failure steps: ${fmt(d.topSteps)} | top rejected tasks: ${fmt(d.topTasks)}`;
}
