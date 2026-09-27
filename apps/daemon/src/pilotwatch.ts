// eval-01: pilot liveness watchdog — "nobody finds out when the fleet stops".
//
// Every pilot alert (notifySupervisor, push digests) lives INSIDE the pilot
// process, so a dead or unloaded pilot can never report its own death: the
// fleet sat dead 12/09→22/09 and again from 24/09 08:07 (com.ocr.pilot booted
// out of launchd, nothing restarted it) with zero alerts. The daemon runs
// under launchd KeepAlive on the same host, so it watches the pilot from the
// OUTSIDE — heartbeat age, pid, launchd load state and restart rate, the
// deploy disk-guard hold, deploy lag behind the gate-verified merges and the
// supervisor session — and pages the paired phones over the daemon's existing
// Web Push path: confirmation before the first page, one persisted episode
// (dedupe across daemon restarts and a second daemon process), an escalation
// schedule for reminders, and exactly one "back to normal" message.
//
// Pure verdict/planner functions (unit-tested with fake clocks) + one watcher
// whose I/O is injectable (hermetic tests use a temp dir and a fake launchctl).
// index.ts only wires push/log/audit and the read routes. The watcher also
// owns the persisted phone digest of pilotnotify.ts (fallback when the
// supervisor session is unreachable) and flushes it on its tick.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeStateAtomic } from "./statefile.js";
import {
  digestAdd,
  digestMarkSent,
  digestPlan,
  emptyDigest,
  normalizeDigest,
  type DigestState,
  type FallbackItem,
} from "./pilotnotify.js";

export const PILOT_LAUNCHD_LABEL = "com.ocr.pilot";
export const PILOTWATCH_INTERVAL_MS = 60_000;
export const PILOTWATCH_INITIAL_DELAY_MS = 30_000;
/** The pilot touches its heartbeat every loop turn and every 60s during long
 * awaits, and its own watchdog exits after 3 min of silence (KeepAlive then
 * restarts it in ~30s) — 10 min of silence means nothing is beating. */
export const HEARTBEAT_STALE_MS = 10 * 60_000;
/** launchd restarts within the window that make a crash loop. */
export const CRASH_LOOP_RESTARTS = 3;
export const CRASH_LOOP_WINDOW_MS = 15 * 60_000;
/** Deploys held by the disk guard for this long page the operator… */
export const DISK_HOLD_ALERT_MS = 60 * 60_000;
/** …while the newest refusal is at most this old (older = hold is over). */
export const DISK_HOLD_FRESH_MS = 6 * 60 * 60_000;
/** The pilot's explicit disk hold (eval-02) re-emits `alert`/`disk-hold` every
 * 6h while it lasts; an hour of slack before a silent hold counts as over (a
 * restarted pilot may never emit the matching `disk-resume`). */
export const DISK_HOLD_EXPLICIT_FRESH_MS = 7 * 60 * 60_000;
/** A gate-verified merge waiting this long for its deploy pages the operator. */
export const DEPLOY_LAG_ALERT_MS = 6 * 60 * 60_000;
/** Read-only GET of the supervisor session at most this often. */
export const SUPERVISOR_PROBE_MS = 10 * 60_000;
/** Consecutive bad ticks before the first page (a restart never pages). */
export const CONFIRM_TICKS = 2;
/** Delay before the next reminder, indexed by messages already sent (last repeats). */
export const REMINDER_DOWN_MS = [60 * 60_000, 4 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000];
export const REMINDER_DEGRADED_MS = [24 * 3_600_000];
/** A phone subscribing mid-episode gets the pending alert after this pause. */
export const CATCH_UP_MS = 5 * 60_000;
/** /api/pilot-liveness answers from a snapshot at most this old. */
export const SNAPSHOT_MAX_AGE_MS = 15_000;
/** Web Push tag the service worker uses for pilot pages (own slot + renotify). */
export const PILOT_PUSH_TAG = "ocr-pilot";

export type LivenessState = "ok" | "degraded" | "down" | "paused" | "absent";
export type ReasonCode =
  | "unloaded"
  | "crash-loop"
  | "dead"
  | "stalled"
  | "no-heartbeat"
  | "disk-hold"
  | "deploy-lag"
  | "supervisor-missing";
export type Severity = 1 | 2;
export type SupervisorProbe = "ok" | "missing" | "unknown";

const REASON_ORDER: ReasonCode[] = [
  "unloaded",
  "crash-loop",
  "dead",
  "stalled",
  "no-heartbeat",
  "disk-hold",
  "deploy-lag",
  "supervisor-missing",
];

/** Short pt-BR label per reason (reminders, recovery, audit). */
export const REASON_LABEL: Record<ReasonCode, string> = {
  unloaded: "fora do launchd",
  "crash-loop": "reiniciando em loop",
  dead: "processo morto",
  stalled: "loop travado",
  "no-heartbeat": "sem heartbeat",
  "disk-hold": "deploy segurado pelo disco",
  "deploy-lag": "deploy atrasado",
  "supervisor-missing": "supervisor inacessível",
};

export interface LaunchdFacts {
  /** False off-darwin, without the plist, or when the probe failed. */
  checked: boolean;
  loaded: boolean | null;
  state: string | null;
  pid: number | null;
  runs: number | null;
  lastExitCode: number | null;
}

