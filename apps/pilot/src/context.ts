/**
 * P1-079 — context-pressure checkpoint for long builder sessions.
 *
 * The pilot resumes the same opencode session across builder rounds (context
 * cache), so the session's token total grows monotonically. A builder that
 * overflows the model window dies mid-round and the crash burns an attempt as
 * if it were merit — but overflowing context is infra, not merit (P1-074
 * spirit). Before each round the pipeline measures the session's pressure
 * (tokens vs the model's context window, straight from the opencode API — the
 * same numbers opencode persists in opencode.db) and, past the critical
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
  /** input+output+reasoning+cacheRead+cacheWrite billed to the session. */
  tokens: number;
  /** The model's context window (tokens). */
  window: number;
  /** Model id as opencode reports it (e.g. "glm-5.2"). */
  model: string;
  /** tokens/window as a percentage (0..100). */
  pct: number;
}

interface OpencodeSessionShape {
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  model?: { providerID?: string; modelID?: string };
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
 * (`GET /session/:id` + `GET /provider`). Returns null on ANY failure — the
 * checkpoint is best-effort by design: an unmeasurable session keeps the
 * pre-P1-079 behavior (builder keeps going, crash still classified by
 * P1-094). `fetchImpl`/`url` injectable for the unit battery.
 */
export async function fetchSessionContext(
  sessionId: string,
  url: string = OPENCODE_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<SessionContext | null> {
  if (!/^ses_[A-Za-z0-9]{4,64}$/.test(sessionId)) return null;
  try {
    const sres = await fetchImpl(`${url}/session/${sessionId}`, { signal: AbortSignal.timeout(5_000) });
    if (!sres.ok) return null;
    const s = (await sres.json()) as OpencodeSessionShape;
    const t = s.tokens ?? {};
    const tokens =
      (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
    const providerID = s.model?.providerID ?? "";
    const modelID = s.model?.modelID ?? "";
    if (!providerID || !modelID) return null;
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
