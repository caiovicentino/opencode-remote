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
import { normalizeSessionModel, pricingFingerprint, taskCostUSD, type PricingConfig, type TaskUsd } from "./pricing";

/** One row of the opencode `session` table (only the token columns we need). */
export interface SessionTokens {
  id: string;
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  /** eval-18: reasoning tokens (billed as output by every provider that
   * reports them separately; 0 on the GLM gateway, which folds them into
   * output). Absent on legacy fixtures. */
  tokens_reasoning?: number;
  /** eval-18: parent session — subagent (`task` tool) sessions are separate
   * rows whose tokens never reach the parent's columns. */
  parent_id?: string;
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
  /** eval-18: pricingFingerprint() the taskUSD entries were last priced
   * with — the boot re-price runs only when it changes. */
  taskUSDPricing?: string;
  /** eval-18: task id → highest token-budget multiple already alerted
   * (tokenbudget.ts). Pruned with taskCosts. */
  tokenBudgetAlerts?: Record<string, number>;
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

/** Total tokens billed to one session (input + output + reasoning + both
 * cache kinds — eval-18: reasoning joins the sum, like context.ts and the
 * daemon gauge already count it). */
export function sessionTotalTokens(s: Omit<SessionTokens, "id">): number {
  return (
    (s.tokens_input || 0) +
    (s.tokens_output || 0) +
    (s.tokens_reasoning || 0) +
    (s.tokens_cache_read || 0) +
    (s.tokens_cache_write || 0)
  );
}

/**
 * SQL for one id-batched lookup. `ids` MUST pass isSessionId (regex-checked:
 * alnum-only after the ses_ prefix), which is what makes inlining safe —
 * no shell is involved either way (the SQL goes in via stdin).
 *
 * eval-18: the recursive CTE also returns every DESCENDANT session (subagents
 * spawned through opencode's `task` tool live in their own rows, linked by
 * parent_id — indexed, so the walk stays cheap on an 87GB database). Their
 * tokens used to vanish from the task's cost entirely.
 */
export function tokensSql(ids: string[]): string {
  const list = ids.map((id) => `'${id}'`).join(", ");
  return (
    `WITH RECURSIVE tree(id) AS (SELECT id FROM session WHERE id IN (${list}) ` +
    `UNION SELECT s.id FROM session s JOIN tree ON s.parent_id = tree.id) ` +
    `SELECT id, parent_id, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, model ` +
    `FROM session WHERE id IN (SELECT id FROM tree);`
  );
}

/** P1-077: provider prefix-cache hit ratio — cacheRead over cacheRead+input
 * (the two "prefix went through the model" token kinds); 0 on empty input so
 * logs/JSON never carry NaN. Eval r3: a ratio of exactly 0 across EVERY task
 * means the gateway is not reporting cache tokens at all (the SGLang server
 * behind glm52 needs `--enable-cache-report` — docs/PILOT.md, P1-077 entry),
 * not that the prefix never matched. */
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
    // eval-18: reasoning + subagent linkage (canonical parent ids only)
    if (r.tokens_reasoning) cur.tokens_reasoning = (cur.tokens_reasoning ?? 0) + (r.tokens_reasoning || 0);
    if (typeof r.parent_id === "string" && isSessionId(r.parent_id)) cur.parent_id = r.parent_id;
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
      // a descendant can come back from more than one chunk (its root sits
      // in one, but the recursive walk is per chunk) — rows are per-session
      // TOTALS, so a repeat is the same row, never additional usage
      if (!out[id]) out[id] = { ...row };
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
  pricing?: PricingConfig,
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
  const fold = foldTaskRows(known, await query(known), pricing);
  const { total, input, cacheRead, cacheWrite, sawRow } = fold;
  if (total > 0) {
    store.taskCosts[taskId] = total;
    if (sawRow) {
      store.taskCache ??= {};
      store.taskCache[taskId] = { input, cacheRead, cacheWrite };
    }
    store.taskUSD ??= {};
    store.taskUSD[taskId] = fold.usd;
  }
  pruneTaskCosts(store);
  return sawRow && total > 0
    ? { task: taskId, input, cacheRead, cacheWrite, ratio: cacheHitRatio(cacheRead, input) }
    : null;
}

/** One task's rows folded into totals + the dollar view (pure). */
interface TaskRowFold {
  total: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  sawRow: boolean;
  usd: TaskUsd;
  /** Every root session had a row (no transient DB gap). */
  complete: boolean;
}

