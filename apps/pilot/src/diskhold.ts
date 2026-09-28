/**
 * eval-02 — disk hold: disk exhaustion must never take the fleet down again.
 *
 * 2026-09-24 the volume holding ~/.opencode-remote (and, back then,
 * opencode.db) reached 0 bytes. The deploy disk guard (P3-006) had refused for
 * 12h, but nothing stopped the 8 slots from filling the rest — and then every
 * write turned fatal: `pilot fatal … ENOSPC … pilot.pid` at each KeepAlive
 * relaunch, an ENOSPC out of the crash path's saveState that skipped the 30s
 * cool-down (763 eager-fill re-picks of one task in ~2min), and a heartbeat
 * write that failed silently until the watchdog killed a live loop.
 *
 * This module is the proactive half. Before any work the loop reads free space
 * on every volume the fleet writes (pilot state, prod checkout, the RESOLVED
 * opencode.db — a symlink onto another volume since 24/09 — and the temp dir)
 * and folds the WORST reading into a hysteresis state:
 *   ok        normal operation
 *   low       < 10 GiB: no new pipelines, no nightly/aux agents; in-flight
 *             pipelines finish and deploys keep their own 5 GiB guard
 *   critical  < 5 GiB, or a write just failed with ENOSPC: nothing new starts,
 *             no deploys — the loop only probes, sweeps and feeds the heartbeat
 * It resumes by itself once the worst volume is back above the threshold plus a
 * 2 GiB margin, so the edge never flaps. Exactly one alert per transition.
 *
 * Pure core (readings, clock and hooks injected, like guardalert.ts); the only
 * fs is readVolume in disk.ts. OCR_DISK_FULL=1 / OCR_DISK_OK=1 force the
 * verdict — the same documented hatches the daemon honors (P2-215/P2-347).
 */
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { defaultOpencodeDb } from "./costs";
import { DISK_MIN_FREE_BYTES, formatGb, isDiskFullError, readVolume, type VolumeProbe, type VolumeReading } from "./disk";
import { emit } from "./events";
import { log } from "./log";
import { notifySupervisor } from "./notify";
import { digest } from "./push";
import { touchHeartbeat } from "./state";

const GIB = 1024 ** 3;

export interface DiskHoldThresholds {
  /** Below this the fleet starts no new work. */
  lowBytes: number;
  /** Below this nothing new starts at all (deploys included). */
  criticalBytes: number;
  /** Hysteresis: a level is left only this far above its threshold. */
  marginBytes: number;
}

export const DISK_HOLD_THRESHOLDS: DiskHoldThresholds = {
  lowBytes: 10 * GIB,
  // the deploy guard's floor (P3-006): below it a deploy is refused anyway, so
  // the loop stops asking (the 24/09 refusal + notify spam, 72 in one night)
  criticalBytes: DISK_MIN_FREE_BYTES,
  marginBytes: 2 * GIB,
};

/** Loop sleep while critical (the heartbeat is fed on every tick). */
export const DISK_HOLD_TICK_MS = 30_000;
/** A runtime ENOSPC keeps the hold critical at least this long, whatever statfs says. */
export const DISK_FORCED_HOLD_MS = 10 * 60_000;
/** A hold that outlives this re-alerts (12/09 → 22/09: one missed signal = 10 days down). */
export const DISK_HOLD_REMIND_MS = 6 * 60 * 60_000;

export type DiskLevel = "ok" | "low" | "critical";
export type DiskTransition = "enter" | "escalate" | "deescalate" | "resume" | "remind";

export interface DiskHold {
  level: DiskLevel;
  /** Epoch ms the current non-ok episode began; null while ok. */
  since: number | null;
  /** Epoch ms until which a runtime ENOSPC keeps the level critical. */
  forcedUntil: number;
  /** The binding (least-free) reading of the last probe. */
  worst: { label: string; path: string; freeBytes: number } | null;
  /** What failed with ENOSPC when the hold was forced (alert text). */
  forcedBy: string | null;
  /** Epoch ms of the last alerting transition (enter/escalate/remind). */
  alertedAt: number | null;
}

export function initialDiskHold(): DiskHold {
  return { level: "ok", since: null, forcedUntil: 0, worst: null, forcedBy: null, alertedAt: null };
}

const SEVERITY: Record<DiskLevel, number> = { ok: 0, low: 1, critical: 2 };

