/**
 * P3-397: lazy model-readiness revalidation tests (apps/daemon/src/modelrevalidate.ts)
 * — the portable twin of the unit.test.ts block. Pure node: no daemon boot,
 * no sockets, no timers, no network; the only fs use is reading the real
 * modelrevalidate.ts and index.ts sources for the purity/wiring assertions,
 * via paths relative to this file (Windows-safe).
 * Run: npx tsx scripts/modelrevalidate.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MODEL_READINESS_DEFAULT_INTERVAL_MS,
  MODEL_READINESS_DISABLE_ENV,
  MODEL_READINESS_INTERVAL_CEILING_MS,
  MODEL_READINESS_INTERVAL_ENV,
  modelRevalidatePlan,
  parseModelReadinessKnobs,
} from "../apps/daemon/src/modelrevalidate";
import { modelReadyVerdict } from "../apps/daemon/src/modelready";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const json = (v: unknown) => JSON.stringify(v);
const MIN = 60_000;
const NOW = 1_800_000_000_000; // arbitrary fixed "now" anchor (pure: no clock reads)

// --- the decision table (pure planner) ----------------------------------
{
  // [name, currentReady, observedAt, now, minIntervalMs, action, reason]
  const table: [string, boolean, number, number, number, string, string][] = [
    ["within the interval the cache is reused (fresh)", false, NOW - (MIN - 1), NOW, MIN, "cache", "fresh"],
    ["exactly at the interval the verdict is re-observed", false, NOW - MIN, NOW, MIN, "observe", "stale"],
    ["after the interval the verdict is re-observed", false, NOW - (MIN + 1), NOW, MIN, "observe", "stale"],
    ["never observed (epoch 0) is always stale", false, 0, NOW, MIN, "observe", "stale"],
    [
      "a ready verdict is never re-observed, however old",
      true,
      NOW - 10 * 365 * 24 * 3_600_000,
      NOW,
      MIN,
      "cache",
      "verdict-ready",
    ],
    ["clock moved back: age clamps to zero, cache reused", false, NOW + 5_000, NOW, MIN, "cache", "fresh"],
  ];
  for (const [name, ready, observedAt, now, minIntervalMs, action, reason] of table) {
    const p = modelRevalidatePlan(ready, observedAt, now, minIntervalMs);
    check(`table: ${name}`, p.action === action && p.reason === reason);
  }

  // fail-closed table: missing, negative and non-finite input never causes
  // an observation (a broken input can only reuse the cache, never fetch)
  const broken: [string, boolean, number, number, number][] = [
    ["missing verdict (undefined)", undefined as unknown as boolean, 0, NOW, MIN],
    ["non-finite observedAt (NaN)", false, NaN, NOW, MIN],
    ["non-finite now (Infinity)", false, 0, Infinity, MIN],
    ["negative observedAt", false, -1, NOW, MIN],
    ["negative now", false, 0, -5, MIN],
    ["zero interval", false, 0, NOW, 0],
    ["negative interval", false, 0, NOW, -MIN],
    ["non-finite interval", false, 0, NOW, NaN],
  ];
  for (const [name, ready, observedAt, now, minIntervalMs] of broken) {
    const p = modelRevalidatePlan(ready, observedAt, now, minIntervalMs);
    check(`fail-closed: ${name} reuses the cache (invalid-input)`, p.action === "cache" && p.reason === "invalid-input");
  }
}

// --- a failed observation degrades to unknown, never accuses -------------
{
  // index.ts records a failed observation as noteProviderCatalog(null, false),
  // which flips modelCatalogFailed — the verdict it feeds is the neutral
  // unknown for ANY cached summary, never a harder accusation.
  check(
    "failed observation: any cached summary with fetchFailed degrades to the neutral unknown",
    modelReadyVerdict([], true).state === "unknown" &&
      modelReadyVerdict(null, true).state === "unknown" &&
      modelReadyVerdict([{ id: "x", models: 3 }], true).state === "unknown" &&
      json(modelReadyVerdict(null, true)) === json(modelReadyVerdict([], true)),
  );
}

// --- the knob parser (fail-closed, mirrors readiness.ts) -----------------
{
  const cfg = parseModelReadinessKnobs({});
  check(
    "knobs: an empty environment yields the documented defaults",
    cfg.minIntervalMs === MODEL_READINESS_DEFAULT_INTERVAL_MS &&
      cfg.minIntervalMs === 60_000 &&
      cfg.disabled === false &&
      cfg.problems.length === 0,
  );
  check(
    "knobs: a blank interval keeps the default with no problem",
    parseModelReadinessKnobs({ [MODEL_READINESS_INTERVAL_ENV]: "   " }).problems.length === 0 &&
      parseModelReadinessKnobs({ [MODEL_READINESS_INTERVAL_ENV]: "   " }).minIntervalMs === MODEL_READINESS_DEFAULT_INTERVAL_MS,
  );
  check(
    "knobs: the documented disable value turns revalidation off with no problem",
    (["off", "0", "false", "OFF", "False"] as const).every(
      (v) => parseModelReadinessKnobs({ [MODEL_READINESS_DISABLE_ENV]: v }).disabled === true &&
        parseModelReadinessKnobs({ [MODEL_READINESS_DISABLE_ENV]: v }).problems.length === 0,
    ) &&
      (["on", "1", "true"] as const).every(
        (v) => parseModelReadinessKnobs({ [MODEL_READINESS_DISABLE_ENV]: v }).disabled === false &&
          parseModelReadinessKnobs({ [MODEL_READINESS_DISABLE_ENV]: v }).problems.length === 0,
      ),
  );
  check(
    "knobs: the interval is honored up to the documented ceiling and fails closed above it",
    parseModelReadinessKnobs({ [MODEL_READINESS_INTERVAL_ENV]: "1234" }).minIntervalMs === 1234 &&
      parseModelReadinessKnobs({ [MODEL_READINESS_INTERVAL_ENV]: String(MODEL_READINESS_INTERVAL_CEILING_MS) }).problems.length === 0 &&
      parseModelReadinessKnobs({ [MODEL_READINESS_INTERVAL_ENV]: String(MODEL_READINESS_INTERVAL_CEILING_MS + 1) }).problems.length === 1,
  );
  check(
    "knobs: non-numeric, zero, negative, fractional and unknown-disable values all fail the boot",
    (["abc", "0", "-5", "1500.5"] as const).every((v) => parseModelReadinessKnobs({ [MODEL_READINESS_INTERVAL_ENV]: v }).problems.length === 1) &&
      parseModelReadinessKnobs({ [MODEL_READINESS_DISABLE_ENV]: "maybe" }).problems.length === 1,
  );
}

// --- the real sources: module purity and daemon wiring -------------------
{
  const src = readFileSync(join(import.meta.dirname, "..", "apps", "daemon", "src", "modelrevalidate.ts"), "utf8");
  check(
    "purity: modelrevalidate.ts imports nothing — no node:fs, no network, no timer",
    !/^import\b/m.test(src) && !src.includes("require(") && !src.includes("node:fs") && !src.includes("fetch(") && !src.includes("setInterval"),
  );

  const indexSrc = readFileSync(join(import.meta.dirname, "..", "apps", "daemon", "src", "index.ts"), "utf8");

  // no new periodic timer entered the daemon (the five pre-existing ones from
  // routines/version/retention stay exactly as they are)
  check(
    "wiring: no new periodic timer — the daemon keeps exactly the five pre-existing ones",
    (indexSrc.match(/setInterval\(/g) || []).length === 5,
  );

  // the route has no fetch of its own: it awaits the gated helper and answers
  const routeAt = indexSrc.indexOf('req.path === "/__ocr/model/status"');
  const route = routeAt >= 0 ? indexSrc.slice(routeAt, indexSrc.indexOf("\n  }", routeAt)) : "";
  check(
    "wiring: the model status route re-observes lazily before answering and fires no fetch of its own",
    route.includes("await maybeReobserveModelCatalog();") && route.includes("body: modelStatus()") && !route.includes("fetch("),
  );

  // the ceiling gate precedes the fetch inside the helper (the "portão do teto")
  const helperAt = indexSrc.indexOf("async function maybeReobserveModelCatalog");
  const helper = helperAt >= 0 ? indexSrc.slice(helperAt, indexSrc.indexOf("\n}", helperAt) + 2) : "";
  check(
    "wiring: the observation reuses the existing /provider catalog read behind the ceiling gate",
    helper.includes("modelRevalidatePlan(") &&
      helper.indexOf("modelRevalidatePlan(") < helper.indexOf('fetch(new URL("/provider", OPENCODE_URL))') &&
      helper.includes("noteProviderCatalog(") &&
      helper.includes("modelReadinessKnobs.disabled || plan.action !== \"observe\""),
  );

  // a failed observation never throws and never leaks a path or a secret:
  // both failure paths degrade through noteProviderCatalog(null, false) and
  // the single log line carries a coarse reason only — never err.message
  check(
    "wiring: failure paths degrade to unknown without throwing and without logging paths or errors",
    (helper.match(/noteProviderCatalog\(null, false\)/g) || []).length === 2 &&
      helper.includes("try {") &&
      helper.includes("} catch {") &&
      helper.includes('log("warn", "model re-observation failed — advertising unknown"') &&
      !helper.includes(".message") &&
      !helper.includes("err"),
  );

  // the model status route stays unique (no new route, no new port, no new listener)
  check(
    "wiring: the model status route is still exactly one route",
    (indexSrc.match(/\/__ocr\/model\/status/g) || []).length === 1,
  );

  // the knob problems fail the boot closed, same contract as the shared knobs
  check(
    "wiring: invalid OCR_MODEL_READINESS_* fails the boot closed",
    indexSrc.includes("modelReadinessKnobs.problems.length > 0") &&
      indexSrc.includes("parseModelReadinessKnobs(process.env)"),
  );
}

if (failures > 0) {
  console.error(`MODEL REVALIDATE TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log("MODEL REVALIDATE TESTS PASSED");
process.exit(0);