export interface DiskHold {
  since: number;
  last: number;
  refusals: number;
  detail: string;
  /** "deploy-guard" = inferred from deploy refusals; "pilot-hold" = the pilot's
   * explicit disk hold (`alert` events, task "disk", phase disk-hold/resume). */
  source: "deploy-guard" | "pilot-hold";
}

export interface PilotSignals {
  installed: boolean;
  paused: boolean;
  heartbeatAt: number | null;
  pid: number | null;
  pidAlive: boolean | null;
  launchd: LaunchdFacts;
  /** launchd restarts inside CRASH_LOOP_WINDOW_MS (null = unknown). */
  restarts: number | null;
  diskHold: DiskHold | null;
  deploy: { prodSha: string | null; undeployed: number | null; oldestUndeployedAt: number | null };
  notify: { pending: number; oldestPendingAt: number | null; lastDeliveredAt: number | null };
  supervisor: { session: string | null; probe: SupervisorProbe | "unset" };
}

export interface LivenessReason {
  code: ReasonCode;
  severity: Severity;
  detail: string;
}

export interface LivenessVerdict {
  state: LivenessState;
  reasons: LivenessReason[];
  heartbeatAgeMs: number | null;
}

export const UNCHECKED_LAUNCHD: LaunchdFacts = {
  checked: false,
  loaded: null,
  state: null,
  pid: null,
  runs: null,
  lastExitCode: null,
};

// ── pure helpers ─────────────────────────────────────────────────────────────

/** "4 min", "2h 05min", "3d 4h" — never negative, minimum "1 min". */
export function fmtDuration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) {
    const rest = min % 60;
    return rest ? `${h}h ${String(rest).padStart(2, "0")}min` : `${h}h`;
  }
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

/**
 * `launchctl print gui/<uid>/<label>`: exit 0 = loaded (top-level fields are
 * indented by exactly one tab), exit 113 / "Could not find service" = not
 * loaded, anything else = unknown (never an accusation).
 */
export function parseLaunchctlPrint(code: number | null, output: string): LaunchdFacts {
  if (code === 113 || /could not find service/i.test(output)) {
    return { ...UNCHECKED_LAUNCHD, checked: true, loaded: false };
  }
  if (code !== 0) return UNCHECKED_LAUNCHD;
  const top = (key: string): string | null => {
    const m = new RegExp(`^\\t${key} = (.+)$`, "m").exec(output);
    return m ? m[1]!.trim() : null;
  };
  const num = (v: string | null): number | null => (v !== null && /^-?\d+$/.test(v) ? Number(v) : null);
  return {
    checked: true,
    loaded: true,
    state: top("state"),
    pid: num(top("pid")),
    runs: num(top("runs")),
    lastExitCode: num(top("last exit code")),
  };
}

/** Restarts seen in the window from (at, runs) samples (null = not enough data). */
export function restartsInWindow(samples: Array<{ at: number; runs: number }>, now: number): number | null {
  const inWindow = samples.filter((s) => now - s.at <= CRASH_LOOP_WINDOW_MS);
  if (inWindow.length < 2) return null;
  const first = inWindow[0]!;
  const last = inWindow[inWindow.length - 1]!;
  return Math.max(0, last.runs - first.runs);
}

/**
 * The trailing disk hold in the pilot's event feed. Two sources: deploy
 * refusals (`deploy`/`disk-guard`/ok:false) since the last successful deploy
 * (`deploy`/`done`/ok:true), and the pilot's explicit hold (`alert` events
 * with task "disk": phase "disk-hold" opens or refreshes it, "disk-resume"
 * clears it — eval-02's shape). Null = no hold.
 */
export function diskHoldFromEvents(lines: string[]): DiskHold | null {
  // `as` keeps the declared union: CFA would otherwise pin the loop to `null`
  let hold = null as DiskHold | null;
  for (const line of lines) {
    let e: { type?: unknown; task?: unknown; phase?: unknown; ok?: unknown; ts?: unknown; detail?: unknown };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      continue;
    }
    if (!e) continue;
    const at = typeof e.ts === "string" ? Date.parse(e.ts) : NaN;
    if (!Number.isFinite(at)) continue;
    const detail = typeof e.detail === "string" ? e.detail : "";
    if (e.type === "alert" && e.task === "disk") {
      if (e.phase === "disk-resume") hold = null;
      else if (e.phase === "disk-hold") {
        hold = hold
          ? { since: hold.since, last: at, refusals: hold.refusals, detail: detail || hold.detail, source: "pilot-hold" }
          : { since: at, last: at, refusals: 0, detail, source: "pilot-hold" };
      }
      continue;
    }
    if (e.type !== "deploy") continue;
    if (e.phase === "done" && e.ok === true) hold = null;
    else if (e.phase === "disk-guard" && e.ok === false) {
      hold = hold
        ? { since: hold.since, last: at, refusals: hold.refusals + 1, detail: detail || hold.detail, source: hold.source }
        : { since: at, last: at, refusals: 1, detail, source: "deploy-guard" };
    }
  }
  return hold;
}

/**
 * Deploy lag: the gate-verified merges (verified-merges.jsonl, oldest first)
 * recorded after the sha production runs. Unknown prod sha or a sha missing
 * from the list = unknown (never a guess).
 */
