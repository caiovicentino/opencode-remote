// P2-167: durable, bounded audit log. The daemon used to appendFileSync the
// audit trail (pairing, rejections, revocations — security events) straight
// into <state dir>/audit.log with no cap and no chmod: in the packaged stage-3
// app the file grew forever on machines whose user will never prune it, and it
// was born with the default umask while holding security-relevant records.
// The desktop side already solved this for shell logs with rotateLog
// (apps/desktop/src/desktop-log.ts): ~1MB soft cap, one previous file kept.
// Same contract here, with the structural fs injection of statefile.ts
// (scripts/unit.test.ts exercises the real logic against a fake fs, never
// touching disk):
//   - appendAudit creates the file 0600 when absent (mode is only applied at
//     creation, so existing permissions are never touched), rotates the active
//     file to audit.log.1 once it reaches the cap (replacing the previous
//     rotation — exactly 2 files on disk, ever) and never throws: a full disk
//     or a vanished directory must never take the daemon down with it.
//   - readAuditTail returns the last n lines, completing the count from
//     audit.log.1 when the active file has fewer — the first rotation must not
//     wipe the user's security view. Missing/unreadable files yield an empty
//     tail, never an exception.
// The JSONL line format and which events are audited are decided by the
// callers; this module only cares about durability, size and mode.

import { appendFileSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";

/** Soft cap for the active audit file; at or above it the file rotates. */
export const AUDIT_CAP_BYTES = 1_000_000;

/** Structural subset of node:fs appendAudit/readAuditTail touch (tests inject fakes). */
export interface AuditLogFs {
  statSync(file: string): { size: number };
  renameSync(from: string, to: string): void;
  unlinkSync(file: string): void;
  appendFileSync(file: string, data: string, opts: { mode: number }): void;
  readFileSync(file: string, encoding: "utf8"): string;
}

export const nodeAuditLogFs: AuditLogFs = {
  statSync: (file) => statSync(file),
  renameSync: (from, to) => renameSync(from, to),
  unlinkSync: (file) => unlinkSync(file),
  appendFileSync: (file, data, opts) => appendFileSync(file, data, opts),
  readFileSync: (file, encoding) => readFileSync(file, encoding),
};

function splitLines(content: string): string[] {
  return content.split("\n").filter(Boolean);
}

/**
 * Append `data` (a complete JSONL line including its "\n") to `file`. When the
 * active file is at/above `capBytes` it is rotated to `<file>.1` first (any
 * previous .1 is unlinked — rename cannot overwrite on Windows). The file is
 * created 0600 when absent. Best-effort by design: never throws.
 */
export function appendAudit(
  file: string,
  data: string,
  fs: AuditLogFs = nodeAuditLogFs,
  capBytes: number = AUDIT_CAP_BYTES,
): void {
  try {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0; // missing/unreadable file counts as empty
    }
    if (size >= capBytes) {
      const one = `${file}.1`;
      try {
        try {
          fs.unlinkSync(one);
        } catch {}
        fs.renameSync(file, one);
      } catch {}
    }
    fs.appendFileSync(file, data, { mode: 0o600 });
  } catch {}
}

/**
 * Last `n` lines of the audit trail, in chronological order: when the active
 * file holds fewer than `n` lines the count is completed from `<file>.1`
 * (older entries first). Missing or unreadable files mean an empty tail —
 * never an exception.
 */
export function readAuditTail(file: string, n: number, fs: AuditLogFs = nodeAuditLogFs): string[] {
  if (!Number.isFinite(n) || n < 1) return [];
  let active: string[];
  try {
    active = splitLines(fs.readFileSync(file, "utf8"));
  } catch {
    active = [];
  }
  const out = active.slice(-n);
  if (out.length >= n) return out;
  let older: string[];
  try {
    older = splitLines(fs.readFileSync(`${file}.1`, "utf8"));
  } catch {
    older = [];
  }
  return [...older.slice(-(n - out.length)), ...out];
}
