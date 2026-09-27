/** Structured JSON-lines logging. One line per event, machine-parseable. */
import { writeSync } from "node:fs";
import { installStdioGuard } from "./stdioguard.js";

export type Level = "debug" | "info" | "warn" | "error";

const MIN = (process.env.OCR_LOG_LEVEL ?? "info") as Level;
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

// eval-12: installed when this module loads — every daemon entry point
// imports log.ts before anything can write a line — so a stdio write error
// (ENOSPC on a full disk, EPIPE from a vanished reader) is absorbed and
// counted instead of killing the process with an unhandled 'error' event.
// /metrics publishes the count as ocr_log_write_errors_total.
export const stdioGuard = installStdioGuard({ stdout: process.stdout, stderr: process.stderr });

export function log(level: Level, msg: string, data?: unknown) {
  if (ORDER[level] < ORDER[MIN]) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...(data !== undefined ? { data } : {}),
  });
  const stream = level === "error" ? process.stderr : process.stdout;
  // eval-12: a stream that failed once is destroyed for good and silently
  // drops every later console write. Write the line straight to its
  // descriptor instead, best-effort: a disk that frees up resumes the log
  // without a restart, and a descriptor that still fails loses this one line.
  if (stream.destroyed) {
    try {
      writeSync(level === "error" ? 2 : 1, line + "\n");
    } catch {
      // diagnostics only — never a reason to throw into the caller
    }
    return;
  }
  (level === "error" ? console.error : console.log)(line);
}
