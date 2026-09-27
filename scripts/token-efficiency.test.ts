/**
 * eval-18 — token & compute efficiency of the fleet.
 *  - pricing: the glm-5.3-flash alias (68/200 tasks sat "unpriced" after the
 *    2026-09-11 model-id rename), the self-hosted ops view (pilot.json
 *    `pricing.selfHosted`: $/MTok or GPU-hour amortization) and the re-price
 *    fingerprint;
 *  - costs: subagent (descendant) sessions + reasoning tokens folded into the
 *    task, the boot re-price that never shrinks a recorded cost;
 *  - token budget: alert at each budget multiple, persisted across restarts
 *    and the midnight rollover, never a kill switch;
 *  - runner: `sessionCapture` attributes reviewer/scribe/recap sessions
 *    (0 of 228 reviewer sessions were attributed) without changing the text
 *    the parsers read;
 *  - AGENTS.md budget ratchet (injected into every agent turn).
 * Portable (scripts/portable-suite.ts): fs/os/path only — the runner checks
 * drive a fake child over PassThrough streams, nothing is spawned or bound.
 * Run: npx tsx scripts/token-efficiency.test.ts
 */
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

// hermetic: nothing below may append to the real pilot event feed
const tmp = mkdtempSync(join(tmpdir(), "ocr-token-eff-"));
process.env.PILOT_EVENTS_FILE = join(tmp, "events.jsonl");

const {
  DEFAULT_COMPUTE_WEIGHTS,
  MODEL_ALIASES,
  PRICE_TABLE,
  listPriceFor,
  normalizePricingConfig,
  pricingFingerprint,
  taskCostUSD,
} = await import("../apps/pilot/src/pricing");
const { applySessionCosts, parseSessionTokenRows, pruneTaskCosts, querySessionTokenRows, repriceTaskUSD, sessionTotalTokens, tokensSql } =
  await import("../apps/pilot/src/costs");
const { budgetLevel, checkTaskTokenBudget, fmtTokens, raiseTokenBudgetAlert } = await import("../apps/pilot/src/tokenbudget");
const { DEFAULT_TOKEN_BUDGET_PER_TASK, loadState, normalizePilotConfig, normalizeTokenBudget } = await import("../apps/pilot/src/state");
const { logLineStripper, rootSessionScanner, runAgent } = await import("../apps/pilot/src/runner");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}
const close = (a: number | undefined, b: number) => typeof a === "number" && Math.abs(a - b) < 1e-9;
const repoRoot = join(import.meta.dirname, "..");

// ── pricing: alias ───────────────────────────────────────────────────────────
{
  check("alias: glm-5.3-flash resolves to the glm-5.2 BYOK row", MODEL_ALIASES["glm-5.3-flash"] === "glm-5.2" && listPriceFor("glm-5.3-flash") === PRICE_TABLE["glm-5.2"]);
  check("alias: exact rows still win, unknown ids stay unpriced", listPriceFor("glm-5.2") === PRICE_TABLE["glm-5.2"] && listPriceFor("mystery-model") === undefined);
  check("alias: __proto__/constructor never resolve to inherited members", listPriceFor("__proto__") === undefined && listPriceFor("constructor") === undefined && listPriceFor("toString") === undefined);
  const flash = taskCostUSD({ "glm-5.3-flash": { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 0 } });
  const glm = taskCostUSD({ "glm-5.2": { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 0 } });
  check("alias: glm-5.3-flash 1M+1M+1M prices exactly like glm-5.2 ($6.06, tier A)", close(flash.total, 6.06) && close(flash.tierA, glm.tierA) && flash.unpricedTokens === 0);
  check("alias: no pricing config → no ops fields (never a fake $0)", !("opsUSD" in flash) && !("opsTokens" in flash));
}

