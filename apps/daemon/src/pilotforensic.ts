// P2-048: forensic timeline for the desktop Mission Control view. Everything
// here is pure and JSONL-driven: the daemon reads real pipeline records
// (logs/pilot.log JSONL + pilot/events.jsonl) and this module shapes them into
// navigable per-task sessions — no invented data, no cost guesses. The
// web dashboard (apps/pilot/dashboard) keeps its live-feed role; the desktop
// Mission Control view consumes these shapes over /api/pilot-forensic.
import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";

export interface RawLogLine {
  ts?: string;
  level?: string;
  /** pilot.log line kind ("agent", "builder round", …). */
  msg?: string;
  /** events.jsonl line kind — same role as msg in the flat shape. */
  type?: string;
  data?: unknown;
}

export type ForensicKind = "phase" | "decision" | "gate" | "review" | "deploy" | "result" | "scribe";

export interface ForensicEntry {
  ts: string;
  kind: ForensicKind;
  /** Human-readable summary (single line, pre-truncated). */
  text: string;
  /** Builder/reviewer round the entry belongs to, when known. */
  round?: number;
  ok?: boolean;
  /** gatekeeper step (evidence|review|integration|deploy…). */
  step?: string;
  /** Last lines of a gate failure output. */
  tail?: string;
}

export interface DeployRecord {
  ts: string;
  ok: boolean;
  rolledBack: boolean;
  detail: string;
}

export type SessionStatus = "running" | "merged" | "failed";

export interface SessionCard {
  id: string;
  title: string;
  status: SessionStatus;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  rounds?: number;
  gateFails: number;
  decisions: number;
  /** Wall-clock agent effort in minutes — the honest cost proxy we have. */
  effortMin: number | null;
  /** Projection for running tasks: avg duration of finished tasks − elapsed. */
  etaMs: number | null;
  /** Merge/deploy sha when a deploy event carried one ("sha <7-12 hex>"). */
  mergeSha?: string;
  deploys: DeployRecord[];
}

export interface ForensicIndex {
  /** task id → ordered forensic entries (pilot.log derived). */
  timelines: Map<string, ForensicEntry[]>;
  /** task id → title captured from "pipeline start". */
  titles: Map<string, string>;
}

/** Parse one pilot.log JSONL line; malformed lines are skipped (log-only). */
export function parseLogLine(line: string): RawLogLine | null {
  try {
    const j = JSON.parse(line) as RawLogLine;
    if (typeof j.msg !== "string") return null;
    return j;
  } catch {
    return null;
  }
}

