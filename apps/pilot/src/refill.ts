/**
 * P1-037 — Pending refill store: when a queue refill fails to push
 * (appendCommitAndPush exhausts its retries), the drafted lines used to live
 * only in the slot worktree — the next syncWorkspace `reset --hard
 * origin/main` silently destroyed them and the queue stayed dry. The refill
 * is now persisted OUTSIDE every worktree (~/.opencode-remote/pilot/) and
 * re-landed by the dispatcher on the next idle cycle. Mirrors the
 * failureLessons.ts pattern: pure helpers + fs wrappers with an injectable
 * path, so the unit battery can exercise the store without touching $HOME.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appendCommitAndPush, type AuxPushIo } from "./backlog";
import { nowLocalISO } from "./log";

export interface PendingRefill {
  /** Validated backlog lines (parseAuxTaskLines output), format preserved. */
  lines: string[];
  /** The exact commit message the first landing attempt used. */
  message: string;
  /** Local timestamp (GMT-3, nowLocalISO()) of the save. */
  ts: string;
}

/** Lives outside every worktree, so no `reset --hard`/`git clean` can touch it.
 * Mission v2 (hardening c): `root` is the per-mission state root
 * (pilot/ for this repo, pilot/mission/<key>/ for a foreign mission) so a
 * refill drafted for one repo is never re-landed on the other. */
export function defaultPendingRefillFile(root = join(homedir(), ".opencode-remote", "pilot")): string {
  return join(root, "pending-refill.json");
}

/** Atomic write (tmp + rename): a crash mid-save never leaves a half-file. */
export function savePendingRefill(file: string, lines: string[], message: string): boolean {
  try {
    const payload: PendingRefill = { lines, message, ts: nowLocalISO() };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(payload, null, 2));
    renameSync(`${file}.tmp`, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parsed pending refill, or null when missing/corrupt — a bad write must
 * never wedge the dispatcher; the next savePendingRefill overwrites it.
 */
export function readPendingRefill(file: string): PendingRefill | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<PendingRefill>;
    if (typeof raw.message !== "string" || !Array.isArray(raw.lines)) return null;
    const lines = raw.lines.filter((l): l is string => typeof l === "string" && l.length > 0);
    if (!lines.length) return null;
    return { lines, message: raw.message, ts: typeof raw.ts === "string" ? raw.ts : "" };
  } catch {
    return null;
  }
}

/** Best-effort removal (a missing file is already the desired state). */
export function clearPendingRefill(file: string): void {
  try {
    unlinkSync(file);
  } catch {}
}

export type RelandResult = "pushed" | "empty" | "refused" | "failed" | "none";

/**
 * Re-land a pending refill on origin/main. Dedup comes first: ids that
 * already landed meanwhile (redteam path, a previous reland) are dropped so
 * "everything landed" resolves to "empty" (file cleared, zero pushes) instead
 * of appendCommitAndPush's all-duplicates "failed" (file kept, retried
 * forever). The id scan mirrors appendReadyLines' taken-set exactly (whole
 * file, ## Blocked/## Done included), so the pre-filter can never disagree
 * with the append guard.
 */
export async function relandPendingRefill(
  repoDir: string,
  file: string,
  io: AuxPushIo,
  opts: { seedSkeleton?: boolean } = {},
): Promise<RelandResult> {
  const pending = readPendingRefill(file);
  if (!pending) return "none";
  io.exec("git fetch -q origin");
  const md = io.exec("git show origin/main:BACKLOG.md");
  let remaining = pending.lines;
  if (md.ok) {
    const taken = new Set(md.output.match(/\((?:P\d|RT)-\d{3}\)/g) ?? []);
    remaining = pending.lines.filter((line) => !taken.has(`(${/\(([^)]+)\)/.exec(line)?.[1] ?? ""})`));
  }
  if (!remaining.length) {
    clearPendingRefill(file);
    return "empty";
  }
  const result = await appendCommitAndPush(repoDir, remaining, pending.message, io, 3, opts);
  if (result === "failed") return "failed"; // transient — KEEP the file, retry next idle cycle
  // pushed: done. refused: the mayPush guard rejected a contaminated worktree —
  // clear the store and warn upstream, never loop on it; the strategist
  // re-drafts naturally since the queue stays low.
  clearPendingRefill(file);
  return result;
}

/** One-line human summary of a reland outcome, for logs/events. */
export function relandDetail(result: RelandResult, lines: number): string {
  switch (result) {
    case "pushed":
      return `pending refill landed (${lines} lines)`;
    case "empty":
      return "pending refill already landed on origin/main";
    case "refused":
      return "pending refill refused — worktree contaminated";
    case "none":
      return "no pending refill";
    default:
      return "pending refill still failing";
  }
}