// ── pricing: self-hosted config normalization ───────────────────────────────
{
  check("selfHosted: garbage / absent → undefined", normalizePricingConfig(undefined) === undefined && normalizePricingConfig("x") === undefined && normalizePricingConfig({}) === undefined && normalizePricingConfig({ selfHosted: 3 }) === undefined);
  check("selfHosted: no model ids → undefined", normalizePricingConfig({ selfHosted: { models: [], usdPerHour: 10, mtokPerHour: 5 } }) === undefined && normalizePricingConfig({ selfHosted: { models: [1, ""], usdPerHour: 10, mtokPerHour: 5 } }) === undefined);
  const direct = normalizePricingConfig({ selfHosted: { models: ["glm-5.3-flash", "glm-5.3-flash", " glm-5.2 "], usdPerMTok: { input: 0.5, output: 2, cacheRead: 0.05, cacheWrite: 0 } } });
  check(
    "selfHosted: direct $/MTok table, models deduped + trimmed",
    direct?.selfHosted?.basis === "usdPerMTok" && JSON.stringify(direct.selfHosted.models) === JSON.stringify(["glm-5.3-flash", "glm-5.2"]) && direct.selfHosted.usdPerMTok.output === 2,
  );
  const gpu = normalizePricingConfig({ selfHosted: { models: ["glm-5.3-flash"], usdPerHour: 20, mtokPerHour: 8 } });
  const perW = 20 / 8;
  check(
    "selfHosted: GPU-hour amortization = usdPerHour / weighted MTok per hour × default weights",
    gpu?.selfHosted?.basis === "gpuHour" &&
      close(gpu.selfHosted.usdPerMTok.input, perW * DEFAULT_COMPUTE_WEIGHTS.input) &&
      close(gpu.selfHosted.usdPerMTok.output, perW * (4.4 / 1.4)) &&
      close(gpu.selfHosted.usdPerMTok.cacheRead, perW * (0.26 / 1.4)) &&
      close(gpu.selfHosted.usdPerMTok.cacheWrite, perW) &&
      gpu.selfHosted.usdPerHour === 20 && gpu.selfHosted.mtokPerHour === 8,
  );
  const custom = normalizePricingConfig({ selfHosted: { models: ["m"], usdPerHour: 10, mtokPerHour: 10, weights: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } } });
  check("selfHosted: custom weights apply", close(custom?.selfHosted?.usdPerMTok.output, 5) && close(custom?.selfHosted?.usdPerMTok.cacheWrite, 1.25));
  const halfTable = normalizePricingConfig({ selfHosted: { models: ["m"], usdPerMTok: { input: 1, output: 2 } } });
  check("selfHosted: a half-filled $/MTok table never prices missing columns at $0 (block dropped)", halfTable === undefined);
  check(
    "selfHosted: NaN / zero / negative rates → block dropped, never NaN",
    normalizePricingConfig({ selfHosted: { models: ["m"], usdPerHour: Number.NaN, mtokPerHour: 5 } }) === undefined &&
      normalizePricingConfig({ selfHosted: { models: ["m"], usdPerHour: 10, mtokPerHour: 0 } }) === undefined &&
      normalizePricingConfig({ selfHosted: { models: ["m"], usdPerHour: -1, mtokPerHour: 5 } }) === undefined &&
      normalizePricingConfig({ selfHosted: { models: ["m"], usdPerMTok: { input: -1, output: 1, cacheRead: 1, cacheWrite: 1 } } }) === undefined,
  );
  const garbageWeights = normalizePricingConfig({ selfHosted: { models: ["m"], usdPerHour: 10, mtokPerHour: 10, weights: { input: "x" } } });
  check("selfHosted: garbage weights fall back to the defaults", close(garbageWeights?.selfHosted?.usdPerMTok.output, 4.4 / 1.4));
}