/** Hysteresis rule for one binding reading. */
export function diskLevelFor(freeBytes: number, prev: DiskLevel, t: DiskHoldThresholds = DISK_HOLD_THRESHOLDS): DiskLevel {
  if (freeBytes < t.criticalBytes) return "critical";
  if (prev === "critical" && freeBytes < t.criticalBytes + t.marginBytes) return "critical";
  if (freeBytes < t.lowBytes) return "low";
  if (prev !== "ok" && freeBytes < t.lowBytes + t.marginBytes) return "low";
  return "ok";
}

/** The binding reading: least free bytes among the readable volumes. */
export function worstReading(readings: VolumeReading[]): DiskHold["worst"] {
  let worst: DiskHold["worst"] = null;
  for (const r of readings) {
    if (r.freeBytes === null || !Number.isFinite(r.freeBytes) || r.freeBytes < 0) continue;
    if (!worst || r.freeBytes < worst.freeBytes) worst = { label: r.label, path: r.path, freeBytes: r.freeBytes };
  }
  return worst;
}

/** Transitions that alert the operator (de-escalation is log-only). */
function alerting(t: DiskTransition | null): boolean {
  return t === "enter" || t === "escalate" || t === "remind";
}

function transitionOf(prev: DiskLevel, next: DiskLevel): DiskTransition | null {
  if (prev === next) return null;
  if (next === "ok") return "resume";
  if (prev === "ok") return "enter";
  return SEVERITY[next] > SEVERITY[prev] ? "escalate" : "deescalate";
}

/**
 * Fold one probe into the hold. No readable volume = no evidence: the level
 * neither enters nor leaves a hold on a failed statfs (the P3-006 fail-open
 * stance for entering, fail-closed for leaving).
 */
export function stepDiskHold(
  prev: DiskHold,
  readings: VolumeReading[],
  now: number,
  t: DiskHoldThresholds = DISK_HOLD_THRESHOLDS,
  remindMs: number = DISK_HOLD_REMIND_MS,
): { hold: DiskHold; transition: DiskTransition | null } {
  const worst = worstReading(readings);
  const forced = now < prev.forcedUntil;
  const level: DiskLevel = forced ? "critical" : worst ? diskLevelFor(worst.freeBytes, prev.level, t) : prev.level;
  let transition = transitionOf(prev.level, level);
  if (!transition && level !== "ok" && prev.alertedAt !== null && now - prev.alertedAt >= remindMs) transition = "remind";
  const hold: DiskHold =
    level === "ok"
      ? { level, since: null, forcedUntil: 0, worst: worst ?? prev.worst, forcedBy: null, alertedAt: null }
      : {
          level,
          since: prev.since ?? now,
          forcedUntil: prev.forcedUntil,
          worst: worst ?? prev.worst,
          forcedBy: forced ? prev.forcedBy : null,
          alertedAt: alerting(transition) ? now : prev.alertedAt,
        };
  return { hold, transition };
}

/** A write failed with ENOSPC: critical now, and for at least `holdMs`. */
export function forceDiskHold(
  prev: DiskHold,
  now: number,
  what: string,
  holdMs: number = DISK_FORCED_HOLD_MS,
): { hold: DiskHold; transition: DiskTransition | null } {
  const transition = transitionOf(prev.level, "critical");
  const hold: DiskHold = {
    ...prev,
    level: "critical",
    since: prev.since ?? now,
    forcedUntil: Math.max(prev.forcedUntil, now + holdMs),
    forcedBy: what.replace(/\s+/g, " ").trim().slice(0, 120),
    alertedAt: alerting(transition) ? now : prev.alertedAt,
  };
  return { hold, transition };
}

/** One-line alert/log text for a transition (the event feed caps at 220 chars). */
export function diskHoldDetail(
  prev: DiskHold,
  next: DiskHold,
  transition: DiskTransition,
  now: number,
  t: DiskHoldThresholds = DISK_HOLD_THRESHOLDS,
): string {
  const where = next.worst ? `${formatGb(next.worst.freeBytes)}gb free on ${next.worst.label}` : "free space unreadable";
  if (transition === "resume") {
    const mins = prev.since === null ? 0 : Math.max(0, Math.round((now - prev.since) / 60_000));
    return `disk ok again: ${where} — fleet resumed after ${mins}min on hold`;
  }
  if (transition === "remind") {
    const hours = next.since === null ? 0 : Math.max(0, Math.round((now - next.since) / 3_600_000));
    return `disk hold still ${next.level} after ${hours}h — ${where}; resumes by itself at ${formatGb(t.lowBytes + t.marginBytes)}gb`;
  }
  const what =
    next.level === "critical"
      ? "critical: nothing new starts, no deploys"
      : "low: no new pipelines or nightly/aux agents";
  const forced = next.forcedBy && now < next.forcedUntil ? ` (write failed: ${next.forcedBy.slice(0, 60)})` : "";
  return `disk hold ${what} — ${where}${forced}; resumes by itself at ${formatGb(t.lowBytes + t.marginBytes)}gb`;
}

