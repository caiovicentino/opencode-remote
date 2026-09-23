// P2-347: uploads-volume revalidation plan + upload gate. Pure module — no
// node:fs, node:child_process, node:http, ws or fetch imports on purpose,
// because index.ts runs main() on import and unit tests must never boot a
// daemon (same pattern as readiness.ts / diskguard.ts). All I/O — the real
// statfs reading of the uploads directory, the mkdir that keeps it defined on
// a fresh install, the log lines — stays in index.ts; this module only
// decides WHEN a cached reading may be re-read and WHETHER an upload may
// start.
//
// Why this exists: the uploads root is the heaviest thing the daemon writes
// (attachment files, exported conversations, rendered clips under clips/ and
// session artifacts under artifacts/ sit on the same volume), and the P2-215
// verdict was read once at boot and then only on the retention janitor's
// interval. Between two readings the volume can fill, the write fails
// mid-file with a raw filesystem error and the phone receives only a generic
// failure — exactly the late, mute failure shape P2-210 closed for provider
// credentials. The cure mirrors P2-250: the upload routes re-read the volume
// lazily, at most once per the same minimum interval every other readiness
// uses (OCR_READINESS_MIN_MS, ceiling one hour, the documented
// OCR_READINESS_DISABLE kill switch), with no new periodic timer.
//
// RULE ORDER CONTRACT — diskProbePlan evaluates in THIS order and the order
// is part of the contract:
//   1. the documented kill switch freezes the last reading — with
//      OCR_READINESS_DISABLE=off the boot reading is the only one and every
//      lazy re-read is skipped (the operator opted out deliberately);
//   2. a non-finite instant is REFUSED instead of guessed about — a broken
//      clock reading reuses the cached verdict and never probes;
//   3. an instant in the future is treated as now (age clamps to zero, never
//      negative);
//   4. a reading younger than the minimum interval is reused — one re-read
//      per window is the whole budget;
//   5. everything else is stale and becomes a re-read.
// Unlike readiness.ts there is NO "ready verdict is never re-probed" rule and
// no in-flight dedupe: free space only ever shrinks, so a healthy reading is
// exactly the one that must go stale (that asymmetry is the whole reason this
// probe exists), and the re-read is a single synchronous statfs call — two
// routes cannot stampede it.
//
// The upload gate is the second half: with a critical verdict the upload is
// refused before any byte is written, with the SAME phrase /api/health
// serves — one sentence, no path, no URL, no raw byte count. ok, low and
// unknown keep today's behavior byte for byte (P2-215's fail-open posture:
// only a verified critical refuses), and a malformed verdict object degrades
// to null — a refusal is never invented from junk.
//
// The closed set itself (ok / low / critical / unknown) and its thresholds
// live in diskguard.ts (P2-215) — the same verdict object /api/health and the
// settings mirror serve. There is exactly ONE classifier in this app on
// purpose: duplicating thresholds inside the same app would be a bug farm.
// The spec's "receives injected free and total bytes, returns the closed set"
// is satisfied by diskStateFromReading below, which DELEGATES to that one
// classifier — index.ts reads the volume only through this module, so the
// reading sites, the revalidation throttle and the upload gate share one
// surface while the thresholds stay pinned where P2-215 shipped them.

import { diskVerdict, type DiskVerdict } from "./diskguard.js";

/**
 * The reading surface: injected free and total bytes (null = the reading
 * failed) come back as the closed-set verdict. A pure delegation to
 * diskguard.ts's diskVerdict — the one classifier, with its documented
 * thresholds (warning below 2 GB free or 10% of the volume, critical below
 * 500 MB or 5%) and its unknown landing for missing, zero-total, negative or
 * non-finite readings.
 */
export function diskStateFromReading(freeBytes: number | null, totalBytes: number | null): DiskVerdict {
  return diskVerdict(freeBytes, totalBytes);
}

export type DiskProbeAction = "redo" | "reuse";

export type DiskProbeReason = "kill-switch" | "invalid-instant" | "fresh" | "stale";

export interface DiskProbePlan {
  action: DiskProbeAction;
  reason: DiskProbeReason;
}

export interface DiskProbeLimits {
  /** Minimum age a cached reading must reach before a re-read is planned. */
  minIntervalMs: number;
  /** True when OCR_READINESS_DISABLE holds a documented off value. */
  disabled: boolean;
}

/**
 * Decide whether the cached uploads-volume reading should be re-read at the
 * upload routes' point of use. `probedAt` is the instant the cached reading
 * was established (0 = never probed), `now` the current instant, `limits`
 * carries the shared readiness knobs. See the module header for the rule
 * order — a fresh reading is reused, a stale one is re-read even when it
 * said ok, and the kill switch plus broken clocks always reuse.
 */
export function diskProbePlan(probedAt: number, now: number, limits: DiskProbeLimits): DiskProbePlan {
  // rule 1 — the documented kill switch freezes the boot reading
  if (limits.disabled) return { action: "reuse", reason: "kill-switch" };
  // rule 2 — a non-finite instant is refused, never guessed about
  if (!Number.isFinite(probedAt) || !Number.isFinite(now) || !Number.isFinite(limits.minIntervalMs)) {
    return { action: "reuse", reason: "invalid-instant" };
  }
  // rule 3 — a future instant is treated as now: age clamps to zero
  const age = Math.max(0, now - probedAt);
  // rule 4 — strictly newer than the interval is reused (exactly at the
  // interval is not newer anymore)
  if (age < limits.minIntervalMs) return { action: "reuse", reason: "fresh" };
  // rule 5 — what remains is stale, healthy or not
  return { action: "redo", reason: "stale" };
}

export interface UploadDiskRefusal {
  /** 507 Insufficient Storage — the honest verdict for a full volume. */
  status: number;
  /** The verdict's own phrase, verbatim — the same one /api/health serves. */
  error: string;
}

/**
 * The upload gate: an upload may start only when the disk verdict is not
 * critical. A critical verdict refuses with the verdict's own phrase (no
 * path, no byte count — the phrase contract is diskguard.ts's) and HTTP 507;
 * ok, low and unknown return null and the caller keeps today's behavior. A
 * missing or malformed verdict degrades to null too — a refusal is never
 * invented from junk (fail-open, the P2-215 posture).
 */
export function uploadDiskGate(verdict: { state: string; message: string } | null | undefined): UploadDiskRefusal | null {
  if (!verdict || typeof verdict !== "object" || verdict.state !== "critical") return null;
  const error = typeof verdict.message === "string" ? verdict.message : "";
  if (!error) return null;
  return { status: 507, error };
}
