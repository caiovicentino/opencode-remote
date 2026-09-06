/**
 * P2-244: GPU-crash plan tests (apps/desktop/src/gpuplan.ts) — the portable
 * twin of the unit.test.ts block. Pure node: no Electron, no sockets, no
 * chmod, no spawn; the only fs use is reading the real main.ts source for the
 * wiring assertions, via a URL relative to this file (Windows-safe).
 * Run: npx tsx scripts/gpuplan.test.ts
 */
import { readFileSync } from "node:fs";
import {
  accelerationPlan,
  GPU_CRASH_CEILING,
  GPU_CRASH_WINDOW_MS,
  GPU_STATE_ZEROED,
  gpuVerdict,
  isGpuProcess,
  sanitizeGpuState,
  NOTIFY_GPU_DISABLED_BODY,
} from "../apps/desktop/src/gpuplan";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const now = 1_700_000_000_000;
const st = (count: number, windowStart: number) => ({ count, windowStart });
const noSlash = (s: string) => !s.includes("/") && !s.includes("://") && !s.includes("\\");
const json = (v: unknown) => JSON.stringify(v);

// --- sanitizeGpuState ------------------------------------------------------------
{
  check("sanitize: absent state becomes zeroed", json(sanitizeGpuState(undefined, now)) === json(GPU_STATE_ZEROED) && json(sanitizeGpuState(null, now)) === json(GPU_STATE_ZEROED));
  check("sanitize: text becomes zeroed", json(sanitizeGpuState("corrupt", now)) === json(GPU_STATE_ZEROED) && json(sanitizeGpuState("3", now)) === json(GPU_STATE_ZEROED));
  check(
    "sanitize: non-finite values become zeroed",
    json(sanitizeGpuState(st(Number.NaN, now), now)) === json(GPU_STATE_ZEROED) &&
      json(sanitizeGpuState(st(Number.POSITIVE_INFINITY, now), now)) === json(GPU_STATE_ZEROED) &&
      json(sanitizeGpuState(st(1, Number.NEGATIVE_INFINITY), now)) === json(GPU_STATE_ZEROED),
  );
  check(
    "sanitize: negative values become zeroed",
    json(sanitizeGpuState(st(-1, now), now)) === json(GPU_STATE_ZEROED) && json(sanitizeGpuState(st(2, -5), now)) === json(GPU_STATE_ZEROED),
  );
  check(
    "sanitize: wrong-typed fields become zeroed",
    json(sanitizeGpuState(st("2", now), now)) === json(GPU_STATE_ZEROED) &&
      json(sanitizeGpuState(st(2, "now"), now)) === json(GPU_STATE_ZEROED) &&
      json(sanitizeGpuState(true, now)) === json(GPU_STATE_ZEROED) &&
      json(sanitizeGpuState([2], now)) === json(GPU_STATE_ZEROED),
  );
  check(
    "sanitize: missing fields become zeroed",
    json(sanitizeGpuState({}, now)) === json(GPU_STATE_ZEROED) &&
      json(sanitizeGpuState({ count: 2 }, now)) === json(GPU_STATE_ZEROED) &&
      json(sanitizeGpuState({ windowStart: now }, now)) === json(GPU_STATE_ZEROED),
  );
  check(
    "sanitize: a window starting in the future becomes zeroed",
    json(sanitizeGpuState(st(2, now + 1), now)) === json(GPU_STATE_ZEROED),
  );
  check(
    "sanitize: a valid state passes through unchanged",
    json(sanitizeGpuState(st(2, now - 100), now)) === json(st(2, now - 100)),
  );
}

