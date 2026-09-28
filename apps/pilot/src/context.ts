/**
 * P1-079 — context-pressure checkpoint for long builder sessions.
 *
 * The pilot resumes the same opencode session across builder rounds (context
 * cache), so the session's live context grows round after round. A builder that
 * overflows the model window dies mid-round and the crash burns an attempt as
 * if it were merit — but overflowing context is infra, not merit (P1-074
 * spirit). Before each round the pipeline measures the session's pressure
 * (the last turn's context vs the model's window, straight from the opencode
 * API — the same numbers opencode persists in opencode.db) and, past the critical
 * threshold, generates a state recap, records it in the task carryover and
 * opens a FRESH session for the next round. No attempt is burned.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { nowLocalISO } from "./log";
import { OPENCODE_URL } from "./runner";

/** Gauge/checkpoint thresholds: yellow from here (share of the window). */
export const CONTEXT_WARN_PCT = 70;
/** Critical: at/above this the pipeline recaps and reopens the session. */
export const CONTEXT_CRITICAL_PCT = 85;

/**
 * Pure pressure calculation: how full is the model window, in percent.
 * Tolerates garbage (negative/NaN tokens, zero window) → 0; caps at 100.
 */
export function contextPct(tokens: number, window: number): number {
  if (!Number.isFinite(tokens) || !Number.isFinite(window) || window <= 0 || tokens <= 0) return 0;
  return Math.min(100, (tokens / window) * 100);
}

/** Pure checkpoint decision — the whole P1-079 trigger. */
export function isContextCritical(pct: number): boolean {
  return Number.isFinite(pct) && pct >= CONTEXT_CRITICAL_PCT;
}

export interface SessionContext {
  /** eval-18: tokens the session's LAST assistant turn held in the window
   * (input+output+reasoning+cacheRead+cacheWrite of that one message — the
   * number opencode itself shows as context usage). NOT the session's
   * cumulative bill: that sums every turn (P3-465: 27M billed vs a 205K
   * context) and read as "100%" on any resumed round. */
  tokens: number;
  /** The model's context window (tokens). */
  window: number;
  /** Model id as opencode reports it (e.g. "glm-5.3-flash"). */
  model: string;
  /** tokens/window as a percentage (0..100). */
  pct: number;
}

type TurnTokens = {
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
};

/** One entry of `GET /session/:id/message` (opencode 1.18.x: {info, parts}). */
interface OpencodeMessageShape {
  info?: {
    role?: string;
    providerID?: string;
    modelID?: string;
    tokens?: TurnTokens;
    time?: { created?: number };
  };
}

/** Messages fetched per probe: the last assistant turn is always in the tail. */
export const CONTEXT_PROBE_MESSAGES = 4;

const nonNeg = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

/**
 * eval-18 (pure): the live context of a session from the tail of its message
 * list — the most recent assistant message that carries tokens and a model.
 * `tokens.total` wins when present (opencode's own sum); otherwise the five
 * kinds are summed. Null when the tail has no measurable assistant turn.
 */
export function lastTurnContext(messages: unknown): { tokens: number; providerID: string; modelID: string } | null {
  if (!Array.isArray(messages)) return null;
  let best: { tokens: number; providerID: string; modelID: string; at: number; idx: number } | null = null;
  messages.forEach((m: OpencodeMessageShape, idx) => {
    const info = m?.info;
    if (!info || info.role !== "assistant" || !info.tokens) return;
    const providerID = typeof info.providerID === "string" ? info.providerID : "";
    const modelID = typeof info.modelID === "string" ? info.modelID : "";
    if (!providerID || !modelID) return;
    const t = info.tokens;
    const summed = nonNeg(t.input) + nonNeg(t.output) + nonNeg(t.reasoning) + nonNeg(t.cache?.read) + nonNeg(t.cache?.write);
    const tokens = nonNeg(t.total) || summed;
    if (tokens <= 0) return;
    const at = nonNeg(info.time?.created);
    // latest by creation time; list order breaks ties (the route is chronological)
    if (!best || at > best.at || (at === best.at && idx > best.idx)) best = { tokens, providerID, modelID, at, idx };
  });
  if (!best) return null;
  const { tokens, providerID, modelID } = best;
  return { tokens, providerID, modelID };
}

