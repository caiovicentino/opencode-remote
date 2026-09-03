/**
 * P2-045 — Dashboard v2 aggregations: honest metrics for the mission-control
 * dashboard. Pure functions over the pilot's own records (events.jsonl,
 * history.jsonl) so the eval battery can test every number the operator sees:
 *
 *  - countFailSteps: FALHAS por step (evidence/invariants/integration/…) from
 *    the structured `gate-fail` events recordGateFail emits;
 *  - burnDown: 7-day task burn-down from the P2-043 history.jsonl;
 *  - avgPhaseDurations: average wall time per pipeline phase (planner, builder,
 *    reviewers, gatekeeper) from phase transitions in the events feed.
 */
import { TZ } from "./log";
import type { PilotEvent } from "./events";
import type { LessonImpact, LessonImpactCohort } from "./state";

/** P1-075: one pipeline outcome for the lesson-injection instrumentation. */
export interface LessonImpactSample {
  /** IER lessons injected into the builder prompt (0 = without cohort). */
  lessons: number;
  /** Builder rounds executed by the pipeline. */
  rounds: number;
  ok: boolean;
  /** Total tokens reconciled for the task (best-effort, 0 when unavailable). */
  tokens: number;
}

/**
 * P1-075: fold one pipeline outcome into the with/without lesson-injection
 * cohorts (mutates `state`, like recordContextPressure). Merges count only
 * successful runs; rounds/tokens count every outcome — the cohorts answer
 * "does lesson injection reduce rounds/cost per merge?".
 */
export function recordLessonImpact(
  state: { lessonImpact?: LessonImpact },
  sample: LessonImpactSample,
): void {
  const cohorts = (state.lessonImpact ??= {
    with: { merges: 0, roundsTotal: 0, tokensTotal: 0 },
    without: { merges: 0, roundsTotal: 0, tokensTotal: 0 },
  });
  const cohort: LessonImpactCohort = sample.lessons > 0 ? cohorts.with : cohorts.without;
  if (sample.ok) cohort.merges++;
  cohort.roundsTotal += Math.max(0, Math.round(sample.rounds));
  cohort.tokensTotal += Math.max(0, Math.round(sample.tokens));
}

/** One P2-043 history.jsonl row: a task outcome with wall duration. */
export interface HistoryEntry {
  ts: string;
  id?: string;
  ok?: boolean;
  durMin?: number;
  attempts?: number;
}

/** A gate step that can reject a task (recordGateFail steps + review). */
export interface FailStep {
  step: string;
  count: number;
}

/** One burn-down bucket: tasks finished on that local day. */
export interface BurnDay {
  day: string; // YYYY-MM-DD in the pilot timezone
  ok: number;
  failed: number;
}

/** Average wall duration of one pipeline phase across completed runs. */
export interface PhaseDuration {
  phase: string;
  avgMs: number;
  n: number;
}

/** Local (GMT-3) YYYY-MM-DD key for an ISO timestamp. */
function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
}

/**
 * Group `gate-fail` events by step name. Counts every occurrence in the feed —
 * a task failing the same step twice counts twice, mirroring state.failures.
 * Sorted by count desc, then step name for stable rendering.
 */
export function countFailSteps(events: PilotEvent[]): FailStep[] {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.type !== "phase" || e.phase !== "gate-fail" || !e.detail) continue;
    counts.set(e.detail, (counts.get(e.detail) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([step, count]) => ({ step, count }))
    .sort((a, b) => b.count - a.count || a.step.localeCompare(b.step));
}

/**
 * 7-day burn-down from history.jsonl (P2-043): tasks finished per local day,
 * split ok/failed. Always returns exactly `days` buckets ending today
 * (zero-filled) so the chart doesn't shift when the pilot idles.
 */
export function burnDown(history: HistoryEntry[], days: number, now = new Date()): BurnDay[] {
  const counts = new Map<string, { ok: number; failed: number }>();
  for (const h of history ?? []) {
    if (!h || typeof h.ts !== "string" || !Number.isFinite(Date.parse(h.ts))) continue;
    const key = dayKey(h.ts);
    const b = counts.get(key) ?? { ok: 0, failed: 0 };
    if (h.ok) b.ok++;
    else b.failed++;
    counts.set(key, b);
  }
  const out: BurnDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const key = d.toLocaleDateString("en-CA", { timeZone: TZ });
    const b = counts.get(key) ?? { ok: 0, failed: 0 };
    out.push({ day: key, ok: b.ok, failed: b.failed });
  }
  return out;
}

/** A phase and the event that closes it (duration = close.ts - open.ts). */
const COMPLETES: Record<string, string> = {
  "planner-done": "planner",
  "builder-done": "builder",
  "reviewers-done": "reviewers",
  merge: "gatekeeper",
};

/**
 * Average wall duration per pipeline phase, derived from phase transitions in
 * the events feed (planner→planner-done, …, gatekeeper→merge). Review rounds
 * are included in the builder/reviewers averages — that is real operator time.
 * Phases with no completed sample are omitted.
 */
export function avgPhaseDurations(events: PilotEvent[]): PhaseDuration[] {
  const totals = new Map<string, { sum: number; n: number }>();
  const open = new Map<string, { phase: string; at: number }>();
  for (const e of events) {
    if (e.type !== "phase" || !e.task || !e.phase) continue;
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t)) continue;
    const key = e.task;
    const closePhase = COMPLETES[e.phase];
    if (closePhase) {
      const o = open.get(key);
      if (o && o.phase === closePhase) {
        const b = totals.get(closePhase) ?? { sum: 0, n: 0 };
        b.sum += Math.max(0, t - o.at);
        b.n++;
        totals.set(closePhase, b);
      }
      open.delete(key);
    } else {
      // opener (planner/builder/reviewers/gatekeeper) or an untracked aux
      // phase — the next matching terminator closes it, stale opens never do
      open.set(key, { phase: e.phase, at: t });
    }
  }
  return [...totals.entries()]
    .map(([phase, { sum, n }]) => ({ phase, avgMs: Math.round(sum / n), n }))
    .sort((a, b) => b.n - a.n || a.phase.localeCompare(b.phase));
}

/**
 * P2-041: the post-rollback health verdict that should light the dashboard's
 * red "prod unhealthy" chip, or null when there is no active alert. The NEWEST
 * verdict wins: an unhealthy `rollback-health` event alerts, a healthy verdict
 * or a later clean deploy (phase `done`) clears it. Scans the full event feed
 * (like countFailSteps) so a 200-event tail cannot silently hide an alert.
 */
export function rollbackHealthAlert(events: PilotEvent[]): PilotEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== "deploy") continue;
    if (e.phase === "rollback-health") return e.ok === false ? e : null;
    if (e.phase === "done") return null;
  }
  return null;
}
