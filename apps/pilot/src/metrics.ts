/**
 * P2-045 — Dashboard v2 aggregations: honest metrics for the mission-control
 * dashboard. Pure functions over the pilot's own records (events.jsonl,
 * history.jsonl) so the eval battery can test every number the operator sees:
 *
 *  - countFailSteps: FALHAS por step (evidence/invariants/integration/…) from
 *    the structured `gate-fail` events recordGateFail emits;
 *  - burnDown: 7-day task burn-down from the P2-043 history.jsonl;
 *  - avgPhaseDurations: average wall time per pipeline phase (planner, builder,
 *    reviewers, gatekeeper) from phase transitions in the events feed.
 */
import { TZ } from "./log";
import type { PilotEvent } from "./events";

// P1-075 lesson-injection instrumentation — rebuilt by eval 05 in its own
// pure module; re-exported here for existing callers.
export { recordLessonImpact, runTokenDelta, type LessonImpactSample } from "./lessonimpact";

/** One P2-043 history.jsonl row: a task outcome with wall duration. */
export interface HistoryEntry {
  ts: string;
  id?: string;
  ok?: boolean;
  durMin?: number;
  attempts?: number;
}

/** A gate step that can reject a task (recordGateFail steps + review). */
export interface FailStep {
  step: string;
  count: number;
}

/** One burn-down bucket: tasks finished on that local day. */
export interface BurnDay {
  day: string; // YYYY-MM-DD in the pilot timezone
  ok: number;
  failed: number;
}

/** Average wall duration of one pipeline phase across completed runs. */
export interface PhaseDuration {
  phase: string;
  avgMs: number;
  n: number;
}

/** Local (GMT-3) YYYY-MM-DD key for an ISO timestamp. */
function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
}

/**
 * Group `gate-fail` events by step name. Counts every occurrence in the feed —
 * a task failing the same step twice counts twice, mirroring state.failures.
 * Sorted by count desc, then step name for stable rendering.
 */
export function countFailSteps(events: PilotEvent[]): FailStep[] {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.type !== "phase" || e.phase !== "gate-fail" || !e.detail) continue;
    counts.set(e.detail, (counts.get(e.detail) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([step, count]) => ({ step, count }))
    .sort((a, b) => b.count - a.count || a.step.localeCompare(b.step));
}

/**
 * 7-day burn-down from history.jsonl (P2-043): tasks finished per local day,
 * split ok/failed. Always returns exactly `days` buckets ending today
 * (zero-filled) so the chart doesn't shift when the pilot idles.
 */
export function burnDown(history: HistoryEntry[], days: number, now = new Date()): BurnDay[] {
  const counts = new Map<string, { ok: number; failed: number }>();
  for (const h of history ?? []) {
    if (!h || typeof h.ts !== "string" || !Number.isFinite(Date.parse(h.ts))) continue;
    const key = dayKey(h.ts);
    const b = counts.get(key) ?? { ok: 0, failed: 0 };
    if (h.ok) b.ok++;
    else b.failed++;
    counts.set(key, b);
  }
  const out: BurnDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const key = d.toLocaleDateString("en-CA", { timeZone: TZ });
    const b = counts.get(key) ?? { ok: 0, failed: 0 };
    out.push({ day: key, ok: b.ok, failed: b.failed });
  }
  return out;
}

/** A phase and the event that closes it (duration = close.ts - open.ts). */
const COMPLETES: Record<string, string> = {
  "planner-done": "planner",
  "builder-done": "builder",
  "reviewers-done": "reviewers",
  // P1-101: the gate runs BEFORE the reviewers now, so `gatekeeper-done` —
  // not `merge` — closes the gatekeeper phase.
  "gatekeeper-done": "gatekeeper",
};

/** P1-101: informational gate phases that must never open a tracked phase —
 * they fire between `gatekeeper` and `gatekeeper-done` and would otherwise
 * clobber the opener, breaking the pairing above. P3-355: the escalation
 * phases fire between `reviewers` and `reviewers-done` for the same reason.
 * P3-356: the nightly pseudo-task (`task: "nightly"`) emits one-off `run` /
 * `skipped` phase events — never openers either. */
const AUX_PHASES = new Set(["gate-flaky", "gate-fail", "review-escalation", "escalation", "run", "skipped"]);

/**
 * Average wall duration per pipeline phase, derived from phase transitions in
 * the events feed (planner→planner-done, …, gatekeeper→gatekeeper-done).
 * Review rounds are included in the builder/reviewers averages — that is real
 * operator time. Phases with no completed sample are omitted.
 */