// ── IO seams ─────────────────────────────────────────────────────────────────

export type DiskHatch = "full" | "ok" | null;

/** The daemon's documented hatches (P2-215/P2-347): OCR_DISK_FULL wins. */
export function diskHatch(env: NodeJS.ProcessEnv = process.env): DiskHatch {
  if (env.OCR_DISK_FULL === "1") return "full";
  if (env.OCR_DISK_OK === "1") return "ok";
  return null;
}

/** Test seam: OCR_DISK_HOLD_TICK_MS shortens the hold tick (clamped 100ms–10min). */
export function diskHoldTickMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.OCR_DISK_HOLD_TICK_MS);
  if (!Number.isFinite(n) || n <= 0) return DISK_HOLD_TICK_MS;
  return Math.min(Math.max(Math.floor(n), 100), 10 * 60_000);
}

/**
 * The volumes the fleet writes to. opencode.db is resolved through its symlink
 * (24/09: ~/.local/share/opencode/opencode.db → the SSD) — the builders' +4–8
 * GB/day land THERE, not on the pilot's own volume. Same-volume paths are kept
 * (the min is what binds); readFleetVolumes drops duplicates by device id.
 */
export function fleetVolumes(o: { stateRoot: string; repo: string; opencodeDb?: string; tmp?: string }): VolumeProbe[] {
  const db = o.opencodeDb ?? defaultOpencodeDb();
  let dbDir = dirname(db);
  try {
    dbDir = dirname(realpathSync(db));
  } catch {}
  return [
    { label: "pilot state", path: o.stateRoot },
    { label: "prod checkout", path: o.repo },
    { label: "opencode db", path: dbDir },
    { label: "temp dir", path: o.tmp ?? tmpdir() },
  ];
}

export interface DiskHoldIo {
  read?: (v: VolumeProbe) => Promise<VolumeReading>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Heartbeat feeder while waiting (default: state.ts touchHeartbeat). */
  touch?: () => void;
  alert?: (transition: DiskTransition, detail: string, hold: DiskHold) => void;
  logFn?: typeof log;
  forcedHoldMs?: number;
}

export async function readFleetVolumes(volumes: VolumeProbe[], io: DiskHoldIo = {}): Promise<VolumeReading[]> {
  const hatch = diskHatch(io.env ?? process.env);
  if (hatch === "full") return volumes.map((v) => ({ ...v, freeBytes: 0, dev: null }));
  if (hatch === "ok") return volumes.map((v) => ({ ...v, freeBytes: 100 * DISK_HOLD_THRESHOLDS.lowBytes, dev: null }));
  const read = io.read ?? readVolume;
  const out: VolumeReading[] = [];
  const seen = new Set<number>();
  for (const v of volumes) {
    let r: VolumeReading;
    try {
      r = await read(v);
    } catch {
      r = { ...v, freeBytes: null, dev: null };
    }
    if (r.dev !== null) {
      if (seen.has(r.dev)) continue;
      seen.add(r.dev);
    }
    out.push(r);
  }
  return out;
}

/** Operator-notification kinds: "disk-hold" for enter/escalate/remind,
 * "disk-resume" when space is back (distinct keys, so a per-kind cooldown
 * can never swallow the resume that follows a hold). */
export type DiskNotifyKind = "disk-hold" | "disk-resume";
export type DiskNotify = (kind: DiskNotifyKind, detail: string) => unknown;

/** What exists on main today: the supervisor notify. */
export function supervisorDiskNotify(kind: DiskNotifyKind, detail: string): unknown {
  return notifySupervisor("pilot-disk", kind === "disk-resume", detail);
}

/**
 * Default alert seam — feed event + operator notify + (optional) phone push
 * per enter/escalate/resume and every 6h while a hold lasts (de-escalation is
 * log-only). eval-01 owns the delivery: its notifyOperator(task, kind, detail)
 * plugs in as `notify` (and already pushes, so `push` goes false) — the one
 * line to switch in index.ts. Never throws.
 */
