import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { nowLocalISO } from "./log";
import { homedir } from "node:os";

export interface PilotConfig {
  repo: string; // production checkout (runs the services)
  workspace: string; // pilot clone where agents work (slot 1 when slots > 1)
  /** P1-006: concurrent pipeline slots; deploys stay serial. */
  slots: number;
  maxTasksPerDay: number;
  maxDeploysPerDay: number;
  maxReviewRounds: number;
  maxAttemptsPerTask: number;
  taskTimeoutMin: number;
  reviewTimeoutMin: number;
  monitorMin: number;
  digest: boolean;
  /** P3-033: record golden-corpus gate samples every N successful merges. */
  corpusEveryNMerges: number;
  /** P1-059: tiered cognition — optional; absent block = everything tier A. */
  models?: ModelsConfig;
}

// ── P1-059: tiered cognition (strong models plan/judge, flash executes) ──────

/** Judgment roles: may be dispatched to a stronger model via the claude CLI. */
export type TierBRole = "strategist" | "planner" | "forensic" | "reviewerEscalation";
/** Execution roles: always run the configured opencode model. Names in tierA
 * are documentation only — tier A dispatch never changes binaries. */
export type TierARole = "builder" | "reviewer" | "scribe";
export type TierBModels = Partial<Record<TierBRole, string>>;
export type TierAModels = Partial<Record<TierARole, string>>;

export interface ModelsConfig {
  tierA?: TierAModels;
  tierB?: TierBModels;
}

/**
 * P1-059: tolerant parse of the `models` pilot.json block. Only string values
 * on the known role keys survive; anything else (garbage, wrong types, empty
 * strings) is dropped. A block that yields no usable entry is undefined, which
 * resolves every role to tier A — the pre-P1-059 behavior.
 */
export function normalizeModels(m: unknown): ModelsConfig | undefined {
  if (!m || typeof m !== "object") return undefined;
  const raw = m as { tierA?: unknown; tierB?: unknown };
  const pick = (v: unknown): Record<string, string> | undefined => {
    if (!v || typeof v !== "object") return undefined;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string" && val.trim()) out[k] = val.trim();
    }
    return Object.keys(out).length ? out : undefined;
  };
  const tierA = pick(raw.tierA) as TierAModels | undefined;
  const tierB = pick(raw.tierB) as TierBModels | undefined;
  if (!tierA && !tierB) return undefined;
  return { tierA, tierB };
}

/** Tier B model configured for a role, if any — the whole dispatch decision. */
export function tierBModelFor(models: ModelsConfig | undefined, role: TierBRole): string | undefined {
  return models?.tierB?.[role];
}

export const DEFAULTS: PilotConfig = {
  repo: process.env.OCR_PILOT_REPO ?? "/Volumes/SSD Major/Major/opencode-remote",
  // P1-006: legacy key — the scheduler derives per-slot paths (pilot/repo-1,
  // repo-2…) and overwrites `workspace` in every PilotConfig it hands out.
  // A `workspace` set in pilot.json is ignored.
  workspace: join(homedir(), ".opencode-remote/pilot/repo-1"),
  slots: 1,
  maxTasksPerDay: 6,
  maxDeploysPerDay: 6,
  maxReviewRounds: 3,
  maxAttemptsPerTask: 4,
  taskTimeoutMin: 45,
  reviewTimeoutMin: 20,
  monitorMin: 10,
  digest: true,
  corpusEveryNMerges: 5,
};

/** P1-006: scheduler slot count — 1 (serial, default) up to a hard cap of 8. */
export function clampSlots(n: unknown): number {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1) return 1;
  return Math.min(v, 8);
}