// --- gpuVerdict --------------------------------------------------------------------
{
  const ignored = gpuVerdict(st(2, now), now, "renderer");
  check(
    "verdict: a non-GPU child process always ignores and accumulates nothing",
    ignored.plan === "ignore" && json(ignored.state) === json(st(2, now)) && !isGpuProcess("renderer") && isGpuProcess("GPU"),
  );
  const first = gpuVerdict(GPU_STATE_ZEROED, now, "GPU");
  check("verdict: the first GPU crash only logs, counting one", first.plan === "log" && first.state.count === 1 && first.state.windowStart === now);
  let walk = GPU_STATE_ZEROED;
  let walkPlans: string[] = [];
  for (let i = 0; i < GPU_CRASH_CEILING; i++) {
    const v = gpuVerdict(walk, now, "GPU");
    walkPlans.push(v.plan);
    walk = v.state;
  }
  check(
    `verdict: exactly ${GPU_CRASH_CEILING} crashes end in disable, the last at the explicit ceiling`,
    walkPlans[0] === "log" && walkPlans[walkPlans.length - 1] === "disable" && walk.count === GPU_CRASH_CEILING,
  );
  check("verdict: a count above the ceiling disables as well", gpuVerdict(st(GPU_CRASH_CEILING + 2, now), now, "GPU").plan === "disable");
  const expired = gpuVerdict(st(99, now - GPU_CRASH_WINDOW_MS - 1), now, "GPU");
  check(
    "verdict: an expired window zeroes the count BEFORE any comparison",
    expired.plan === "log" && expired.state.count === 1 && expired.state.windowStart === now,
  );
  check(
    "verdict: the returned count is never negative",
    gpuVerdict(GPU_STATE_ZEROED, now, "GPU").state.count >= 0 && gpuVerdict(st(-5, now), now, "GPU").state.count >= 0,
  );
  check(
    "verdict: stable between two calls with the same input",
    json(gpuVerdict(st(1, now), now, "GPU")) === json(gpuVerdict(st(1, now), now, "GPU")),
  );
  check("verdict: phrases are path-free and scheme-free", [first.reason, expired.reason, NOTIFY_GPU_DISABLED_BODY].every(noSlash));
}

// --- accelerationPlan ---------------------------------------------------------------
{
  const aboveCeiling = st(GPU_CRASH_CEILING + 6, now);
  const harnessPlan = accelerationPlan({ harnessSession: true, state: aboveCeiling, nowMs: now });
  check("plan: harness session enables and persists nothing even above the ceiling", harnessPlan.action === "enable" && harnessPlan.persist === false);
  check("plan: rule order — harness beats an above-ceiling state in the same call", accelerationPlan({ harnessSession: true, state: st(99, now), nowMs: now }).action === "enable");
  check("plan: absent/zeroed state enables", accelerationPlan({ harnessSession: false, state: GPU_STATE_ZEROED, nowMs: now }).action === "enable");
  check(
    "plan: at the ceiling inside the window disables, below it enables",
    accelerationPlan({ harnessSession: false, state: st(GPU_CRASH_CEILING, now), nowMs: now }).action === "disable" &&
      accelerationPlan({ harnessSession: false, state: st(1, now), nowMs: now }).action === "enable",
  );
  check(
    "plan: an expired window enables (self-healing)",
    accelerationPlan({ harnessSession: false, state: st(99, now - GPU_CRASH_WINDOW_MS - 1), nowMs: now }).action === "enable",
  );
  check(
    "plan: phrases are path-free and scheme-free",
    [harnessPlan.reason, accelerationPlan({ harnessSession: false, state: GPU_STATE_ZEROED, nowMs: now }).reason].every(noSlash),
  );
}

// --- the real main.ts wiring ----------------------------------------------------------
{
  const src = readFileSync(new URL("../apps/desktop/src/main.ts", import.meta.url), "utf8");
  check("wiring: exactly one child-process-gone listener", src.split('app.on("child-process-gone"').length - 1 === 1);
  const planAt = src.indexOf("accelerationPlan({");
  // First ".whenReady(" in the file is the real readiness call (main.ts splits
  // it across lines; the only "app.whenReady()" literal is a later comment).
  const readyAt = src.search(/\.whenReady\(/);
  check("wiring: the acceleration decision is consulted before the app is ready", planAt >= 0 && readyAt > planAt);
  check("wiring: no periodic timer in the GPU lines", src.split("\n").filter((l) => l.includes("gpu") || l.includes("Gpu") || l.includes("GPU")).every((l) => !l.includes("setInterval") && !l.includes("setTimeout")));
}

console.log(failures === 0 ? "\ngpuplan tests: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
