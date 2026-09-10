// P3-397: lazy model-readiness revalidation planner. Pure module — no file
// system, no network, no timer imports on purpose, because index.ts runs
// main() on import and unit tests must never boot a daemon (same hygiene as
// modelready.ts / readiness.ts).
//
// Why this exists: the model verdict (modelready.ts) is fed ONLY by fetches
// that already happen — the context ruler's on-miss refresh and the /provider
// passthrough. In a session where nobody opens the model selector (and no
// context-gauge miss fires) the verdict freezes at no-provider/unknown even
// after a credential is configured, and every re-check in the app keeps
// reading a stale truth. The fix mirrors the P2-250 lazy design: index.ts
// re-observes the ALREADY-EXISTING opencode /provider catalog at the point of
// use (right before the model status route answers), at most once per
// interval, guided by this module. No new route, no new port, no new
// listener, no periodic timer.
//
// Decision rules — modelRevalidatePlan evaluates them in THIS order and the
// order is part of the contract:
//   1. a verdict that already says ready is never re-observed — the happy
//      path (every status read on a working machine) must cost zero;
//   2. invalid input is fail-closed: a missing (undefined) verdict, a
//      negative or non-finite instant and a negative, zero or non-finite
//      interval all reuse the cache — a broken clock reading or a broken
//      knob never causes an observation, and a zero budget can never
//      degenerate into a per-request fetch storm;
//   3. an observation strictly newer than the interval is reused;
//   4. everything left is stale and becomes an observation.
// A future observedAt (clock moved back) is treated as now: age clamps to
// zero, never negative. observedAt 0 (epoch = never observed) is VALID and
// always stale — the very first route call observes, which is exactly the
// frozen-verdict session this module exists to unfreeze.
//
// Knob rationale (mirrors readiness.ts, P2-250):
//   - default interval 60 000 ms: configuring a credential takes minutes, so
//     a one-minute window is imperceptible next to the step the user just
//     performed, while the cost (one /provider read to the local opencode
//     server) is negligible at that cadence;
//   - ceiling 3 600 000 ms (one hour): beyond it "revalidation" stops
//     meaning anything to a lay user, so larger values fail closed;
//   - OCR_MODEL_READINESS_DISABLE=off|0|false (any case) turns revalidation
//     off entirely — the documented kill switch; on|1|true (any case) is the
//     documented enable value; anything else is a problem (fail-closed,
//     never a silent enable/disable);
//   - blank or missing values keep the documented default with no problem —
//     the ONLY case that does.

/** Default minimum interval between two model-catalog observations. */
export const MODEL_READINESS_DEFAULT_INTERVAL_MS = 60_000;

/** Documented operator override ceiling (fail-closed beyond it): one hour. */
export const MODEL_READINESS_INTERVAL_CEILING_MS = 3_600_000;

/** Env var that sets the minimum re-observation interval, in whole ms. */
export const MODEL_READINESS_INTERVAL_ENV = "OCR_MODEL_READINESS_MIN_MS";

/** Env var that turns model-readiness revalidation off entirely. */
export const MODEL_READINESS_DISABLE_ENV = "OCR_MODEL_READINESS_DISABLE";

export type ModelRevalidateAction = "observe" | "cache";

export type ModelRevalidateReason = "verdict-ready" | "invalid-input" | "fresh" | "stale";

export interface ModelRevalidatePlan {
  action: ModelRevalidateAction;
  reason: ModelRevalidateReason;
}

/**
 * Decide whether the cached model verdict should be re-observed. `currentReady`
 * maps the cached verdict to the single question that matters — does the
 * machine currently advertise a usable model (true) or not (false).
 * `observedAt` is the instant the cached verdict was established (0 = never),
 * `now` the current instant, `minIntervalMs` the minimum interval between two
 * observations. See the module header for the rule order.
 */
