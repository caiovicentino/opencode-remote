// Instance hygiene (P2-069): one live shell per userData.
//
// The incident this prevents: a harness-launched Electron instance outlived its
// keeper for 32h, showing a white, unpaired window on the operator's screen.
// Three guards live here:
//   (a) the single-instance lock in main.ts (second real instance quits and the
//       running window is focused instead) — the helpers below only document it;
//   (c) a boot-time boot-record file in userData: when a previous instance of
//       the SAME userData is still alive with an earlier start (`lstart`), the
//       new instance logs a zombie warning to desktop.log;
//   (b) the harness leash: tools/desktop.mjs passes its own pid via
//       OCR_KEEPER_PID, and the app quits when that pid disappears — a SIGKILLed
//       keeper can no longer leak an Electron instance.
//
// Pure, electron-free module (pattern of window-state.ts / tray.ts): fs, ps and
// the log sink are injectable so scripts/instances.test.ts exercises the real
// logic under plain tsx.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Boot-record file name, written inside the userData dir. */
export const INSTANCE_RECORD_FILE = "instance.json";
/** Test-only hatch (tools/desktop.mjs): the keeper's pid, for the death leash. */
export const KEEPER_PID_ENV = "OCR_KEEPER_PID";

export interface InstanceRecord {
  pid: number;
  /** Boot time in epoch ms — an alive record holder always started earlier. */
  startedAt: number;
}

export function instanceRecordPath(userDataDir: string): string {
  return join(userDataDir, INSTANCE_RECORD_FILE);
}

/** Null for anything untrusted: a corrupted record must never break the boot. */
export function parseInstanceRecord(raw: string): InstanceRecord | null {
  try {
    const rec = JSON.parse(raw) as Partial<InstanceRecord>;
    if (typeof rec?.pid !== "number" || !Number.isInteger(rec.pid) || rec.pid <= 0) return null;
    if (typeof rec?.startedAt !== "number" || !Number.isFinite(rec.startedAt) || rec.startedAt <= 0) return null;
    return { pid: rec.pid, startedAt: rec.startedAt };
  } catch {
    return null;
  }
}

export function readInstanceRecord(file: string): InstanceRecord | null {
  try {
    return parseInstanceRecord(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Best-effort: a full disk is log-only, never a boot failure. */
export function writeInstanceRecord(file: string, record: InstanceRecord): boolean {
  try {
    writeFileSync(file, JSON.stringify(record), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** true = alive, false = gone. EPERM (different user) counts as alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Parses `ps -o lstart=` output (BSD format, local time):
 * "Fri Sep  4 21:15:00 2026". Null when the shape is not recognized.
 */
export function parsePsLstart(output: string): Date | null {
  const MONTHS: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  const m = output
    .trim()
    .replace(/\s+/g, " ")
    .match(/^\w{3} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/);
  if (!m) return null;
  const month = m[1] ? MONTHS[m[1]] : undefined;
  if (month === undefined) return null;
  return new Date(
    Number(m[6]),
    month,
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
  );
}

type PsRunner = (pid: number) => string | null;

const psRunner: PsRunner = (pid) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return null;
  const res = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 });
  return res.status === 0 ? (res.stdout ?? "").trim() : null;
};

/**
 * Did `pid` start before `beforeMs`? true/false from ps, null when the platform
 * has no ps or the answer is unknowable (race, permission). Callers treat null
 * as "cannot disprove" — the fail direction of a log-only warning is to warn.
 */
export function processStartedBefore(pid: number, beforeMs: number, runner: PsRunner = psRunner): boolean | null {
  const start = parsePsLstart(runner(pid) ?? "");
  if (!start) return null;
  return start.getTime() < beforeMs;
}

/**
 * The zombie verdict for the boot-record file. Warn only when the recorded
 * holder is (still) alive, is not us, and nothing disproves that it started
 * earlier — a reused PID that ps proves is younger must stay quiet.
 */
export function zombieWarning(opts: {
  previous: InstanceRecord;
  currentPid: number;
  nowMs: number;
  alive: boolean;
  startedBeforeCurrent: boolean | null;
}): string | null {
  if (opts.previous.pid === opts.currentPid) return null;
  if (!opts.alive) return null;
  if (opts.previous.startedAt > opts.nowMs) return null; // clock skew — do not cry wolf
  if (opts.startedBeforeCurrent === false) return null;
  const when = new Date(opts.previous.startedAt).toISOString();
  return `possible zombie instance: pid ${opts.previous.pid} (started ${when}) is still alive on this userData — a white window from a killed harness/keeper may be it (P2-069)`;
}

/**
 * The keeper-leash hatch (b): parse OCR_KEEPER_PID. Only a foreign, positive
 * pid qualifies — pointing the leash at ourselves would be a no-op guard.
 */
export function keeperPidFromEnv(env: NodeJS.ProcessEnv): number | null {
  const raw = env[KEEPER_PID_ENV];
  if (!raw) return null;
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return null;
  return pid;
}
