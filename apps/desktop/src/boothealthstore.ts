// P2-270: persistence for the boot-health record (boothealth.json inside the
// shell's userData, a sibling of gpu-state.json). Thin I/O only — every
// decision lives in the pure boothealth.ts, and this module follows the
// quitstore.ts/gpustore.ts precedent: the payload lands in a sibling .tmp
// file created with mode 0600 and a rename moves it over the destination, so
// a crash never leaves a half-written or world-readable file behind.
//
// The filesystem is INJECTED (the same structural pattern as LogFs in
// desktop-log.ts and the P2-267 wipe executor), so scripts/unit.test.ts and
// the portable scripts/boothealth.test.ts exercise every path against a fake
// fs and never touch the real disk. Each read or write failure is reported as
// a plain { written: false, reason } outcome line — never an exception that
// could take the boot down. The harness-session rule is checked again here
// (defense in depth — the verdict already returns "normal" for it): a test
// session writes nothing at all.

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BootHealthRecord } from "./boothealth";

/** Structural subset of node:fs the store touches (tests inject fakes). */
export interface BootHealthFs {
  readFileSync(file: string, encoding: "utf8"): string;
  writeFileSync(file: string, data: string, opts: { mode: number }): void;
  renameSync(from: string, to: string): void;
  unlinkSync(file: string): void;
}

export const nodeBootHealthFs: BootHealthFs = {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
};

export function bootHealthRecordFile(userDataDir: string): string {
  return join(userDataDir, "boothealth.json");
}

/** Outcome of one store operation: `written` plus a static reason for one
 * log line — ok | harness | relogio | escrita. Never throws. */
export interface BootHealthStoreOutcome {
  written: boolean;
  reason: string;
}

const OUTCOME_OK: BootHealthStoreOutcome = { written: true, reason: "ok" };
const OUTCOME_HARNESS: BootHealthStoreOutcome = { written: false, reason: "harness" };
const OUTCOME_CLOCK: BootHealthStoreOutcome = { written: false, reason: "relogio" };
const OUTCOME_WRITE: BootHealthStoreOutcome = { written: false, reason: "escrita" };

/** Read the stored record; null means "absent/unreadable/corrupted" — which
 * the pure verdict maps to normal, never to an accusation. ENOENT stays
 * silent: an app whose version always opened has no boothealth.json yet and
 * that is not an error. */
export function readBootHealthRecord(file: string, fs: BootHealthFs): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** Atomic private write: <file>.tmp with mode 0600, renamed over the
 * destination, tmp removed again on any failure. A full disk or a read-only
 * volume is a report line, never an exception. */
function writeRecord(file: string, fs: BootHealthFs, record: BootHealthRecord): BootHealthStoreOutcome {
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return OUTCOME_OK;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // already gone — nothing to clean up
    }
    return OUTCOME_WRITE;
  }
}

/** Mark the opening now in progress: the record describes the PAST openings
 * (the verdict consumed it), this write adds the current one, which has not
 * reached a useful window yet. The count carried forward is the verdict's
 * effective count (already zeroed for a version change or a corrupt record),
 * plus one. A harness session writes nothing; a non-finite instant refuses
 * instead of guessing. */
export function markOpeningInProgress(input: {
  file: string;
  fs: BootHealthFs;
  harnessSession: boolean;
  runningVersion: string;
  /** The verdict's normalized record (its `record` field) — the base whose
   * lastHealthyVersion is carried over; null when there is none. */
  base: BootHealthRecord | null;
  /** The verdict's effective count for the running version. */
  effectiveCount: number;
  nowMs: number;
}): BootHealthStoreOutcome {
  if (input.harnessSession) return OUTCOME_HARNESS;
  if (!Number.isFinite(input.nowMs)) return OUTCOME_CLOCK;
  // Field order is a contract (P2-218): identical to normalizeBootHealthRecord.
  const carriesHealthy = input.base?.lastHealthyVersion !== undefined;
  const record: BootHealthRecord = carriesHealthy
    ? {
        lastSeenVersion: input.runningVersion,
        lastHealthyVersion: input.base?.lastHealthyVersion,
        unmatchedOpenings: Math.max(0, input.effectiveCount) + 1,
        lastOpeningAt: input.nowMs,
      }
    : {
        lastSeenVersion: input.runningVersion,
        unmatchedOpenings: Math.max(0, input.effectiveCount) + 1,
        lastOpeningAt: input.nowMs,
      };
  return writeRecord(input.file, input.fs, record);
}

/** Promote the running version to "healthy": called ONLY when the main
 * window finished loading for real (the did-finish-load path in main.ts).
 * The count resets to zero — this opening reached a useful window, so the
 * past unmatched openings of this version are forgiven. */
export function promoteHealthyOpening(input: {
  file: string;
  fs: BootHealthFs;
  harnessSession: boolean;
  runningVersion: string;
  nowMs: number;
}): BootHealthStoreOutcome {
  if (input.harnessSession) return OUTCOME_HARNESS;
  if (!Number.isFinite(input.nowMs)) return OUTCOME_CLOCK;
  const stored = readBootHealthRecord(input.file, input.fs);
  // The base record is re-read tolerantly: unreadable → the opening instant
  // falls back to now and the promotion still happens.
  const previousLastOpeningAt = ((): number | undefined => {
    if (typeof stored !== "object" || stored === null) return undefined;
    const raw = (stored as { lastOpeningAt?: unknown }).lastOpeningAt;
    return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
  })();
  const record: BootHealthRecord = {
    lastSeenVersion: input.runningVersion,
    lastHealthyVersion: input.runningVersion,
    unmatchedOpenings: 0,
    lastOpeningAt: previousLastOpeningAt ?? input.nowMs,
  };
  return writeRecord(input.file, input.fs, record);
}
