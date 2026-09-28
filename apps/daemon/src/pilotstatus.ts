// eval-19: the operator's one-glance fleet digest — GET /api/pilot-status
// (loopback, Bearer/cookie) and the sealed /__ocr/pilot-status (phone).
//
// The pilot was down 12/09→22/09 and again from 24/09 while the dashboard only
// painted a gold heartbeat age, Mission Control kept showing the in-flight
// cards as "running", the queue came from the (stale) production checkout and
// nothing surfaced the deploy lag, the disk hold, the cost or the undelivered
// alerts. The daemon is the observer that stays up when the pilot is gone, so
// it answers all of it from the pilot's own records:
//
//   pilot    heartbeat + pid probe + pid identity  → alive | stale | down | absent
//   deploy   prod HEAD vs the verified merges on origin/main → merges behind,
//            oldest pending, hold (the raw commit count stays informational)
//   disk     statfs of the prod volume  → free bytes vs the deploy guard floor
//   queue    BACKLOG.md of origin/main  → ready / blocked (checkout fallback)
//   cost     verified merges × ledgers  → tokens / USD / unpriced, 24h and 7d
//   alerts   notify-pending.jsonl       → undelivered supervisor notifications
//
// Every verdict is a pure function in apps/pilot/src/metrics.ts; this module
// only reads (git commands are read-only: rev-parse, log, show — never
// status/fetch, which could write the index or refs; the pid identity probe is
// a read-only `ps -o lstart=`). All I/O is injectable so the unit battery runs
// against a temp HOME.
import { execFile } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DISK_MIN_FREE_BYTES } from "../../pilot/src/disk";
import { parseQuarantine, parseVerifiedMerges } from "../../pilot/src/deployguard";
import type { PilotEvent } from "../../pilot/src/events";
import {
  DEPLOY_LAG_WALK_MAX,
  attentionFlags,
  costSummary,
  deployHold,
  deployLagFacts,
  pilotLiveness,
  type AttentionFlag,
  type CostSummary,
  type DeployHold,
  type LagCommit,
  type PilotLiveness,
} from "../../pilot/src/metrics";
import { queueView } from "./backlogview.js";

export const PILOT_STATUS_VERSION = 1;
/** git answers are cached this long — the digest is polled every few seconds. */
export const GIT_CACHE_MS = 60_000;
const DAY_MS = 24 * 3_600_000;

export interface PilotStatus {
  v: number;
  /** ISO instant the digest was computed */
  at: string;
  /** false on machines that never ran the pilot — every surface hides the digest */
  installed: boolean;
  pilot: PilotLiveness & { pid: number | null; pidAlive: boolean | null; lastEventAt: string | null };
  deploy: {
    prodSha: string | null;
    mainSha: string | null;
    /** verified merges on origin/main still pending in production (null =
     * unknown; the deploy target rule is the pilot's own — bookkeeping
     * commits after a merge never deploy alone, so a healthy idle fleet reads
     * 0, not 1–2) */
    behind: number | null;
    /** informational: ALL first-parent commits on origin/main after prod,
     * capped at DEPLOY_LAG_WALK_MAX (null = unknown) */
    behindTotal: number | null;
    /** committer date of the oldest pending verified merge */
    pendingSince: string | null;
    /** mtime of FETCH_HEAD — how fresh origin/main itself is */
    fetchedAt: string | null;
    hold: DeployHold | null;
  };
  disk: { freeBytes: number | null; totalBytes: number | null; minFreeBytes: number };
  queue: { ready: number; blocked: number; misplaced: number; source: "origin/main" | "checkout" | "none" };
  cost: { day: CostSummary; week: CostSummary };
  alerts: { undelivered: number; lastDeliveredAgeMs: number | null };
  attention: AttentionFlag[];
}

/** Runs one read-only git command in `cwd`; resolves stdout or null. */
export type GitRunner = (args: string[], cwd: string) => Promise<string | null>;

