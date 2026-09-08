// P2-228: uploads retention janitor — pure planning module. No node:fs,
// node:path, node:child_process or fetch imports on purpose, because index.ts
// runs main() on import and unit tests must never boot a daemon (same pattern
// as artifactretention.ts / diskguard.ts). All I/O (scanning, deleting) lives
// in the caller; this module only decides WHAT would be deleted.
//
// Why: ~/.opencode-remote/uploads/ is where videos and documents sent from
// the phone land and where files generated for download are written — the
// state dir that grows the most bytes per item on the lay user's machine
// (docs/VISION.md stage 3) and, until now, the only one with no ceiling: the
// P2-207 janitor bounds only the artifacts root and P2-215 merely ANNOUNCES
// a full disk, after which every daemon write becomes a raw error
// mid-conversation. This module bounds the uploads root the same way.
//
// SCAN PROHIBITION (binding for the caller in index.ts): the sweep must read
// ONLY the uploads root — flat regular files, ignoring subdirectories,
// hidden (dot-leading) files and anything that is not a regular file, with
// symlinks never followed — and must NEVER touch the artifacts root, the
// clips folder, the chunkstore.ts chunk-staging area, the state file, the
// audit log or any directory outside the uploads root. This module never
// sees a filesystem, so the prohibition is enforced by the caller and pinned
// by the real-source assertions in scripts/unit.test.ts.
//
// Threshold rationale (each choice):
//   - grace 24 h: an upload still arriving in pieces and a download the
//     owner just requested are recent by definition; a day of grace covers
//     that tail without keeping media around for days.
//   - max age 30 days: mirrors the artifacts janitor (P2-207) — a month is
//     plenty of time to re-send a file from the phone or re-generate one.
//   - byte cap 2 GB: videos are the largest items that flow through uploads
//     and routinely reach hundreds of MB; 2 GB holds several large videos
//     plus the small document tail.
//   - min files 5: a single conversation can reference several files at once
//     (attachments plus generated documents), so the five newest files
//     survive even when every other ceiling is blown — one giant video
//     survives for being one of the newest.

/** Files modified inside this many hours are never deleted (grace period). */
export const UPLOAD_RETENTION_GRACE_HOURS = 24;

/** Files older than this many days are deletable (age ceiling). */
export const UPLOAD_RETENTION_MAX_AGE_DAYS = 30;

/** Total bytes across the uploads root above which the oldest files go. */
export const UPLOAD_RETENTION_MAX_TOTAL_BYTES = 2_000_000_000; // 2 GB

/** The N most recently modified files are never deleted, period. */
export const UPLOAD_RETENTION_MIN_FILES = 5;

/** Set this env var to off/0/false to disable the uploads janitor entirely. */
export const UPLOAD_RETENTION_DISABLE_ENV = "OCR_UPLOAD_RETENTION";

/** Documented operator override ceilings (fail-closed beyond them). */
export const UPLOAD_RETENTION_GRACE_HOURS_CEILING = 720; // one month
export const UPLOAD_RETENTION_MAX_AGE_DAYS_CEILING = 3650; // ten years
export const UPLOAD_RETENTION_MAX_BYTES_CEILING = 10_000_000_000; // 10 GB
export const UPLOAD_RETENTION_MIN_FILES_CEILING = 1000;

export const UPLOAD_RETENTION_GRACE_MS = UPLOAD_RETENTION_GRACE_HOURS * 3_600_000;
const MAX_AGE_MS = UPLOAD_RETENTION_MAX_AGE_DAYS * 24 * 3_600_000;

export interface UploadEntry {
  /** file name (absolute path as scanned by the caller, returned verbatim) */
  path: string;
  bytes: number;
  /** last modification time in ms since the epoch */
  mtime: number;
}

export interface UploadRetentionPlan {
  /** paths the caller may delete, oldest first */
  paths: string[];
  /** total bytes those paths would free */
  bytes: number;
}

export interface UploadRetentionThresholds {
  graceMs: number;
  maxAgeMs: number;
  maxTotalBytes: number;
  minFiles: number;
}

/** The documented defaults above, as a thresholds object. */
export const UPLOAD_RETENTION_DEFAULTS: UploadRetentionThresholds = {
  graceMs: UPLOAD_RETENTION_GRACE_MS,
  maxAgeMs: MAX_AGE_MS,
  maxTotalBytes: UPLOAD_RETENTION_MAX_TOTAL_BYTES,
  minFiles: UPLOAD_RETENTION_MIN_FILES,
};

export interface UploadRetentionConfig {
  thresholds: UploadRetentionThresholds;
  disabled: boolean;
  /** Non-empty means the boot must fail closed (exit 1, no listener). */
  problems: string[];
}

/**
 * True when the operator disabled the janitor via UPLOAD_RETENTION_DISABLE_ENV.
 * Default is enabled: only off/0/false (any case) turns it off.
 */
export function uploadRetentionDisabled(env: Record<string, string | undefined>): boolean {
  const raw = env[UPLOAD_RETENTION_DISABLE_ENV];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "off" || v === "0" || v === "false";
}

/**
 * One integer env var resolved fail-closed: missing or blank keeps the
 * documented default with no problem — the ONLY case that does. Non-numeric,
 * zero, negative, fractional and above-ceiling values all push a problem into
 * `problems` (collected, never short-circuited) and fall back to the default.
 */
function positiveInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  ceiling: number,
  what: string,
  problems: string[],
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    problems.push(
      `${name}=${JSON.stringify(raw)} is not a number: refusing to start the daemon (fail-closed)`,
    );
    return fallback;
  }
  if (parsed <= 0) {
    problems.push(
      `${name}=${JSON.stringify(raw)} must be a positive number of ${what}: refusing to start the daemon (fail-closed)`,
    );
    return fallback;
  }
  if (!Number.isInteger(parsed)) {
    problems.push(
      `${name}=${JSON.stringify(raw)} must be a whole number of ${what}: refusing to start the daemon (fail-closed)`,
    );
    return fallback;
  }
  if (parsed > ceiling) {
    problems.push(
      `${name}=${JSON.stringify(raw)} is above the documented ceiling of ${ceiling} ${what}: refusing to start the daemon (fail-closed)`,
    );
    return fallback;
  }
  return parsed;
}

/**
 * Resolve the OCR_UPLOAD_RETENTION* environment into the janitor thresholds.
 * An empty environment reproduces the documented defaults. Every variable is
 * parsed independently and ALL problems are returned at once (no
 * short-circuit); with any problem present the caller must fail the boot
 * closed instead of running with thresholds the operator never asked for.
 * OCR_UPLOAD_RETENTION=off|0|false disables the janitor entirely.
 */
export function parseUploadRetention(env: Record<string, string | undefined>): UploadRetentionConfig {
  const problems: string[] = [];
  const graceHours = positiveInt(
    env,
    "OCR_UPLOAD_RETENTION_GRACE_HOURS",
    UPLOAD_RETENTION_GRACE_HOURS,
    UPLOAD_RETENTION_GRACE_HOURS_CEILING,
    "hours",
    problems,
  );
  const maxAgeDays = positiveInt(
    env,
    "OCR_UPLOAD_RETENTION_MAX_AGE_DAYS",
    UPLOAD_RETENTION_MAX_AGE_DAYS,
    UPLOAD_RETENTION_MAX_AGE_DAYS_CEILING,
    "days",
    problems,
  );
  const maxTotalBytes = positiveInt(
    env,
    "OCR_UPLOAD_RETENTION_MAX_BYTES",
    UPLOAD_RETENTION_MAX_TOTAL_BYTES,
    UPLOAD_RETENTION_MAX_BYTES_CEILING,
    "bytes",
    problems,
  );
  const minFiles = positiveInt(
    env,
    "OCR_UPLOAD_RETENTION_MIN_FILES",
    UPLOAD_RETENTION_MIN_FILES,
    UPLOAD_RETENTION_MIN_FILES_CEILING,
    "files",
    problems,
  );
  return {
    thresholds: {
      graceMs: graceHours * 3_600_000,
      maxAgeMs: maxAgeDays * 24 * 3_600_000,
      maxTotalBytes,
      minFiles,
    },
    disabled: uploadRetentionDisabled(env),
    problems,
  };
}

/**
 * Pure retention plan. Receives the scanned files (name/bytes/mtime) and the
 * current instant; returns the paths to delete plus the bytes they would
 * free. Rules, in order:
 *
 *  1. files modified inside the grace period never enter the plan — an
 *     upload still arriving in pieces and a download the owner just
 *     requested are recent by definition;
 *  2. the `minFiles` most recently modified files never enter the plan, even
 *     when every other ceiling is blown;
 *  3. the remaining files go oldest-first while they are past the age
 *     ceiling OR the surviving total of the deletable pool is past the byte
 *     ceiling — protected files are never sacrificed to make the folder fit.
 *
 * Determinism: candidates sort by mtime ascending, ties broken by
 * lexicographic path ascending, so the plan depends only on the input list,
 * never on its order. The plan never contains a path that was not received,
 * and entries with non-finite bytes or mtime are refused (never planned)
 * instead of guessed about.
 */
export function uploadRetentionPlan(
  entries: UploadEntry[],
  now: number,
  thresholds: UploadRetentionThresholds = UPLOAD_RETENTION_DEFAULTS,
): UploadRetentionPlan {
  const byPath = (a: UploadEntry, b: UploadEntry): number =>
    a.mtime - b.mtime || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const valid = entries.filter(
    (e) => Number.isFinite(e.bytes) && Number.isFinite(e.mtime),
  );
  // rule 1 — grace: a fresh upload/download is never planned
  const pastGrace = valid.filter((e) => now - e.mtime >= thresholds.graceMs);
  // rule 2 — the minFiles most recent files survive, always (ties by path)
  const protectedPaths = new Set(
    [...valid]
      .sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .slice(0, thresholds.minFiles)
      .map((e) => e.path),
  );
  const candidates = pastGrace
    .filter((e) => !protectedPaths.has(e.path))
    .sort(byPath);
  let remaining = candidates.reduce((sum, e) => sum + Math.max(0, e.bytes), 0);
  const paths: string[] = [];
  let bytes = 0;
  for (const e of candidates) {
    const size = Math.max(0, e.bytes);
    if (now - e.mtime > thresholds.maxAgeMs || remaining > thresholds.maxTotalBytes) {
      paths.push(e.path);
      bytes += size;
      remaining -= size;
    }
  }
  return { paths, bytes };
}
