// Desktop file logging (P3-012). The shell's main-process code only used
// console.log/error, which is invisible in the packaged app: the stage-5 user
// (docs/VISION.md) has no terminal, so support had no way to see what the
// shell did. This module appends the same `[desktop] …` lines the code already
// produced to userData/logs/desktop.log, capped at ~1MB with one previous
// file kept on rotation (desktop.log.1 — exactly 2 files on disk, ever).
//
// Write failures are strictly log-only: a full disk or a read-only volume
// must never crash the shell. Same structural-injection pattern as
// window-state.ts / crash.ts — no `electron` import, fs injected — so
// scripts/desktop-log.test.ts exercises the real logic under plain tsx.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

/** Soft cap for the active log file; at or above it the file rotates. */
export const LOG_CAP_BYTES = 1_000_000;
/** Files kept on disk: desktop.log (active) + desktop.log.1 (previous). */
export const LOG_MAX_FILES = 2;

export type LogLevel = "log" | "error";

/** Structural subset of node:fs the logger touches (tests inject fakes). */
export interface LogFs {
  existsSync(file: string): boolean;
  mkdirSync(dir: string, opts: { recursive: boolean }): void;
  statSync(file: string): { size: number };
  renameSync(from: string, to: string): void;
  unlinkSync(file: string): void;
  appendFileSync(file: string, data: string): void;
}

export const nodeLogFs: LogFs = {
  existsSync,
  mkdirSync,
  statSync,
  renameSync,
  unlinkSync,
  appendFileSync,
};

export function logsDir(userDataDir: string): string {
  return join(userDataDir, "logs");
}

export function desktopLogFile(userDataDir: string): string {
  return join(logsDir(userDataDir), "desktop.log");
}

/**
 * P2-069: when the reader of our stdout/stderr dies (a SIGKILLed harness
 * keeper, a closed terminal), the async EPIPE from the next console write
 * surfaces as uncaughtException — and since the crash handler logs through the
 * same console, that used to loop: EPIPE → crash report → console → EPIPE,
 * spamming client-logs/ forever on a shell that can no longer write anywhere
 * but the file. Swallowing stream errors here is safe: this file log keeps the
 * truth, and installFatalErrorHandlers keeps handling real exceptions.
 * Attach once per stream; failures are ignored (best-effort by design).
 */
export function installPipeGuards(streams: { on: (event: string, cb: () => void) => unknown }[]): void {
  for (const stream of streams) {
    if (!stream) continue;
    try {
      stream.on("error", () => {});
    } catch {
      /* not attachable — nothing to guard */
    }
  }
}

/**
 * Local-time timestamp (user rule: UI/log timestamps are local, GMT-3) with an
 * explicit offset so entries stay unambiguous and sortable:
 * 2026-09-01T09:34:12.345-03:00.
 */
export function formatTimestamp(d: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** Strings pass through, Errors keep their stack, objects become JSON. */
export function serializePart(part: unknown): string {
  if (typeof part === "string") return part;
  if (part instanceof Error) return part.stack ?? part.message;
  if (typeof part === "object" && part !== null) {
    try {
      const json = JSON.stringify(part);
      if (json !== undefined) return json;
    } catch {
      /* circular or otherwise unserializable — fall through to String() */
    }
  }
  return String(part);
}

/** One full log line (without the trailing newline). */
export function formatLine(level: LogLevel, parts: unknown[], now: Date): string {
  const message = parts.map(serializePart).join(" ");
  return `[${formatTimestamp(now)}] [${level}] ${message}`;
}

/**
 * Rotate: desktop.log → desktop.log.1 (any previous .1 is unlinked first —
 * rename cannot overwrite on Windows). False on failure; callers carry on.
 */
export function rotateLog(logFile: string, fs: LogFs = nodeLogFs): boolean {
  try {
    const one = `${logFile}.1`;
    if (fs.existsSync(one)) fs.unlinkSync(one);
    fs.renameSync(logFile, one);
    return true;
  } catch {
    return false;
  }
}

export interface DesktopLogger {
  log(...parts: unknown[]): void;
  error(...parts: unknown[]): void;
  /** Absolute path of the file being appended to (diagnostics/tests). */
  file(): string;
}

export interface DesktopLoggerOptions {
  fs?: LogFs;
  /** Override the ~1MB soft cap (unit tests use a tiny cap). */
  capBytes?: number;
  /** Mirror sink; default prints to the console (dev keeps terminal output). */
  out?: (level: LogLevel, line: string) => void;
}

/**
 * Build a logger that appends `[ts] [level] message` lines to
 * userData/logs/desktop.log. Rotation happens lazily before an append when
 * the active file is at/above the cap. Every fs operation is guarded: any
 * failure degrades to mirror-only output and is reported on stderr once,
 * never thrown.
 */
export function createDesktopLogger(
  userDataDir: string,
  opts: DesktopLoggerOptions = {},
): DesktopLogger {
  const fs = opts.fs ?? nodeLogFs;
  const cap = Math.max(1, opts.capBytes ?? LOG_CAP_BYTES);
  const file = desktopLogFile(userDataDir);
  const dir = logsDir(userDataDir);
  const mirror =
    opts.out ??
    ((level, line) => {
      try {
        if (level === "error") console.error(line);
        else console.log(line);
      } catch {
        /* console unavailable in some packaged contexts — ignore */
      }
    });

  const ensureDir = (): boolean => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  };
  ensureDir();

  const append = (line: string): boolean => {
    try {
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        size = 0; // missing/unreadable file counts as empty
      }
      if (size >= cap) rotateLog(file, fs);
      fs.appendFileSync(file, line);
      return true;
    } catch (err) {
      // ENOENT here usually means the logs dir vanished under us (user or
      // cleaner deleted it while running): recreate once and retry.
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && ensureDir()) {
        try {
          fs.appendFileSync(file, line);
          return true;
        } catch {
          /* fall through to the log-only path */
        }
      }
      try {
        process.stderr.write(`[desktop] desktop-log write failed: ${String(err)}\n`);
      } catch {
        /* even stderr can be gone — nothing else to do */
      }
      return false;
    }
  };

  const write = (level: LogLevel, parts: unknown[]): void => {
    const line = formatLine(level, parts, new Date());
    mirror(level, line);
    append(`${line}\n`);
  };

  return {
    log: (...parts) => write("log", parts),
    error: (...parts) => write("error", parts),
    file: () => file,
  };
}

// --- process-wide default (installed by main.ts) ------------------------------

let active: DesktopLogger | null = null;

/** Install the process-wide file logger; call once at the top of main.ts. */
export function initDesktopLog(userDataDir: string, opts: DesktopLoggerOptions = {}): DesktopLogger {
  // P2-069: the mirror writes to process.stdout/stderr — guard both pipes so
  // a dead reader (SIGKILLed keeper/terminal) cannot turn the next console
  // write into an uncaughtException crash-report loop. Idempotent: an extra
  // 'error' listener is a no-op and a second init is not a supported path.
  installPipeGuards([process.stdout, process.stderr]);
  active = createDesktopLogger(userDataDir, opts);
  return active;
}

/** File-backed console replacement for our main-process code (P3-012). */
export function log(...parts: unknown[]): void {
  if (active) active.log(...parts);
  else console.log(...parts);
}

/** Same as log() but flagged error in the file and on the mirror sink. */
export function logError(...parts: unknown[]): void {
  if (active) active.error(...parts);
  else console.error(...parts);
}