export interface PilotStatusDeps {
  /** HOME holding .opencode-remote/ (tests pass a temp dir) */
  home?: string;
  /** production checkout; null disables the git-derived fields */
  repo?: string | null;
  nowMs?: number;
  git?: GitRunner;
  /** pid probe: true alive, false gone, null unknown */
  pidAlive?: (pid: number) => boolean | null;
  /**
   * pid identity probe: when the recorded pid holds a LIVE process, when did
   * THAT process start (epoch ms; null = unknown)? `kill(pid, 0)` cannot say
   * the process is the pilot — on this host the pid space wraps every ~23 min,
   * so a dead pilot's pid is reassigned within hours, and a long-lived squatter
   * plus a third-party heartbeat write would resurrect it. The default probe
   * reads `ps -o lstart=` (read-only) and the caller compares it with the
   * pid file's mtime: ensureSingleton writes pilot.pid at boot, so the REAL
   * pilot must have started before that instant.
   */
  pidIdentity?: (pid: number) => Promise<number | null>;
  statfs?: (path: string) => { freeBytes: number; totalBytes: number } | null;
  /** seam for a daemon-side watchdog verdict; absent → heartbeat file + pid */
  liveness?: (facts: {
    heartbeatAtMs: number | null;
    pidAlive: boolean | null;
    nowMs: number;
    pidDeadForMs: number | null;
    lastActivityAtMs: number | null;
  }) => PilotLiveness;
}

const defaultGit: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 5_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });

/** `kill(pid, 0)` probes without signalling: ESRCH = gone, EPERM = alive (not ours). */
export function probePid(pid: number): boolean | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return null;
  }
}

/**
 * lstart answers in whole seconds, so a freshly booted pilot can appear up to
 * 1s "after" the pid file it wrote a moment earlier — never flag a mismatch
 * inside this window. A real reuse (the pilot lived for hours before dying)
 * exceeds it by hours.
 */
export const PID_IDENTITY_SKEW_MS = 3_000;

const LSTART_MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/**
 * The default identity probe: when did this pid's process start?
 * `ps -o lstart=` (read-only; etimes is not a macOS keyword) under LC_ALL=C so
 * the month name parses on every host locale. Returns null when the process is
 * gone or ps is missing — unknown never flips a verdict by itself. The answer
 * is only ever COMPARED with the pid file's mtime (same system clock), so no
 * absolute-time guard is needed here.
 */
export function defaultPidStart(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      { timeout: 2_000, windowsHide: true, env: { ...process.env, LC_ALL: "C" } },
      (err, stdout) => {
        if (err) return resolve(null);
        const p = String(stdout).trim().split(/\s+/);
        if (p.length !== 5 || !(p[1]! in LSTART_MONTHS) || !/^\d\d:\d\d:\d\d$/.test(p[3] ?? "")) return resolve(null);
        const [h, m, s] = (p[3] ?? "").split(":").map(Number);
        const d = new Date(Number(p[4]), LSTART_MONTHS[p[1]!]!, Number(p[2]), h, m, s);
        resolve(Number.isFinite(d.getTime()) ? d.getTime() : null);
      },
    );
  });
}

interface PidIdentityCacheEntry {
  mtimeMs: number;
  startMs: number | null;
}
/** pid → the identity answer for the pid file with that mtime (one ps per
 * daemon lifetime per pid file generation; the pid file only changes at boot). */
const pidIdentityCache = new Map<number, PidIdentityCacheEntry>();

async function pidStartFor(
  pid: number,
  mtimeMs: number,
  probe: (pid: number) => Promise<number | null>,
): Promise<number | null> {
  const hit = pidIdentityCache.get(pid);
  if (hit && hit.mtimeMs === mtimeMs) return hit.startMs;
  let startMs: number | null = null;
  try {
    startMs = await probe(pid);
  } catch {
    startMs = null;
  }
  pidIdentityCache.set(pid, { mtimeMs, startMs });
  return startMs;
}