// ── pricing: ops view in taskCostUSD ─────────────────────────────────────────
{
  const pricing = normalizePricingConfig({ selfHosted: { models: ["glm-5.3-flash"], usdPerMTok: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } } });
  const perModel = {
    "glm-5.3-flash": { input: 1e6, output: 1e6, cacheRead: 10e6, cacheWrite: 0 },
    "claude-sonnet-4-6": { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const withOps = taskCostUSD(perModel, pricing);
  const byok = taskCostUSD(perModel);
  // ops: 1×1 + 1×2 + 10×0.1 = $4 over 12M tokens of the self-hosted model only
  check("ops: opsUSD prices only the self-hosted models ($4.00 over 12M tokens)", close(withOps.opsUSD, 4) && withOps.opsTokens === 12e6);
  check(
    "ops: the BYOK list fields are byte-identical with or without the ops config",
    close(withOps.total, byok.total) && close(withOps.tierA, byok.tierA) && close(withOps.tierB, byok.tierB) && withOps.unpricedTokens === byok.unpricedTokens && withOps.tokens === byok.tokens,
  );
  const none = taskCostUSD({ "claude-sonnet-4-6": { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 } }, pricing);
  check("ops: configured but no self-hosted tokens → opsUSD 0 / opsTokens 0 (present, honest zero)", none.opsUSD === 0 && none.opsTokens === 0);
  const fp1 = pricingFingerprint(undefined);
  check("fingerprint: stable for the same inputs", fp1 === pricingFingerprint(undefined) && /^v1-[0-9a-f]+$/.test(fp1));
  check("fingerprint: changes when the self-hosted config changes", fp1 !== pricingFingerprint(pricing) && pricingFingerprint(pricing) !== pricingFingerprint(normalizePricingConfig({ selfHosted: { models: ["glm-5.3-flash"], usdPerHour: 9, mtokPerHour: 3 } })));
}

// ── costs: descendants, reasoning, chunk dedupe ──────────────────────────────
{
  const sql = tokensSql(["ses_root00000001"]);
  check("costs sql: recursive walk over parent_id, validated ids still inlined", sql.includes("IN ('ses_root00000001')") && /WITH RECURSIVE tree/.test(sql) && sql.includes("s.parent_id = tree.id") && sql.includes("tokens_reasoning"));
  const parsed = parseSessionTokenRows(
    JSON.stringify([
      { id: "ses_child0000001", parent_id: "ses_root00000001", tokens_input: 1, tokens_output: 2, tokens_reasoning: 3, tokens_cache_read: 4, tokens_cache_write: 0 },
      { id: "ses_child0000002", parent_id: "ses_x'; DROP", tokens_input: 1, tokens_output: 0, tokens_cache_read: 0, tokens_cache_write: 0 },
    ]),
  );
  check("costs parse: parent_id + reasoning kept; a hostile parent id is dropped", parsed.ses_child0000001.parent_id === "ses_root00000001" && parsed.ses_child0000001.tokens_reasoning === 3 && parsed.ses_child0000002.parent_id === undefined);
  check("costs total: reasoning joins the five-kind sum", sessionTotalTokens({ tokens_input: 1, tokens_output: 2, tokens_reasoning: 3, tokens_cache_read: 4, tokens_cache_write: 5 }) === 15);

  const glm = '{"id":"glm-5.3-flash","providerID":"b200x4","variant":"default"}';
  const rows = {
    ses_root00000001: { id: "ses_root00000001", tokens_input: 1000, tokens_output: 100, tokens_cache_read: 10_000, tokens_cache_write: 0, model: glm },
    // subagent of the builder, and ITS subagent (grandchild)
    ses_child0000001: { id: "ses_child0000001", parent_id: "ses_root00000001", tokens_input: 200, tokens_output: 50, tokens_reasoning: 10, tokens_cache_read: 2_000, tokens_cache_write: 0, model: glm },
    ses_grand0000001: { id: "ses_grand0000001", parent_id: "ses_child0000001", tokens_input: 20, tokens_output: 5, tokens_cache_read: 100, tokens_cache_write: 0, model: glm },
    // a stray row whose parent is NOT in this task must never be counted
    ses_stray0000001: { id: "ses_stray0000001", parent_id: "ses_other0000001", tokens_input: 9e9, tokens_output: 0, tokens_cache_read: 0, tokens_cache_write: 0, model: glm },
  };
  const store: Parameters<typeof applySessionCosts>[0] = {};
  const fold = await applySessionCosts(store, "P3-465", ["ses_root00000001"], async () => rows);
  const expectTotal = 1000 + 100 + 10_000 + (200 + 50 + 10 + 2_000) + (20 + 5 + 100);
  check("costs fold: child + grandchild subagent sessions count toward the task, a stray row does not", store.taskCosts?.["P3-465"] === expectTotal, `got ${store.taskCosts?.["P3-465"]}`);
  check("costs fold: descendants never become recorded roots (re-discovered on every recompute)", JSON.stringify(store.taskCostSessions?.["P3-465"]) === JSON.stringify(["ses_root00000001"]));
  check("costs fold: cache breakdown includes the descendants", fold?.input === 1220 && fold.cacheRead === 12_100);
  const usd = store.taskUSD?.["P3-465"];
  // reasoning is priced as output: output column = 100 + (50+10) + 5 = 165
  const expectUsd = (1220 * 1.4 + 165 * 4.4 + 12_100 * 0.26) / 1e6;
  check("costs fold: glm-5.3-flash priced via the alias, reasoning at the output rate", close(usd?.total, expectUsd) && usd?.unpricedTokens === 0, `got ${usd?.total} want ${expectUsd}`);

  // querySessionTokenRows: a row repeated across chunks is the same per-session
  // total — never summed twice
  const ids = Array.from({ length: 150 }, (_, i) => `ses_bulk${String(i).padStart(8, "0")}`);
  let calls = 0;
  const dup = { id: "ses_shared000001", parent_id: "ses_bulk00000000", tokens_input: 7, tokens_output: 0, tokens_cache_read: 0, tokens_cache_write: 0 };
  const merged = await querySessionTokenRows(ids, "/nonexistent.db", async () => {
    calls++;
    return JSON.stringify([dup]);
  });
  check("costs query: 150 ids → 2 chunks; a repeated row is kept once (not 14 tokens)", calls === 2 && merged.ses_shared000001.tokens_input === 7);
}

// ── costs: boot re-price ──────────────────────────────────────────────────────
{
  const glm = '{"id":"glm-5.3-flash","providerID":"b200x4"}';
  const row = (id: string) => ({ id, tokens_input: 1_000_000, tokens_output: 0, tokens_cache_read: 0, tokens_cache_write: 0, model: glm });
  const store: Parameters<typeof repriceTaskUSD>[0] = {
    taskCosts: { "P3-001": 1_000_000, "P3-002": 2_000_000 },
    taskCostSessions: { "P3-001": ["ses_rp0000000001"], "P3-002": ["ses_rp0000000002", "ses_rp0000000gone"] },
    taskUSD: {
      "P3-001": { total: 0, tierA: 0, tierB: 0, unpricedTokens: 1_000_000, tokens: 1_000_000 },
      "P3-002": { total: 0, tierA: 0, tierB: 0, unpricedTokens: 2_000_000, tokens: 2_000_000 },
    },
  };
  let asked: string[] = [];
  const query = async (ids: string[]) => {
    asked = ids;
    return { ses_rp0000000001: row("ses_rp0000000001"), ses_rp0000000002: row("ses_rp0000000002") };
  };
  const r1 = await repriceTaskUSD(store, query);
  check("reprice: the previously unpriced glm-5.3-flash task gets its $ view ($1.40)", r1.changed && r1.repriced === 1 && close(store.taskUSD?.["P3-001"]?.total, 1.4));
  check("reprice: a task with a vanished root session is skipped (never shrinks)", r1.skipped === 1 && store.taskUSD?.["P3-002"]?.total === 0 && store.taskUSD["P3-002"].unpricedTokens === 2_000_000);
  check("reprice: taskCosts untouched (REPLACE-by-recompute stays with applySessionCosts)", store.taskCosts?.["P3-001"] === 1_000_000 && store.taskCosts["P3-002"] === 2_000_000);
  check("reprice: ONE batched query for the whole window", asked.length === 3);
  let again = 0;
  const r2 = await repriceTaskUSD(store, async () => {
    again++;
    return {};
  });
  check("reprice: same fingerprint → no-op, no query", !r2.changed && again === 0 && store.taskUSDPricing === r1.fingerprint);
  const ops = normalizePricingConfig({ selfHosted: { models: ["glm-5.3-flash"], usdPerMTok: { input: 2, output: 2, cacheRead: 2, cacheWrite: 2 } } });
  const r3 = await repriceTaskUSD(store, query, ops);
  check("reprice: a new self-hosted config re-prices and adds opsUSD", r3.changed && close(store.taskUSD?.["P3-001"]?.opsUSD, 2) && store.taskUSDPricing === pricingFingerprint(ops));
}

// ── token budget ──────────────────────────────────────────────────────────────
{
  check("budget: default ≈ p95 of the 200-task window (40M)", DEFAULT_TOKEN_BUDGET_PER_TASK === 40_000_000 && normalizeTokenBudget(undefined) === 40_000_000);
  check("budget: 0 disables, garbage → default, fractions floor", normalizeTokenBudget(0) === 0 && normalizeTokenBudget("x") === 40_000_000 && normalizeTokenBudget(-5) === 40_000_000 && normalizeTokenBudget(1.9e6 + 0.5) === 1_900_000);
  check("budget: levels", budgetLevel(39_999_999, 40e6) === 0 && budgetLevel(40e6, 40e6) === 1 && budgetLevel(85.6e6, 40e6) === 2 && budgetLevel(1e9, 0) === 0 && budgetLevel(Number.NaN, 40e6) === 0);
  check("budget: compact token format", fmtTokens(51_307_260) === "51.3M" && fmtTokens(2.74e9) === "2.74B" && fmtTokens(950) === "950");
  const st: { tokenBudgetAlerts?: Record<string, number> } = {};
  check("budget: below the budget → no alert, nothing recorded", !checkTaskTokenBudget(st, "P3-001", 10e6, 40e6).alert && st.tokenBudgetAlerts === undefined);
  const v1 = checkTaskTokenBudget(st, "P3-465", 51_307_260, 40e6, { outcome: "gate green but the PR merge failed: conflict in scripts/unit.test.ts" });
  check(
    "budget: crossing 1x alerts once with a bounded, informative line",
    v1.alert && v1.level === 1 && st.tokenBudgetAlerts?.["P3-465"] === 1 && v1.detail.includes("P3-465") && v1.detail.includes("51.3M") && v1.detail.includes("budget 40.0M") && v1.detail.includes("1.3x") && v1.detail.includes("merge failed") && v1.detail.length <= 220,
    v1.detail,
  );
  check("budget: same level again → silent (no alert storm)", !checkTaskTokenBudget(st, "P3-465", 60e6, 40e6).alert);
  const v2 = checkTaskTokenBudget(st, "P3-465", 85.6e6, 40e6);
  check("budget: escalates at 2x", v2.alert && v2.level === 2 && st.tokenBudgetAlerts?.["P3-465"] === 2);
  check("budget: disabled (0) never alerts", !checkTaskTokenBudget({}, "P9-1", 1e12, 0).alert);
  const long = checkTaskTokenBudget({}, "P9-2", 80e6, 40e6, { outcome: "x".repeat(500) });
  check("budget: long outcomes are clipped — detail ≤ 220 chars", long.detail.length <= 220);
  const events: Array<{ type: string; fields: Record<string, unknown> }> = [];
  const notes: string[] = [];
  const hooks = {
    emitEvent: ((type: string, fields: Record<string, unknown>) => void events.push({ type, fields })) as never,
    notify: (async (task: string, _ok: boolean, detail: string) => {
      notes.push(`${task}:${detail}`);
      return true;
    }) as never,
  };
  raiseTokenBudgetAlert("P3-465", v1, hooks);
  raiseTokenBudgetAlert("P3-001", { alert: false, level: 0, detail: "" }, hooks);
  check("budget: alert → one `alert` event (phase token-budget) + one supervisor notify", events.length === 1 && events[0].type === "alert" && events[0].fields.phase === "token-budget" && notes.length === 1 && notes[0].startsWith("P3-465:"));
  const pruned: Parameters<typeof pruneTaskCosts>[0] = { taskCosts: {}, taskCostSessions: {}, tokenBudgetAlerts: {} };
  for (let i = 0; i < 205; i++) {
    pruned.taskCosts![`P9-${i}`] = i;
    pruned.tokenBudgetAlerts![`P9-${i}`] = 1;
  }
  pruneTaskCosts(pruned, 200);
  check("budget: alert levels are pruned in lockstep with taskCosts", Object.keys(pruned.tokenBudgetAlerts ?? {}).length === 200 && !("P9-0" in (pruned.tokenBudgetAlerts ?? {})));
}

// ── state: config normalization + rollover persistence ──────────────────────
{
  const cfg = normalizePilotConfig({ pricing: { selfHosted: { models: ["glm-5.3-flash"], usdPerHour: 16, mtokPerHour: 4 } }, tokenBudgetPerTask: 50_000_000 });
  check("config: pricing normalized, budget kept", cfg.pricing?.selfHosted?.basis === "gpuHour" && cfg.tokenBudgetPerTask === 50_000_000);
  const bad = normalizePilotConfig({ pricing: { selfHosted: { models: ["m"], usdPerHour: "lots" } }, tokenBudgetPerTask: "huge" });
  check("config: garbage pricing dropped, garbage budget → default", bad.pricing === undefined && !("pricing" in bad) && bad.tokenBudgetPerTask === 40_000_000);
  const sf = join(tmp, "state.json");
  writeFileSync(
    sf,
    JSON.stringify({ date: "2020-01-01", tasks: 3, deploys: 0, failures: 0, merges: 1, taskAttempts: {}, taskUSDPricing: "v1-abc", tokenBudgetAlerts: { "P3-465": 1, junk: "x", neg: -2 } }),
  );
  const s = loadState(sf);
  check("state: midnight rollover keeps the re-price fingerprint and budget levels (no re-alert storm)", s.tasks === 0 && s.taskUSDPricing === "v1-abc" && JSON.stringify(s.tokenBudgetAlerts) === JSON.stringify({ "P3-465": 1 }));
}

// ── runner: session capture without changing the parsed text ──────────────
{
  const drop = logLineStripper();
  const out =
    drop.push("VERDICT: APPROVE\ntimestamp=2026-09-24T10:40:48.826Z level=INFO run=1 message=created id=ses_x\nError: real") +
    drop.push(" stderr line\ntimestamp=2026-09-24T10:40:49") +
    drop.push(".109Z level=INFO run=1 message=loop step=0\n- [BLOCKING] a/b.ts:1 — kept\n") +
    drop.flush();
  check("stripper: log lines (even split across chunks) dropped, every other byte kept", out === "VERDICT: APPROVE\nError: real stderr line\n- [BLOCKING] a/b.ts:1 — kept\n", JSON.stringify(out));
  const tail = logLineStripper();
  check("stripper: a trailing partial non-log line is released on flush", tail.push("no newline yet") === "" && tail.flush() === "no newline yet");
  const logTail = logLineStripper();
  logTail.push("timestamp=2026-09-24T00:00:00Z level=WARN run=1 message=x");
  check("stripper: a trailing partial log line is dropped on flush", logTail.flush() === "");

  // spawn-free fake of `opencode run` (portable battery: no child process):
  // each run replays a scripted interleaving of stdout/stderr chunks
  const LOG = (msg: string) => `timestamp=2026-09-24T10:40:48.826Z level=INFO run=076efe7f ${msg}`;
  const ROOT_CREATED = LOG('message=created id=ses_rootSess000001 slug=calm-otter version=1.18.32 projectID=p directory=/x path="" workspaceID=undefined parentID=undefined title="New session"\n');
  const CHILD_CREATED = LOG('message=created id=ses_childSess00001 slug=x version=1.18.32 projectID=p directory=/x path="" workspaceID=undefined parentID=ses_rootSess000001 title="sub"\n');
  let script: Array<["out" | "err", string]> = [];
  const seen: string[][] = [];
  const fakeSpawn = ((_cmd: string, args: string[]) => {
    seen.push(args);
    const chunks = script;
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    let open = 2;
    const ended = () => {
      if (--open === 0) setImmediate(() => child.emit("exit", 0));
    };
    child.stdout.on("end", ended);
    child.stderr.on("end", ended);
    setImmediate(() => {
      for (const [stream, text] of chunks) (stream === "out" ? child.stdout : child.stderr).write(text);
      child.stdout.end();
      child.stderr.end();
    });
    return child;
  }) as unknown as typeof spawn;
  // a reviewer run: the root line split across two chunks, a test fixture id
  // quoted on stdout BEFORE the verdict, then a subagent's own created line
  const reviewerRun: Array<["out" | "err", string]> = [
    ["err", ROOT_CREATED.slice(0, 70)],
    ["err", ROOT_CREATED.slice(70)],
    ["out", 'grep: const SESS = { id: "ses_abc123456" }\n'],
    ["err", CHILD_CREATED],
    ["out", "VERDICT: APPROVE\n"],
    ["err", "Error: real stderr line\n"],
  ];
  const base = { cwd: tmpdir(), timeoutMin: 1, label: "t", preflight: async () => true, spawnImpl: fakeSpawn, heartbeatTouch: () => {} };
  script = reviewerRun;
  const cap = await runAgent("p", { ...base, sessionCapture: true });
  check("runAgent sessionCapture: --print-logs added for the id line", JSON.stringify(seen[0]) === JSON.stringify(["run", "--print-logs", "p"]));
  check("runAgent sessionCapture: the ROOT created line wins over a fixture id quoted on stdout and over a subagent's line", cap.sessionId === "ses_rootSess000001", String(cap.sessionId));
  check(
    "runAgent sessionCapture: output = agent text + real stderr, no log lines",
    cap.output.includes("VERDICT: APPROVE") && cap.output.includes("Error: real stderr line") && cap.output.includes("ses_abc123456") && !cap.output.includes("timestamp="),
    JSON.stringify(cap.output),
  );
  script = reviewerRun;
  const plain = await runAgent("p", base);
  check("runAgent default: argv unchanged (no --print-logs), stderr passes through untouched", JSON.stringify(seen[1]) === JSON.stringify(["run", "p"]) && plain.output.includes("timestamp="));
  script = reviewerRun;
  const builder = await runAgent("p", { ...base, printLogs: true });
  check("runAgent printLogs: logs stay in the output (builder log file unchanged), root id authoritative", JSON.stringify(seen[2]) === JSON.stringify(["run", "--print-logs", "p"]) && builder.output.includes("timestamp=") && builder.sessionId === "ses_rootSess000001");
  script = [
    ["out", 'test output: ses_abc123456 fixture\n'],
    ["err", LOG("message=loop session.id=ses_resumeSess0001 step=0\n")],
    ["out", "PILOT:TASK-DONE\n"],
  ];
  const resumed = await runAgent("p", { ...base, printLogs: true, sessionId: "ses_resumeSess0001" });
  check("runAgent resume (-s): the resumed session IS the id, whatever stdout quotes", JSON.stringify(seen[3]) === JSON.stringify(["run", "--print-logs", "-s", "ses_resumeSess0001", "p"]) && resumed.sessionId === "ses_resumeSess0001");
  const scan = rootSessionScanner();
  scan.push(CHILD_CREATED);
  check("root scanner: a subagent created line alone is not a root", scan.id() === undefined);
  const scan2 = rootSessionScanner();
  scan2.push(ROOT_CREATED.slice(0, 40));
  scan2.push(ROOT_CREATED.slice(40) + ROOT_CREATED.replace("ses_rootSess000001", "ses_laterRoot00001"));
  check("root scanner: split line completes; the FIRST root wins", scan2.id() === "ses_rootSess000001");
  const scan3 = rootSessionScanner();
  scan3.push(ROOT_CREATED.trimEnd());
  check("root scanner: a final unterminated root line still counts", scan3.id() === "ses_rootSess000001");
}

// ── wiring (source assertions): attribution + budget + re-price stay wired ─
{
  const pipelineSrc = readFileSync(join(repoRoot, "apps", "pilot", "src", "pipeline.ts"), "utf8");
  for (const label of ["sec-${t.id}-r${round}", "qual-${t.id}-r${round}", "esc-${t.id}-r${round}", "recap-${t.id}-r${round}"]) {
    const re = new RegExp(`label: \`${label.replace(/[$.{}]/g, (c) => `\\${c}`)}\`,\\n\\s+onStdout: stream,\\n\\s+sessionCapture: true,`);
    check(`pipeline: ${label.split("-")[0]} dispatch captures its session for cost attribution`, re.test(pipelineSrc));
  }
  check("pipeline: scribe dispatch captures its session", /label: `scribe-\$\{t\.id\}`,\n\s+onStdout: agentStream\("scribe"\),\n\s+sessionCapture: true,/.test(pipelineSrc));
  const indexSrc = readFileSync(join(repoRoot, "apps", "pilot", "src", "index.ts"), "utf8");
  check("index: reconciliation passes the pricing config", indexSrc.includes("applySessionCosts(state, task.id, [...taskSessions], (ids) => querySessionTokenRows(ids), cfg.pricing)"));
  check("index: every reconciled task goes through the budget check", /raiseTokenBudgetAlert\(\s*task\.id,\s*checkTaskTokenBudget\(state, task\.id, impact\.tokens, normalizeTokenBudget\(cfg\.tokenBudgetPerTask\)/.test(indexSrc));
  check("index: boot re-price runs before the loop", indexSrc.indexOf("repriceTaskUSD(bootState") > 0 && indexSrc.indexOf("repriceTaskUSD(bootState") < indexSrc.indexOf("for (;;) {"));
  const crashAt = indexSrc.indexOf('log("error", "pipeline crashed"');
  const crashReconcile = indexSrc.lastIndexOf("applySessionCosts(state, task.id, [...taskSessions]", crashAt);
  check(
    "index: a crashed pipeline still reconciles the sessions it spawned (crash path, before the log line)",
    crashReconcile > indexSrc.indexOf("const wake = recordPipelineCrash(state);") && crashReconcile < crashAt && indexSrc.indexOf("const taskSessions = new Set<string>();") < indexSrc.indexOf("const result = await runPipeline(taskCfg"),
  );
}

// ── AGENTS.md budget ratchet ─────────────────────────────────────────────────
{
  // opencode injects AGENTS.md into the system prompt of EVERY agent turn in
  // this repo (Instruction.find/resolve in opencode 1.18.32). Measured cost:
  // 0.2596 tokens/byte (OLS over 399 sessions, R² 0.998) — 9.1K tokens per
  // turn at 35,125 B; re-reading it cost 114.8M tokens (7.6% of the fleet)
  // over 14,778 turns on 09-22..24. Trimmed to ~16.8 KB on 2026-09-27; grow
  // it only by moving something out.
  const AGENTS_MD_BUDGET_BYTES = 18 * 1024;
  const agents = readFileSync(join(repoRoot, "AGENTS.md"));
  check(
    `AGENTS.md stays under ${AGENTS_MD_BUDGET_BYTES} bytes (now ${agents.length}) — reference/changelog text goes to docs/`,
    agents.length <= AGENTS_MD_BUDGET_BYTES,
    "AGENTS.md rides every agent turn: move reference material to docs/ (e.g. docs/desktop-flow.md) instead of growing it",
  );
  const text = agents.toString("utf8");
  check("AGENTS.md points to the moved desktop-flow history", text.includes("docs/desktop-flow.md") && existsSync(join(repoRoot, "docs", "desktop-flow.md")));
  check("AGENTS.md: pilot agents are told NOT to read the operator's private journal", /Agentes do Pilot[\s\S]{0,80}NÃO leem/.test(text));
  const flowDoc = readFileSync(join(repoRoot, "docs", "desktop-flow.md"), "utf8");
  check("docs/desktop-flow.md keeps the moved beat history (P1-070 … P2-355)", flowDoc.includes("P1-070 adicionou o bloco") && flowDoc.includes("open < install < settle < read < shots."));
}

rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("token-efficiency: all checks passed");
