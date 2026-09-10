import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { appendAudit } from "../../daemon/src/auditlog";
import { log } from "./log";
import { digest } from "./push";

/**
 * P3-357 — supervisor notify with honest outcomes. notifySupervisor used to
 * swallow every error (bare `catch { return false }`) and read the daemon's
 * unconditional HTTP 200 as success, so a stale supervisor session or a dead
 * opencode API silently dropped every ping (grep pilot-notify audit.log = 0
 * all-time). Every attempt now:
 *   - logs warn with the REAL reason (HTTP status, socket error,
 *     delivered=false, missing config) or info on success;
 *   - appends a structured `pilot-notify` record to the shared machine audit
 *     trail (~/.opencode-remote/audit.log) so delivery history is grep-able;
 *   - on failure parks the message in pilot/notify-pending.jsonl — the next
 *     configured attempt drains that queue first (24h TTL, no duplicates);
 *   - when refusals repeat, the push digest gets a copy of the parked
 *     warnings marked "needs operator" (the phone notices what the
 *     supervisor chat cannot).
 */

/** Pending entries older than this are dropped, not replayed. */
export const NOTIFY_PENDING_TTL_MS = 24 * 60 * 60_000;
/** Parked refusals that trigger one "needs operator" push digest. */
export const NOTIFY_DIGEST_THRESHOLD = 3;
/** Hard bound for the pending file (oldest lines dropped first). */
export const NOTIFY_PENDING_MAX = 100;
/**
 * The daemon answers pilot-notify only after the supervisor session's full
 * opencode turn (measured >120s in production) — a short timeout here is the
 * reason notifications never landed. Long on purpose; callers outside the
 * pipeline-critical path await it.
 */
export const NOTIFY_TIMEOUT_MS = 120_000;
/** Reasons carry transport error text — bound them. */
const REASON_CAP = 200;

export interface NotifyResult {
  delivered: boolean;
  /** Real failure reason (HTTP status, socket text, delivered=false, config). */
  reason?: string;
  /** True when the outcome is UNKNOWN (timeout while the daemon may still be
   * delivering) — the message must NOT be queued for replay: the first copy
   * usually lands and a replay would duplicate it in the supervisor chat. */
  unknown?: boolean;
}

/** Minimal fetch shape — the real fetch satisfies it; tests inject fakes. */
export type NotifyTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface NotifyDeps {
  /** HTTP transport (default: global fetch to the loopback daemon). */
  transport?: NotifyTransport;
  /** State dir (~/.opencode-remote); tests point it at a temp dir. */
  dir?: string;
  now?: () => number;
  /** Push digest fn (default: push.ts digest); tests inject a spy. */
  push?: (title: string, body: string) => Promise<boolean>;
  /** Pilot log fn (default: log.ts); tests inject a spy. */
  logFn?: typeof log;
}

export interface PendingEntry {
  /** Epoch ms of the failed attempt. */
  ts: number;
  task: string;
  ok: boolean;
  text: string;
}

interface NotifyConfig {
  session?: string;
  token?: string;
  /** Real parse-failure reason (file named); a MISSING file is just the
   * normal not-configured state and must not be misreported (P3-357 r2). */
  error?: string;
}

function stateDir(deps: NotifyDeps): string {
  return deps.dir ?? join(homedir(), ".opencode-remote");
}

function pendingFile(dir: string): string {
  return join(dir, "pilot", "notify-pending.jsonl");
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, REASON_CAP);
}

function readConfig(dir: string): NotifyConfig {
  const out: NotifyConfig = {};
  let raw: string;
  try {
    raw = readFileSync(join(dir, "pilot.json"), "utf8");
  } catch {
    return out; // missing/unreadable file = the normal not-configured state
  }
  try {
    out.session = (JSON.parse(raw) as { supervisorSession?: string }).supervisorSession;
  } catch (err) {
    out.error = `pilot.json unparseable: ${errText(err)}`;
    return out;
  }
  try {
    raw = readFileSync(join(dir, "daemon.json"), "utf8");
  } catch {
    return out;
  }
  try {
    out.token = (JSON.parse(raw) as { apiToken?: string }).apiToken;
  } catch (err) {
    out.error = `daemon.json unparseable: ${errText(err)}`;
  }
  return out;
}