function defaultStatfs(path: string): { freeBytes: number; totalBytes: number } | null {
  try {
    const s = statfsSync(path);
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

/**
 * The production checkout the pilot deploys into: OCR_PILOT_REPO (the pilot's
 * own override, set by its launchd plist) or the checkout this daemon runs
 * from. Null when neither is a git work tree (packaged desktop sidecar).
 */
export function defaultProdRepo(): string | null {
  const env = process.env.OCR_PILOT_REPO;
  if (env && existsSync(join(env, ".git"))) return env;
  try {
    if (typeof __dirname !== "undefined") return null; // CJS sidecar bundle: no checkout
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    return existsSync(join(root, ".git")) ? root : null;
  } catch {
    return null;
  }
}

/**
 * The last `maxLines` complete lines of a file, reading at most `maxBytes`
 * from its end. /api/pilot-events used to read the WHOLE pilot.log (10.4 MB on
 * 2026-09-27, ~24 ms of blocked event loop) on every 2s dashboard poll just to
 * keep its last 400 lines. A partial first line inside the window is dropped.
 * Missing/unreadable file → [].
 */
export function readTailLines(path: string, maxLines: number, maxBytes = 256 * 1024): string[] {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, Math.max(0, maxBytes));
    const buf = Buffer.alloc(len);
    const read = len > 0 ? readSync(fd, buf, 0, len, size - len) : 0;
    const lines = buf.subarray(0, read).toString("utf8").split("\n");
    if (len < size) lines.shift(); // the window cut the first line mid-way
    return lines.filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function jsonLines<T>(text: string | null): T[] {
  if (!text) return [];
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // a torn last line (writer mid-append) is skipped, never fatal
    }
  }
  return out;
}

function epochFile(path: string): number | null {
  const raw = readText(path);
  if (raw === null) return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

interface GitFacts {
  prodSha: string | null;
  mainSha: string | null;
  /** origin/main's first-parent history, newest first, stopped at prod (or
   * capped at DEPLOY_LAG_WALK_MAX) — the lag counts verified merges on it */
  history: LagCommit[];
  backlog: string | null;
}

const gitCache = new Map<string, { at: number; value: Promise<GitFacts> }>();
/** pid → first instant this daemon saw it dead (see pilotLiveness) */
const pidDeath = new Map<number, number>();

/** Test hook: forget cached git answers and pid observations. */
export function resetPilotStatusCache(): void {
  gitCache.clear();
  pidDeath.clear();
  pidIdentityCache.clear();
}

async function readGitFacts(repo: string, git: GitRunner): Promise<GitFacts> {
  const prod = (await git(["rev-parse", "HEAD"], repo))?.trim() || null;
  const main = (await git(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], repo))?.trim() || null;
  // the lag walk needs main's first-parent history down to prod — one read-only
  // `git log` answers it (rev-list --count over ALL commits counted bookkeeping
  // too, which kept a healthy idle fleet permanently 1–2 "behind")
  const history: LagCommit[] = [];
  if (prod && main && prod !== main) {
    const out = (await git(["log", "--first-parent", `--max-count=${DEPLOY_LAG_WALK_MAX}`, "--format=%H %ct", main], repo)) ?? "";
    for (const line of out.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const sp = t.indexOf(" ");
      const sha = t.slice(0, sp);
      const ct = Number(t.slice(sp + 1));
      if (!/^[0-9a-f]{7,40}$/.test(sha) || !Number.isFinite(ct)) continue;
      history.push({ sha, ct });
      if (sha === prod) break;
    }
  }
  // the pilot works origin/main's queue; the checkout's copy lags by the deploy lag
  const backlog = main ? await git(["show", `${main}:BACKLOG.md`], repo) : null;
  return { prodSha: prod, mainSha: main, history, backlog };
}

function gitFacts(repo: string, git: GitRunner, nowMs: number): Promise<GitFacts> {
  const hit = gitCache.get(repo);
  if (hit && nowMs - hit.at < GIT_CACHE_MS) return hit.value;
  const value = readGitFacts(repo, git).catch(
    (): GitFacts => ({ prodSha: null, mainSha: null, history: [], backlog: null }),
  );
  gitCache.set(repo, { at: nowMs, value });
  return value;
}

