/**
 * P1-075 lesson-injection instrumentation, rebuilt by eval 05 (2026-09-27) as
 * `state.lessonImpactV2`. Pure and light on purpose — metrics.ts re-exports it
 * and the daemon imports metrics.ts.
 *
 * What the numbers can and cannot say: the cohorts are DESCRIPTIVE. Nothing
 * randomizes which builder gets lessons (the matcher decides from the task
 * text), so "with" and "without" differ in task mix and a gap between them is
 * not evidence that lessons help or hurt.
 *
 * Why a new key: the v1 record (`state.lessonImpact`) re-added each task's
 * LIFETIME token total on every run (1.70x inflated over 568 runs) and filed
 * runs that never reached a builder (8 planner failures) under "without". It
 * is left untouched — never rewritten, never migrated — so a deploy rollback
 * to older code (which only knows `lessonImpact`) cannot lose either record.
 */
import { TZ } from "./log";
import type { LessonImpactV2, LessonImpactV2Cohort } from "./state";

/** P1-075: one pipeline outcome for the lesson-injection instrumentation. */
export interface LessonImpactSample {
  /** IER lessons injected into the builder prompt (0 = without cohort). */
  lessons: number;
  /** Builder rounds executed by the pipeline (0 = never reached a builder). */
  rounds: number;
  ok: boolean;
  /** Tokens THIS run consumed (runTokenDelta; 0 when unavailable). */
  tokens: number;
}

const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0);

function cohort(c: unknown): LessonImpactV2Cohort {
  const m = (c ?? {}) as Partial<LessonImpactV2Cohort>;
  return { runs: num(m.runs), merges: num(m.merges), roundsTotal: num(m.roundsTotal), tokensTotal: num(m.tokensTotal) };
}

/** Tolerant parse of state.lessonImpactV2 — garbage → undefined. */
export function normalizeLessonImpactV2(v: unknown): LessonImpactV2 | undefined {
  if (!v || typeof v !== "object") return undefined;
  const raw = v as Partial<Record<keyof LessonImpactV2, unknown>>;
  return {
    since: typeof raw.since === "string" ? raw.since : "",
    with: cohort(raw.with),
    without: cohort(raw.without),
    untreated: num(raw.untreated),
  };
}

/**
 * Tokens one pipeline run consumed. state.taskCosts holds the task's LIFETIME
 * total (every session of every attempt, recomputed per run), so the run's
 * share is after − before; adding the lifetime value per run counted a 4-run
 * task's first attempt 4 times.
 */
export function runTokenDelta(before: number | undefined, after: number | undefined): number {
  return Math.max(0, num(after) - num(before));
}

/**
 * Fold one pipeline outcome into the with/without cohorts of
 * `state.lessonImpactV2` (mutates `state`, like recordContextPressure).
 * Merges count only successful runs; runs, rounds and tokens count every
 * treated outcome. A run that never reached a builder round got no injection
 * at all, so it is counted in `untreated`. The legacy `state.lessonImpact` is
 * never touched.
 */
export function recordLessonImpact(
  state: { lessonImpactV2?: LessonImpactV2 },
  sample: LessonImpactSample,
  now = new Date(),
): void {
  const impact = (state.lessonImpactV2 ??= {
    since: now.toLocaleDateString("en-CA", { timeZone: TZ }),
    with: cohort(null),
    without: cohort(null),
    untreated: 0,
  });
  if (!(sample.rounds > 0)) {
    impact.untreated++;
    return;
  }
  const c = sample.lessons > 0 ? impact.with : impact.without;
  c.runs++;
  if (sample.ok) c.merges++;
  c.roundsTotal += Math.max(0, Math.round(sample.rounds));
  c.tokensTotal += Math.max(0, Math.round(sample.tokens));
}