export function deployLagFrom(
  prodSha: string | null,
  verifiedLines: string[],
): { undeployed: number | null; oldestUndeployedAt: number | null } {
  const unknown = { undeployed: null, oldestUndeployedAt: null };
  if (!prodSha) return unknown;
  const rows: Array<{ sha: string; at: number }> = [];
  for (const line of verifiedLines) {
    try {
      const r = JSON.parse(line) as { sha?: unknown; at?: unknown };
      if (typeof r.sha === "string") rows.push({ sha: r.sha, at: typeof r.at === "string" ? Date.parse(r.at) : NaN });
    } catch {}
  }
  let idx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.sha === prodSha) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return unknown;
  const after = rows.slice(idx + 1);
  const oldest = after.length ? after[0]!.at : NaN;
  return { undeployed: after.length, oldestUndeployedAt: Number.isFinite(oldest) ? oldest : null };
}

/**
 * The liveness verdict for one set of signals. Down reasons need the process
 * to be gone or silent; degraded reasons only apply to a pilot that is
 * otherwise beating OR add context to a down one. Paused (pilot.lock, the
 * pilot's own freeze switch) and absent (no pilot on this host) never alert.
 */
export function livenessVerdict(s: PilotSignals, now: number): LivenessVerdict {
  const hbAge = s.heartbeatAt === null ? null : Math.max(0, now - s.heartbeatAt);
  if (!s.installed) return { state: "absent", reasons: [], heartbeatAgeMs: hbAge };
  if (s.paused) return { state: "paused", reasons: [], heartbeatAgeMs: hbAge };
  const reasons: LivenessReason[] = [];
  const add = (code: ReasonCode, severity: Severity, detail: string) => reasons.push({ code, severity, detail });
  const alive = s.pidAlive === true;
  const stale = hbAge === null || hbAge > HEARTBEAT_STALE_MS;
  const hbText = hbAge === null ? "nenhum heartbeat registrado" : `último heartbeat há ${fmtDuration(hbAge)}`;
  if (s.launchd.checked && s.launchd.loaded === false && !alive) {
    add(
      "unloaded",
      2,
      `com.ocr.pilot não está carregado no launchd — o KeepAlive não vai religar o pilot sozinho (${hbText}).`,
    );
  } else if (stale) {
    if (alive) add("stalled", 2, `processo vivo (pid ${s.pid}) mas sem heartbeat — ${hbText}; o loop travou.`);
    else if (hbAge === null) add("no-heartbeat", 2, "o pilot está instalado mas nunca registrou heartbeat nesta máquina.");
    else add("dead", 2, `o processo do pilot${s.pid ? ` (pid ${s.pid})` : ""} não está rodando — ${hbText}.`);
  }
  if (
    s.restarts !== null &&
    s.restarts >= CRASH_LOOP_RESTARTS &&
    (s.launchd.lastExitCode !== null ? s.launchd.lastExitCode !== 0 : stale)
  ) {
    add(
      "crash-loop",
      2,
      `reiniciando em loop — ${s.restarts} reinícios em ${fmtDuration(CRASH_LOOP_WINDOW_MS)}` +
        `${s.launchd.lastExitCode !== null ? ` (último exit code ${s.launchd.lastExitCode})` : ""}.`,
    );
  }
  const hold = s.diskHold;
  const holdFreshMs = hold?.source === "pilot-hold" ? DISK_HOLD_EXPLICIT_FRESH_MS : DISK_HOLD_FRESH_MS;
  if (hold && now - hold.last <= holdFreshMs && now - hold.since >= DISK_HOLD_ALERT_MS) {
    const why = hold.detail ? `: ${hold.detail.slice(0, 120)}` : "";
    add(
      "disk-hold",
      1,
      hold.source === "pilot-hold"
        ? `o pilot está em disk hold há ${fmtDuration(now - hold.since)}${why}.`
        : `deploy segurado pelo disk guard há ${fmtDuration(now - hold.since)} (${hold.refusals} recusa${hold.refusals === 1 ? "" : "s"})${why}.`,
    );
  }
  const lag = s.deploy;
  if (lag.undeployed && lag.oldestUndeployedAt !== null && now - lag.oldestUndeployedAt >= DEPLOY_LAG_ALERT_MS) {
    add(
      "deploy-lag",
      1,
      `${lag.undeployed} merge${lag.undeployed === 1 ? "" : "s"} verificado${lag.undeployed === 1 ? "" : "s"} esperando deploy há ` +
        `${fmtDuration(now - lag.oldestUndeployedAt)}${lag.prodSha ? ` (produção em ${lag.prodSha.slice(0, 7)})` : ""}.`,
    );
  }
  if (s.supervisor.session && s.supervisor.probe === "missing") {
    add(
      "supervisor-missing",
      1,
      "a sessão do supervisor configurada em pilot.json não existe mais no opencode — os avisos do pilot seguem só pelo telefone.",
    );
  }
  reasons.sort((a, b) => b.severity - a.severity || REASON_ORDER.indexOf(a.code) - REASON_ORDER.indexOf(b.code));
  const state: LivenessState = reasons.length === 0 ? "ok" : reasons[0]!.severity === 2 ? "down" : "degraded";
  return { state, reasons, heartbeatAgeMs: hbAge };
}

// ── alert planner ────────────────────────────────────────────────────────────

export interface AlertEpisode {
  code: ReasonCode;
  severity: Severity;
  /** First bad observation of the episode. */
  since: number;
  lastSentAt: number | null;
  /** Messages sent in this episode (alert + reminders + escalations). */
  sent: number;
  /** Phones reached across those messages. */
  delivered: number;
  /** Push subscribers at the last send (catch-up when a phone appears). */
  lastSubscribers: number;
}