/** Queue counts from origin/main's BACKLOG.md, falling back to the checkout. */
function queueFrom(backlogOnMain: string | null, repo: string | null): PilotStatus["queue"] {
  if (backlogOnMain) {
    const v = queueView(backlogOnMain);
    return { ready: v.ready.length, blocked: v.blocked.length, misplaced: v.misplaced, source: "origin/main" };
  }
  const local = repo ? readText(join(repo, "BACKLOG.md")) : null;
  if (local) {
    const v = queueView(local);
    return { ready: v.ready.length, blocked: v.blocked.length, misplaced: v.misplaced, source: "checkout" };
  }
  return { ready: 0, blocked: 0, misplaced: 0, source: "none" };
}

/**
 * BACKLOG.md text for the dashboard's queue lists (/api/pilot-ready): the copy
 * on origin/main when the checkout has one, else the checkout's own file.
 */
export async function readQueueBacklog(deps: PilotStatusDeps = {}): Promise<string | null> {
  const repo = deps.repo === undefined ? defaultProdRepo() : deps.repo;
  if (!repo) return null;
  const facts = await gitFacts(repo, deps.git ?? defaultGit, deps.nowMs ?? Date.now());
  return facts.backlog ?? readText(join(repo, "BACKLOG.md"));
}

/** Build the digest from the real files (or the injected ones). Never throws. */
export async function readPilotStatus(deps: PilotStatusDeps = {}): Promise<PilotStatus> {
  const nowMs = deps.nowMs ?? Date.now();
  const home = deps.home ?? homedir();
  const root = join(home, ".opencode-remote");
  const dir = join(root, "pilot");
  const repo = deps.repo === undefined ? defaultProdRepo() : deps.repo;

  const heartbeatAtMs = epochFile(join(dir, "heartbeat"));
  const pidFile = join(dir, "pilot.pid");
  const pid = epochFile(pidFile);
  let pidAlive = pid === null ? null : (deps.pidAlive ?? probePid)(pid);
  if (pid !== null && pidAlive === true) {
    // A live kill(pid, 0) is not identity: on this host the pid space wraps
    // every ~23 min, so a dead pilot's pid is reassigned within hours — and a
    // long-lived squatter plus a third-party heartbeat write read as "alive"
    // (replay case B). ensureSingleton writes pilot.pid at boot, so the REAL
    // pilot's process must have started before that file's mtime; anything
    // born after it is a reuse → not the pilot → dead. Unknown (ps gone,
    // unparseable) never flips a verdict by itself.
    let pidFileMtimeMs: number | null = null;
    try {
      pidFileMtimeMs = statSync(pidFile).mtimeMs;
    } catch {
      pidFileMtimeMs = null;
    }
    if (pidFileMtimeMs !== null) {
      const startMs = await pidStartFor(pid, pidFileMtimeMs, deps.pidIdentity ?? defaultPidStart);
      if (startMs !== null && startMs > pidFileMtimeMs + PID_IDENTITY_SKEW_MS) pidAlive = false;
    }
  }
  let pidDeadForMs: number | null = null;
  if (pid !== null && pidAlive === false) {
    const first = pidDeath.get(pid) ?? nowMs;
    pidDeath.set(pid, first);
    pidDeadForMs = Math.max(0, nowMs - first);
  } else if (pid !== null) pidDeath.delete(pid);
  const installed = heartbeatAtMs !== null || existsSync(join(root, "pilot.json")) || existsSync(join(dir, "state.json"));

  // The pilot's last sign of life for a pid-dead verdict: logs/pilot.log is
  // written only by the pilot itself, so its mtime anchors the outage even
  // when third parties (in-chat agents, test runs) keep appending to
  // events.jsonl or touching the heartbeat. The newest events.jsonl ts is the
  // fallback when pilot.log is gone.
  let lastActivityAtMs: number | null = null;
  try {
    lastActivityAtMs = statSync(join(home, ".opencode-remote", "logs", "pilot.log")).mtimeMs;
  } catch {
    lastActivityAtMs = null;
  }
  const events = jsonLines<PilotEvent>(readText(join(dir, "events.jsonl")));
  const lastEventAt = events.length ? (events[events.length - 1]!.ts ?? null) : null;
  if (lastActivityAtMs === null && lastEventAt) {
    const t = Date.parse(lastEventAt);
    if (Number.isFinite(t) && t > 0) lastActivityAtMs = t;
  }
  const liveness = (deps.liveness ?? pilotLiveness)({
    heartbeatAtMs,
    pidAlive,
    nowMs,
    pidDeadForMs,
    lastActivityAtMs: lastActivityAtMs !== null && Number.isFinite(lastActivityAtMs) ? lastActivityAtMs : null,
  });

  const facts: GitFacts = repo
    ? await gitFacts(repo, deps.git ?? defaultGit, nowMs)
    : { prodSha: null, mainSha: null, history: [], backlog: null };
  let fetchedAt: string | null = null;
  if (repo) {
    try {
      fetchedAt = statSync(join(repo, ".git", "FETCH_HEAD")).mtime.toISOString();
    } catch {
      // never fetched here (or a worktree .git file) — freshness unknown
    }
  }
  const hold = deployHold(events);

  const disk = repo || existsSync(root) ? (deps.statfs ?? defaultStatfs)(repo ?? root) : null;

  let state: { taskCosts?: Record<string, number>; taskUSD?: Record<string, { total?: number; unpricedTokens?: number; tokens?: number }> } = {};
  try {
    state = JSON.parse(readText(join(dir, "state.json")) ?? "{}") as typeof state;
  } catch {
    state = {};
  }
  const merges = parseVerifiedMerges(readText(join(dir, "verified-merges.jsonl")) ?? "");
  const quarantined = parseQuarantine(readText(join(dir, "quarantine.jsonl")) ?? "");
  // the deploy lag is measured against the pilot's real deploy target: only
  // gate-verified merges after prod count (the pure rule lives in metrics.ts,
  // the same one latestDeployableSha walks with)
  const lag = deployLagFacts({
    prodSha: facts.prodSha,
    mainSha: facts.mainSha,
    history: facts.history,
    verified: merges,
    quarantined,
  });

  const pending = readText(join(dir, "notify-pending.jsonl"));
  const undelivered = pending ? pending.split("\n").filter((l) => l.trim()).length : 0;
  const notifyLast = epochFile(join(dir, "notify-last"));

  const status: PilotStatus = {
    v: PILOT_STATUS_VERSION,
    at: new Date(nowMs).toISOString(),
    installed,
    pilot: { ...liveness, pid, pidAlive, lastEventAt },
    deploy: {
      prodSha: facts.prodSha,
      mainSha: facts.mainSha,
      behind: lag.behind,
      behindTotal: lag.behindTotal,
      pendingSince: lag.pendingSinceMs === null ? null : new Date(lag.pendingSinceMs).toISOString(),
      fetchedAt,
      hold,
    },
    disk: { freeBytes: disk?.freeBytes ?? null, totalBytes: disk?.totalBytes ?? null, minFreeBytes: DISK_MIN_FREE_BYTES },
    queue: queueFrom(facts.backlog, repo),
    cost: { day: costSummary(merges, state, nowMs, DAY_MS), week: costSummary(merges, state, nowMs, 7 * DAY_MS) },
    alerts: { undelivered, lastDeliveredAgeMs: notifyLast === null ? null : Math.max(0, nowMs - notifyLast) },
    attention: [],
  };
  status.attention = attentionFlags({
    installed,
    pilot: status.pilot,
    deploy: { behind: lag.behind, pendingSinceMs: lag.pendingSinceMs, hold },
    disk: status.disk,
    alerts: status.alerts,
    nowMs,
  });
  return status;
}