export function loadConfig(): PilotConfig {
  const p = join(homedir(), ".opencode-remote", "pilot.json");
  try {
    if (existsSync(p)) {
      const cfg = { ...DEFAULTS, ...JSON.parse(readFileSync(p, "utf8")) } as PilotConfig;
      if (!Number.isFinite(cfg.maxAttemptsPerTask) || cfg.maxAttemptsPerTask < 1)
        cfg.maxAttemptsPerTask = DEFAULTS.maxAttemptsPerTask;
      if (!Number.isFinite(cfg.corpusEveryNMerges) || cfg.corpusEveryNMerges < 1)
        cfg.corpusEveryNMerges = DEFAULTS.corpusEveryNMerges;
      cfg.slots = clampSlots(cfg.slots);
      // P1-059: tolerate garbage in the models block — invalid content behaves
      // exactly like an absent block (everything tier A)
      const models = normalizeModels(cfg.models);
      if (models) cfg.models = models;
      else delete cfg.models;
      return cfg;
    }
  } catch {}
  return DEFAULTS;
}

// ── runtime state (counters) ──────────────────────────────────────────────────
const STATE_FILE = join(homedir(), ".opencode-remote", "pilot", "state.json");

/** P2-032: one pipeline outcome in the fever sliding window. */
export interface CycleSample {
  ok: boolean;
  at: number; // epoch ms
  /** P2-063: task id that produced this outcome (absent on pipeline-level
   * crashes with no task, and on legacy samples written before P2-063). */
  task?: string;
}

/** P2-032: fever audit mode — the scheduler-wide pause state. */
export interface AuditMode {
  since: string; // ISO timestamp of when it tripped
  reason: string; // which trigger fired
  lastFailure: number; // epoch ms of the most recent failure (drives the 2h resume)
}

export interface PilotState {
  date: string; // YYYY-MM-DD
  tasks: number;
  deploys: number;
  failures: number;
  /** P2-045: successful merges today — the honest dashboard MERGES counter. */
  merges: number;
  /** P1-074: infra-signature pipeline failures today (API down, spawn error,
   * timeout without output). Diagnostic counter only — never merit evidence:
   * burns no attempt and feeds no fever window. Resets at the daily rollover. */
  infraFails?: number;
  /** P1-014 stop-loss: pipeline failures per task id (circuit breaker). */
  taskAttempts: Record<string, number>;
  redteamLast?: string;
  researchLast?: string;
  /** P3-052: last YYYY-MM-DD the nightly explorer ran (once per day). */
  explorerLast?: string;
  /** P1-059: last date the weekly tier-B forensic taxonomy ran (own 7-day guard). */
  forensicLast?: string;
  /** P2-032: sliding window of recent pipeline outcomes (fever rate). */
  cycles?: CycleSample[];
  /** P2-032: epoch ms timestamps of blocks that landed on main (30min burst). */
  blockEvents?: number[];
  /** P2-032: active audit mode (queue paused) or null when healthy. */
  auditMode?: AuditMode | null;
  /** P3-033: successful merges since the last golden-corpus capture. */
  mergesSinceCorpus?: number;
  /** P2-045: last audit-mode doctor summary (formatDiagnosis) shown on the dash chip. */
  auditDiagnosis?: string;
  /** P2-028: task id → total tokens (input+output+cache) across all the agent
   * sessions the task consumed, from the local opencode.db. Best-effort signal
   * (ids are captured from agent stdout; cost prioritization only — no gate
   * consumes it), read with sqlite3 -readonly. Not a daily budget: persists
   * across midnight rollovers and is pruned by tasks.ts cap. */
  taskCosts?: Record<string, number>;
  /** P2-028: task id → session ids already reflected in taskCosts (dedupes the
   * recompute; a resumed builder session keeps the same id across rounds). */
  taskCostSessions?: Record<string, string[]>;
  /** P1-077: task id → provider prefix-cache token breakdown across the task's
   * agent sessions (input = non-cached input, cacheRead = provider cache hits,
   * cacheWrite = tokens written to the provider cache). Folded by the same
   * REPLACE-by-recompute reconciliation as taskCosts; hit ratio is
   * cacheRead/(cacheRead+input). Lifetime record, pruned with taskCosts. */
  taskCache?: Record<string, { input: number; cacheRead: number; cacheWrite: number }>;
  /** P1-078: slot number → provider prefix-cache breakdown of the most recent
   * task reconciled in that slot (live window, replaced per task). Proof
   * surface for the slot-affinity/stagger effect; best-effort like taskCache. */
  slotCache?: Record<number, { input: number; cacheRead: number; cacheWrite: number }>;
  /** P1-095: epoch ms of the last pipeline cycle (any outcome). Drives the
   * nightly idle-window trigger — undefined means idle since forever (due). */
  lastCycleAt?: number;
  /** P1-095: today's "nightly skipped" record (once per day; cleared when the
   * pass actually starts). Surfaced to Mission Control via /api/pilot-events. */
  nightlySkipped?: { date: string; reason: string } | null;
  /** P1-079: context-pressure samples per task, one per builder round (pct =
   * session tokens vs the model window). Bounded to the last 8 samples per
   * task by recordContextPressure; diagnostic signal only. */
  contextPressure?: Record<string, { round: number; pct: number; at: string }[]>;
}

