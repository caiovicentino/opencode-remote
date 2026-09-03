/**
 * P2-028 — per-task token costs, read from the local opencode.db (SQLite).
 *
 * The token data already exists: every agent the pilot spawns is an opencode
 * session, and opencode's own database (`~/.local/share/opencode/opencode.db`)
 * carries per-session token totals in the `session` table (columns match the
 * sums of the per-message `data` JSON exactly, verified by probe). The runner
 * (P2-013) already captures each spawn's `ses_…` id from agent stdout — so the
 * pipeline just needs to reconcile those ids against the DB and accumulate the
 * totals into state.json as `taskCosts: {taskId: tokens}`.
 *
 * Data provenance is BEST-EFFORT (round 3 review): session ids are captured
 * from agent stdout, so a rogue/malicious agent could echo a foreign `ses_…`
 * and inflate its own task's cost line. taskCosts feeds cost prioritization
 * only — no gate or privilege decision consumes it. The reconciler also opens
 * the database strictly read-only (`sqlite3 -readonly`).
 *
 * Reconciliation is REPLACE-by-recompute, never ADD: a resumed builder session
 * grows over time, so the task's stored total is recomputed from the full set
 * of session ids ever recorded for it. Re-running the same round therefore
 * cannot double count, and retried attempts keep the attempts' earlier costs.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { normalizeSessionModel, taskCostUSD, type TaskUsd } from "./pricing";

/** One row of the opencode `session` table (only the token columns we need). */
export interface SessionTokens {
  id: string;
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  /** P2-113: raw `session.model` column (JSON blob/legacy string) — priced in
   * pricing.ts; undefined when the DB row predates the column. */
  model?: string;
}

/** The pilot state fields P2-028 owns (documented in state.ts). Both optional
 * so a PilotState (or a hand-rolled fixture) satisfies the interface. */
export interface TaskCostStore {
  taskCosts?: Record<string, number>;
  taskCostSessions?: Record<string, string[]>;
  /** P1-077: task id → provider prefix-cache breakdown across the task's
   * agent sessions. Additive sibling of taskCosts: same REPLACE-by-recompute
   * reconciliation and the same rolling cap. */
  taskCache?: Record<string, TaskCacheEntry>;
  /** P2-113: task id → BYOK list-price dollar view (see pricing.ts). Folded
   * by the same REPLACE-by-recompute reconciliation; no gate consumes it. */
  taskUSD?: Record<string, TaskUsd>;
}

/** P1-077: per-task cache-token breakdown (subset of the session columns). */
export interface TaskCacheEntry {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

/** P1-077: what the reconciliation folded for one task, ready for the log line. */
export interface TaskCacheFold extends TaskCacheEntry {
  task: string;
  /** cacheRead/(cacheRead+input); 0 when the denominator is 0. */
  ratio: number;
}

/**
 * Max task ids kept in taskCosts/taskCostSessions — a rolling window over the
 * most recent tasks, so state.json stays bounded (6 tasks/day ⇒ months of
 * history). Pruned in insertion order, oldest first.
 */
export const TASK_COST_CAP = 200;

/** Real opencode session ids are `ses_` + nanoid (22 alnum chars here). */
const SESSION_ID_RE = /^ses_[A-Za-z0-9]{4,64}$/;

/** Injection guard: only canonical ids may ever reach the SQL IN-list. */
export function isSessionId(id: string): boolean {
  return typeof id === "string" && SESSION_ID_RE.test(id);
}

export function defaultOpencodeDb(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) return join(xdg, "opencode", "opencode.db");
  return join(homedir(), ".local/share/opencode/opencode.db");
}

/** Total tokens billed to one session (input + output + both cache kinds). */
export function sessionTotalTokens(s: Omit<SessionTokens, "id">): number {
  return (
    (s.tokens_input || 0) +
    (s.tokens_output || 0) +
    (s.tokens_cache_read || 0) +
    (s.tokens_cache_write || 0)
  );
}

/**
 * SQL for one id-batched lookup. `ids` MUST pass isSessionId (regex-checked:
 * alnum-only after the ses_ prefix), which is what makes inlining safe —
 * no shell is involved either way (the SQL goes in via stdin).
 */
export function tokensSql(ids: string[]): string {
  const list = ids.map((id) => `'${id}'`).join(", ");
  return `SELECT id, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, model FROM session WHERE id IN (${list});`;
}

/** P1-077: provider prefix-cache hit ratio — cacheRead over cacheRead+input
 * (the two "prefix went through the model" token kinds); 0 on empty input so
 * logs/JSON never carry NaN. */
export function cacheHitRatio(cacheRead: number, input: number): number {
  const denom = cacheRead + input;
  return denom > 0 ? cacheRead / denom : 0;
}

