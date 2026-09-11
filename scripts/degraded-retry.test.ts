/**
 * P3-372: the auto-retry line is live copy, not a frozen static string —
 * seconds tick since the current attempt started and the shell's attempt
 * counter rides along once it exists. Pins the copy contract of the pure
 * helper DegradedView renders (apps/web/src/lib/degraded.ts): negative
 * elapsed clamps to 0, the elapsed segment only appears from the first full
 * second (round-2 review nit — no "há 0s" first paint) and an absent/zero
 * attempt hides the counter segment.
 * Run: npx tsx scripts/degraded-retry.test.ts
 */
import { retryLineParts } from "../apps/web/src/lib/degraded";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

// fake t: same {var} interpolation contract as lib/i18n translate()
const t = (key: string, vars?: Record<string, string | number>) => {
  const dict: Record<string, string> = {
    retryElapsed: "{s}s",
    retryElapsedMin: "{m} min",
    retryAttempt: "attempt {n}",
  };
  let s = dict[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
};

check("elapsed and attempt both render", retryLineParts(12, 3, t) === "12s · attempt 3");
check("attempt 1 renders alone during the first second", retryLineParts(0, 1, t) === "attempt 1");
check("no attempt yet hides the counter (first contact)", retryLineParts(0, undefined, t) === "");
check("attempt 0 hides the counter", retryLineParts(5, 0, t) === "5s");
check("negative elapsed clamps to 0 (hidden first paint)", retryLineParts(-3, 2, t) === "attempt 2");
check("elapsed segment appears from the first full second", retryLineParts(1, undefined, t) === "1s");
check("fractional seconds floor", retryLineParts(12.9, 2, t) === "12s · attempt 2");
check("unknown attempt type hides the counter", retryLineParts(7, undefined, t) === "7s");

// P3-417: past 90s the live segment shares the escalation's minutes clock —
// "há 214s" beside the title's "há 3 min" read as two disagreeing watches.
check("90s still counts seconds", retryLineParts(90, undefined, t) === "90s");
check("past 90s the segment switches to minutes", retryLineParts(91, undefined, t) === "1 min");
check("the fable evidence case: 214s reads as the escalation's 3 min", retryLineParts(214, undefined, t) === "3 min");
check("the attempt counter rides along in the minutes regime", retryLineParts(214, 3, t) === "3 min · attempt 3");

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("DEGRADED-RETRY TESTS PASSED");
