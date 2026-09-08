// P2-250: lazy capability re-probing plan. Pure module — no node:fs,
// node:path, node:child_process or fetch imports on purpose, because index.ts
// runs main() on import and unit tests must never boot a daemon (same
// pattern as doccap.ts / modelready.ts, lessons P2-149 and P2-228). All I/O
// (running the real whisper/edge probes, existsSync over install locations,
// spawning `opencode --version`) stays in the caller; this module only
// decides WHEN a cached capability verdict may be re-probed and WHAT the
// operator configured via the environment.
//
// Why this exists: every machine capability (voice transcription, spoken
// replies, document→PDF conversion, opencode version) was probed EXACTLY
// ONCE at daemon boot and cached in module state that nothing ever
// refreshed. A lay user (docs/VISION.md stage 3) who installs LibreOffice,
// installs whisper or updates opencode AFTER the first boot keeps receiving
// the same polite "this machine can't do that" refusal forever — the only
// cure was restarting the daemon, which nobody knows they must do. The fix
// is lazy: index.ts re-probes a capability at its point of use, at most
// once per interval, guided by this module.
//
// Decision rules — readinessRefreshPlan evaluates them in THIS order and the
// order is part of the contract:
//   1. a cached verdict that says the capability WORKS is never re-probed —
//      a capability that already functions needs no new probe and the happy
//      path (every health check, every successful conversation) must cost
//      zero; only a verdict that refuses something can ever flip;
//   2. a probe already in flight is never duplicated — concurrent requests
//      during one probe all reuse instead of stampeding the machine;
//   3. a verdict newer than the minimum interval is reused — one re-probe
//      per capability per interval is the whole budget;
//   4. everything left is stale and becomes a re-probe.
// Guards folded into the rules: a non-finite instant is REFUSED instead of
// guessed about (the plan neither probes nor crashes on a broken clock
// reading — it reuses the cached verdict); an instant in the future is
// treated as now (age clamped to zero, never negative).
//
// Knob rationale (each choice):
//   - default interval 60 000 ms: installing a tool takes minutes, so a
//     one-minute window is imperceptible next to the install step the user
//     just performed, while the probe cost (a handful of existsSync calls,
//     at most one version spawn) is negligible at that cadence;
//   - ceiling 3 600 000 ms (one hour): beyond it "revalidation" stops
//     meaning anything to a lay user, so larger values fail closed;
//   - OCR_READINESS_DISABLE=off|0|false (any case) turns revalidation off
//     entirely — the documented kill switch; on|1|true (any case) is the
//     documented enable value; anything else is a problem (fail-closed,
//     never a silent enable/disable);
//   - blank or missing values keep the documented default with no problem —
//     the ONLY case that does.

/** Default minimum interval between two probes of the same capability. */
export const READINESS_DEFAULT_INTERVAL_MS = 60_000;

/** Documented operator override ceiling (fail-closed beyond it): one hour. */
export const READINESS_INTERVAL_CEILING_MS = 3_600_000;

/** Env var that sets the minimum re-probe interval, in whole milliseconds. */
export const READINESS_INTERVAL_ENV = "OCR_READINESS_MIN_MS";

/** Env var that turns capability revalidation off entirely. */
export const READINESS_DISABLE_ENV = "OCR_READINESS_DISABLE";

export interface ReadinessLimits {
  /** Minimum age a cached verdict must reach before a re-probe is planned. */
  minIntervalMs: number;
}

export type ReadinessAction = "redo" | "reuse";

export type ReadinessReason =
  | "verdict-ready"
  | "probe-in-flight"
  | "invalid-instant"
  | "fresh"
  | "stale";

export interface ReadinessPlan {
  action: ReadinessAction;
  reason: ReadinessReason;
}

export interface ReadinessKnobs {
  minIntervalMs: number;
  /** True when OCR_READINESS_DISABLE holds a documented off value. */
  disabled: boolean;
  /** Non-empty means the boot must fail closed (exit 1, no listener). */
  problems: string[];
}