export interface AlertState {
  /** Unconfirmed bad observations (no page yet). */
  pending: { code: ReasonCode; severity: Severity; since: number; seen: number } | null;
  episode: AlertEpisode | null;
}

export type AlertKind = "alert" | "reminder" | "recovery";

export interface AlertMessage {
  kind: AlertKind;
  title: string;
  body: string;
}

export const EMPTY_ALERT: AlertState = { pending: null, episode: null };

export function reminderDelay(severity: Severity, sent: number): number {
  const table = severity === 2 ? REMINDER_DOWN_MS : REMINDER_DEGRADED_MS;
  return table[Math.min(Math.max(sent, 1) - 1, table.length - 1)]!;
}

function extras(v: LivenessVerdict): string {
  const rest = v.reasons.slice(1, 3).map((r) => REASON_LABEL[r.code]);
  return rest.length ? ` Também: ${rest.join(", ")}.` : "";
}

function alertMessage(kind: "alert" | "reminder", v: LivenessVerdict, ep: AlertEpisode, now: number): AlertMessage {
  const primary = v.reasons[0]!;
  const down = primary.severity === 2;
  const title =
    kind === "alert"
      ? down
        ? "🛑 Pilot parado"
        : "⚠️ Pilot precisa de atenção"
      : down
        ? `🛑 Pilot ainda parado (há ${fmtDuration(now - ep.since)})`
        : `⚠️ Pilot: problema segue (há ${fmtDuration(now - ep.since)})`;
  const body = `${primary.detail.charAt(0).toUpperCase()}${primary.detail.slice(1)}${extras(v)}`;
  return { kind, title, body };
}

/**
 * One planning step. Pure: returns the next persisted state and at most one
 * message. Rules — confirmation: CONFIRM_TICKS consecutive bad ticks before
 * the first page; escalation (degraded → down): immediate page; reminders:
 * the severity's schedule; de-escalation (down → degraded): one "voltou a
 * rodar" message naming what is still wrong; recovery: one "de volta"
 * message, only when the episode actually paged; paused/absent: the episode
 * closes silently; catch-up: an episode that reached no phone (0
 * subscriptions) re-pages once a phone subscribes.
 */
export function planAlert(
  prev: AlertState,
  v: LivenessVerdict,
  now: number,
  ctx: { subscribers: number },
): { next: AlertState; message: AlertMessage | null } {
  const primary = v.reasons[0];
  if (v.state === "paused" || v.state === "absent") return { next: EMPTY_ALERT, message: null };
  if (v.state === "ok" || !primary) {
    const ep = prev.episode;
    if (ep && ep.sent > 0) {
      return {
        next: EMPTY_ALERT,
        message: {
          kind: "recovery",
          title: "✅ Pilot de volta ao normal",
          body: `Normalizou após ${fmtDuration(now - ep.since)} (${REASON_LABEL[ep.code]}).`,
        },
      };
    }
    return { next: EMPTY_ALERT, message: null };
  }
  const severity = primary.severity;
  const ep = prev.episode;
  if (!ep) {
    const pending = prev.pending
      ? { code: primary.code, severity, since: prev.pending.since, seen: prev.pending.seen + 1 }
      : { code: primary.code, severity, since: now, seen: 1 };
    if (pending.seen < CONFIRM_TICKS) return { next: { pending, episode: null }, message: null };
    const opened: AlertEpisode = {
      code: primary.code,
      severity,
      since: pending.since,
      lastSentAt: now,
      sent: 1,
      delivered: 0,
      lastSubscribers: ctx.subscribers,
    };
    return { next: { pending: null, episode: opened }, message: alertMessage("alert", v, opened, now) };
  }
  if (severity > ep.severity) {
    const next = { ...ep, code: primary.code, severity, lastSentAt: now, sent: ep.sent + 1, lastSubscribers: ctx.subscribers };
    return { next: { pending: null, episode: next }, message: alertMessage("alert", v, next, now) };
  }
  if (severity < ep.severity) {
    if (ep.sent === 0) return { next: { pending: null, episode: { ...ep, code: primary.code, severity } }, message: null };
    const next = { ...ep, code: primary.code, severity, lastSentAt: now, sent: ep.sent + 1, lastSubscribers: ctx.subscribers };
    return {
      next: { pending: null, episode: next },
      message: {
        kind: "recovery",
        title: "✅ Pilot voltou a rodar",
        body: `Após ${fmtDuration(now - ep.since)} (${REASON_LABEL[ep.code]}). Ainda: ${primary.detail}`,
      },
    };
  }
  const same = { ...ep, code: primary.code };
  if (ep.lastSentAt === null || now - ep.lastSentAt >= reminderDelay(severity, ep.sent)) {
    const next = { ...same, lastSentAt: now, sent: ep.sent + 1, lastSubscribers: ctx.subscribers };
    return { next: { pending: null, episode: next }, message: alertMessage("reminder", v, next, now) };
  }
  if (
    ep.delivered === 0 &&
    ep.lastSubscribers === 0 &&
    ctx.subscribers > 0 &&
    now - ep.lastSentAt >= CATCH_UP_MS
  ) {
    const next = { ...same, lastSentAt: now, sent: ep.sent + 1, lastSubscribers: ctx.subscribers };
    return { next: { pending: null, episode: next }, message: alertMessage("alert", v, next, now) };
  }
  return { next: { pending: null, episode: same }, message: null };
}

