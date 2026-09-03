/**
 * P1-079 tests: the context-pressure checkpoint.
 *  - pure math: contextPct + thresholds (pilot + daemon + web agree)
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
  CONTEXT_WARN_PCT,
  clearRecapCarry,
  contextPct,
  contextWindowFor,
  fetchSessionContext,
  isContextCritical,
  loadRecapCarry,
  saveRecapCarry,
  setRecapCarryDir,
} from "../apps/pilot/src/context";
import { parseRecap, recapBlock, recapPrompt, recordContextPressure, builderPrompt } from "../apps/pilot/src/pipeline";
import { contextPct as webPct, firstSentence, pressureLevel } from "../apps/web/src/lib/context";
import { contextPct as daemonPct, contextWindowFor as daemonWindow, sessionTokenTotal } from "../apps/daemon/src/contextgauge";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

// ── pure math: one calculation, three consumers ──────────────────────────────
check("pilot/daemon/web pressure math agree", contextPct(50, 100) === webPct(50, 100) && contextPct(50, 100) === daemonPct(50, 100));
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
check("daemon window lookup matches pilot", daemonWindow(catalog, "glm52", "glm-5.2") === 262144);
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
const task = { id: "P1-079", priority: "P1", title: "ctx gauge", spec: "s", area: "infra", size: "S" as const };
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