export function avgPhaseDurations(events: PilotEvent[]): PhaseDuration[] {
  const totals = new Map<string, { sum: number; n: number }>();
  const open = new Map<string, { phase: string; at: number }>();
  for (const e of events) {
    if (e.type !== "phase" || !e.task || !e.phase) continue;
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t)) continue;
    const key = e.task;
    const closePhase = COMPLETES[e.phase];
    if (closePhase) {
      const o = open.get(key);
      if (o && o.phase === closePhase) {
        const b = totals.get(closePhase) ?? { sum: 0, n: 0 };
        b.sum += Math.max(0, t - o.at);
        b.n++;
        totals.set(closePhase, b);
      }
      open.delete(key);
    } else if (!AUX_PHASES.has(e.phase)) {
      // opener (planner/builder/reviewers/gatekeeper) or an untracked aux
      // phase — the next matching terminator closes it, stale opens never do.
      // P1-101: gate-flaky/gate-fail are ignored as openers so the
      // gatekeeper→gatekeeper-done pairing survives a red or flaky gate.
      open.set(key, { phase: e.phase, at: t });
    }
  }
  return [...totals.entries()]
    .map(([phase, { sum, n }]) => ({ phase, avgMs: Math.round(sum / n), n }))
    .sort((a, b) => b.n - a.n || a.phase.localeCompare(b.phase));
}

/**
 * P2-041: the post-rollback health verdict that should light the dashboard's
 * red "prod unhealthy" chip, or null when there is no active alert. The NEWEST
 * verdict wins: an unhealthy `rollback-health` event alerts, a healthy verdict
 * or a later clean deploy (phase `done`) clears it. Scans the full event feed
 * (like countFailSteps) so a 200-event tail cannot silently hide an alert.
 */
export function rollbackHealthAlert(events: PilotEvent[]): PilotEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== "deploy") continue;
    if (e.phase === "rollback-health") return e.ok === false ? e : null;
    if (e.phase === "done") return null;
  }
  return null;
}

// ── eval-19: operator status digest ────────────────────────────────────────
// The pilot was down 12/09→22/09 and again from 24/09 while every surface
// kept rendering it as merely "stale" (a gold HB age) and the forensic cards
// kept saying "running". These pure verdicts are what the daemon's
// /api/pilot-status digest, the dashboard chips and Mission Control (desktop
// and phone) all agree on — thresholds live here once.

/** A healthy pilot touches its heartbeat on every loop pass (5–20s) plus a
 * 60s timer while agents run, and its own watchdog exits after 3 min of
 * silence (state.ts startWatchdog) for KeepAlive to respawn it — so silence
 * past 5 min means nobody is feeding it. */
export const PILOT_ALIVE_MAX_MS = 5 * 60_000;
/** Silence past 30 min is an outage, not a restart hiccup. */
export const PILOT_DOWN_AFTER_MS = 30 * 60_000;
/** A dead pid only means "down" once KeepAlive had its chance to respawn
 * (ThrottleInterval 30s + boot); before that it is a restart in progress. */
export const PILOT_PID_GRACE_MS = 90_000;

export type PilotLivenessState = "alive" | "stale" | "down" | "absent";

export interface PilotLiveness {
  state: PilotLivenessState;
  /** ms since the last heartbeat; null when there is none. */
  heartbeatAgeMs: number | null;
  /** ISO of the pilot's last sign of life: the heartbeat, or — when the
   * recorded process is gone — its last recorded activity. */
  since: string | null;
  /** how long the pilot has been silent (what the UI calls "parado há") */
  silentForMs: number | null;
  /** static cause token — never free text */
  reason: "fresh" | "silent" | "pid-dead" | "no-heartbeat";
}

/**
 * Liveness verdict from the heartbeat file (epoch ms written by
 * touchHeartbeat) and an optional pid probe (null = unknown / not probed).
 * No heartbeat at all is "absent" — a machine that never ran the pilot, which
 * the UI hides instead of accusing. A future heartbeat (clock skew) reads as
 * age 0. Order: silence past PILOT_DOWN_AFTER_MS → down; a recorded pid that
 * has been dead past the respawn grace → down; silence past
 * PILOT_ALIVE_MAX_MS → stale; else alive.
 *
 * A fresh heartbeat does NOT outvote a dead pid: on 2026-09-27 test runs
 * with the real HOME kept rewriting pilot/heartbeat for a pilot dead since
 * 24/09. `pidDeadForMs` (how long the observer has seen that pid dead) makes
 * the grace survive such writes; without it the heartbeat age stands in.
 * `lastActivityAtMs` (newest events.jsonl ts) dates a pid-dead outage.
 */