// ── persisted state ──────────────────────────────────────────────────────────

export interface WatchFile {
  v: 1;
  alert: AlertState;
  digest: DigestState;
}

function isReason(v: unknown): v is ReasonCode {
  return typeof v === "string" && (REASON_ORDER as string[]).includes(v);
}

/** Defensive load (unknown JSON, old shapes → empty parts). */
export function normalizeWatchFile(raw: unknown): WatchFile {
  const r = (raw && typeof raw === "object" ? raw : {}) as { alert?: Partial<AlertState>; digest?: unknown };
  const a = (r.alert && typeof r.alert === "object" ? r.alert : {}) as Partial<AlertState>;
  const ep = a.episode as Partial<AlertEpisode> | null | undefined;
  const pend = a.pending as AlertState["pending"] | undefined;
  const sev = (n: unknown): Severity | null => (n === 1 || n === 2 ? n : null);
  const episode: AlertEpisode | null =
    ep && isReason(ep.code) && sev(ep.severity) && typeof ep.since === "number"
      ? {
          code: ep.code,
          severity: sev(ep.severity)!,
          since: ep.since,
          lastSentAt: typeof ep.lastSentAt === "number" ? ep.lastSentAt : null,
          sent: typeof ep.sent === "number" ? ep.sent : 0,
          delivered: typeof ep.delivered === "number" ? ep.delivered : 0,
          lastSubscribers: typeof ep.lastSubscribers === "number" ? ep.lastSubscribers : 0,
        }
      : null;
  const pending =
    pend && isReason(pend.code) && sev(pend.severity) && typeof pend.since === "number" && typeof pend.seen === "number"
      ? { code: pend.code, severity: sev(pend.severity)!, since: pend.since, seen: pend.seen }
      : null;
  return { v: 1, alert: { pending, episode }, digest: normalizeDigest(r.digest) };
}

// ── impure collectors (injectable) ───────────────────────────────────────────

export interface WatchIo {
  readText(path: string): string | null;
  exists(path: string): boolean;
  mtimeMs(path: string): number | null;
  pidAlive(pid: number): boolean;
  /** Null when launchctl cannot run at all. */
  launchctl(args: string[]): Promise<{ code: number | null; output: string } | null>;
  writeState(path: string, data: string): void;
}

export const nodeWatchIo: WatchIo = {
  readText: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  exists: (p) => existsSync(p),
  mtimeMs: (p) => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return null;
    }
  },
  pidAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  launchctl: (args) =>
    new Promise((resolve) => {
      try {
        execFile("launchctl", args, { timeout: 5_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
          const output = `${String(stdout ?? "")}${String(stderr ?? "")}`;
          if (!err) return resolve({ code: 0, output });
          const code = (err as { code?: unknown }).code;
          resolve(typeof code === "number" ? { code, output } : null);
        });
      } catch {
        resolve(null);
      }
    }),
  writeState: (p, data) => writeStateAtomic(p, data),
};

export interface WatchPaths {
  stateDir: string;
  launchAgentsDir: string;
  prodRepo: string;
}

export function defaultWatchPaths(): WatchPaths {
  const stateDir = join(homedir(), ".opencode-remote");
  return {
    stateDir,
    launchAgentsDir: join(homedir(), "Library", "LaunchAgents"),
    prodRepo: process.env.OCR_PILOT_REPO || join(stateDir, "prod"),
  };
}

function lines(text: string | null): string[] {
  return text ? text.split("\n").filter(Boolean) : [];
}