export function diskAlert(
  push: boolean,
  notify: DiskNotify = supervisorDiskNotify,
): (transition: DiskTransition, detail: string, hold: DiskHold) => void {
  return (transition, detail, hold) => {
    if (transition === "deescalate") return;
    const resumed = transition === "resume";
    const kind: DiskNotifyKind = resumed ? "disk-resume" : "disk-hold";
    try {
      emit("alert", { task: "disk", phase: kind, ok: resumed, detail });
    } catch {}
    try {
      void Promise.resolve(notify(kind, detail)).catch(() => {});
    } catch {}
    if (!push) return;
    const title = resumed
      ? "💾 Pilot: espaço em disco liberado"
      : transition === "remind"
        ? "💾 Pilot segue pausado: disco"
        : hold.level === "critical"
          ? "💾 Pilot pausado: disco quase cheio"
          : "💾 Pilot: pouco espaço em disco";
    try {
      void Promise.resolve(digest(title, detail.slice(0, 120), "#/")).catch(() => {});
    } catch {}
  };
}

function announce(prev: DiskHold, next: DiskHold, transition: DiskTransition, now: number, io: DiskHoldIo): void {
  const detail = diskHoldDetail(prev, next, transition, now);
  try {
    (io.logFn ?? log)(transition === "resume" ? "info" : "warn", transition === "resume" ? "disk hold released" : "disk hold", {
      level: next.level,
      transition,
      worst: next.worst,
      forcedBy: next.forcedBy,
      detail,
    });
  } catch {}
  try {
    (io.alert ?? diskAlert(false))(transition, detail, next);
  } catch {}
}

/** Probe every volume, fold the worst reading in, announce a transition. */
export async function pollDiskHold(
  prev: DiskHold,
  volumes: VolumeProbe[],
  io: DiskHoldIo = {},
): Promise<{ hold: DiskHold; transition: DiskTransition | null }> {
  const readings = await readFleetVolumes(volumes, io);
  const now = (io.now ?? Date.now)();
  const step = stepDiskHold(prev, readings, now);
  if (step.transition) announce(prev, step.hold, step.transition, now, io);
  return step;
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 80);
}

/**
 * Fold a runtime failure into the hold: an ENOSPC-class error forces critical
 * (announced once — an already-critical hold only extends its window);
 * anything else leaves the hold untouched and reports forced=false.
 */
export function noteDiskFailure(
  prev: DiskHold,
  err: unknown,
  what: string,
  io: DiskHoldIo = {},
): { hold: DiskHold; forced: boolean } {
  if (!isDiskFullError(err)) return { hold: prev, forced: false };
  const now = (io.now ?? Date.now)();
  const step = forceDiskHold(prev, now, `${what}: ${errText(err)}`, io.forcedHoldMs);
  if (step.transition) announce(prev, step.hold, step.transition, now, io);
  return { hold: step.hold, forced: true };
}

/**
 * Probe → feed the heartbeat → sleep, for as long as the hold is critical;
 * returns the first non-critical hold. Shared by the boot gate and by the
 * disk-full fatal path (index.ts), which must both outlive a full disk
 * instead of exiting into a KeepAlive relaunch that meets the same disk.
 */
export async function waitWhileDiskCritical(prev: DiskHold, volumes: VolumeProbe[], io: DiskHoldIo = {}): Promise<DiskHold> {
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const touch = io.touch ?? touchHeartbeat;
  const tick = diskHoldTickMs(io.env ?? process.env);
  let hold = prev;
  for (;;) {
    hold = (await pollDiskHold(hold, volumes, io)).hold;
    if (hold.level !== "critical") return hold;
    try {
      touch();
    } catch {}
    await sleep(tick);
  }
}

/**
 * Boot gate. The pidfile write (ensureSingleton) is the first write of every
 * boot, and on 24/09 it threw ENOSPC at each KeepAlive relaunch (~14 times, 30s
 * apart). Nothing is written while the disk is critical; an ENOSPC out of
 * `firstWrite` forces the hold and waits again instead of `pilot fatal`.
 * Any other error propagates unchanged (crash-only contract).
 */
export async function bootDiskGate(volumes: VolumeProbe[], firstWrite: () => Promise<void>, io: DiskHoldIo = {}): Promise<DiskHold> {
  let hold = initialDiskHold();
  for (;;) {
    hold = await waitWhileDiskCritical(hold, volumes, io);
    try {
      await firstWrite();
      return hold;
    } catch (err) {
      const noted = noteDiskFailure(hold, err, "boot write", io);
      if (!noted.forced) throw err;
      hold = noted.hold;
    }
  }
}

/** Run a persistence step that must never throw out of a crash/cleanup path. */
export function persistSafely(write: () => void, onError: (err: unknown) => void): boolean {
  try {
    write();
    return true;
  } catch (err) {
    try {
      onError(err);
    } catch {}
    return false;
  }
}
