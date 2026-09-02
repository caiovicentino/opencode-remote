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

/** One row of the opencode `session` table (only the token columns we need). */
export interface SessionTokens {
  id: string;
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
}

/** The pilot state fields P2-028 owns (documented in state.ts). Both optional
 * so a PilotState (or a hand-rolled fixture) satisfies the interface. */
export interface TaskCostStore {
  taskCosts?: Record<string, number>;
  taskCostSessions?: Record<string, string[]>;
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
  return `SELECT id, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write FROM session WHERE id IN (${list});`;
}

/** Parse `sqlite3 -json` output (array of SessionTokens; tolerate partial rows). */
export function parseSessionTokens(json: string): Record<string, number> {
  let rows: SessionTokens[] = [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return {};
    rows = parsed as SessionTokens[];
  } catch {
    return {};
  }
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (!r || typeof r.id !== "string" || !isSessionId(r.id)) continue;
    out[r.id] = (out[r.id] ?? 0) + sessionTotalTokens(r);
  }
  return out;
}

/**
 * Query opencode.db via the sqlite3 CLI (present on the host) for the given
 * session ids; returns {sessionId: totalTokens}. Chunked so long session
 * lists stay within sane command-line/SQL limits. `exec` is injectable for
 * the unit battery; the real path passes SQL over stdin (no shell).
 *
 * Round 2 (review): ASYNC — this runs inside `runSlot` on the shared event
 * loop, and with slots > 1 a sync spawn (the only one in pilot src) could
 * stall the other slot's stdout streaming and heartbeats for the whole
 * timeout. execFile keeps the loop free; a slow/locked DB now only delays
 * this one reconciliation promise.
 */
export async function querySessionTokens(
  ids: string[],
  dbPath: string = defaultOpencodeDb(),
  exec?: (dbPath: string, sql: string) => Promise<string>,
): Promise<Record<string, number>> {
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
  const out: Record<string, number> = {};
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100).filter(isSessionId);
    if (!chunk.length) continue;
    for (const [id, n] of Object.entries(parseSessionTokens(await run(dbPath, tokensSql(chunk))))) {
      out[id] = (out[id] ?? 0) + n;
    }
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
 */
export async function applySessionCosts(
  store: TaskCostStore,
  taskId: string,
  newSessions: string[] | undefined,
  query: (ids: string[]) => Promise<Record<string, number>>,
): Promise<void> {
  if (!taskId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)) return;
  store.taskCostSessions ??= {};
  store.taskCosts ??= {};
  const known = store.taskCostSessions[taskId] ?? [];
  for (const s of newSessions ?? []) {
    if (isSessionId(s) && !known.includes(s)) known.push(s);
  }
  if (!known.length) return;
  store.taskCostSessions[taskId] = known;
  const tokens = await query(known);
  const total = known.reduce((sum, id) => sum + (tokens[id] ?? 0), 0);
  if (total > 0) store.taskCosts[taskId] = total;
  pruneTaskCosts(store);
}

/** Keep the rolling window bounded: drop the oldest task ids past the cap. */
export function pruneTaskCosts(store: TaskCostStore, cap = TASK_COST_CAP): void {
  const costs = store.taskCosts ?? {};
  const sessions = store.taskCostSessions ?? {};
  for (const key of Object.keys(costs)) {
    if (Object.keys(costs).length <= cap) break;
    delete costs[key];
  }
  for (const key of Object.keys(sessions)) {
    if (Object.keys(sessions).length <= cap) break;
    delete sessions[key];
  }
  store.taskCosts = costs;
  store.taskCostSessions = sessions;
}