function positiveNumber(text: string | null): number | null {
  if (text === null) return null;
  const n = Number(text.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** HEAD sha of a plain clone without spawning git (loose ref, then packed-refs). */
export function resolveHeadSha(repo: string, io: Pick<WatchIo, "readText">): string | null {
  const head = io.readText(join(repo, ".git", "HEAD"))?.trim();
  if (!head) return null;
  if (/^[0-9a-f]{40}$/.test(head)) return head;
  const m = /^ref: (refs\/\S+)$/.exec(head);
  if (!m) return null;
  const loose = io.readText(join(repo, ".git", m[1]!))?.trim();
  if (loose && /^[0-9a-f]{40}$/.test(loose)) return loose;
  for (const line of lines(io.readText(join(repo, ".git", "packed-refs")))) {
    const [sha, ref] = line.trim().split(" ");
    if (ref === m[1] && sha && /^[0-9a-f]{40}$/.test(sha)) return sha;
  }
  return null;
}

/** Read-only `GET /session/<id>` outcome → probe verdict. Only opencode's
 * NotFoundError is "missing"; any other answer or none at all is unknown. */
export function supervisorProbeFrom(status: number | null, text: string): SupervisorProbe {
  if (status !== null && status >= 200 && status < 300) return "ok";
  if (status === 404 && /NotFoundError|session not found/i.test(text)) return "missing";
  return "unknown";
}

/**
 * The pilot counts as installed on this host when launchd manages it (the
 * plist from deploy/install-pilot.sh) or when it has run here at least once
 * (pilot.json + a heartbeat file). A lay user's machine never qualifies, so
 * the watchdog cannot cry wolf there. OCR_PILOTWATCH=on forces it.
 */
export function pilotInstalled(paths: WatchPaths, io: Pick<WatchIo, "exists">, force = false): boolean {
  if (force) return true;
  if (io.exists(join(paths.launchAgentsDir, `${PILOT_LAUNCHD_LABEL}.plist`))) return true;
  return io.exists(join(paths.stateDir, "pilot.json")) && io.exists(join(paths.stateDir, "pilot", "heartbeat"));
}

// ── watcher ──────────────────────────────────────────────────────────────────

export interface PushOutcome {
  delivered: number;
  subscribers: number;
}

export interface PilotWatchDeps {
  paths?: WatchPaths;
  io?: WatchIo;
  now?: () => number;
  platform?: NodeJS.Platform;
  uid?: number | null;
  /** Alerts on/off (OCR_PILOTWATCH=off → false). The read API works either way. */
  alerts?: boolean;
  /** Treat the pilot as installed regardless of plist/heartbeat (OCR_PILOTWATCH=on). */
  forceInstalled?: boolean;
  intervalMs?: number;
  initialDelayMs?: number;
  /** Web Push to every paired phone; resolves with the phones reached. */
  push: (title: string, body: string, data: { url: string; tag: string }) => Promise<PushOutcome>;
  subscribers: () => number;
  /** Read-only GET of the supervisor session on opencode. */
  probeSupervisor?: (session: string) => Promise<SupervisorProbe>;
  /** The daemon's own disk verdict for the state volume (ok/low/critical/unknown). */
  diskState?: () => string | null;
  log?: (level: "info" | "warn" | "error", msg: string, data?: unknown) => void;
  audit?: (event: string, data: Record<string, unknown>) => void;
  /** Dashboard feed (events.jsonl) — transitions only. */
  emitEvent?: (fields: { task: string; phase: string; ok: boolean; detail: string }) => void;
}

export interface LivenessSnapshot {
  v: 1;
  state: LivenessState;
  checkedAt: number;
  reasons: Array<{ code: ReasonCode; severity: "down" | "degraded"; detail: string }>;
  heartbeat: { at: number | null; ageMs: number | null };
  process: { pid: number | null; alive: boolean | null };
  launchd: LaunchdFacts;
  disk: { hold: DiskHold | null; daemon: string | null };
  deploy: { prodSha: string | null; undeployed: number | null; oldestUndeployedAt: number | null };
  notify: { pending: number; oldestPendingAt: number | null; lastDeliveredAt: number | null; supervisor: SupervisorProbe | "unset" };
  push: { subscribers: number };
  alerts: boolean;
  alert: {
    episode: {
      code: ReasonCode;
      severity: "down" | "degraded";
      since: number;
      sent: number;
      delivered: number;
      lastSentAt: number | null;
      nextAt: number | null;
    } | null;
  };
}

export interface PilotWatch {
  /** One full pass: collect, verdict, page if due, flush the phone digest. */
  tick(): Promise<void>;
  /** Snapshot for the read routes (cached up to SNAPSHOT_MAX_AGE_MS). */
  current(): Promise<LivenessSnapshot>;
  /** Queue one item on the phone digest (pushes now when due). */
  enqueue(item: FallbackItem): Promise<{ pushed: boolean; phones: number }>;
  /** Feed a relay outcome (session-not-found marks the supervisor missing). */
  noteRelay(reason: string | undefined, delivered: boolean): void;
  start(): () => void;
}

export function createPilotWatch(deps: PilotWatchDeps): PilotWatch {
  const paths = deps.paths ?? defaultWatchPaths();
  const io = deps.io ?? nodeWatchIo;
  const now = deps.now ?? Date.now;
  const platform = deps.platform ?? process.platform;
  const uid = deps.uid === undefined ? (process.getuid?.() ?? null) : deps.uid;
  const alerts = deps.alerts ?? true;
  const log = deps.log ?? (() => {});
  const audit = deps.audit ?? (() => {});
  const file = join(paths.stateDir, "pilotwatch.json");
  const plist = join(paths.launchAgentsDir, `${PILOT_LAUNCHD_LABEL}.plist`);

  let mem: WatchFile = normalizeWatchFile(null);
  let saveWarned = false;
  const runsSamples: Array<{ at: number; runs: number }> = [];
  let supervisor: { session: string | null; probe: SupervisorProbe; at: number } = { session: null, probe: "unknown", at: 0 };
  let lastState: LivenessState | null = null;
  let cached: LivenessSnapshot | null = null;
  let lock: Promise<unknown> = Promise.resolve();

  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => undefined);
    return run;
  };

  // The file is the dedupe source of truth (another daemon process may share
  // it); memory is the fallback when the disk cannot be read or written —
  // a full disk must never silence the watchdog.
  const load = (): WatchFile => {
    const raw = io.readText(file);
    if (raw !== null) {
      try {
        mem = normalizeWatchFile(JSON.parse(raw));
      } catch {}
    }
    return mem;
  };
  const save = (next: WatchFile): void => {
    mem = next;
    try {
      io.writeState(file, JSON.stringify(next));
      saveWarned = false;
    } catch (err) {
      if (!saveWarned) {
        saveWarned = true;
        log("warn", "pilotwatch state not persisted (kept in memory)", { error: String(err).slice(0, 160) });
      }
    }
  };

  const collect = async (): Promise<{ signals: PilotSignals; verdict: LivenessVerdict; at: number }> => {
    const at = now();
    const installed = pilotInstalled(paths, io, deps.forceInstalled === true);
    const pilotDir = join(paths.stateDir, "pilot");
    const hbFile = join(pilotDir, "heartbeat");
    const heartbeatAt = positiveNumber(io.readText(hbFile)) ?? io.mtimeMs(hbFile);
    const pidRaw = positiveNumber(io.readText(join(pilotDir, "pilot.pid")));
    const pid = pidRaw !== null && Number.isInteger(pidRaw) ? pidRaw : null;
    const pidAlive = pid === null ? null : io.pidAlive(pid);
    let launchd = UNCHECKED_LAUNCHD;
    if (installed && platform === "darwin" && uid !== null && io.exists(plist)) {
      const r = await io.launchctl(["print", `gui/${uid}/${PILOT_LAUNCHD_LABEL}`]);
      launchd = r ? parseLaunchctlPrint(r.code, r.output) : UNCHECKED_LAUNCHD;
    }
    if (launchd.runs !== null) {
      runsSamples.push({ at, runs: launchd.runs });
      while (runsSamples.length > 0 && at - runsSamples[0]!.at > CRASH_LOOP_WINDOW_MS) runsSamples.shift();
    }
    const restarts = launchd.loaded === true ? restartsInWindow(runsSamples, at) : null;
    let session: string | null = null;
    try {
      const cfg = JSON.parse(io.readText(join(paths.stateDir, "pilot.json")) ?? "{}") as { supervisorSession?: unknown };
      session = typeof cfg.supervisorSession === "string" && cfg.supervisorSession.trim() ? cfg.supervisorSession.trim() : null;
    } catch {}
    if (session !== supervisor.session) supervisor = { session, probe: "unknown", at: 0 };
    if (installed && session && deps.probeSupervisor && at - supervisor.at >= SUPERVISOR_PROBE_MS) {
      const probe = await deps.probeSupervisor(session).catch(() => "unknown" as const);
      supervisor = { session, probe, at };
    }
    const pending = lines(io.readText(join(pilotDir, "notify-pending.jsonl")));
    let oldestPendingAt: number | null = null;
    for (const l of pending) {
      try {
        const ts = (JSON.parse(l) as { ts?: unknown }).ts;
        if (typeof ts === "number" && (oldestPendingAt === null || ts < oldestPendingAt)) oldestPendingAt = ts;
      } catch {}
    }
    const prodSha = installed ? resolveHeadSha(paths.prodRepo, io) : null;
    const signals: PilotSignals = {
      installed,
      paused: io.exists(join(paths.stateDir, "pilot.lock")),
      heartbeatAt,
      pid,
      pidAlive,
      launchd,
      restarts,
      diskHold: installed ? diskHoldFromEvents(lines(io.readText(join(pilotDir, "events.jsonl")))) : null,
      deploy: { prodSha, ...deployLagFrom(prodSha, lines(io.readText(join(pilotDir, "verified-merges.jsonl")))) },
      notify: {
        pending: pending.length,
        oldestPendingAt,
        lastDeliveredAt: positiveNumber(io.readText(join(pilotDir, "notify-last"))),
      },
      supervisor: { session, probe: session ? supervisor.probe : "unset" },
    };
    return { signals, verdict: livenessVerdict(signals, at), at };
  };

  const snapshotOf = (signals: PilotSignals, verdict: LivenessVerdict, at: number, state: WatchFile): LivenessSnapshot => {
    const ep = state.alert.episode;
    return {
      v: 1,
      state: verdict.state,
      checkedAt: at,
      reasons: verdict.reasons.map((r) => ({ code: r.code, severity: r.severity === 2 ? "down" : "degraded", detail: r.detail })),
      heartbeat: { at: signals.heartbeatAt, ageMs: verdict.heartbeatAgeMs },
      process: { pid: signals.pid, alive: signals.pidAlive },
      launchd: signals.launchd,
      disk: { hold: signals.diskHold, daemon: deps.diskState?.() ?? null },
      deploy: signals.deploy,
      notify: { ...signals.notify, supervisor: signals.supervisor.probe },
      push: { subscribers: deps.subscribers() },
      alerts,
      alert: {
        episode: ep
          ? {
              code: ep.code,
              severity: ep.severity === 2 ? "down" : "degraded",
              since: ep.since,
              sent: ep.sent,
              delivered: ep.delivered,
              lastSentAt: ep.lastSentAt,
              nextAt: ep.lastSentAt === null ? null : ep.lastSentAt + reminderDelay(ep.severity, ep.sent),
            }
          : null,
      },
    };
  };

  const sendPush = async (title: string, body: string): Promise<PushOutcome> => {
    try {
      return await deps.push(title, body, { url: "#/", tag: PILOT_PUSH_TAG });
    } catch (err) {
      log("warn", "pilotwatch push failed", { error: String(err).slice(0, 160) });
      return { delivered: 0, subscribers: deps.subscribers() };
    }
  };

  // Flush the phone digest when due; caller holds the lock and passes the state.
  const flushDigest = async (state: WatchFile, at: number): Promise<{ state: WatchFile; pushed: boolean }> => {
    const plan = digestPlan(state.digest, at);
    if (!plan) return { state, pushed: false };
    const res = await sendPush(plan.title, plan.body);
    audit("pilot-notify-fallback", { keys: plan.keys.length, delivered: res.delivered, subscribers: res.subscribers });
    if (res.subscribers === 0) log("warn", "pilot notify fallback reached no phone (0 push subscriptions)", { keys: plan.keys.length });
    else log("info", "pilot notify fallback pushed", { keys: plan.keys.length, delivered: res.delivered });
    return { state: { ...state, digest: digestMarkSent(state.digest, plan.keys, at) }, pushed: res.delivered > 0 };
  };

  const tick = async (): Promise<void> => {
    // collection touches no persisted state — only planning/sending is serialized
    const { signals, verdict, at } = await collect();
    if (verdict.state !== lastState) {
      if (lastState !== null || verdict.state !== "absent") {
        log(verdict.state === "down" ? "warn" : "info", "pilot liveness", {
          state: verdict.state,
          reasons: verdict.reasons.map((r) => r.code),
        });
      }
      lastState = verdict.state;
    }
    await serial(async () => {
      let state = load();
      const before = JSON.stringify(state);
      const hadEpisode = state.alert.episode !== null;
      if (alerts) {
        const subscribers = deps.subscribers();
        const planned = planAlert(state.alert, verdict, at, { subscribers });
        state = { ...state, alert: planned.next };
        const msg = planned.message;
        if (msg) {
          const res = await sendPush(msg.title, msg.body);
          if (state.alert.episode) {
            state = {
              ...state,
              alert: {
                ...state.alert,
                episode: { ...state.alert.episode, delivered: state.alert.episode.delivered + res.delivered, lastSubscribers: res.subscribers },
              },
            };
          }
          const code = verdict.reasons[0]?.code ?? null;
          log(msg.kind === "recovery" ? "info" : "warn", "pilot liveness page", {
            kind: msg.kind,
            state: verdict.state,
            code,
            delivered: res.delivered,
            subscribers: res.subscribers,
          });
          if (res.subscribers === 0) log("warn", "pilot liveness page reached no phone (0 push subscriptions)");
          audit("pilot-liveness", { kind: msg.kind, state: verdict.state, code, delivered: res.delivered, subscribers: res.subscribers });
          try {
            deps.emitEvent?.({
              task: "pilot",
              phase: "liveness",
              ok: msg.kind === "recovery",
              detail: `${msg.title} — ${msg.body}`.slice(0, 220),
            });
          } catch {}
        } else if (hadEpisode && !state.alert.episode) {
          log("info", "pilot liveness episode closed without page", { state: verdict.state });
        }
      }
      const flushed = await flushDigest(state, at);
      state = flushed.state;
      if (JSON.stringify(state) !== before) save(state);
      cached = snapshotOf(signals, verdict, at, state);
    });
  };

  return {
    tick,
    async current() {
      if (cached && now() - cached.checkedAt <= SNAPSHOT_MAX_AGE_MS) return cached;
      const { signals, verdict, at } = await collect();
      cached = snapshotOf(signals, verdict, at, load());
      return cached;
    },
    enqueue(item) {
      return serial(async () => {
        const at = now();
        let state = load();
        state = { ...state, digest: digestAdd(state.digest, item, at) };
        const flushed = await flushDigest(state, at);
        save(flushed.state);
        return { pushed: flushed.pushed, phones: deps.subscribers() };
      });
    },
    noteRelay(reason, delivered) {
      if (delivered) supervisor = { ...supervisor, probe: "ok", at: now() };
      else if (reason === "session-not-found") supervisor = { ...supervisor, probe: "missing", at: now() };
    },
    start() {
      const intervalMs = deps.intervalMs ?? PILOTWATCH_INTERVAL_MS;
      let stopped = false;
      const run = () => {
        if (stopped) return;
        void tick().catch((err) => log("warn", "pilotwatch tick failed", { error: String(err).slice(0, 160) }));
      };
      const first = setTimeout(run, deps.initialDelayMs ?? PILOTWATCH_INITIAL_DELAY_MS);
      const timer = setInterval(run, intervalMs);
      first.unref?.();
      timer.unref?.();
      return () => {
        stopped = true;
        clearTimeout(first);
        clearInterval(timer);
      };
    },
  };
}