interface OpencodeProviderShape {
  all?: {
    id: string;
    models?: Record<string, { id?: string; limit?: { context?: number } }>;
  }[];
}

/** Resolve the model's context window from the /provider catalog. */
export function contextWindowFor(
  providers: OpencodeProviderShape,
  providerID: string,
  modelID: string,
): number {
  for (const p of providers.all ?? []) {
    if (p?.id !== providerID) continue;
    for (const [key, m] of Object.entries(p.models ?? {})) {
      if (key === modelID || m?.id === modelID || key === `${providerID}/${modelID}`) {
        const ctx = m.limit?.context;
        return typeof ctx === "number" && Number.isFinite(ctx) && ctx > 0 ? ctx : 0;
      }
    }
    break;
  }
  return 0;
}

/**
 * Measure one session's context pressure against the live opencode server
 * (`GET /session/:id/message?limit=N` + `GET /provider`). Returns null on ANY
 * failure — the checkpoint is best-effort by design: an unmeasurable session
 * keeps the pre-P1-079 behavior (builder keeps going, crash still classified
 * by P1-094). `fetchImpl`/`url` injectable for the unit battery.
 *
 * eval-18: the first version read `GET /session/:id`, whose `model` is
 * `{id, providerID, variant}` in opencode 1.18.x — it looked for `modelID`,
 * so every probe returned null (zero `contextPressure` lines in 1,447
 * builder rounds, 08-31..09-24) — and its `tokens` are the cumulative bill,
 * which would have read as 100% on every resumed round had the id matched.
 * The last assistant message carries both the per-turn context and
 * `providerID`/`modelID`.
 */
export async function fetchSessionContext(
  sessionId: string,
  url: string = OPENCODE_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<SessionContext | null> {
  if (!/^ses_[A-Za-z0-9]{4,64}$/.test(sessionId)) return null;
  try {
    const mres = await fetchImpl(`${url}/session/${sessionId}/message?limit=${CONTEXT_PROBE_MESSAGES}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!mres.ok) return null;
    const turn = lastTurnContext(await mres.json());
    if (!turn) return null;
    const { tokens, providerID, modelID } = turn;
    const pres = await fetchImpl(`${url}/provider`, { signal: AbortSignal.timeout(15_000) });
    if (!pres.ok) return null;
    const window = contextWindowFor((await pres.json()) as OpencodeProviderShape, providerID, modelID);
    if (window <= 0) return null;
    return { tokens, window, model: modelID, pct: contextPct(tokens, window) };
  } catch {
    return null;
  }
}

// ── P1-079: per-task recap carryover ─────────────────────────────────────────

/** {task, recap, round, at} persisted for a task whose session was recycled. */
export interface RecapCarry {
  task: string;
  recap: string;
  round: number;
  at: string;
}

/**
 * Injectable base dir for the unit battery — the real path lives under
 * ~/.opencode-remote/pilot/carryover and must never be touched by tests.
 */
let recapCarryDir: string | null = null;

/** Point the carryover helpers at a temp dir; call again with null to reset. */
export function setRecapCarryDir(dir: string | null): void {
  recapCarryDir = dir;
}

function carryFile(taskId: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)) return null;
  const base = recapCarryDir ?? join(homedir(), ".opencode-remote/pilot/carryover");
  return join(base, `${taskId}.json`);
}

/** Persist the recap in the task carryover (best-effort — pipeline bookkeeping). */
export function saveRecapCarry(taskId: string, recap: string, round: number): void {
  const f = carryFile(taskId);
  if (!f) return;
  try {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ task: taskId, recap, round, at: nowLocalISO() } satisfies RecapCarry, null, 2));
  } catch {}
}

/** Load the persisted recap for a task, or null. Tolerant by design. */
export function loadRecapCarry(taskId: string): RecapCarry | null {
  const f = carryFile(taskId);
  if (!f) return null;
  try {
    const c = JSON.parse(readFileSync(f, "utf8")) as RecapCarry;
    if (c?.task !== taskId || typeof c.recap !== "string" || !c.recap.trim()) return null;
    return c;
  } catch {
    return null;
  }
}

/** Remove the carryover file once it has been consumed (merge or clean round). */
export function clearRecapCarry(taskId: string): void {
  const f = carryFile(taskId);
  if (!f || !existsSync(f)) return;
  try {
    rmSync(f);
  } catch {}
}