/** Parse `sqlite3 -json` output into per-session 4-way breakdowns, keyed by
 * canonical session id (P1-077). Tolerates partial/garbage rows: missing
 * numeric columns count as 0 (older DBs predate the cache columns). */
export function parseSessionTokenRows(json: string): Record<string, SessionTokens> {
  let rows: SessionTokens[] = [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return {};
    rows = parsed as SessionTokens[];
  } catch {
    return {};
  }
  const out: Record<string, SessionTokens> = {};
  for (const r of rows) {
    if (!r || typeof r.id !== "string" || !isSessionId(r.id)) continue;
    const cur = (out[r.id] ??= { id: r.id, tokens_input: 0, tokens_output: 0, tokens_cache_read: 0, tokens_cache_write: 0 });
    cur.tokens_input += r.tokens_input || 0;
    cur.tokens_output += r.tokens_output || 0;
    cur.tokens_cache_read += r.tokens_cache_read || 0;
    cur.tokens_cache_write += r.tokens_cache_write || 0;
    // P2-113: last row wins — the reconciler emits at most one row per id
    if (typeof r.model === "string") cur.model = r.model;
  }
  return out;
}

/** Parse `sqlite3 -json` output (array of SessionTokens; tolerate partial rows). */
export function parseSessionTokens(json: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, row] of Object.entries(parseSessionTokenRows(json))) {
    out[id] = sessionTotalTokens(row);
  }
  return out;
}

/**
 * Query opencode.db via the sqlite3 CLI (present on the host) for the given
 * session ids; returns {sessionId: 4-way token breakdown} (P1-077). Chunked
 * so long session lists stay within sane command-line/SQL limits. `exec` is
 * injectable for the unit battery; the real path passes SQL over stdin (no
 * shell).
 *
 * Round 2 (review): ASYNC — this runs inside `runSlot` on the shared event
 * loop, and with slots > 1 a sync spawn (the only one in pilot src) could
 * stall the other slot's stdout streaming and heartbeats for the whole
 * timeout. execFile keeps the loop free; a slow/locked DB now only delays
 * this one reconciliation promise.
 */
export async function querySessionTokenRows(
  ids: string[],
  dbPath: string = defaultOpencodeDb(),
  exec?: (dbPath: string, sql: string) => Promise<string>,
): Promise<Record<string, SessionTokens>> {
  if (!ids.length) return {};
  const run =
    exec ??
    ((db: string, sql: string): Promise<string> =>
      new Promise((resolve, reject) => {
        // -readonly (round 3 review): the reconciler must never be able to
        // write the live opencode.db (WAL/journal of a running opencode);
        // writes now fail with "attempt to write a readonly database".
        const child = execFile("sqlite3", ["-readonly", "-json", db], { timeout: 15_000 }, (err, stdout) =>
          err ? reject(err) : resolve(String(stdout)),
        );
        child.stdin?.end(sql); // SQL via stdin: no shell, no argv leakage
      }));
  const out: Record<string, SessionTokens> = {};
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100).filter(isSessionId);
    if (!chunk.length) continue;
    for (const [id, row] of Object.entries(parseSessionTokenRows(await run(dbPath, tokensSql(chunk))))) {
      const cur = out[id];
      if (!cur) {
        out[id] = { ...row };
        continue;
      }
      cur.tokens_input += row.tokens_input;
      cur.tokens_output += row.tokens_output;
      cur.tokens_cache_read += row.tokens_cache_read;
      cur.tokens_cache_write += row.tokens_cache_write;
    }
  }
  return out;
}

/** Totals-only view of `querySessionTokenRows` (P2-028 shape). */
export async function querySessionTokens(
  ids: string[],
  dbPath: string = defaultOpencodeDb(),
  exec?: (dbPath: string, sql: string) => Promise<string>,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [id, row] of Object.entries(await querySessionTokenRows(ids, dbPath, exec))) {
    out[id] = sessionTotalTokens(row);
  }
  return out;
}

/**
 * Fold one task's freshly captured session ids into the cost store and
 * recompute its total from the DB. Pure mutator over `store` so the caller
 * (index.ts runSlot) decides when to persist. Every id is regex-validated
 * before it can reach the SQL layer. Missing/failed DB reads keep the
 * previous total (stale-but-honest beats erasing real data on a transient
 * sqlite error). Async so the sqlite3 child never blocks the event loop.
 *
 * P1-077: the injected query may return per-session 4-way rows
 * (`querySessionTokenRows`) or plain totals (legacy fixtures). Rows are the
 * real path: they additionally fold `input/cacheRead/cacheWrite` into
 * `store.taskCache` — REPLACE-by-recompute like the total, so a resumed
 * session never double-counts cache tokens. Returns the folded breakdown
 * (with hit ratio) for the caller's "task cache" log line, or null when
 * nothing was recorded.
 */
