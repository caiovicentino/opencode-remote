// P2-207: artifact retention janitor — pure planning module. No node:fs,
// node:child_process, node:http or ws imports on purpose, because index.ts
// runs main() on import and unit tests must never boot a daemon (same pattern
// as pairwindow.ts / voicecap.ts). All I/O (scanning, deleting) lives in the
// caller; this module only decides WHAT would be deleted.
//
// Why: every conversation that produces a report, spreadsheet or pdf leaves
// files under ~/.opencode-remote/artifacts/<sessionId>/ forever — the listing
// cap (P2-173) and the audit-log rotation (P2-167) never freed that disk. On
// a lay user's machine the app becomes the process that silently fills the
// disk. The janitor bounds the artifacts root with conservative ceilings.

import { resolve } from "node:path";
import { validSegment } from "./artifacts.js";

/** Session artifacts older than this many days are deletable (age ceiling). */
export const RETENTION_MAX_AGE_DAYS = 30;

/** Total bytes across the artifacts root above which the oldest sessions go. */
export const RETENTION_MAX_TOTAL_BYTES = 1_000_000_000; // 1 GB

/** The N most recently modified session dirs are never deleted, period. */
export const RETENTION_MIN_SESSIONS = 3;

/** Files modified inside this many hours are never deleted (grace period). */
export const RETENTION_GRACE_HOURS = 48;

/** Sweep runs once at boot, then at this interval. */
export const RETENTION_INTERVAL_MS = 6 * 60 * 60_000;

/** Set this env var to off/0/false to disable the janitor entirely. */
export const RETENTION_DISABLE_ENV = "OCR_ARTIFACT_RETENTION";

export const RETENTION_GRACE_MS = RETENTION_GRACE_HOURS * 3_600_000;
const MAX_AGE_MS = RETENTION_MAX_AGE_DAYS * 24 * 3_600_000;

export interface RetentionEntry {
  /** absolute path of the entry (a session dir under the artifacts root) */
  path: string;
  bytes: number;
  /** last modification time in ms since the epoch */
  mtime: number;
}

export interface RetentionPlan {
  /** paths the caller may delete, oldest first */
  paths: string[];
  /** total bytes those paths would free */
  bytes: number;
}

/**
 * True when the operator disabled the janitor via RETENTION_DISABLE_ENV.
 * Default is enabled: only off/0/false (any case) turns it off.
 */
export function retentionDisabled(env: Record<string, string | undefined>): boolean {
  const raw = env[RETENTION_DISABLE_ENV];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "off" || v === "0" || v === "false";
}

/**
 * The session dir an entry belongs to (first segment below the root), or null
 * when the entry is refused: not strictly under the root (including `..`
 * traversal and paths outside/outside-equal to the root) or carrying any
 * segment that fails the same validSegment rule the rest of the app applies.
 * A caller mistake can therefore never turn the janitor into an arbitrary
 * file deleter — refusals are silent, never planned.
 */
function sessionUnderRoot(base: string, rawPath: string): string | null {
  let abs: string;
  try {
    abs = resolve(base, rawPath);
  } catch {
    return null;
  }
  // strictly under the root: the root itself and everything outside is refused
  if (abs === base || !abs.startsWith(base + "/")) return null;
  const parts = abs.slice(base.length + 1).split("/");
  for (const part of parts) {
    if (!validSegment(part)) return null;
  }
  return parts[0];
}

/**
 * Pure retention plan. Receives the artifacts root, the scanned entries
 * (path/bytes/mtime) and the current instant; returns the paths to delete
 * plus the bytes they would free. Rules, in order:
 *
 *  1. entries modified inside the grace period never enter the plan;
 *  2. the RETENTION_MIN_SESSIONS most recently modified session dirs never
 *     enter the plan, even when every other ceiling is blown;
 *  3. the remaining entries go oldest-first while they are past the age
 *     ceiling OR the surviving total is past the byte ceiling.
 */
export function retentionPlan(
  root: string,
  entries: RetentionEntry[],
  now: number,
): RetentionPlan {
  const base = resolve(root);
  const latestMtime = new Map<string, number>();
  const grace: Array<{ entry: RetentionEntry; session: string }> = [];
  for (const entry of entries) {
    const session = sessionUnderRoot(base, entry.path);
    if (session === null) continue; // refused: never planned
    latestMtime.set(session, Math.max(latestMtime.get(session) ?? 0, entry.mtime));
    if (now - entry.mtime < RETENTION_GRACE_MS) continue; // grace: never planned
    grace.push({ entry, session });
  }
  const protectedSessions = new Set(
    [...latestMtime.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, RETENTION_MIN_SESSIONS)
      .map(([session]) => session),
  );
  const candidates = grace
    .filter(({ session }) => !protectedSessions.has(session))
    .sort((a, b) => a.entry.mtime - b.entry.mtime);
  const paths: string[] = [];
  let bytes = 0;
  let remaining = candidates.reduce((sum, { entry }) => sum + Math.max(0, entry.bytes), 0);
  for (const { entry } of candidates) {
    const size = Math.max(0, entry.bytes);
    if (now - entry.mtime > MAX_AGE_MS || remaining > RETENTION_MAX_TOTAL_BYTES) {
      paths.push(entry.path);
      bytes += size;
      remaining -= size;
    }
  }
  return { paths, bytes };
}
