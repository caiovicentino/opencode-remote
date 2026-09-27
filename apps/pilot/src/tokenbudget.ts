import { nowLocalISO } from "./log";
import { notifySupervisor } from "./notify";
import { emit } from "./events";

/**
 * eval-18 — per-task token budget + alert. The fleet averaged ~18M tokens per
 * merge, but single tasks ran to 51M (P3-465: a gate-green, reviewed attempt
 * lost to a merge conflict and a FRESH builder session redid the work) and
 * 86M (P2-332) with nothing surfacing it — the numbers only lived in
 * state.taskCosts. The budget is VISIBILITY, never a kill switch: the
 * operator's standing rule is quality and coherence over cost, so crossing it
 * raises an `alert` event + supervisor notify (like P2-115's guard alerts)
 * and escalates again at every further multiple (2x, 3x…) — the pipeline
 * itself is untouched.
 */

/** Whole budget multiples reached (0 below the budget, 0 when disabled).
 * The budget itself is pilot.json `tokenBudgetPerTask`, normalized in
 * state.ts (DEFAULT_TOKEN_BUDGET_PER_TASK). */
export function budgetLevel(tokens: number, budget: number): number {
  if (!(budget > 0) || !Number.isFinite(tokens) || tokens < budget) return 0;
  return Math.floor(tokens / budget);
}

/** Compact token count for the one-line alert ("51.3M"). */
export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.max(0, Math.round(n)));
}

export interface BudgetVerdict {
  alert: boolean;
  level: number;
  detail: string;
}

/**
 * Pure decision + bookkeeping: alert when the task's tokens reached a budget
 * multiple not alerted before (recorded in `store.tokenBudgetAlerts`, which
 * survives restarts and midnight — no re-alert storm on reboot). The detail
 * line is bounded for the 220-char event cap and carries no LLM text beyond
 * the caller's short outcome.
 */
export function checkTaskTokenBudget(
  store: { tokenBudgetAlerts?: Record<string, number> },
  taskId: string,
  tokens: number,
  budget: number,
  context: { outcome?: string } = {},
): BudgetVerdict {
  const level = budgetLevel(tokens, budget);
  const already = store.tokenBudgetAlerts?.[taskId] ?? 0;
  if (level === 0 || level <= already) return { alert: false, level, detail: "" };
  store.tokenBudgetAlerts ??= {};
  store.tokenBudgetAlerts[taskId] = level;
  const ratio = (tokens / budget).toFixed(1);
  const outcome = context.outcome ? ` — last: ${context.outcome.replace(/\s+/g, " ").trim().slice(0, 110)}` : "";
  const detail = `task ${taskId} used ${fmtTokens(tokens)} tokens (budget ${fmtTokens(budget)}, ${ratio}x)${outcome}`;
  return { alert: true, level, detail: detail.slice(0, 220) };
}

/**
 * Surface a verdict: error JSONL line, `alert` event (phase `token-budget`)
 * and a supervisor notify. Hooks injectable for tests; never throws into the
 * slot bookkeeping.
 */
export function raiseTokenBudgetAlert(
  taskId: string,
  verdict: BudgetVerdict,
  hooks?: { emitEvent?: typeof emit; notify?: typeof notifySupervisor },
): void {
  if (!verdict.alert) return;
  console.log(
    JSON.stringify({ ts: nowLocalISO(), level: "error", msg: "token-budget", data: { task: taskId, level: verdict.level, detail: verdict.detail } }),
  );
  const emitEvent = hooks?.emitEvent ?? emit;
  const notify = hooks?.notify ?? notifySupervisor;
  try {
    emitEvent("alert", { task: taskId, phase: "token-budget", ok: false, detail: verdict.detail });
  } catch {}
  try {
    void Promise.resolve(notify(taskId, false, verdict.detail)).catch(() => {});
  } catch {}
}