export async function applySessionCosts(
  store: TaskCostStore,
  taskId: string,
  newSessions: string[] | undefined,
  query: (ids: string[]) => Promise<Record<string, SessionTokens | number>>,
): Promise<TaskCacheFold | null> {
  if (!taskId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)) return null;
  store.taskCostSessions ??= {};
  store.taskCosts ??= {};
  const known = store.taskCostSessions[taskId] ?? [];
  for (const s of newSessions ?? []) {
    if (isSessionId(s) && !known.includes(s)) known.push(s);
  }
  if (!known.length) return null;
  store.taskCostSessions[taskId] = known;
  const rows = await query(known);
  let total = 0;
  let input = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let sawRow = false;
  // P2-113: per-model token groups — the pricing table is applied per model,
  // never against a blended total, so tier attribution stays honest.
  // Null prototype (round 2 review): session.model text is arbitrary — a row
  // with model "__proto__"/"constructor" must not resolve inherited keys and
  // pollute Object.prototype from the long-lived pilot process.
  const perModel: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> =
    Object.create(null);
  let legacyTokens = 0;
  for (const id of known) {
    const r = rows[id];
    if (!r) continue;
    if (typeof r === "number") {
      total += r; // legacy totals-only injector: no breakdown available
      legacyTokens += r;
      continue;
    }
    sawRow = true;
    total += sessionTotalTokens(r);
    input += r.tokens_input || 0;
    cacheRead += r.tokens_cache_read || 0;
    cacheWrite += r.tokens_cache_write || 0;
    const model = normalizeSessionModel(r.model);
    const cols = (perModel[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    cols.input += r.tokens_input || 0;
    cols.output += r.tokens_output || 0;
    cols.cacheRead += r.tokens_cache_read || 0;
    cols.cacheWrite += r.tokens_cache_write || 0;
  }
  if (total > 0) {
    store.taskCosts[taskId] = total;
    if (sawRow) {
      store.taskCache ??= {};
      store.taskCache[taskId] = { input, cacheRead, cacheWrite };
    }
    // P2-113: BYOK list-price view. Legacy totals-only injectors carry no
    // model info — their tokens are counted as unpriced, never priced at $0
    // in a way that implies "free".
    store.taskUSD ??= {};
    const usd = sawRow
      ? taskCostUSD(perModel)
      : { total: 0, tierA: 0, tierB: 0, unpricedTokens: 0, tokens: 0 };
    if (legacyTokens > 0) {
      usd.unpricedTokens += legacyTokens;
      usd.tokens += legacyTokens;
    }
    store.taskUSD[taskId] = usd;
  }
  pruneTaskCosts(store);
  return sawRow && total > 0
    ? { task: taskId, input, cacheRead, cacheWrite, ratio: cacheHitRatio(cacheRead, input) }
    : null;
}

/**
 * P1-078: fold one task's cache breakdown into the per-slot live window —
 * REPLACE by task (never accumulate), keyed by slot number. Pure mutator over
 * `store` so the caller decides when to persist. Returns the "slot cache" log
 * payload ({slot, task, input, cacheRead, cacheWrite, ratio}) or null when
 * there is nothing to fold.
 */
export function foldSlotCache(
  store: { slotCache?: Record<number, { input: number; cacheRead: number; cacheWrite: number }> },
  slot: number,
  fold: TaskCacheFold | null,
): (TaskCacheFold & { slot: number }) | null {
  if (!fold) return null;
  store.slotCache ??= {};
  store.slotCache[slot] = { input: fold.input, cacheRead: fold.cacheRead, cacheWrite: fold.cacheWrite };
  return { slot, ...fold };
}

/** Keep the rolling window bounded: drop the oldest task ids past the cap. */
export function pruneTaskCosts(store: TaskCostStore, cap = TASK_COST_CAP): void {
  const costs = store.taskCosts ?? {};
  const sessions = store.taskCostSessions ?? {};
  const cache = store.taskCache ?? {};
  const usd = store.taskUSD ?? {}; // P2-113: keep the dollar view aligned
  for (const key of Object.keys(costs)) {
    if (Object.keys(costs).length <= cap) break;
    delete costs[key];
    delete sessions[key]; // P1-077: keep the sibling maps aligned
    delete cache[key];
    delete usd[key];
  }
  for (const key of Object.keys(sessions)) {
    if (Object.keys(sessions).length <= cap) break;
    delete sessions[key];
  }
  for (const key of Object.keys(cache)) {
    if (Object.keys(cache).length <= cap) break;
    delete cache[key];
  }
  for (const key of Object.keys(usd)) {
    if (Object.keys(usd).length <= cap) break;
    delete usd[key];
  }
  store.taskCosts = costs;
  store.taskCostSessions = sessions;
  store.taskCache = cache;
  store.taskUSD = usd;
}
