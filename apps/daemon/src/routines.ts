// P2-256: routines.json is persisted through the SAME atomic tmp+rename
// write as the daemon state file (writeStateAtomic, P2-165) — a crash, OOM
// or power loss mid-write can no longer leave a truncated file, and the
// 0600 mode comes from the write itself, never a chmod after the fact. The
// read goes through the pure routinesVerdict (routinesfile.ts): an illegible
// file is preserved beside the original (the P2-234 quarantine path) and
// logged once, instead of silently loading an empty list that the next save
// would write back, erasing every scheduled routine for good.
//
// A refusal keeps the original file safe even when the quarantine move could
// not happen at load (a read failure never moves the file; a failed move
// leaves the bytes in place): the first save after any refusal preserves the
// still-present original through the same quarantine move BEFORE writing,
// and skips the write when even that fails — the original is never
// overwritten behind the owner's back.

import { readFileSync, renameSync, chmodSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { writeStateAtomic } from "./statefile.js";
import { quarantineName } from "./identityfile.js";
import { routinesVerdict, ROUTINES_REFUSE_PRESERVE_FAILED_MESSAGE } from "./routinesfile.js";
import { log } from "./log.js";

export interface Routine {
  id: string;
  name: string;
  prompt: string;
  hour: number; // machine-local time (daily/days modes)
  minute: number;
  mode?: "daily" | "days" | "interval";
  days?: number[]; // 0=Sun..6=Sat, for mode "days"
  intervalMinutes?: number; // for mode "interval"
  lastRun?: string; // local YYYY-MM-DD of the last fire (daily/days)
  lastFiredAt?: number; // epoch ms of the last fire (interval pacing)
  lastSessionID?: string; // session awaiting result persistence
  runStartedAt?: number; // epoch ms when the current in-flight run was first observed (run lease basis, P2-236)
  lastStatus?: "ok" | "error";
  lastError?: string;
}

const FILE = () => join(homedir(), ".opencode-remote", "routines.json");

// A refused load whose original file is still in place: the next save must
// preserve it through the same quarantine move before writing anything.
let refusalPendingPreservation = false;

function quarantineMove(): boolean {
  try {
    const qfile = join(dirname(FILE()), quarantineName(basename(FILE()), new Date()));
    renameSync(FILE(), qfile);
    chmodSync(qfile, 0o600);
    return true;
  } catch {
    return false;
  }
}

export function loadRoutines(): Routine[] {
  let exists = true;
  let content: string | null = null;
  let readFailure: string | null = null;
  try {
    content = readFileSync(FILE(), "utf8");
  } catch (err) {
    // A missing file is the long-standing first-run path, bit for bit; any
    // other filesystem failure refuses with the file untouched — a transient
    // read failure is never an empty list (routinesfile.ts rule order).
    const code = (err as NodeJS.ErrnoException)?.code ?? "";
    if (code === "ENOENT") exists = false;
    else readFailure = code || "EUNKNOWN";
  }
  const verdict = routinesVerdict(exists, content, readFailure);
  if (verdict.plan === "refuse") {
    // ONE static log line per refusal — no path, no content, no secret. A
    // content refusal preserves the illegible bytes beside the original
    // (0600, never deleted); the next save then recreates a fresh file
    // without ever touching the preserved copy.
    let quarantined = false;
    if (verdict.quarantine) quarantined = quarantineMove();
    // When the move failed the phrase must not promise preservation — and
    // the original is still in place, so the first save defers to it.
    const message =
      verdict.quarantine && !quarantined ? ROUTINES_REFUSE_PRESERVE_FAILED_MESSAGE : verdict.message;
    refusalPendingPreservation = !quarantined;
    log("error", message, { quarantined });
  }
  return verdict.plan === "use" ? verdict.routines : [];
}

// The first save after a refusal must not overwrite the original file: the
// unreadable bytes are preserved through the same quarantine move first.
// A missing file has nothing left to preserve; any other failure keeps the
// refusal pending so the original is never overwritten.
function preserveRefusedOriginal(): boolean {
  try {
    const qfile = join(dirname(FILE()), quarantineName(basename(FILE()), new Date()));
    renameSync(FILE(), qfile);
    chmodSync(qfile, 0o600);
    refusalPendingPreservation = false;
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") return false;
    refusalPendingPreservation = false; // the original is already gone
    return true;
  }
}

export function saveRoutines(rs: Routine[]) {
  if (refusalPendingPreservation && !preserveRefusedOriginal()) {
    log("error", ROUTINES_REFUSE_PRESERVE_FAILED_MESSAGE);
    return;
  }
  writeStateAtomic(FILE(), JSON.stringify(rs, null, 2));
}
