/**
 * P1-079 tests: the context-pressure checkpoint.
 *  - pure math: contextPct (pilot + daemon compute the number; web color-bands)
 *  - the recap parse + prompt block (pipeline glue)
 *  - e2e over real HTTP: fetchSessionContext against a fake opencode server
 *    (session tokens > 85% of the window), the checkpoint decision, the recap
 *    carryover file lifecycle and the "no attempt burned" contract.
 * Run: npx tsx scripts/context-checkpoint.test.ts
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTEXT_CRITICAL_PCT,
  clearRecapCarry,
  contextPct,
  contextWindowFor,
  fetchSessionContext,
  isContextCritical,
  loadRecapCarry,
  saveRecapCarry,
  setRecapCarryDir,
} from "../apps/pilot/src/context";
import { parseRecap, recapBlock, recapPrompt, recordContextPressure, builderPrompt, applyCheckpoint, dropResumeSession, evaluateCheckpoint } from "../apps/pilot/src/pipeline";
import { buildWindowMap, WindowCache, sessionTokenTotal, contextPct as daemonPct } from "../apps/daemon/src/contextgauge";
import type { AgentIds } from "../apps/pilot/src/runner";
import { CONTEXT_CRITICAL_PCT as WEB_CRITICAL_PCT, CONTEXT_WARN_PCT, firstSentence, pressureLevel } from "../apps/web/src/lib/context";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

// ── pure math: one calculation per responsibility ────────────────────────────
// pilot + daemon each compute the number (pipeline checkpoint / gauge
// endpoint); web only color-bands the daemon-computed pct — the formulas and
// the shared 85% red band must not drift.
check("pilot and daemon pressure math agree", contextPct(50, 100) === daemonPct(50, 100));
check("web red band matches the pilot recycle threshold", CONTEXT_CRITICAL_PCT === WEB_CRITICAL_PCT);
check("50% of the window is 50", contextPct(50, 100) === 50);
check("0 tokens is 0% pressure", contextPct(0, 100) === 0);
check("zero window is 0% (no divide-by-zero)", contextPct(10, 0) === 0);
check("negative window is 0%", contextPct(10, -5) === 0);
check("NaN tokens are 0%", contextPct(Number.NaN, 100) === 0);
check("over the window caps at 100%", contextPct(150, 100) === 100);
check("warn threshold at 70%", CONTEXT_WARN_PCT === 70 && pressureLevel(69.9) === "ok" && pressureLevel(70) === "warn");
check("critical threshold at 85%", CONTEXT_CRITICAL_PCT === 85 && pressureLevel(84.9) === "warn" && pressureLevel(85) === "danger");
check("isContextCritical matches the 85% threshold", !isContextCritical(84.9) && isContextCritical(85) && isContextCritical(100));
check("over-window pressure is still critical", isContextCritical(contextPct(300, 100)));

// ── model window lookup (provider catalog shapes) ────────────────────────────
const catalog = {
  all: [
    { id: "glm52", models: { "glm-5.2": { limit: { context: 262144 } } } },
    {
      id: "hpc-ai",
      models: { "deepseek/deepseek-v4-flash": { id: "deepseek/deepseek-v4-flash", limit: { context: 1048576 } } },
    },
    { id: "broken", models: { "m1": { limit: { context: 0 } } } },
  ],
};
check("bare model key resolves", contextWindowFor(catalog, "glm52", "glm-5.2") === 262144);
check("qualified model key resolves", contextWindowFor(catalog, "hpc-ai", "deepseek/deepseek-v4-flash") === 1048576);
check("unknown provider is 0", contextWindowFor(catalog, "nope", "glm-5.2") === 0);
check("unknown model is 0", contextWindowFor(catalog, "glm52", "nope") === 0);
check("zero context is 0 (fail-open)", contextWindowFor(catalog, "broken", "m1") === 0);
check(
  "session token total sums all five kinds",
  sessionTokenTotal({ tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 20, write: 5 } } }) === 38,
);

// ── recap glue ────────────────────────────────────────────────────────────────
const recapOut = `some prose first\n${"RECAP:"}\n1. P1-079: context gauge\n2. gauge done, tests pending\n3. wire the e2e test\nRECAP-END\nnoise after`;
check("parseRecap extracts the body", parseRecap(recapOut).includes("context gauge") && parseRecap(recapOut).includes("wire the e2e test"));
check("parseRecap drops the trailing noise", !parseRecap(recapOut).includes("noise after"));
check("parseRecap on malformed output is empty", parseRecap("no marker here") === "");
check("recapBlock is empty for an empty recap", recapBlock("") === "");
check(
  "recapBlock explains the clean recycle",
  recapBlock("the state").includes("CONTEXT RECAP") && recapBlock("the state").includes("the state") && recapBlock("the state").includes("P1-079"),
);
const task = { id: "P1-079", priority: "P1", title: "ctx gauge", spec: "s", area: "infra", size: "S" as const, line: "P1-079 ctx gauge" };
check(
  "builderPrompt carries the recap block",
  builderPrompt(task, 2, "", [], null, null, 1, "the state").includes("CONTEXT RECAP") &&
    builderPrompt(task, 2, "", [], null, null, 1, "the state").includes("the state"),
);
check("builderPrompt without recap has no block", !builderPrompt(task, 1, "", [], null, null, 1).includes("CONTEXT RECAP"));
check(
  "recapPrompt asks for task/findings/next-step",
  recapPrompt(task, "fix X").includes("P1-079") && recapPrompt(task, "fix X").includes("fix X") && recapPrompt(task, "fix X").includes("RECAP:"),
);

// ── recap carryover file lifecycle (isolated temp dir, never the real one) ──
const carryDir = mkdtempSync(join(tmpdir(), "ocr-ctx-carry-"));
setRecapCarryDir(carryDir);
check("loadRecapCarry on a fresh task is null", loadRecapCarry("P1-079") === null);
saveRecapCarry("PX-1", "the state of work", 2);
const carry = loadRecapCarry("PX-1");
check("saveRecapCarry round-trips", carry?.recap === "the state of work" && carry?.round === 2 && carry?.task === "PX-1");
check("carryover id guard: traversal id is a no-op", (saveRecapCarry("../evil", "x", 1), loadRecapCarry("../evil") === null));
clearRecapCarry("PX-1");
check("clearRecapCarry removes the file", loadRecapCarry("PX-1") === null);
setRecapCarryDir(null);
rmSync(carryDir, { recursive: true, force: true });

// ── state instrumentation: bounded per-task samples ──────────────────────────
const state: { contextPressure?: Record<string, { round: number; pct: number; at: string }[]> } = {};
for (let round = 1; round <= 10; round++) recordContextPressure(state, "P1-079", round, round * 10);
check(
  "recordContextPressure keeps the last 8 samples",
  (state.contextPressure?.["P1-079"]?.length ?? 0) === 8 && state.contextPressure?.["P1-079"]?.[0]?.round === 3,
);
check("recordContextPressure drops NaN", (recordContextPressure(state, "X", 1, Number.NaN), (state.contextPressure?.X?.length ?? 0) === 0));

// ── e2e: fetchSessionContext against a fake opencode server ──────────────────
async function withServer(jsonFor: (url: string) => { status?: number; body: unknown }, fn: (port: number) => Promise<void>) {
  const server: Server = createServer((req, res) => {
    const url = req.url ?? "";
    const r = jsonFor(url);
    res.writeHead(r.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(r.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn((server.address() as { port: number }).port);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const SESSION = "ses_unitTestSession01";
const fullSession = {
  tokens: { input: 200_000, output: 10_000, reasoning: 0, cache: { read: 30_000, write: 5_000 } },
  model: { providerID: "glm52", modelID: "glm-5.2" },
};
const WINDOW = 262_144;

await withServer(
  (url) =>
    url.startsWith("/session/")
      ? { body: fullSession }
      : url === "/provider"
        ? { body: catalog }
        : { status: 404, body: { error: "nope" } },
  async (port) => {
    const base = `http://127.0.0.1:${port}`;
    const ctx = await fetchSessionContext(SESSION, base);
    check("fetchSessionContext returns the pressure", ctx !== null && ctx.window === 262_144);
    const tokens = 245_000; // 200k+10k+30k+5k
    const expected = contextPct(tokens, WINDOW);
    check("fetchSessionContext tokens = DB columns sum", ctx?.tokens === tokens && Math.round(ctx!.pct) === Math.round(expected));
    check("fixture session sits in the critical band", isContextCritical(ctx!.pct) === (expected >= 85));
    check("fetchSessionContext rejects junk ids", (await fetchSessionContext("garbage", base)) === null);
  },
);

await withServer(
  (url) => (url.startsWith("/session/") ? { status: 500, body: { error: "boom" } } : { body: catalog }),
  async (port) => {
    check("fetchSessionContext fail-open on session error", (await fetchSessionContext(SESSION, `http://127.0.0.1:${port}`)) === null);
  },
);

await withServer(
  (url) => (url.startsWith("/session/") ? { body: { tokens: fullSession.tokens, model: { providerID: "glm52", modelID: "unknown-model" } } } : { body: catalog }),
  async (port) => {
    check("fetchSessionContext fail-open on unknown model", (await fetchSessionContext(SESSION, `http://127.0.0.1:${port}`)) === null);
  },
);

await withServer(
  (url) => (url.startsWith("/session/") ? { body: fullSession } : { status: 500, body: { error: "boom" } }),
  async (port) => {
    check("fetchSessionContext fail-open on provider error", (await fetchSessionContext(SESSION, `http://127.0.0.1:${port}`)) === null);
  },
);
// unreachable server
check("fetchSessionContext fail-open when the server is down", (await fetchSessionContext(SESSION, "http://127.0.0.1:1")) === null);

// ── e2e: the full recycle contract — measure → decide → apply ───────────────
// Drives the REAL evaluateCheckpoint + applyCheckpoint glue (the same functions
// runPipeline calls) with the REAL fetchSessionContext against the fake
// opencode server: past 85% the session is recycled with a recap and the
// attempt counter is untouched; below it, nothing changes.
{
  const task = { id: "P1-079", priority: "P1", title: "ctx gauge", spec: "s", area: "infra", size: "S" as const, line: "P1-079 ctx gauge" };
  const attempts = 2;
  const resume: AgentIds | null = { sessionId: SESSION, taskIds: ["task_abcdef12"] };
  const builderSession = SESSION;

  await withServer(
    (url) => (url.startsWith("/session/") ? { body: fullSession } : { body: catalog }),
    async (port) => {
      const base = `http://127.0.0.1:${port}`;
      const fetchCtx = (sid: string) => fetchSessionContext(sid, base);
      // fullSession tokens (~245k) sit ABOVE 85% of the 262144 window
      const over = await evaluateCheckpoint(builderSession, task, "fix X", fetchCtx, async () => "1. task\n2. pending\n3. next");
      check("critical session → recycle decision", over.recycle && over.recap.includes("next") && (over.pct ?? 0) >= 85);
      const applied = applyCheckpoint({ builderSession, resume, attempts }, over);
      check("applyCheckpoint kills the session (fresh one opens next round)", applied.builderSession === undefined);
      check("applyCheckpoint never burns an attempt (infra, P1-074)", applied.attempts === attempts);
      check("applyCheckpoint drops the killed session from the resume block", applied.resume?.sessionId === undefined);
      check("resumable subagent task ids survive the recycle", applied.resume?.taskIds.length === 1 && applied.resume.taskIds[0] === "task_abcdef12");
      // below the threshold nothing happens — identity transition
      const low = await evaluateCheckpoint(
        builderSession,
        task,
        "",
        async (sid) => {
          const c = await fetchCtx(sid);
          return c ? { ...c, tokens: 1000, pct: contextPct(1000, WINDOW) } : null;
        },
        async () => "should not be asked",
      );
      check("sub-critical session is not recycled", !low.recycle && low.recap === "" && (low.pct ?? 0) < 85);
      const untouched = applyCheckpoint({ builderSession, resume, attempts }, low);
      check("applyCheckpoint is an identity below the threshold", untouched.builderSession === builderSession && untouched.resume === resume && untouched.attempts === attempts);
      // recap pass fails → fail-open, the session is KEPT (recap-less recycle loses context for nothing)
      const noRecap = await evaluateCheckpoint(builderSession, task, "", fetchCtx, async () => "");
      check("unusable recap keeps the session (fail-open)", (noRecap.pct ?? 0) >= 85 && !noRecap.recycle);
      // unmeasurable session → no decision, no recycle
      const blind = await evaluateCheckpoint(builderSession, task, "", async () => null, async () => "r");
      check("unmeasurable session is fail-open", blind.pct === null && !blind.recycle);
      // no session (round 1 / already recycled) → nothing measured
      const none = await evaluateCheckpoint(undefined, task, "", fetchCtx, async () => "r");
      check("no session → no checkpoint", none.pct === null && !none.recycle);
      // prompt glue: the recycled round must not tell the builder to resume "-s"
      const prompt = builderPrompt(task, 2, "", [], null, applied.resume, 1, over.recap);
      check("recycled round prompt no longer advertises the killed session via -s", !prompt.includes("continues it via -s"));
      check("recycled round prompt carries the recap", prompt.includes("CONTEXT RECAP"));
    },
  );
}

// dropResumeSession edge cases (pure)
check("dropResumeSession on null is null", dropResumeSession(null) === null);

// ── provider window cache (round 2: no 6MB refetch per gauge request) �───────
{
  const cache = new WindowCache(60_000);
  check("empty cache misses", cache.lookup("glm52", "glm-5.2") === 0);
  cache.refresh(catalog, 1_000);
  check("fresh cache hits the bare model key", cache.lookup("glm52", "glm-5.2", 2_000) === 262_144);
  check("fresh cache hits the qualified model key", cache.lookup("hpc-ai", "deepseek/deepseek-v4-flash", 2_000) === 1_048_576);
  check("stale cache misses (TTL)", cache.lookup("glm52", "glm-5.2", 1_000 + 60_001) === 0);
  cache.refresh(catalog, 1_000);
  check("unknown model misses even when fresh", cache.lookup("glm52", "nope", 2_000) === 0);
  check("zero-context models are not cached", cache.lookup("broken", "m1", 2_000) === 0);
  cache.clear();
  check("clear forces a miss", cache.lookup("glm52", "glm-5.2", 2_000) === 0);
  check("buildWindowMap matches contextWindowFor", buildWindowMap(catalog).get("glm52/glm-5.2") === contextWindowFor(catalog, "glm52", "glm-5.2"));
}

// ── the checkpoint contract — a session recycle is infra, not merit ─────────
{
  // P1-074/P1-079: crossing the threshold recycles the session WITHOUT
  // advancing the attempt counter. The prompt carries that promise (the
  // builder and reviewer trust it) and the decision predicate pins it.
  const block = recapBlock("work state");
  check(
    "recapBlock promises a clean recycle with no attempt burned",
    block.includes("no attempt was burned") && block.includes("closed CLEAN"),
  );
  check(
    "the critical predicate alone drives the recycle",
    isContextCritical(contextPct(220_000, 262_144)) === (contextPct(220_000, 262_144) >= CONTEXT_CRITICAL_PCT),
  );
}

// ── web recap strip source: firstSentence ────────────────────────────────────
check("firstSentence takes the first sentence", firstSentence("One. Two. Three.") === "One.");
check("firstSentence handles ? and !", firstSentence("Really? Yes!") === "Really?");
check("firstSentence collapses whitespace/newlines", firstSentence("Line one\nLine two. Next") === "Line one Line two.");
check("firstSentence caps long text with an ellipsis", firstSentence("x".repeat(500), 200).length === 200 && firstSentence("x".repeat(500), 200).endsWith("…"));
check("firstSentence empty is empty", firstSentence("   ") === "");

console.log(failures ? `\n${failures} failure(s)` : "\nall green");
process.exit(failures ? 1 : 0);
