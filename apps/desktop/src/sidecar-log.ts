// Sidecar stdout/stderr tee (P3-018). In the packaged app the daemon child's
// stdout forwarding to process.stdout (apps/desktop/src/daemon.ts spawnChild)
// is invisible: the stage-5 user has no terminal, so the daemon's JSONL output
// — the raw material for every support request — was lost. This module tees
// every chunk the sidecar prints to userData/logs/daemon-sidecar.log, capped
// at ~1MB with one previous file kept on rotation (daemon-sidecar.log.1 —
// exactly 2 files on disk, ever). Same pattern as desktop-log.ts: fs injected,
// no `electron` import, write failures strictly log-only and never thrown.

import { join } from "node:path";
import { logsDir, nodeLogFs, rotateLog, type LogFs } from "./desktop-log";

/** Soft cap for the active sidecar log file; at or above it the file rotates. */
export const SIDECAR_LOG_CAP_BYTES = 1_000_000;
/** Files kept on disk: daemon-sidecar.log (active) + daemon-sidecar.log.1. */
export const SIDECAR_LOG_MAX_FILES = 2;

/** Absolute path of the sidecar log under userData/logs. */
export function sidecarLogFile(userDataDir: string): string {
  return join(logsDir(userDataDir), "daemon-sidecar.log");
}

export interface SidecarTeeOptions {
  fs?: LogFs;
  /** Override the ~1MB soft cap (unit tests use a tiny cap). */
  capBytes?: number;
  /** Failure sink (tests inject a collector); default writes a guarded note
   * to stderr — guarded because even stderr may be gone in the packaged app. */
  onFailure?: (err: unknown) => void;
}

/** One teed chunk of the sidecar's stdout/stderr (raw bytes, lines included). */
export type SidecarTee = (chunk: string) => void;

/**
 * Build a tee that appends raw sidecar chunks to
 * userData/logs/daemon-sidecar.log. Rotation happens lazily before an append
 * when the active file is at/above the cap; a chunk bigger than the cap (a
 * lineless flood) is still flushed whole. Every fs operation is guarded: any
 * failure is reported through `onFailure` and never thrown.
 */
export function createSidecarTee(userDataDir: string, opts: SidecarTeeOptions = {}): SidecarTee {
  const fs = opts.fs ?? nodeLogFs;
  const cap = Math.max(1, opts.capBytes ?? SIDECAR_LOG_CAP_BYTES);
  const file = sidecarLogFile(userDataDir);
  const dir = logsDir(userDataDir);
  const onFailure =
    opts.onFailure ??
    ((err: unknown) => {
      try {
        process.stderr.write(`[desktop] sidecar-log write failed: ${String(err)}\n`);
      } catch {
        /* even stderr can be gone — nothing else to do */
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
  // Create the logs dir eagerly so the tee's file location exists even before
  // the sidecar prints its first line.
  ensureDir();

  const writeChunk = (chunk: string): void => {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0; // missing/unreadable file counts as empty
    }
    if (size >= cap) rotateLog(file, fs);
    fs.appendFileSync(file, chunk);
  };

  return (chunk: string): void => {
    try {
      writeChunk(chunk);
    } catch (err) {
      // ENOENT here usually means the logs dir vanished under us (user or
      // cleaner deleted it while running): recreate once and retry.
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && ensureDir()) {
        try {
          writeChunk(chunk);
          return;
        } catch (retryErr) {
          onFailure(retryErr);
          return;
        }
      }
      onFailure(err);
    }
  };
}

// --- process-wide default (installed by main.ts) ------------------------------

let active: SidecarTee | null = null;

/** Install the process-wide sidecar tee; call once at the top of main.ts. */
export function initSidecarLog(userDataDir: string, opts: SidecarTeeOptions = {}): SidecarTee {
  active = createSidecarTee(userDataDir, opts);
  return active;
}

/**
 * Tee one chunk of the sidecar's stdout/stderr into the installed log file.
 * No-op (never throws) before initSidecarLog — e.g. unit tests that import
 * daemon.ts without ever installing the tee.
 */
export function teeSidecarChunk(chunk: string): void {
  if (!active) return;
  active(chunk);
}
