import type { Task } from "./backlog";

/**
 * P1-006: scheduling key for parallel slots. Tagged tasks share their area key
 * (`area:ui` etc.) and the scheduler never runs two of the same area at once;
 * ALL untagged tasks share the `solo` key so untagged work always runs
 * serially — the conservative default until the strategist tags it.
 */
export function areaKey(t: Task): string {
  return t.area ? `area:${t.area}` : "solo";
}

/**
 * Pick up to `freeSlots` tasks from the queue (in BACKLOG order, so priority
 * is respected) whose area keys are distinct from each other and from the
 * `busy` set of the slots already running.
 */
export function pickTasks(queue: Task[], freeSlots: number, busy: Set<string>): Task[] {
  const picked: Task[] = [];
  const used = new Set(busy);
  for (const t of queue) {
    if (picked.length >= freeSlots) break;
    const key = areaKey(t);
    if (used.has(key)) continue;
    picked.push(t);
    used.add(key);
  }
  return picked;
}

/**
 * Batch pick for one scheduler cycle: never exceeds the remaining daily task
 * budget (in-flight pipelines included) and never schedules over `freeSlots`.
 */
export function pickBatch(queue: Task[], freeSlots: number, busy: Set<string>, remainingBudget: number): Task[] {
  const cap = Math.min(Math.max(0, freeSlots), Math.max(0, remainingBudget));
  return pickTasks(queue, cap, busy);
}

// ── P1-095: nightly pass trigger — idle window instead of a wall-clock hour ──
//
// The old gate (`hour === 3` AND `running.size === 0`) was effectively
// unreachable: pipelines routinely span the whole 03:00–03:59 window, so
// redteam/explorer/forensic never ran. The nightly pass now fires at the first
// moment the scheduler has been idle >= 2h since the last pipeline cycle.

/** Idle gap (ms since the last pipeline cycle) that arms the nightly pass. */
export const NIGHTLY_IDLE_MS = 2 * 60 * 60_000;

/**
 * True when the scheduler has been idle long enough to start the nightly pass.
 * An undefined `lastCycleAt` (fresh or legacy state) means idle since forever →
 * due immediately.
 */
export function nightlyIdleDue(lastCycleAt: number | undefined, now = Date.now()): boolean {
  return now - (lastCycleAt ?? 0) >= NIGHTLY_IDLE_MS;
}

/** The nightly skip record persisted in state.json (once per day, honest). */
export interface NightlySkip {
  date: string;
  reason: string;
}

/**
 * Reason string when the classic nightly window (03:xx) has passed with slots
 * still busy and the pass not run today — the "nightly skipped" signal for
 * state.json + Mission Control. Returns null (nothing to record) when the
 * slots are idle, the hour is still within the window, the pass already ran
 * today, or a skip was already recorded today (dedupe by date).
 */
export function nightlySkipDue(
  st: { redteamLast?: string; explorerLast?: string; nightlySkipped?: NightlySkip | null },
  today: string,
  hour: number,
  slotsBusy: boolean,
): string | null {
  if (!slotsBusy) return null;
  if (hour < 4) return null; // 03:xx window not over yet — reason must stay truthful
  if (st.redteamLast === today && st.explorerLast === today) return null;
  if (st.nightlySkipped?.date === today) return null;
  return "slots busy past the nightly window — pass not run today";
}
