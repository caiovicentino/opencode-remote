// P3-397: lazy model-catalog revalidation plan. Pure module — no node:fs, no
// network, no timer, no I/O of any kind, because index.ts runs main() on
// import and unit tests must never boot a daemon (same hygiene as
// modelready.ts / readiness.ts, lessons P2-149 and P2-228).
//
// Why this exists: the model-readiness verdict (modelready.ts) is fed ONLY by
// fetches that already happen — the context ruler's on-miss refresh and the
// /provider passthrough. In a session where nobody opens the catalog the
// verdict freezes at no-provider/unknown even after a credential is
// configured, and every re-check keeps reading a stale truth. The fix is the
// same lazy design P2-250 gave the machine capabilities: the status route
// re-observes the catalog at the point of use, at most once per interval,
// guided by this module. No new route, no new port, no new listener and no
// periodic timer.
//
// Decision rules — modelRevalidatePlan evaluates them in THIS order and the
// order is part of the contract:
//   1. a verdict that already says ready is never re-observed — the happy
//      path (every status poll of a working machine) costs zero;
//   2. missing, negative or non-finite input is fail-closed: the cached
//      verdict is reused, because acting on a reading the plan cannot trust
//      (a broken clock, a zero ceiling) must never turn into a fetch storm;
//   3. an observation strictly younger than the minimum interval is reused —
//      at most one observation per interval is the whole budget (exactly at
//      the interval is not younger anymore);
//   4. everything left is stale and becomes an observation.
// A lastObservedAt in the future is treated as now (age clamped to zero,
// never negative).
//
// Knob rationale (same choices as the P2-250 knobs in readiness.ts):
//   - default interval 60 000 ms and documented ceiling 3 600 000 ms (one
//     hour); invalid values are problems, never silently swallowed;
//   - OCR_MODEL_READINESS_DISABLE=off|0|false turns the revalidation off
//     entirely; on|1|true (any case) is the documented enable value and
//     anything else is a problem (fail-closed, never a silent enable);
//   - blank or missing values keep the documented default with no problem —
//     the ONLY case that does.

/** Default minimum interval between two catalog observations. */
export const MODEL_READINESS_DEFAULT_INTERVAL_MS = 60_000;

/** Documented operator override ceiling (fail-closed beyond it): one hour. */
export const MODEL_READINESS_INTERVAL_CEILING_MS = 3_600_000;

/** Env var that sets the minimum re-observation interval, in whole ms. */
export const MODEL_READINESS_INTERVAL_ENV = "OCR_MODEL_READINESS_MIN_MS";

/** Env var that turns the model-catalog revalidation off entirely. */
export const MODEL_READINESS_DISABLE_ENV = "OCR_MODEL_READINESS_DISABLE";

export type ModelRevalidateAction = "observe" | "reuse";

export type ModelRevalidateReason =
  | "verdict-ready"
  | "invalid-input"
  | "within-ceiling"
  | "ceiling-elapsed";

export interface ModelRevalidatePlan {
  action: ModelRevalidateAction;
  reason: ModelRevalidateReason;
}

/**
 * Decide whether the cached model-readiness verdict should be re-observed.
 * `currentState` is the current verdict state (a `ModelReadyState` string);
 * `lastObservedAt` the instant the cached verdict was established, `now` the
 * current instant, `minIntervalMs` the minimum interval between observations.
 * See the module header for the rule order.
 */
export function modelRevalidatePlan(
  currentState: unknown,
  lastObservedAt: number,
  now: number,
  minIntervalMs: number,
): ModelRevalidatePlan {
  // rule 1 — a working verdict never re-observes (happy path costs zero)
  if (currentState === "ready") return { action: "reuse", reason: "verdict-ready" };
  // guard — fail-closed on missing, negative or non-finite input
  if (
    typeof currentState !== "string" ||
    currentState === "" ||
    !Number.isFinite(lastObservedAt) ||
    !Number.isFinite(now) ||
    !Number.isFinite(minIntervalMs) ||
    lastObservedAt < 0 ||
    now < 0 ||
    minIntervalMs <= 0
  ) {
    return { action: "reuse", reason: "invalid-input" };
  }
  // a future instant is treated as now: age clamps to zero, never negative
  const age = Math.max(0, now - lastObservedAt);
  // rule 3 — strictly younger than the interval is reused (exactly at the
  // interval is not younger anymore)
  if (age < minIntervalMs) return { action: "reuse", reason: "within-ceiling" };
  // rule 4 — what remains is stale
  return { action: "observe", reason: "ceiling-elapsed" };
}

export interface ModelReadinessKnobs {
  /** Minimum age a cached verdict must reach before an observation is due. */
  minIntervalMs: number;
  /** True when OCR_MODEL_READINESS_DISABLE holds a documented off value. */
  disabled: boolean;
  /** Non-empty means the boot must fail closed (exit 1, no listener). */
  problems: string[];
}

/**
 * One integer env var resolved fail-closed: missing or blank keeps the
 * documented default with no problem — the ONLY case that does. Non-numeric,
 * zero, negative, fractional and above-ceiling values all push a problem
 * into `problems` and fall back to the default.
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
 * variable is parsed independently and ALL problems are returned at once
 * (no short-circuit); with any problem present the caller must fail the boot
 * closed instead of running with knobs the operator never asked for.
 * OCR_MODEL_READINESS_DISABLE=off|0|false disables the revalidation entirely;
 * on|1|true (any case) is the documented enable value and anything else is
 * a problem instead of a silent enable.
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