function dataStr(d: unknown, key: string): string | undefined {
  if (d && typeof d === "object") {
    const v = (d as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

function dataNum(d: unknown, key: string): number | undefined {
  if (d && typeof d === "object") {
    const v = (d as Record<string, unknown>)[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

function dataBool(d: unknown, key: string): boolean | undefined {
  if (d && typeof d === "object") {
    const v = (d as Record<string, unknown>)[key];
    if (typeof v === "boolean") return v;
  }
  return undefined;
}

function dataTask(d: unknown): string | undefined {
  const t = dataStr(d, "task");
  return t && /^[P\d][\w.-]{1,24}$/.test(t) ? t : undefined;
}

function clip(s: string, max = 400): string {
  return s.length > max ? s.slice(0, max) : s;
}

const SHA_RE = /\bsha ([0-9a-f]{7,12})\b/i;

/**
 * Walk pilot.log lines chronologically and split them into per-task forensic
 * timelines. Lines that don't name a task ("agent" narration) are attributed
 * to the most recent line that did — that is exactly how the pipeline emits
 * them (round markers bracket the builder's stdout bridge).
 */
export function buildForensicIndex(logLines: string[], eventLines: string[] = []): ForensicIndex {
  const timelines = new Map<string, ForensicEntry[]>();
  const titles = new Map<string, string>();
  let current: string | undefined;
  const push = (task: string, e: ForensicEntry) => {
    let list = timelines.get(task);
    if (!list) {
      list = [];
      timelines.set(task, list);
    }
    list.push(e);
  };

  // events.jsonl already carries structured agent narrations (with task) —
  // richer than the throttled pilot.log "agent" bridge, so they win. Note its
  // shape is {ts, type, task, detail} (type, not msg), so it can't go through
  // parseLogLine without normalization.
  for (const raw of eventLines) {
    let j: RawLogLine | null = null;
    try {
      j = JSON.parse(raw) as RawLogLine;
    } catch {
      continue;
    }
    if (!j || typeof j.ts !== "string") continue;
    // events.jsonl is flat: {ts, type, task, detail} — pass the whole object
    // as the data bag (pilot.log nests it under `data` instead)
    const msg = typeof j.type === "string" ? j.type : undefined;
    const task = dataTask(j);
    const detail = dataStr(j, "detail");
    if (msg === "agent" && task && detail) {
      push(task, { ts: j.ts, kind: "decision", text: clip(detail) });
    }
  }

  for (const raw of logLines) {
    const j = parseLogLine(raw);
    if (!j || !j.ts) continue;
    const d = j.data;
    const task = dataTask(d);
    if (task) current = task;
    const round = dataNum(d, "round");
    switch (j.msg) {
      case "pipeline start": {
        const title = dataStr(d, "title");
        if (task) {
          if (title) titles.set(task, title);
          push(task, { ts: j.ts, kind: "phase", text: `pipeline start — ${title ?? task}` });
        }
        break;
      }
      case "planner":
        if (task) push(task, { ts: j.ts, kind: "phase", text: "planner pass" });
        break;
      case "builder round":
        if (task) push(task, { ts: j.ts, kind: "phase", text: `builder round ${round ?? 1}`, round });
        break;
      case "builder done":
        if (task) push(task, { ts: j.ts, kind: "phase", text: `builder round ${round ?? 1} done`, round, ok: true });
        break;
      case "reviewers start":
        if (task) push(task, { ts: j.ts, kind: "review", text: `reviewers start (round ${round ?? 1})`, round });
        break;
      case "reviewers done": {
        if (!task) break;
        const sec = dataBool(d, "secOk");
        const qual = dataBool(d, "qualOk");
        push(task, {
          ts: j.ts,
          kind: "review",
          text: `reviewers done — security ${sec ? "✓" : "✗"} · quality ${qual ? "✓" : "✗"}`,
          round,
          ok: sec !== false && qual !== false,
        });
        break;
      }
      case "gatekeeper fail":
        if (task) {
          push(task, {
            ts: j.ts,
            kind: "gate",
            text: `gate fail: ${dataStr(d, "step") ?? "unknown"}`,
            step: dataStr(d, "step"),
            tail: clip(dataStr(d, "tail") ?? "", 1200),
            ok: false,
          });
        }
        break;
      case "deploy result":
        if (task) {
          const ok = dataBool(d, "ok") ?? false;
          const rolled = dataBool(d, "rolledBack") ?? false;
          push(task, {
            ts: j.ts,
            kind: "deploy",
            text: rolled ? "deploy rolled back" : ok ? "deploy done" : "deploy failed",
            ok: ok && !rolled,
            tail: clip(dataStr(d, "detail") ?? "", 400),
          });
        }
        break;
      case "pipeline result":
        if (task) {
          push(task, {
            ts: j.ts,
            kind: "result",
            text: clip(dataStr(d, "detail") ?? (dataBool(d, "ok") ? "ok" : "failed"), 300),
            ok: dataBool(d, "ok"),
          });
        }
        break;
      case "scribe":
        if (task) {
          const msg = dataStr(d, "msg");
          if (msg) push(task, { ts: j.ts, kind: "scribe", text: clip(msg, 200) });
        }
        break;
      case "agent": {
        // builder stdout narration — attribute to the running task context
        const text = typeof d === "string" ? d : "";
        if (current && text) push(current, { ts: j.ts, kind: "decision", text: clip(text) });
        break;
      }
      default:
        break;
    }
  }
  // events.jsonl narrations were pushed first, pilot.log after — every
  // timeline must read chronologically regardless of the source mix
  for (const list of timelines.values()) {
    list.sort((a, b) => tsMs(a.ts) - tsMs(b.ts));
  }
  return { timelines, titles };
}

const PHASE_SEQ = ["planner", "builder", "reviewers", "gatekeeper", "merge", "scribe"] as const;

/** Progress across the known pipeline phases, 0..1. */
export function progressOf(entries: ForensicEntry[]): number {
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.kind === "phase" && /planner/.test(e.text)) seen.add("planner");
    if (e.kind === "phase" && /builder/.test(e.text)) seen.add("builder");
    if (e.kind === "review") seen.add("reviewers");
    if (e.kind === "gate") seen.add("gatekeeper");
    if (e.kind === "deploy") seen.add("merge");
    if (e.kind === "scribe") seen.add("scribe");
  }
  return seen.size / PHASE_SEQ.length;
}

function tsMs(ts: string): number {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * Cards summarize timelines: one per task with at least one forensic entry.
 * `avgDoneMs` (mean duration of previously finished tasks) feeds the running
 * cards' ETA — a projection, never presented as fact.
 */
export function buildCards(
  timelines: Map<string, ForensicEntry[]>,
  titles: Map<string, string> = new Map(),
  opts: { avgDoneMs?: number; nowMs?: number } = {},
): SessionCard[] {
  const cards: SessionCard[] = [];
  for (const [id, entries] of timelines) {
    if (entries.length === 0) continue;
    const start = entries[0]!;
    const end = entries[entries.length - 1]!;
    const result = [...entries].reverse().find((e) => e.kind === "result");
    const deploys: DeployRecord[] = entries
      .filter((e) => e.kind === "deploy")
      .map((e) => ({ ts: e.ts, ok: e.ok === true, rolledBack: /rolled back/.test(e.text), detail: e.tail ?? "" }));
    const startMs = tsMs(start.ts);
    let durationMs: number | undefined;
    if (result) {
      const endMs = tsMs(result.ts);
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) durationMs = endMs - startMs;
    }
    const status: SessionStatus = result
      ? result.ok === true
        ? "merged"
        : "failed"
      : "running";
    const roundsSet = new Set(entries.filter((e) => e.kind === "phase" && e.round !== undefined).map((e) => e.round!));
    let etaMs: number | null = null;
    if (status === "running" && Number.isFinite(startMs) && opts.avgDoneMs && opts.avgDoneMs > 0) {
      const elapsed = (opts.nowMs ?? Date.now()) - startMs;
      etaMs = Math.max(0, Math.round(opts.avgDoneMs - elapsed));
    }
    const lastDeploy = deploys[deploys.length - 1];
    const mergeSha = lastDeploy ? (SHA_RE.exec(lastDeploy.detail)?.[1] ?? undefined) : undefined;
    cards.push({
      id,
      title: titles.get(id) ?? "—",
      status,
      startedAt: start.ts,
      endedAt: status === "running" ? undefined : end.ts,
      durationMs,
      rounds: roundsSet.size || undefined,
      gateFails: entries.filter((e) => e.kind === "gate").length,
      decisions: entries.filter((e) => e.kind === "decision").length,
      effortMin: durationMs !== undefined ? Math.round(durationMs / 60_000) : null,
      etaMs,
      ...(mergeSha ? { mergeSha } : {}),
      deploys,
    });
  }
  cards.sort((a, b) => (tsMs(b.startedAt ?? "") || 0) - (tsMs(a.startedAt ?? "") || 0));
  return cards;
}

/** Mean duration of tasks whose result was ok — the ETA baseline. */
export function avgDoneDuration(timelines: Map<string, ForensicEntry[]>): number | undefined {
  const ds: number[] = [];
  for (const entries of timelines.values()) {
    const result = [...entries].reverse().find((e) => e.kind === "result" && e.ok === true);
    if (!result || entries.length === 0) continue;
    const s = tsMs(entries[0]!.ts);
    const e = tsMs(result.ts);
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) ds.push(e - s);
  }
  if (ds.length === 0) return undefined;
  return ds.reduce((a, b) => a + b, 0) / ds.length;
}

/** Shot files for a task (post-deploy captures: <TASK>-<sha>-<ts>.png). */
export function shotsForTask(task: string, files: string[]): string[] {
  const prefix = `${task}-`;
  return files
    .filter((f) => f.startsWith(prefix) && f.endsWith(".png"))
    .sort()
    .reverse();
}

const PILOT_DIR = join(homedir(), ".opencode-remote", "pilot");
const PILOT_LOG = join(homedir(), ".opencode-remote", "logs", "pilot.log");

/** Read the forensic index from the real files; failures degrade to empty. */
export function readForensicIndex(): ForensicIndex {
  let logLines: string[] = [];
  let eventLines: string[] = [];
  try {
    logLines = readFileSync(PILOT_LOG, "utf8").split("\n").filter(Boolean);
  } catch {}
  try {
    eventLines = readFileSync(join(PILOT_DIR, "events.jsonl"), "utf8").split("\n").filter(Boolean);
  } catch {}
  return buildForensicIndex(logLines, eventLines);
}

/** List PNG shots under pilot/shots (post-deploy evidence). */
export function listShots(): string[] {
  try {
    return readdirSync(join(PILOT_DIR, "shots")).filter((f) => f.endsWith(".png"));
  } catch {
    return [];
  }
}

/** Absolute path of a validated shot name, or null. */
export function shotPath(name: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.png$/.test(name) || name.includes("..")) return null;
  return join(PILOT_DIR, "shots", name);
}

/**
 * Takeover data extracted from the real builder log (P2-048): the opencode
 * --print-logs output pins both the workspace directory and the session id.
 * Pure so the unit battery can pin the extraction.
 */
export function takeoverFromBuilderLog(
  lines: string[],
): { directory?: string; sessionId?: string } {
  let directory: string | undefined;
  let sessionId: string | undefined;
  for (const line of lines) {
    const dirMatch = /directory=(\S+)/.exec(line);
    if (dirMatch) directory = dirMatch[1];
    const sesMatch = /ses_[A-Za-z0-9]+/.exec(line);
    if (sesMatch) sessionId = sesMatch[0];
  }
  return { directory, sessionId };
}

/** The builder log lives at a fixed path per task. */
export function builderLogPath(task: string): string {
  return join(PILOT_DIR, `builder-${task}.log`);
}