/**
 * Decide whether a cached capability verdict should be re-probed.
 * `cachedReady` is the caller's mapping of the cached verdict state to the
 * single question that matters — does the capability currently work (true)
 * or does the cached verdict refuse something (false). `probedAt` is the
 * instant the cached verdict was established, `now` the current instant,
 * `inFlight` says a probe is already running, `limits` carries the minimum
 * interval. See the module header for the rule order.
 */
export function readinessRefreshPlan(
  cachedReady: boolean,
  probedAt: number,
  now: number,
  inFlight: boolean,
  limits: ReadinessLimits,
): ReadinessPlan {
  // rule 1 — a working capability is never re-probed (happy path costs zero)
  if (cachedReady) return { action: "reuse", reason: "verdict-ready" };
  // rule 2 — never duplicate a probe that is already running
  if (inFlight) return { action: "reuse", reason: "probe-in-flight" };
  // guard — a non-finite instant is refused, never guessed about
  if (!Number.isFinite(probedAt) || !Number.isFinite(now) || !Number.isFinite(limits.minIntervalMs)) {
    return { action: "reuse", reason: "invalid-instant" };
  }
  // a future instant is treated as now: age clamps to zero, never negative
  const age = Math.max(0, now - probedAt);
  // rule 3 — strictly newer than the interval is reused (exactly at the
  // interval is not newer anymore)
  if (age < limits.minIntervalMs) return { action: "reuse", reason: "fresh" };
  // rule 4 — what remains is stale
  return { action: "redo", reason: "stale" };
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
  what: string,
  problems: string[],
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return READINESS_DEFAULT_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    problems.push(
      `${name}=${JSON.stringify(raw)} is not a number: refusing to start the daemon (fail-closed)`,
    );
    return READINESS_DEFAULT_INTERVAL_MS;
  }
  if (parsed <= 0) {
    problems.push(
      `${name}=${JSON.stringify(raw)} must be a positive number of ${what}: refusing to start the daemon (fail-closed)`,
    );
    return READINESS_DEFAULT_INTERVAL_MS;
  }
  if (!Number.isInteger(parsed)) {
    problems.push(
      `${name}=${JSON.stringify(raw)} must be a whole number of ${what}: refusing to start the daemon (fail-closed)`,
    );
    return READINESS_DEFAULT_INTERVAL_MS;
  }
  if (parsed > ceiling) {
    problems.push(
      `${name}=${JSON.stringify(raw)} is above the documented ceiling of ${ceiling} ${what}: refusing to start the daemon (fail-closed)`,
    );
    return READINESS_DEFAULT_INTERVAL_MS;
  }
  return parsed;
}

/**
 * Resolve the OCR_READINESS_* environment into the re-probe knobs. An empty
 * environment reproduces the documented defaults. Every variable is parsed
 * independently and ALL problems are returned at once (no short-circuit);
 * with any problem present the caller must fail the boot closed instead of
 * running with knobs the operator never asked for.
 * OCR_READINESS_DISABLE=off|0|false disables revalidation entirely;
 * on|1|true (any case) is the documented enable value and anything else is
 * a problem instead of a silent enable.
 */
export function parseReadinessKnobs(env: Record<string, string | undefined>): ReadinessKnobs {
  const problems: string[] = [];
  const minIntervalMs = positiveInt(env, READINESS_INTERVAL_ENV, READINESS_INTERVAL_CEILING_MS, "milliseconds", problems);
  const rawDisable = env[READINESS_DISABLE_ENV];
  let disabled = false;
  if (rawDisable !== undefined && rawDisable.trim() !== "") {
    const v = rawDisable.trim().toLowerCase();
    if (v === "off" || v === "0" || v === "false") disabled = true;
    else if (v === "on" || v === "1" || v === "true") disabled = false;
    else {
      disabled = false;
      problems.push(
        `${READINESS_DISABLE_ENV}=${JSON.stringify(rawDisable)} is not a documented value (off|0|false to disable, on|1|true to enable): refusing to start the daemon (fail-closed)`,
      );
    }
  }
  return { minIntervalMs, disabled, problems };
}