/**
 * Pure fold shared by the reconciliation and the boot re-price. `known` are
 * the task's captured ROOT sessions; eval-18 adds every row whose parent
 * chain reaches one of them (subagent sessions from the recursive tokensSql).
 * A row whose parent is NOT in the task stays out — an injected or stray row
 * can never inflate a task it does not descend from.
 */
function foldTaskRows(
  known: string[],
  rows: Record<string, SessionTokens | number>,
  pricing?: PricingConfig,
): TaskRowFold {
  const inTask = new Set(known);
  const members = [...known];
  for (let grew = true; grew; ) {
    grew = false;
    for (const [id, r] of Object.entries(rows)) {
      if (inTask.has(id) || typeof r !== "object" || !r?.parent_id || !inTask.has(r.parent_id)) continue;
      inTask.add(id);
      members.push(id);
      grew = true;
    }
  }
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
  for (const id of members) {
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
    // eval-18: reasoning is generated output — billed at the output rate
    cols.output += (r.tokens_output || 0) + (r.tokens_reasoning || 0);
    cols.cacheRead += r.tokens_cache_read || 0;
    cols.cacheWrite += r.tokens_cache_write || 0;
  }
  // P2-113: BYOK list-price view. Legacy totals-only injectors carry no
  // model info — their tokens are counted as unpriced, never priced at $0
  // in a way that implies "free".
  const usd: TaskUsd = sawRow ? taskCostUSD(perModel, pricing) : { total: 0, tierA: 0, tierB: 0, unpricedTokens: 0, tokens: 0 };
  if (legacyTokens > 0) {
    usd.unpricedTokens += legacyTokens;
    usd.tokens += legacyTokens;
  }
  return { total, input, cacheRead, cacheWrite, sawRow, usd, complete: known.every((id) => rows[id] !== undefined) };
}

/**
 * eval-18: re-price the dollar view of every task in the rolling window when
 * the pricing changed (alias added, self-hosted rates configured) — the 68
 * tasks reconciled after the 2026-09-11 model-id rename stay "unpriced"
 * forever otherwise, since done tasks are never reconciled again.
 *
 * Only tasks whose every root session still has a row, and whose re-fold is
 * not below the recorded total, are touched: opencode.db may have lost old
 * sessions, and a recompute must never shrink a recorded cost. For those,
 * taskUSD, taskCosts and taskCache are replaced from the same fold
 * (descendant sessions included) — the tokens chip and the $ tooltip of one
 * task describe the same sessions. One batched query.
 */
export async function repriceTaskUSD(
  store: TaskCostStore,
  query: (ids: string[]) => Promise<Record<string, SessionTokens | number>>,
  pricing?: PricingConfig,
): Promise<{ changed: boolean; repriced: number; skipped: number; fingerprint: string }> {
  const fingerprint = pricingFingerprint(pricing);
  if (store.taskUSDPricing === fingerprint) return { changed: false, repriced: 0, skipped: 0, fingerprint };
  const sessions = store.taskCostSessions ?? {};
  const all = [...new Set(Object.values(sessions).flat().filter(isSessionId))];
  const rows = all.length ? await query(all) : {};
  let repriced = 0;
  let skipped = 0;
  store.taskUSD ??= {};
  for (const [task, known] of Object.entries(sessions)) {
    const valid = (known ?? []).filter(isSessionId);
    if (!valid.length) continue;
    const fold = foldTaskRows(valid, rows, pricing);
    // all-or-nothing per task: a gap in the DB or a re-fold BELOW the recorded
    // total leaves the task exactly as it was (never shrink, never split the
    // tokens chip from the $ view)
    if (!fold.complete || !fold.sawRow || fold.total <= 0 || fold.total < (store.taskCosts?.[task] ?? 0)) {
      skipped++;
      continue;
    }
    store.taskUSD[task] = fold.usd;
    store.taskCosts ??= {};
    store.taskCosts[task] = fold.total;
    store.taskCache ??= {};
    store.taskCache[task] = { input: fold.input, cacheRead: fold.cacheRead, cacheWrite: fold.cacheWrite };
    repriced++;
  }
  store.taskUSDPricing = fingerprint;
  return { changed: true, repriced, skipped, fingerprint };
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
    if (store.tokenBudgetAlerts) delete store.tokenBudgetAlerts[key]; // eval-18
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
  const alerts = store.tokenBudgetAlerts ?? {};
  for (const key of Object.keys(alerts)) {
    if (Object.keys(alerts).length <= cap) break;
    delete alerts[key];
  }
  if (store.tokenBudgetAlerts) store.tokenBudgetAlerts = alerts;
  store.taskCosts = costs;
  store.taskCostSessions = sessions;
  store.taskCache = cache;
  store.taskUSD = usd;
}