function normalizeAudit(a: unknown): AuditMode | null {
  if (!a || typeof a !== "object") return null;
  const m = a as Partial<AuditMode>;
  if (typeof m.reason !== "string" || !m.reason) return null;
  return {
    since: typeof m.since === "string" ? m.since : "",
    reason: m.reason,
    lastFailure: typeof m.lastFailure === "number" ? m.lastFailure : 0,
  };
}

/** P1-095: tolerant parse of the nightly skip record — garbage → null. */
function normalizeNightlySkipped(v: unknown): { date: string; reason: string } | null {
  if (!v || typeof v !== "object") return null;
  const m = v as Partial<{ date: string; reason: string }>;
  if (typeof m.date !== "string" || !m.date || typeof m.reason !== "string" || !m.reason) return null;
  return { date: m.date, reason: m.reason };
}

/** P1-079: tolerant parse of the context-pressure samples — garbage dropped. */
function normalizeContextPressure(
  v: unknown,
): Record<string, { round: number; pct: number; at: string }[]> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, { round: number; pct: number; at: string }[]> = {};
  for (const [task, samples] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(samples)) continue;
    const list = samples.filter(
      (s): s is { round: number; pct: number; at: string } =>
        !!s &&
        typeof s === "object" &&
        Number.isFinite((s as { round?: unknown }).round) &&
        Number.isFinite((s as { pct?: unknown }).pct),
    );
    if (list.length) out[task] = list.slice(-8);
  }
  return Object.keys(out).length ? out : undefined;
}

