/**
 * P2-032 — Fever circuit breaker (audit mode): a global, self-inflicted pause
 * for the whole scheduler. Two independent triggers watch the pipeline's vital
 * signs over sliding windows held in state.json:
 *
 *  1. fever rate — >= 60% of the last 10 pipeline cycles failed;
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
import type { AuditMode, PilotState } from "./state";

/** Sliding-window size for the fever-rate trigger (pipeline cycles). */
export const AUDIT_WINDOW = 10;
/** Fraction of failed cycles inside the window that trips the breaker. */
export const AUDIT_FAIL_RATE = 0.6;
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
 * recent AUDIT_WINDOW samples). A failure recorded while already in audit
 * mode pushes the 2h resume deadline forward.
 */
export function recordCycle(st: PilotState, ok: boolean, now = Date.now()): void {
  const cycles = st.cycles ?? (st.cycles = []);
  cycles.push({ ok, at: now });
  if (cycles.length > AUDIT_WINDOW) st.cycles = cycles.slice(-AUDIT_WINDOW);
  if (!ok && st.auditMode) st.auditMode.lastFailure = now;
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
 * The two P2-032 triggers. Returns the reason string when the pilot is in
 * fever, null otherwise. The rate trigger needs a full window so a single
 * early failure can never trip the breaker on its own.
 */
export function feverReason(st: PilotState, now = Date.now()): string | null {
  const cycles = st.cycles ?? [];
  if (cycles.length >= AUDIT_WINDOW) {
    const fails = cycles.filter((c) => !c.ok).length;
    if (fails / cycles.length >= AUDIT_FAIL_RATE) {
      return `fever: ${fails}/${cycles.length} cycles failed (>= ${AUDIT_FAIL_RATE * 100}%)`;
    }
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