/**
 * Env knobs, default-safe: OCR_PILOTWATCH=off disables pages (the read API
 * stays), =on forces the pilot as installed; OCR_PILOTWATCH_INTERVAL_MS /
 * OCR_PILOTWATCH_INITIAL_DELAY_MS tune the tick (tests). An invalid value
 * falls back to the default with a problem line — never a boot failure: a
 * daemon that refuses to boot would silence every alert it exists to send.
 */
export function parsePilotWatchEnv(env: NodeJS.ProcessEnv): {
  alerts: boolean;
  forceInstalled: boolean;
  intervalMs: number;
  initialDelayMs: number;
  problems: string[];
} {
  const problems: string[] = [];
  const mode = (env.OCR_PILOTWATCH ?? "").trim().toLowerCase();
  if (mode && mode !== "on" && mode !== "off") problems.push(`OCR_PILOTWATCH=${mode.slice(0, 20)} ignored (on|off)`);
  const ms = (name: string, def: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return def;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 50 && n <= 3_600_000) return n;
    problems.push(`${name}=${raw.slice(0, 20)} ignored (integer 50..3600000)`);
    return def;
  };
  return {
    alerts: mode !== "off",
    forceInstalled: mode === "on",
    intervalMs: ms("OCR_PILOTWATCH_INTERVAL_MS", PILOTWATCH_INTERVAL_MS),
    initialDelayMs: ms("OCR_PILOTWATCH_INITIAL_DELAY_MS", PILOTWATCH_INITIAL_DELAY_MS),
    problems,
  };
}
