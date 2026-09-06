// P2-248: clips retention janitor — pure planning module. No node:fs,
// node:path, node:child_process or fetch imports on purpose, because index.ts
// runs main() on import and unit tests must never boot a daemon (same pattern
// as uploadretention.ts / artifactretention.ts, per the P2-149/P2-228
// lessons). All I/O (scanning, deleting) lives in the caller; this module
// only decides WHAT would be deleted.
//
// Why: ~/.opencode-remote/clips/ is where tools/clip.mjs writes the heaviest
// files the product ever produces — the rendered vertical social clips plus
// the extracted transcription audio — one folder per source video (line 133
// of tools/clip.mjs) with loose work files at the root (line 45), inside a
// directory nothing ever cleaned: the uploadretention.ts scan explicitly
// never touches it, index.ts repeats the prohibition, the P2-207 janitor
// bounds only the artifacts root and P2-215 merely ANNOUNCES a full disk —
// after which every daemon write becomes a raw error mid-conversation on the
// lay user's machine (docs/VISION.md stage 3). This module bounds the clips
// root the same way.
//
// THE GROUP IS THE DECISION UNIT (not the lone file): every immediate child
// of the clips root is one group — either a source-video folder holding all
// its rendered clips or a loose work file sitting at the root. A group enters
// the plan with its TOTAL bytes and the MOST RECENT modification instant
// found inside it, so a group is never deleted by halves and a freshly
// rendered clip is never dropped for living in an old folder.
//
// SCAN PROHIBITION (binding for the caller in index.ts): the sweep must read
// ONLY the immediate children of the clips root, never follow a symbolic
// link, never walk above the root, and NEVER touch the uploads root, the
// artifacts root, the chunkstore.ts chunk-staging area, the state file, the
// audit log or any directory outside the clips root; deletion removes whole
// groups and never the root itself. This module never sees a filesystem, so
// the prohibition is enforced by the caller and pinned by the real-source
// assertions in scripts/unit.test.ts.
//
// Threshold rationale (each choice):
//   - grace 24 h: a clip the user just rendered is being watched, fetched
//     and shared right now; a day of grace covers that tail (same as the
//     uploads janitor) without keeping heavy media around for days.
//   - max age 30 days: mirrors the artifacts (P2-207) and uploads (P2-228)
//     janitors — a month is plenty of time to re-render from the source.
//   - byte cap 4 GB: a rendered 9:16 clip at crf 20 runs roughly 40–80 MB
//     per minute, so a heavy source video yields six clips ≈ 300–500 MB per
//     group and the extracted 16 kHz-mono transcription audio adds ~115 MB
//     per hour of source; 4 GB therefore holds a dozen worst-case recent
//     groups and dozens of typical ones with room to spare — several recent
//     videos comfortably survive the ceiling.
//   - min groups 3: the three most recently modified groups survive even
//     when every other ceiling is blown — the session in progress plus the
//     two before it, whatever their size.

/** Groups modified inside this many hours are never deleted (grace period). */
export const CLIP_RETENTION_GRACE_HOURS = 24;

/** Groups older than this many days are deletable (age ceiling). */
export const CLIP_RETENTION_MAX_AGE_DAYS = 30;

/** Total bytes across the clips root above which the oldest groups go. */
export const CLIP_RETENTION_MAX_TOTAL_BYTES = 4_000_000_000; // 4 GB

/** The N most recently modified groups are never deleted, period. */
export const CLIP_RETENTION_MIN_GROUPS = 3;

/** Set this env var to off/0/false to disable the clips janitor entirely. */
export const CLIP_RETENTION_DISABLE_ENV = "OCR_CLIP_RETENTION";

/** Documented operator override ceilings (fail-closed beyond them). */
export const CLIP_RETENTION_GRACE_HOURS_CEILING = 720; // one month
export const CLIP_RETENTION_MAX_AGE_DAYS_CEILING = 3650; // ten years
export const CLIP_RETENTION_MAX_BYTES_CEILING = 20_000_000_000; // 20 GB
export const CLIP_RETENTION_MIN_GROUPS_CEILING = 1000;

export const CLIP_RETENTION_GRACE_MS = CLIP_RETENTION_GRACE_HOURS * 3_600_000;
const MAX_AGE_MS = CLIP_RETENTION_MAX_AGE_DAYS * 24 * 3_600_000;

export interface ClipGroup {
  /** group path (absolute, as scanned by the caller, returned verbatim) */
  path: string;
  /** total bytes of every file inside the group */
  bytes: number;
  /** most recent modification instant found inside the group, ms since epoch */
  mtime: number;
}

export interface ClipRetentionPlan {
  /** group paths the caller may delete, oldest first */
  paths: string[];
  /** total bytes those paths would free */
  bytes: number;
}

export interface ClipRetentionThresholds {
  graceMs: number;
  maxAgeMs: number;
  maxTotalBytes: number;
  minGroups: number;
}

/** The documented defaults above, as a thresholds object. */
export const CLIP_RETENTION_DEFAULTS: ClipRetentionThresholds = {
  graceMs: CLIP_RETENTION_GRACE_MS,
  maxAgeMs: MAX_AGE_MS,
  maxTotalBytes: CLIP_RETENTION_MAX_TOTAL_BYTES,
  minGroups: CLIP_RETENTION_MIN_GROUPS,
};

