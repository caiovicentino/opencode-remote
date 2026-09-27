/**
 * P1-075 lesson-injection instrumentation (state.lessonImpact), rebuilt by
 * eval 05 (2026-09-27). Pure and light on purpose — metrics.ts re-exports it
 * and the daemon imports metrics.ts.
 *
 * What the numbers can and cannot say: the cohorts are DESCRIPTIVE. Nothing
 * randomizes which builder gets lessons (the matcher decides from the task
 * text), so "with" and "without" differ in task mix and a gap between them is
 * not evidence that lessons help or hurt. v1 (until 2026-09-27) also re-added
 * each task's lifetime token total on every run (1.70x inflated over 568
 * runs) and filed runs that never reached a builder (8 planner failures)
 * under "without".
 */
import { TZ } from "./log";
import type { LessonImpact, LessonImpactCohort } from "./state";

/** Current accounting: per-run token deltas, untreated runs kept apart. */
export const LESSON_IMPACT_VERSION = 2;

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

function legacyCohort(c: unknown): LessonImpactCohort {
  const m = (c ?? {}) as Partial<LessonImpactCohort>;
  return { merges: num(m.merges), roundsTotal: num(m.roundsTotal), tokensTotal: num(m.tokensTotal) };
}

function cohort(c: unknown): LessonImpactCohort {
  return { ...legacyCohort(c), runs: num((c as Partial<LessonImpactCohort> | null)?.runs) };
}

function emptyLessonImpact(): LessonImpact {
  return { v: LESSON_IMPACT_VERSION, since: "", with: cohort(null), without: cohort(null), untreated: 0 };
}

/**
 * Tolerant parse of state.lessonImpact (garbage → undefined). A pre-v2
 * record restarts the measurement: its cohorts move to `legacyV1` and are
 * never summed with v2 numbers — the token accounting differs.
 */
export function normalizeLessonImpact(v: unknown): LessonImpact | undefined {
  if (!v || typeof v !== "object") return undefined;
  const raw = v as Partial<Record<keyof LessonImpact, unknown>>;
  if (raw.v !== LESSON_IMPACT_VERSION) {
    return { ...emptyLessonImpact(), legacyV1: { with: legacyCohort(raw.with), without: legacyCohort(raw.without) } };
  }
  const legacy = raw.legacyV1 as { with?: unknown; without?: unknown } | undefined;
  return {
    v: LESSON_IMPACT_VERSION,
    since: typeof raw.since === "string" ? raw.since : "",
    with: cohort(raw.with),
    without: cohort(raw.without),
    untreated: num(raw.untreated),
    ...(legacy && typeof legacy === "object" ? { legacyV1: { with: legacyCohort(legacy.with), without: legacyCohort(legacy.without) } } : {}),
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
 * Fold one pipeline outcome into the with/without cohorts (mutates `state`,
 * like recordContextPressure). Merges count only successful runs; runs,
 * rounds and tokens count every treated outcome. A run that never reached a
 * builder round got no injection at all, so it is counted in `untreated`.
 */
export function recordLessonImpact(
  state: { lessonImpact?: LessonImpact },
  sample: LessonImpactSample,
  now = new Date(),
): void {
  if (state.lessonImpact?.v !== LESSON_IMPACT_VERSION) {
    state.lessonImpact = (state.lessonImpact && normalizeLessonImpact(state.lessonImpact)) || emptyLessonImpact();
  }
  const impact = state.lessonImpact;
  if (!impact.since) impact.since = now.toLocaleDateString("en-CA", { timeZone: TZ });
  if (!(sample.rounds > 0)) {
    impact.untreated = (impact.untreated ?? 0) + 1;
    return;
  }
  const c: LessonImpactCohort = sample.lessons > 0 ? impact.with : impact.without;
  c.runs = (c.runs ?? 0) + 1;
  if (sample.ok) c.merges++;
  c.roundsTotal += Math.max(0, Math.round(sample.rounds));
  c.tokensTotal += Math.max(0, Math.round(sample.tokens));
}