export function loadState(file = STATE_FILE): PilotState {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as PilotState;
    const today = nowLocalISO().slice(0, 10);
    // daily budgets reset at midnight; per-task attempts and the fever breaker
    // (P2-032) persist — neither breaker may be defeated by the date rollover
    const attempts = s.taskAttempts ?? {};
    // P2-045: legacy state files predate the daily merge counter
    const merges = typeof s.merges === "number" && Number.isFinite(s.merges) ? s.merges : 0;
    // P1-074: infra counter backfilled for legacy files, never NaN (resets at
    // the midnight rollover like the other daily counters — diagnostic only)
    const infraFails = typeof s.infraFails === "number" && Number.isFinite(s.infraFails) ? s.infraFails : 0;
    const shared = {
      taskAttempts: attempts,
      cycles: Array.isArray(s.cycles) ? s.cycles : [],
      blockEvents: Array.isArray(s.blockEvents) ? s.blockEvents.filter((t) => typeof t === "number") : [],
      auditMode: normalizeAudit(s.auditMode),
      // P2-028: token costs are lifetime records, not daily budgets — midnight
      // rollover must not wipe them
      taskCosts: s.taskCosts && typeof s.taskCosts === "object" ? s.taskCosts : {},
      taskCostSessions: s.taskCostSessions && typeof s.taskCostSessions === "object" ? s.taskCostSessions : {},
      // P1-077: cache breakdown backfilled for legacy files, never crash
      taskCache: s.taskCache && typeof s.taskCache === "object" ? s.taskCache : {},
      // P1-078: per-slot cache breakdown backfilled for legacy files
      slotCache: s.slotCache && typeof s.slotCache === "object" ? s.slotCache : {},
      // P1-095: idle-window trigger + nightly skip record survive midnight (the
      // timestamp stays a finite number or undefined — never NaN/garbage)
      lastCycleAt: typeof s.lastCycleAt === "number" && Number.isFinite(s.lastCycleAt) ? s.lastCycleAt : undefined,
      nightlySkipped: normalizeNightlySkipped(s.nightlySkipped),
      // P1-079: tolerant backfill of the context-pressure samples
      contextPressure: normalizeContextPressure(s.contextPressure),
    };
    if (s.date === today) return { ...s, ...shared, merges, infraFails };
    return { date: today, tasks: 0, deploys: 0, failures: 0, merges: 0, infraFails: 0, ...shared };
  } catch {
    return {
      date: nowLocalISO().slice(0, 10),
      tasks: 0,
      deploys: 0,
      failures: 0,
      merges: 0,
      infraFails: 0,
      taskAttempts: {},
      cycles: [],
      blockEvents: [],
      auditMode: null,
      taskCosts: {},
      taskCostSessions: {},
      taskCache: {},
      slotCache: {},
      nightlySkipped: null,
    };
  }
}

/**
 * P1-014 stop-loss: count one more pipeline failure for a task.
 * Returns true when the failure count reached maxAttempts (breaker trips).
 */
export function recordTaskFailure(state: PilotState, taskId: string, maxAttempts: number): boolean {
  const n = (state.taskAttempts[taskId] ?? 0) + 1;
  state.taskAttempts[taskId] = n;
  return n >= maxAttempts;
}

/** P2-024: fs surface writeJsonAtomic needs — injectable so unit tests are
 * hermetic (P3-013 pattern: fs wrappers with injectable io). */
export interface AtomicWriteIo {
  writeFileSync(file: string, data: string): void;
  renameSync(from: string, to: string): void;
  unlinkSync(file: string): void;
}

const realWriteIo: AtomicWriteIo = {
  writeFileSync: (file, data) => writeFileSync(file, data),
  renameSync: (from, to) => renameSync(from, to),
  unlinkSync: (file) => unlinkSync(file),
};

/**
 * P2-024: atomic JSON write — the payload lands in `<file>.tmp` and a rename
 * moves it over the destination (rename is atomic within the same filesystem),
 * so a crash/OOM/full disk mid-write can never leave a truncated file behind.
 * On any failure the .tmp is removed and the error rethrown: the caller decides
 * whether to retry or keep running with the last good state.
 */
export function writeJsonAtomic(file: string, value: unknown, io: AtomicWriteIo = realWriteIo): void {
  const tmp = `${file}.tmp`;
  try {
    io.writeFileSync(tmp, JSON.stringify(value, null, 2));
    io.renameSync(tmp, file);
  } catch (err) {
    try {
      io.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

export function saveState(s: PilotState, file: string = STATE_FILE) {
  writeJsonAtomic(file, s);
}

/** P1-030: the doctor's state subcommand repairs this exact file by default. */
export function defaultStateFile(): string {
  return STATE_FILE;
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

/**
 * P1-035: arms a periodic heartbeat feeder for long aux-agent awaits (the main
 * loop is blocked while a strategist/researcher/redteam run, so nothing else
 * touches the heartbeat). Returns an idempotent stop function. The injectable
 * `touch` keeps unit tests hermetic — no writes to the real heartbeat file.
 */
export function startHeartbeat(everyMs = 60_000, touch: () => void = touchHeartbeat): () => void {
  const timer = setInterval(touch, everyMs);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
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