/** Build the message body for a fresh notification. */
function messageBody(task: string, ok: boolean, detail: string): string {
  return (
    `🔍 **Verificação complementar** — pilot ${ok ? "mergeou" : "falhou em"} **${task}**\n\n` +
    `${detail}\n\nAudite o resultado (diff, constituição, backlog) e redirecione se precisar.`
  );
}

/** Classify one delivery attempt; never throws. */
async function deliver(
  cfg: NotifyConfig,
  transport: NotifyTransport,
  text: string,
): Promise<NotifyResult> {
  if (cfg.error) return { delivered: false, reason: cfg.error };
  if (!cfg.session) return { delivered: false, reason: "no supervisorSession in pilot.json" };
  if (!cfg.token) return { delivered: false, reason: "no apiToken in daemon.json" };
  try {
    const res = await transport("http://127.0.0.1:8792/api/pilot-notify", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (!res.ok) return { delivered: false, reason: `daemon HTTP ${res.status}` };
    let body: { delivered?: boolean } | null = null;
    try {
      body = (await res.json()) as { delivered?: boolean };
    } catch {
      return { delivered: false, reason: "daemon response not JSON" };
    }
    if (body?.delivered !== true) {
      return { delivered: false, reason: "daemon could not reach the supervisor session (delivered=false)" };
    }
    return { delivered: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError" || /abort|timeout/i.test(msg)) {
      return {
        delivered: false,
        unknown: true,
        reason: `no answer in ${NOTIFY_TIMEOUT_MS / 1000}s — the daemon may still deliver the message (outcome unknown)`,
      };
    }
    return { delivered: false, reason: `transport: ${msg.slice(0, REASON_CAP)}` };
  }
}

/** Shared machine audit trail (daemon audit.log JSONL format), best-effort. */
function auditNotify(dir: string, data: { task: string; ok: boolean; reason?: string }): void {
  try {
    appendAudit(
      join(dir, "audit.log"),
      JSON.stringify({ ts: new Date().toISOString(), event: "pilot-notify", data }) + "\n",
    );
  } catch {}
}

function readPending(dir: string): PendingEntry[] {
  try {
    return readFileSync(pendingFile(dir), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as PendingEntry)
      .filter((e) => e && typeof e.ts === "number" && typeof e.text === "string");
  } catch {
    return [];
  }
}

function writePending(dir: string, entries: PendingEntry[]): void {
  try {
    mkdirSync(join(dir, "pilot"), { recursive: true });
    // mode applies at creation only — existing permissions are never touched
    if (entries.length === 0) {
      writeFileSync(pendingFile(dir), "", { mode: 0o600 });
      return;
    }
    writeFileSync(pendingFile(dir), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
  } catch {}
}

// P3-357 r2: every pending-file mutation is serialized behind one promise
// chain. A flush awaits up to NOTIFY_TIMEOUT_MS per entry, so an unsynchronized
// park landing mid-flush was erased by the flush's final rewrite, and two
// overlapping flushes delivered the same entry twice (reviewer repro).
let queueLock: Promise<unknown> = Promise.resolve();
function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueLock.then(fn, fn);
  queueLock = run.catch(() => undefined);
  return run;
}

/** Append one failed delivery under the queue lock; returns the fresh (< TTL)
 * queue size after. The rewrite is the ONLY place the cap is enforced — the
 * oldest entries are dropped first (append alone would grow the file forever). */
function parkPending(dir: string, entry: PendingEntry, nowMs: number): number {
  const all = [...readPending(dir), entry];
  writePending(dir, all.slice(-NOTIFY_PENDING_MAX));
  return all.filter((e) => nowMs - e.ts < NOTIFY_PENDING_TTL_MS).length;
}

/** Stamp the last successful delivery for the dashboard age widget. */
function stampDelivered(dir: string, nowMs: number): void {
  try {
    mkdirSync(join(dir, "pilot"), { recursive: true });
    writeFileSync(join(dir, "pilot", "notify-last"), String(nowMs));
  } catch {}
}

/**
 * Replay the pending queue through `transport`. Delivered entries are removed
 * (no duplicates), stale entries expire, failed entries stay exactly once.
 * The whole read-deliver-rewrite cycle runs under the queue lock: concurrent
 * flushes serialize instead of double-delivering, and a park landing mid-flush
 * survives the final rewrite.
 */
export function flushPending(
  cfg: NotifyConfig,
  transport: NotifyTransport,
  deps: NotifyDeps = {},
): Promise<number> {
  return withQueueLock(() => flushPendingLocked(cfg, transport, deps));
}

async function flushPendingLocked(
  cfg: NotifyConfig,
  transport: NotifyTransport,
  deps: NotifyDeps = {},
): Promise<number> {
  const dir = stateDir(deps);
  const nowMs = (deps.now ?? Date.now)();
  const logFn = deps.logFn ?? log;
  const pending = readPending(dir);
  if (pending.length === 0) return 0;
  const keep: PendingEntry[] = [];
  let delivered = 0;
  let expired = 0;
  let unknown = 0;
  for (const e of pending) {
    if (nowMs - e.ts >= NOTIFY_PENDING_TTL_MS) {
      expired++;
      continue;
    }
    const r = await deliver(cfg, transport, e.text);
    if (r.delivered) {
      delivered++;
      stampDelivered(dir, nowMs);
    } else if (r.unknown) {
      // the replay may have reached the session anyway — dropping beats a
      // duplicate supervisor ping (P3-357 no-duplicate rule)
      unknown++;
    } else {
      keep.push(e);
    }
  }
  if (delivered || expired || unknown || keep.length !== pending.length) writePending(dir, keep);
  if (delivered > 0) logFn("info", "supervisor notify backlog drained", { delivered, expired, unknown });
  else if (expired > 0 || unknown > 0) logFn("info", "supervisor notify backlog expired", { expired, unknown });
  return delivered;
}

/**
 * Wake the supervisor agent (the user's chat session) after a pipeline result.
 * Returns whether the message really reached the opencode session — the
 * daemon's HTTP 200 alone is NOT success (it wraps `{delivered}`).
 */
export async function notifySupervisor(
  task: string,
  ok: boolean,
  detail: string,
  deps: NotifyDeps = {},
): Promise<boolean> {
  const dir = stateDir(deps);
  const nowMs = (deps.now ?? Date.now)();
  const logFn = deps.logFn ?? log;
  const cfg = readConfig(dir);
  if (!cfg.session || !cfg.token) {
    logFn("warn", "supervisor notify skipped — not configured", {
      task,
      reason: cfg.error ?? (!cfg.session ? "no supervisorSession in pilot.json" : "no apiToken in daemon.json"),
    });
    return false;
  }
  const transport = deps.transport ?? ((url, init) => fetch(url, init));
  // fallback (P3-357): replay what previous attempts parked before sending ours
  await flushPending(cfg, transport, deps);
  const text = messageBody(task, ok, detail);
  const outcome = await deliver(cfg, transport, text);
  if (outcome.delivered) {
    stampDelivered(dir, nowMs);
    logFn("info", "supervisor notify delivered", { task, ok });
    auditNotify(dir, { task, ok: true });
    return true;
  }
  const reason = outcome.reason ?? "unknown";
  logFn("warn", "supervisor notify failed", { task, ok, reason });
  auditNotify(dir, { task, ok: false, reason });
  // unknown outcome (timeout while the daemon may still be delivering) is
  // never queued — a replay would duplicate the message in the supervisor chat
  if (outcome.unknown) return false;
  // park + digest copy under the queue lock: a concurrent flush's rewrite must
  // never erase the fresh entry, and the copy must reflect the parked set
  const { freshCount, copy } = await withQueueLock(async () => {
    const entry: PendingEntry = { ts: nowMs, task, ok, text };
    const count = parkPending(dir, entry, nowMs);
    const warnings = readPending(dir)
      .filter((e) => nowMs - e.ts < NOTIFY_PENDING_TTL_MS)
      .slice(-NOTIFY_DIGEST_THRESHOLD)
      .map((e) => `${e.task}: ${e.ok ? "ok" : "fail"}`)
      .join(" | ");
    return { freshCount: count, copy: warnings };
  });
  // repeated refusal → one digest copy marked "needs operator" per episode
  if (freshCount === NOTIFY_DIGEST_THRESHOLD) {
    try {
      await (deps.push ?? digest)(
        "📮 Pilot notify: needs operator",
        `supervisor notify falhou ${freshCount}x (${reason}) — pendências: ${copy} · needs operator`,
        "#/",
      );
    } catch {}
  }
  return false;
}