export function modelRevalidatePlan(
  currentReady: boolean,
  observedAt: number,
  now: number,
  minIntervalMs: number,
): ModelRevalidatePlan {
  // rule 1 — a working machine is never re-observed (happy path costs zero)
  if (currentReady === true) return { action: "cache", reason: "verdict-ready" };
  // rule 2 — missing/negative/non-finite input is fail-closed: never observe
  if (
    typeof currentReady !== "boolean" ||
    !Number.isFinite(observedAt) ||
    !Number.isFinite(now) ||
    !Number.isFinite(minIntervalMs) ||
    observedAt < 0 ||
    now < 0 ||
    minIntervalMs <= 0
  ) {
    return { action: "cache", reason: "invalid-input" };
  }
  // a future observedAt is treated as now: age clamps to zero, never negative
  const age = Math.max(0, now - observedAt);
  // rule 3 — strictly newer than the interval is reused (exactly at the
  // interval is not newer anymore)
  if (age < minIntervalMs) return { action: "cache", reason: "fresh" };
  // rule 4 — what remains is stale
  return { action: "observe", reason: "stale" };
}

export interface ModelReadinessKnobs {
  /** Minimum age a cached verdict must reach before an observation is planned. */
  minIntervalMs: number;
  /** True when OCR_MODEL_READINESS_DISABLE holds a documented off value. */
  disabled: boolean;
  /** Non-empty means the boot must fail closed (exit 1, no listener). */
  problems: string[];
}

/**
 * One integer env var resolved fail-closed (same contract as readiness.ts):
 * missing or blank keeps the documented default with no problem — the ONLY
 * case that does. Non-numeric, zero, negative, fractional and above-ceiling
 * values all push a problem into `problems` and fall back to the default.
 */
function positiveInt(
  env: Record<string, string | undefined>,
  name: string,
  ceiling: number,
  problems: string[],
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return MODEL_READINESS_DEFAULT_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    problems.push(
      `${name}=${JSON.stringify(raw)} is not a number: refusing to start the daemon (fail-closed)`,
    );
    return MODEL_READINESS_DEFAULT_INTERVAL_MS;
  }
  if (parsed <= 0) {
    problems.push(
      `${name}=${JSON.stringify(raw)} must be a positive number of milliseconds: refusing to start the daemon (fail-closed)`,
    );
    return MODEL_READINESS_DEFAULT_INTERVAL_MS;
  }
  if (!Number.isInteger(parsed)) {
    problems.push(
      `${name}=${JSON.stringify(raw)} must be a whole number of milliseconds: refusing to start the daemon (fail-closed)`,
    );
    return MODEL_READINESS_DEFAULT_INTERVAL_MS;
  }
  if (parsed > ceiling) {
    problems.push(
      `${name}=${JSON.stringify(raw)} is above the documented ceiling of ${ceiling} milliseconds: refusing to start the daemon (fail-closed)`,
    );
    return MODEL_READINESS_DEFAULT_INTERVAL_MS;
  }
  return parsed;
}

/**
 * Resolve the OCR_MODEL_READINESS_* environment into the re-observation
 * knobs. An empty environment reproduces the documented defaults. Every
 * variable is parsed independently and ALL problems are returned at once (no
 * short-circuit); with any problem present the caller must fail the boot
 * closed instead of running with knobs the operator never asked for.
 * OCR_MODEL_READINESS_DISABLE=off|0|false disables revalidation entirely;
 * on|1|true (any case) is the documented enable value and anything else is a
 * problem instead of a silent enable.
 */
export function parseModelReadinessKnobs(env: Record<string, string | undefined>): ModelReadinessKnobs {
  const problems: string[] = [];
  const minIntervalMs = positiveInt(env, MODEL_READINESS_INTERVAL_ENV, MODEL_READINESS_INTERVAL_CEILING_MS, problems);
  const rawDisable = env[MODEL_READINESS_DISABLE_ENV];
  let disabled = false;
  if (rawDisable !== undefined && rawDisable.trim() !== "") {
    const v = rawDisable.trim().toLowerCase();
    if (v === "off" || v === "0" || v === "false") disabled = true;
    else if (v === "on" || v === "1" || v === "true") disabled = false;
    else {
      disabled = false;
      problems.push(
        `${MODEL_READINESS_DISABLE_ENV}=${JSON.stringify(rawDisable)} is not a documented value (off|0|false to disable, on|1|true to enable): refusing to start the daemon (fail-closed)`,
      );
    }
  }
  return { minIntervalMs, disabled, problems };
}
