// Minimal crash reporting (P1-050): every fatal main-process error and every
// renderer crash lands as a timestamped text file under
// ~/.opencode-remote/pilot/client-logs/, capped to the newest
// CRASH_LOG_MAX_FILES files (older ones are deleted on each write).
//
// The pilot directory is outside userData on purpose: the pilot pipeline and
// the user both look there, and support (docs/troubleshooting.md) points at
// the same path. Same structural-injection pattern as desktop-log.ts — no
// electron import, fs injected — so scripts/client-ready.test.ts exercises
// the real logic under plain tsx. Every write is best-effort: a full disk or
// a read-only volume must never take the shell down.

import { existsSync, mkdirSync, readdirSync, unlinkSync, appendFileSync } from "node:fs";
import { join } from "node:path";

/** Newest crash files kept on disk; anything older is deleted after a write. */
export const CRASH_LOG_MAX_FILES = 20;

/** Structural subset of node:fs the crash logger touches (tests inject fakes). */
export interface CrashLogFs {
  existsSync(file: string): boolean;
  mkdirSync(dir: string, opts: { recursive: boolean }): void;
  readdirSync(dir: string): string[];
  unlinkSync(file: string): void;
  appendFileSync(file: string, data: string): void;
}

export const nodeCrashFs: CrashLogFs = {
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  appendFileSync,
};

/** ~/.opencode-remote/pilot/client-logs — shared with the pilot pipeline. */
export function clientLogsDir(home: string): string {
  return join(home, ".opencode-remote", "pilot", "client-logs");
}

/** Crash file naming: crash-<local ts>-<kind>.txt, sortable by name. */
export function crashFileName(kind: string, now: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  const ts =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}` +
    `-${pad(now.getMilliseconds(), 3)}`;
  const safeKind = kind.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
  return `crash-${ts}-${safeKind}.txt`;
}

/** Body of one crash file — full detail, no secrets (never log tokens/keys). */
export function formatCrashReport(kind: string, detail: string, version: string, now: Date): string {
  return [
    `kind: ${kind}`,
    `app: OpenCode Remote ${version}`,
    `at: ${now.toISOString()}`,
    "",
    detail,
    "",
  ].join("\n");
}

/**
 * Write one crash report and prune the folder to the newest
 * CRASH_LOG_MAX_FILES files. Best-effort: returns the written path on
 * success, null on any failure — never throws.
 */
export function writeCrashReport(
  dir: string,
  kind: string,
  detail: string,
  version: string,
  fs: CrashLogFs = nodeCrashFs,
  now: Date = new Date(),
): string | null {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = join(dir, crashFileName(kind, now));
    fs.appendFileSync(file, formatCrashReport(kind, detail, version, now));
    // Retention: newest CRASH_LOG_MAX_FILES crash-*.txt survive. Deletion of
    // an individual old file is allowed to fail (one line, log-only below).
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("crash-") && f.endsWith(".txt"))
      .sort();
    for (const old of files.slice(0, Math.max(0, files.length - CRASH_LOG_MAX_FILES))) {
      try {
        fs.unlinkSync(join(dir, old));
      } catch {
        /* best-effort retention */
      }
    }
    return file;
  } catch {
    return null;
  }
}
