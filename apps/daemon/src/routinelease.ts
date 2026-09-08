/**
 * Routine run lease (P2-236): automatic release of a stuck routine run.
 *
 * A fired routine keeps its in-flight marker (Routine.lastSessionID) until a
 * session event drives completeRoutine() or failRoutine(). Those events only
 * exist while the opencode session is reachable — a daemon restarted mid-run,
 * an opencode that closed, a lost session or an event that simply never
 * arrives leave the marker written to routines.json forever. Because the
 * periodic sweep skips routines with a live marker, the user's daily routine
 * then silently stops running for good: no log line, no notification, nothing
 * on screen — the opposite of the docs/VISION.md stage-3 promise of a
 * reliable routine for people who never opened a terminal.
 *
 * Pure decision module — imports nothing (no node:fs, node:child_process,
 * node:path/os, node:http or fetch) so the wiring in index.ts stays thin and
 * unit tests never boot a daemon (same pattern as pairwindow.ts /
 * identityfile.ts).
 *
 * Documented numbers and why they exist:
 *
 * - DEFAULT_RUN_LEASE_MS = 2 h. A routine run is one prompt → answer
 *   session; even a pathological one (huge context, model retries) finishes
 *   far inside two hours, while a daily routine gets its life back the same
 *   day instead of silently missing whole days.
 * - RUN_LEASE_CEILING_MS = 24 h. A lease longer than a day can never release
 *   a daily routine before its next scheduled fire, so anything above 24 h
 *   only delays the recovery the lease exists for.
 * - The documented off switch is the OCR_RUN_LEASE_MS="off" keyword
 *   (RUN_LEASE_OFF_MS = 0). The bare numeric 0 is NOT accepted as off: a zero
 *   is far more likely a typo or a pasted placeholder than a decision to
 *   disable the safety net, so it fails closed like every other invalid
 *   value.
 */

/** Default in-flight run lease: 2 hours from the observed run start. */
export const DEFAULT_RUN_LEASE_MS = 2 * 60 * 60_000;

/** Documented maximum anyone may set OCR_RUN_LEASE_MS to: 24 hours. */
export const RUN_LEASE_CEILING_MS = 24 * 60 * 60_000;

/** Sentinel for the documented "off" keyword: a lease of 0 ms disables the release. */
export const RUN_LEASE_OFF_MS = 0;

/** Environment variable carrying the lease, kept next to the other OCR_* knobs. */
export const RUN_LEASE_ENV = "OCR_RUN_LEASE_MS";

export interface RunLease {
  /** Resolved lease in milliseconds (0 = off). Only meaningful when problems is empty. */
  leaseMs: number;
  /** Non-empty means the boot must fail closed (exit 1, no listener). */
  problems: string[];
}

/**
 * Resolve OCR_RUN_LEASE_MS. Missing or blank keeps the default with no
 * problem; the documented "off" keyword disables the lease. Anything else
 * must be a whole, positive number of milliseconds at or below the ceiling —
 * and unlike a soft fallback, every violation is reported: a single value can
 * accumulate several problems (no short-circuit) so the boot log explains the
 * whole picture at once. Any problem means the daemon must not start.
 */
export function parseRunLease(env: Record<string, string | undefined>): RunLease {
  const raw = env[RUN_LEASE_ENV];
  if (raw === undefined || raw.trim() === "") {
    return { leaseMs: DEFAULT_RUN_LEASE_MS, problems: [] };
  }
  if (raw.trim().toLowerCase() === "off") {
    return { leaseMs: RUN_LEASE_OFF_MS, problems: [] };
  }
  const problems: string[] = [];
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    problems.push(
      `${RUN_LEASE_ENV}=${JSON.stringify(raw)} is not a number: ` +
        "refusing to start the daemon (fail-closed)",
    );
  } else {
    if (parsed < 0) {
      problems.push(
        `${RUN_LEASE_ENV}=${JSON.stringify(raw)} must be a positive number of milliseconds: ` +
          "a negative lease is meaningless (fail-closed)",
      );
    }
    if (parsed === 0) {
      problems.push(
        `${RUN_LEASE_ENV}="0" is not accepted: use the documented off keyword to disable the lease ` +
          "(fail-closed)",
      );
    }
    if (!Number.isInteger(parsed)) {
      problems.push(
        `${RUN_LEASE_ENV}=${JSON.stringify(raw)} must be a whole number of milliseconds: ` +
          "a fractional lease cannot be applied (fail-closed)",
      );
    }
    if (parsed > RUN_LEASE_CEILING_MS) {
      problems.push(
        `${RUN_LEASE_ENV}=${JSON.stringify(raw)} is above the documented ceiling of ` +
          `${RUN_LEASE_CEILING_MS} ms: a lease longer than a day can never free a daily routine (fail-closed)`,
      );
    }
  }
  return { leaseMs: problems.length === 0 ? parsed : DEFAULT_RUN_LEASE_MS, problems };
}

/** What the sweep needs from a routine, reduced to what the lease decides on. */
export interface RoutineRunFacts {
  id: string;
  /** A run is in flight (in-flight marker present). */
  inFlight: boolean;
  /** Epoch ms the current in-flight run was first observed; unknown until stamped. */
  startedAt?: number;
}

export type LeasePlan = "none" | "stamp" | "kill";

export interface LeaseVerdict {
  id: string;
  plan: LeasePlan;
}

/**
 * Decide, for every routine exactly one plan, preserving the iteration order
 * and never returning an id outside the received list:
 *
 * - a disabled lease (leaseMs <= 0) never kills anything — everything is
 *   "none", even an ancient in-flight run;
 * - a routine not in flight never enters (a stale start stamp from a
 *   finished run is ignored);
 * - a run in flight with NO known start instant is NEVER killed: it is
 *   stamped with the current instant so the lease starts counting from the
 *   first observation — a legitimate run that began before this version
 *   existed can never be killed unjustly, same prudence liveness.ts applies
 *   to an undefined last-contact stamp;
 * - only a run in flight whose known start is strictly older than the lease
 *   (now - startedAt > leaseMs, so exactly at the threshold survives) is
 *   killed.
 *
 * Pure: `nowMs` is injected, never read from the clock.
 */
export function leaseVerdict(
  nowMs: number,
  leaseMs: number,
  routines: readonly RoutineRunFacts[],
): LeaseVerdict[] {
  if (leaseMs <= 0) {
    return routines.map((r) => ({ id: r.id, plan: "none" as const }));
  }
  return routines.map((r) => {
    if (!r.inFlight) return { id: r.id, plan: "none" as const };
    if (r.startedAt === undefined) return { id: r.id, plan: "stamp" as const };
    if (nowMs - r.startedAt > leaseMs) return { id: r.id, plan: "kill" as const };
    return { id: r.id, plan: "none" as const };
  });
}

/**
 * The kill phrase: short, actionable, pt-BR, always static — no absolute file
 * path, no URL scheme, no session identifier, no secrets — because the same
 * sentence goes to the log, to the routine's lastError field and to the
 * notification.
 */
export const RUN_LEASE_KILL_MESSAGE =
  "Uma execução anterior desta rotina ficou presa e foi liberada agora; a rotina volta a rodar no próximo horário programado.";