export function pilotLiveness(input: {
  heartbeatAtMs: number | null;
  pidAlive: boolean | null;
  nowMs: number;
  pidDeadForMs?: number | null;
  lastActivityAtMs?: number | null;
}): PilotLiveness {
  const hb = input.heartbeatAtMs;
  if (hb === null || !Number.isFinite(hb) || hb <= 0) {
    return { state: "absent", heartbeatAgeMs: null, since: null, silentForMs: null, reason: "no-heartbeat" };
  }
  const age = Math.max(0, input.nowMs - hb);
  const since = new Date(hb).toISOString();
  if (age > PILOT_DOWN_AFTER_MS) return { state: "down", heartbeatAgeMs: age, since, silentForMs: age, reason: "silent" };
  const deadFor = Math.max(age, input.pidDeadForMs ?? 0);
  if (input.pidAlive === false && deadFor > PILOT_PID_GRACE_MS) {
    const act = input.lastActivityAtMs;
    const known = typeof act === "number" && Number.isFinite(act) && act > 0 && act <= input.nowMs;
    return {
      state: "down",
      heartbeatAgeMs: age,
      since: known ? new Date(act).toISOString() : since,
      silentForMs: known ? input.nowMs - act : deadFor,
      reason: "pid-dead",
    };
  }
  if (age > PILOT_ALIVE_MAX_MS) return { state: "stale", heartbeatAgeMs: age, since, silentForMs: age, reason: "silent" };
  return { state: "alive", heartbeatAgeMs: age, since, silentForMs: 0, reason: "fresh" };
}

/** A pending deploy the pilot refuses to run (guard chain in deploy.ts). */
export interface DeployHold {
  /** the refusing guard: sha-guard | disk-guard | dirty-guard | direction-guard */
  reason: string;
  /** the newest refusal's own detail (already bounded by emit) */
  detail: string;
  /** ISO of the newest refusal or backoff event */
  at: string;
  /** ISO when the pending-deploy backoff expires; null without a backoff */
  until: string | null;
  /** refusals of this kind since the last deploy that got past the guards */
  count: number;
}

const DEPLOY_GUARDS = new Set(["sha-guard", "disk-guard", "dirty-guard", "direction-guard"]);

/** Deploy phases that only exist once the guard chain let a deploy through. */
function deployProceeded(phase: string): boolean {
  return phase === "baseline" || phase === "install" || phase === "done" || phase === "rollback" || phase.startsWith("soak") || phase.startsWith("live-invariants");
}

/**
 * The deploy hold in force, or null. Walks the feed newest → oldest: the first
 * guard refusal or pending-deploy `backoff` found before any deploy that got
 * past the guards is the hold; a proceeding deploy (install/baseline/soak/
 * live-invariants/done/rollback) clears it. `start`, reload and shot events
 * are neutral — every attempt starts with `start` before its guard answers.
 * Before this the dashboard flashed the refusal as a 6s core tag, so a page
 * opened during the 23/09→24/09 disk hold (85 refusals) showed nothing.
 */
export function deployHold(events: PilotEvent[]): DeployHold | null {
  let hold: DeployHold | null = null;
  let backoffUntil: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== "deploy" || !e.phase) continue;
    if (deployProceeded(e.phase)) break;
    if (e.phase === "backoff" && !hold && backoffUntil === null) {
      const min = /paused (\d+)\s*min/.exec(e.detail ?? "");
      const at = Date.parse(e.ts);
      if (min && Number.isFinite(at)) backoffUntil = new Date(at + Number(min[1]) * 60_000).toISOString();
      continue;
    }
    if (!DEPLOY_GUARDS.has(e.phase) || e.ok !== false) continue;
    if (!hold) hold = { reason: e.phase, detail: e.detail ?? "", at: e.ts, until: backoffUntil, count: 1 };
    else if (hold.reason === e.phase) hold.count++;
  }
  return hold;
}

/** One verified merge (pilot/verified-merges.jsonl row). */
export interface MergeRecord {
  task?: string;
  at?: string;
}

/** Cost of the tasks merged inside a window — read from the P2-028/P2-113
 * per-task ledgers (state.taskCosts / state.taskUSD). */
export interface CostSummary {
  windowMs: number;
  merges: number;
  tokens: number;
  /** priced USD (BYOK list price, P2-113); null when nothing was priced */
  usd: number | null;
  /** tokens from models absent from the price table — never priced as $0 */
  unpricedTokens: number;
}

/**
 * Tokens and dollars of the tasks merged in the last `windowMs`, one count per
 * task (a task merged twice counts once). The ledgers are per task across all
 * its attempts, so this is "what the merges of the window cost", not a
 * wall-clock burn. Merge timestamps come from verified-merges.jsonl because
 * state.cycles keeps only the last 10 outcomes. Unpriced tokens stay visible
 * instead of collapsing into a fake $0 (the whole fleet runs on a model that
 * pricing.ts does not list yet — every recent taskUSD.total is 0).
 */