export interface ClipRetentionConfig {
  thresholds: ClipRetentionThresholds;
  disabled: boolean;
  /** Non-empty means the boot must fail closed (exit 1, no listener). */
  problems: string[];
}

/**
 * True when the operator disabled the janitor via CLIP_RETENTION_DISABLE_ENV.
 * Default is enabled: only off/0/false (any case) turns it off.
 */
export function clipRetentionDisabled(env: Record<string, string | undefined>): boolean {
  const raw = env[CLIP_RETENTION_DISABLE_ENV];
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
 * Resolve the OCR_CLIP_RETENTION* environment into the janitor thresholds.
 * An empty environment reproduces the documented defaults. Every variable is
 * parsed independently and ALL problems are returned at once (no
 * short-circuit); with any problem present the caller must fail the boot
 * closed instead of running with thresholds the operator never asked for.
 * OCR_CLIP_RETENTION=off|0|false disables the janitor entirely.
 */
export function parseClipRetention(env: Record<string, string | undefined>): ClipRetentionConfig {
  const problems: string[] = [];
  const graceHours = positiveInt(
    env,
    "OCR_CLIP_RETENTION_GRACE_HOURS",
    CLIP_RETENTION_GRACE_HOURS,
    CLIP_RETENTION_GRACE_HOURS_CEILING,
    "hours",
    problems,
  );
  const maxAgeDays = positiveInt(
    env,
    "OCR_CLIP_RETENTION_MAX_AGE_DAYS",
    CLIP_RETENTION_MAX_AGE_DAYS,
    CLIP_RETENTION_MAX_AGE_DAYS_CEILING,
    "days",
    problems,
  );
  const maxTotalBytes = positiveInt(
    env,
    "OCR_CLIP_RETENTION_MAX_BYTES",
    CLIP_RETENTION_MAX_TOTAL_BYTES,
    CLIP_RETENTION_MAX_BYTES_CEILING,
    "bytes",
    problems,
  );
  const minGroups = positiveInt(
    env,
    "OCR_CLIP_RETENTION_MIN_GROUPS",
    CLIP_RETENTION_MIN_GROUPS,
    CLIP_RETENTION_MIN_GROUPS_CEILING,
    "groups",
    problems,
  );
  return {
    thresholds: {
      graceMs: graceHours * 3_600_000,
      maxAgeMs: maxAgeDays * 24 * 3_600_000,
      maxTotalBytes,
      minGroups,
    },
    disabled: clipRetentionDisabled(env),
    problems,
  };
}

/**
 * Pure retention plan. Receives the scanned groups (path/bytes/mtime) and the
 * current instant; returns the group paths to delete plus the bytes they
 * would free. Rules, in order:
 *
 *  1. groups modified inside the grace period never enter the plan — a clip
 *     the user just rendered is being watched and shared right now (this
 *     also keeps a group with a future instant safe: it is inside grace by
 *     definition);
 *  2. the `minGroups` most recently modified groups never enter the plan,
 *     even when every other ceiling is blown;
 *  3. the remaining groups go oldest-first while they are past the age
 *     ceiling OR the surviving total of the deletable pool is past the byte
 *     ceiling — protected groups are never sacrificed to make the folder fit.
 *
 * Determinism: candidates sort by mtime ascending, ties broken by
 * lexicographic path ascending, so the plan depends only on the input list,
 * never on its order. The plan never contains a path that was not received,
 * and groups with non-finite bytes or mtime are refused (never planned)
 * instead of guessed about.
 */
export function clipRetentionPlan(
  groups: ClipGroup[],
  now: number,
  thresholds: ClipRetentionThresholds = CLIP_RETENTION_DEFAULTS,
): ClipRetentionPlan {
  const byPath = (a: ClipGroup, b: ClipGroup): number =>
    a.mtime - b.mtime || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const valid = groups.filter(
    (g) => Number.isFinite(g.bytes) && Number.isFinite(g.mtime),
  );
  // rule 1 — grace: a freshly rendered group is never planned (a future
  // instant is inside grace by definition, so it is never planned either)
  const pastGrace = valid.filter((g) => now - g.mtime >= thresholds.graceMs);
  // rule 2 — the minGroups most recent groups survive, always (ties by path)
  const protectedPaths = new Set(
    [...valid]
      .sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .slice(0, thresholds.minGroups)
      .map((g) => g.path),
  );
  const candidates = pastGrace
    .filter((g) => !protectedPaths.has(g.path))
    .sort(byPath);
  let remaining = candidates.reduce((sum, g) => sum + Math.max(0, g.bytes), 0);
  const paths: string[] = [];
  let bytes = 0;
  for (const g of candidates) {
    const size = Math.max(0, g.bytes);
    if (now - g.mtime > thresholds.maxAgeMs || remaining > thresholds.maxTotalBytes) {
      paths.push(g.path);
      bytes += size;
      remaining -= size;
    }
  }
  return { paths, bytes };
}
