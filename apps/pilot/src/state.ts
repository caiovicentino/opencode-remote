import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { nowLocalISO } from "./log";
import { homedir } from "node:os";

export interface PilotConfig {
  repo: string; // production checkout (runs the services)
  workspace: string; // pilot clone where agents work
  maxTasksPerDay: number;
  maxDeploysPerDay: number;
  maxReviewRounds: number;
  taskTimeoutMin: number;
  reviewTimeoutMin: number;
  monitorMin: number;
  digest: boolean;
}

export const DEFAULTS: PilotConfig = {
  repo: process.env.OCR_PILOT_REPO ?? "/Volumes/SSD Major/Major/opencode-remote",
  workspace: join(homedir(), ".opencode-remote/pilot/repo"),
  maxTasksPerDay: 6,
  maxDeploysPerDay: 6,
  maxReviewRounds: 3,
  taskTimeoutMin: 45,
  reviewTimeoutMin: 20,
  monitorMin: 10,
  digest: true,
};

export function loadConfig(): PilotConfig {
  const p = join(homedir(), ".opencode-remote", "pilot.json");
  try {
    if (existsSync(p)) return { ...DEFAULTS, ...JSON.parse(readFileSync(p, "utf8")) };
  } catch {}
  return DEFAULTS;
}

// ── runtime state (counters) ──────────────────────────────────────────────────
const STATE_FILE = join(homedir(), ".opencode-remote", "pilot", "state.json");

export interface PilotState {
  date: string; // YYYY-MM-DD
  tasks: number;
  deploys: number;
  failures: number;
  redteamLast?: string;
  researchLast?: string;
}

export function loadState(): PilotState {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8")) as PilotState;
    const today = nowLocalISO().slice(0, 10);
    if (s.date === today) return s;
    return { date: today, tasks: 0, deploys: 0, failures: 0 };
  } catch {
    return { date: nowLocalISO().slice(0, 10), tasks: 0, deploys: 0, failures: 0 };
  }
}

export function saveState(s: PilotState) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

export function frozen(): boolean {
  return existsSync(join(homedir(), ".opencode-remote", "pilot.lock"));
}

// ── singleton via pidfile ────────────────────────────────────────────────────
const PID_FILE = join(homedir(), ".opencode-remote", "pilot", "pilot.pid");

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Single-instance guard: if a previous pilot is still alive in the pidfile,
 * take it down (SIGTERM, 2s grace, SIGKILL) and record our pid. Prevents the
 * double-deploy bug caused by orphaned duplicates of the loop.
 */
export async function ensureSingleton(pidFile = PID_FILE): Promise<void> {
  try {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
        await new Promise((r) => setTimeout(r, 2_000));
        if (pidAlive(pid)) process.kill(pid, "SIGKILL");
        console.log(JSON.stringify({ ts: nowLocalISO(), level: "warn", msg: "stale pilot instance killed", data: { pid } }));
      } catch {
        // vanished between the liveness check and the signal — nothing to kill
      }
    }
  } catch {}
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, String(process.pid));
}

// ── heartbeat + self-watchdog ────────────────────────────────────────────────
const HEARTBEAT = join(homedir(), ".opencode-remote", "pilot", "heartbeat");

export function touchHeartbeat() {
  try {
    writeFileSync(HEARTBEAT, String(Date.now()));
  } catch {}
}

/** Self-watchdog: exits the process if the heartbeat went silent. KeepAlive restarts it. */
export function startWatchdog(maxSilenceMin = 3) {
  touchHeartbeat();
  setInterval(() => {
    try {
      const last = Number(readFileSync(HEARTBEAT, "utf8"));
      const silentMin = (Date.now() - last) / 60_000;
      if (silentMin > maxSilenceMin) {
        console.log(JSON.stringify({ ts: nowLocalISO(), level: "warn", msg: "watchdog: heartbeat stale, exiting for KeepAlive restart", data: { silentMin } }));
        process.exit(1);
      }
    } catch {}
  }, 60_000);
}