export function costSummary(
  merges: MergeRecord[],
  state: { taskCosts?: Record<string, number>; taskUSD?: Record<string, { total?: number; unpricedTokens?: number; tokens?: number }> },
  nowMs: number,
  windowMs: number,
): CostSummary {
  const tasks = new Set<string>();
  for (const m of merges ?? []) {
    if (!m || typeof m.task !== "string" || typeof m.at !== "string") continue;
    const at = Date.parse(m.at);
    if (!Number.isFinite(at) || at > nowMs || nowMs - at > windowMs) continue;
    tasks.add(m.task);
  }
  let tokens = 0;
  let usd = 0;
  let priced = false;
  let unpricedTokens = 0;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  for (const task of tasks) {
    const u = state.taskUSD?.[task];
    tokens += num(u?.tokens) || num(state.taskCosts?.[task]);
    if (num(u?.total) > 0) {
      usd += num(u?.total);
      priced = true;
    }
    unpricedTokens += num(u?.unpricedTokens);
  }
  return { windowMs, merges: tasks.size, tokens, usd: priced ? usd : null, unpricedTokens };
}

/** Pending deploy older than this is abnormal (a green merge deploys in minutes). */
export const DEPLOY_LAG_WARN_MS = 2 * 3_600_000;
/** …and older than this is an outage of the delivery path. */
export const DEPLOY_LAG_CRITICAL_MS = 24 * 3_600_000;

/** The facts attentionFlags weighs (the digest's own shape, loosely typed). */
export interface AttentionInput {
  installed: boolean;
  pilot: { state: PilotLivenessState };
  deploy: { behind: number | null; pendingSinceMs: number | null; hold: DeployHold | null };
  disk: { freeBytes: number | null; minFreeBytes: number };
  alerts: { undelivered: number };
  nowMs: number;
}

export type AttentionKind = "pilot-down" | "pilot-stale" | "deploy-hold" | "deploy-lag" | "disk-low" | "alerts-undelivered";

export interface AttentionFlag {
  kind: AttentionKind;
  level: "critical" | "warn";
}

/**
 * What needs the operator, most severe first (critical before warn, then a
 * fixed kind order) — one list every surface renders the same way. A machine
 * without the pilot yields nothing: product users never see fleet alarms.
 */
export function attentionFlags(s: AttentionInput): AttentionFlag[] {
  if (!s.installed) return [];
  const out: AttentionFlag[] = [];
  if (s.pilot.state === "down") out.push({ kind: "pilot-down", level: "critical" });
  else if (s.pilot.state === "stale") out.push({ kind: "pilot-stale", level: "warn" });
  if (s.deploy.hold) {
    // disk/dirty refusals need the operator — unless the disk refusal's cause
    // is already gone (free space back above the floor): then the hold only
    // waits for the next attempt and stays a warning.
    const diskBack = s.disk.freeBytes !== null && s.disk.freeBytes >= s.disk.minFreeBytes;
    const needsOperator = s.deploy.hold.reason === "dirty-guard" || (s.deploy.hold.reason === "disk-guard" && !diskBack);
    out.push({ kind: "deploy-hold", level: needsOperator ? "critical" : "warn" });
  }
  if (s.deploy.behind !== null && s.deploy.behind > 0 && s.deploy.pendingSinceMs !== null) {
    const lag = s.nowMs - s.deploy.pendingSinceMs;
    if (lag > DEPLOY_LAG_CRITICAL_MS) out.push({ kind: "deploy-lag", level: "critical" });
    else if (lag > DEPLOY_LAG_WARN_MS) out.push({ kind: "deploy-lag", level: "warn" });
  }
  if (s.disk.freeBytes !== null && Number.isFinite(s.disk.freeBytes)) {
    if (s.disk.freeBytes < s.disk.minFreeBytes) out.push({ kind: "disk-low", level: "critical" });
    else if (s.disk.freeBytes < 2 * s.disk.minFreeBytes) out.push({ kind: "disk-low", level: "warn" });
  }
  if (s.alerts.undelivered > 0) out.push({ kind: "alerts-undelivered", level: "warn" });
  const order: AttentionKind[] = ["pilot-down", "pilot-stale", "deploy-hold", "disk-low", "deploy-lag", "alerts-undelivered"];
  return out.sort((a, b) => (a.level === b.level ? order.indexOf(a.kind) - order.indexOf(b.kind) : a.level === "critical" ? -1 : 1));
}
