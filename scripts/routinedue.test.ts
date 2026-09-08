/**
 * P2-286: the routineDue decision table, its rule order, and the real-repo
 * wiring — portable by construction (fs + path only, no socket, no spawn, no
 * chmod, no Electron), so it runs both standalone and inside the Windows
 * battery (scripts/portable-suite.ts). The same table also runs inside
 * scripts/unit.test.ts; this file is the copy the portable sub-battery
 * reaches under the P2-237 coverage rule.
 * Run: npx tsx scripts/routinedue.test.ts
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  routineDue,
  ROUTINE_DUE_DELAY_WINDOW_MIN,
  ROUTINE_DUE_EXHAUSTED_MESSAGE,
  ROUTINE_DUE_MAX_ATTEMPTS,
  type RoutineDueFacts,
} from "../apps/daemon/src/routinedue";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const here = dirname(fileURLToPath(import.meta.url));
const daemonIndexSrc = readFileSync(join(here, "..", "apps", "daemon", "src", "index.ts"), "utf8");
const routinedueSrc = readFileSync(join(here, "..", "apps", "daemon", "src", "routinedue.ts"), "utf8");

// Local calendar helpers — every fixture is built from local accessors so the
// table holds on any machine timezone.
const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const at = (h: number, m: number) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
};
const daily = (over: Partial<RoutineDueFacts> = {}): RoutineDueFacts => ({
  hour: 9,
  minute: 0,
  mode: "daily",
  ...over,
});

// --- rule 1: refuse, and never fire (fail-closed) ---------------------------
check("refuse: missing input (undefined and null) never fires", (() => {
  const a = routineDue(at(9, 10), undefined, ROUTINE_DUE_DELAY_WINDOW_MIN);
  const b = routineDue(at(9, 10), null, ROUTINE_DUE_DELAY_WINDOW_MIN);
  return a.plan === "refuse" && b.plan === "refuse";
})());
check("refuse: non-object input (number, string, array) never fires", (() => {
  const inputs: unknown[] = [42, "x", []];
  return inputs.every((i) => routineDue(at(9, 10), i as never, ROUTINE_DUE_DELAY_WINDOW_MIN).plan === "refuse");
})());
check("refuse: non-integer hour or minute never fires", (() => {
  return (
    routineDue(at(9, 10), daily({ hour: 7.5 }), ROUTINE_DUE_DELAY_WINDOW_MIN).plan === "refuse" &&
    routineDue(at(9, 10), daily({ minute: 30.5 }), ROUTINE_DUE_DELAY_WINDOW_MIN).plan === "refuse"
  );
})());
check("refuse: non-finite now never fires", (() => {
  return (
    routineDue(NaN, daily(), ROUTINE_DUE_DELAY_WINDOW_MIN).plan === "refuse" &&
    routineDue(Infinity, daily(), ROUTINE_DUE_DELAY_WINDOW_MIN).plan === "refuse"
  );
})());

// --- rules 2-4: wait ---------------------------------------------------------
const todayStr = dayKey(new Date(at(9, 10)));
check("wait: already fulfilled on the current local day", (() => {
  const v = routineDue(at(9, 10), daily({ lastRun: todayStr }), ROUTINE_DUE_DELAY_WINDOW_MIN);
  return v.plan === "wait" && v.reason === "already-done";
})());
check("wait: weekday mode with today outside the day list", (() => {
  const dow = new Date(at(9, 10)).getDay();
  const v = routineDue(at(9, 10), daily({ mode: "days", days: [(dow + 1) % 7] }), ROUTINE_DUE_DELAY_WINDOW_MIN);
  return v.plan === "wait" && v.reason === "day-not-scheduled";
})());
check("wait: now before the scheduled time", (() => {
  const v = routineDue(at(8, 59), daily(), ROUTINE_DUE_DELAY_WINDOW_MIN);
  return v.plan === "wait" && v.reason === "before-time";
})());

// --- rule 5: beyond the documented window closes the day ---------------------
check("close-day: now beyond the delay window does not fire", (() => {
  const v = routineDue(at(15, 0), daily(), ROUTINE_DUE_DELAY_WINDOW_MIN);
  return v.plan === "close-day" && v.reason === "past-window";
})());

// --- fire: inside the window, edge included ----------------------------------
check("fire: inside the window and exactly at its edge", (() => {
  return (
    routineDue(at(9, 10), daily(), ROUTINE_DUE_DELAY_WINDOW_MIN).plan === "fire" &&
    routineDue(at(9, 30), daily(), ROUTINE_DUE_DELAY_WINDOW_MIN).plan === "fire" &&
    routineDue(at(9, 31), daily(), ROUTINE_DUE_DELAY_WINDOW_MIN).plan === "close-day"
  );
})());

// --- rule order: already-done beats past-window ------------------------------
check(
  "order: already fulfilled today stays wait even with the instant beyond the window",
  (() => {
    const v = routineDue(at(23, 0), daily({ lastRun: todayStr }), ROUTINE_DUE_DELAY_WINDOW_MIN);
    return v.plan === "wait" && v.reason === "already-done";
  })(),
);

// --- clock moved backward on the same local day ------------------------------
check("clock moved backward on the same local day never fires again", (() => {
  const fired = routineDue(at(9, 10), daily(), ROUTINE_DUE_DELAY_WINDOW_MIN);
  const rewoundBefore = routineDue(at(8, 55), daily({ lastRun: todayStr }), ROUTINE_DUE_DELAY_WINDOW_MIN);
  const rewoundInside = routineDue(at(9, 5), daily({ lastRun: todayStr }), ROUTINE_DUE_DELAY_WINDOW_MIN);
  return fired.plan === "fire" && rewoundBefore.plan === "wait" && rewoundInside.plan === "wait";
})());

// --- rule 6: the documented attempt ceiling ----------------------------------
check("close-day: exhausted attempt ceiling closes the day", (() => {
  const done = routineDue(at(9, 10), daily({ attemptsToday: ROUTINE_DUE_MAX_ATTEMPTS }), ROUTINE_DUE_DELAY_WINDOW_MIN);
  const retry = routineDue(at(9, 10), daily({ attemptsToday: ROUTINE_DUE_MAX_ATTEMPTS - 1 }), ROUTINE_DUE_DELAY_WINDOW_MIN);
  return done.plan === "close-day" && done.reason === "attempts-exhausted" && retry.plan === "fire";
})());

// --- determinism -------------------------------------------------------------
check("determinism: the same input yields the identical verdict twice", (() => {
  const input = daily({ lastRun: "2020-01-02", attemptsToday: 1 });
  const a = routineDue(at(9, 10), input, ROUTINE_DUE_DELAY_WINDOW_MIN);
  const b = routineDue(at(9, 10), input, ROUTINE_DUE_DELAY_WINDOW_MIN);
  return JSON.stringify(a) === JSON.stringify(b);
})());

// --- purity of the module ------------------------------------------------------
// strip block + line comments first — the header prose names the banned modules
const routinedueCode = routinedueSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
check(
  "purity: routinedue.ts imports nothing — no fs, child_process or http imports, no fetch",
  !/^import /m.test(routinedueCode) &&
    !/node:(fs|child_process|path|os|http)/.test(routinedueCode) &&
    !/\bfetch\(/.test(routinedueCode),
);

// --- real-repo wiring ----------------------------------------------------------
const sweepAt = daemonIndexSrc.indexOf("function checkRoutines");
const sweepEnd = daemonIndexSrc.indexOf("setInterval(checkRoutines");
check(
  "wiring: the fire decision in checkRoutines comes from the module, not a hand-rolled time comparison",
  sweepAt >= 0 &&
    sweepEnd > sweepAt &&
    daemonIndexSrc.indexOf("routineDue(") > sweepAt &&
    daemonIndexSrc.indexOf("routineDue(") < sweepEnd &&
    !daemonIndexSrc.includes("if (nowMin < r.hour * 60 + r.minute) continue;"),
);
const fireAt = daemonIndexSrc.indexOf("async function fireRoutine");
const fireBlock = fireAt >= 0 ? daemonIndexSrc.slice(fireAt, daemonIndexSrc.indexOf("async function completeRoutine")) : "";
check(
  "wiring: the failure path consults the documented ceiling and closes the day instead of clearing the mark forever",
  fireBlock.includes("bumpFireAttempt(") &&
    fireBlock.includes("ROUTINE_DUE_MAX_ATTEMPTS") &&
    fireBlock.includes("ROUTINE_DUE_EXHAUSTED_MESSAGE"),
);
check(
  "wiring: no new periodic timer was introduced for the routine decision",
  daemonIndexSrc
    .split("\n")
    .filter((l) => l.includes("setInterval"))
    .every((l) => !/routinedue|fireAttempt|routineDue/i.test(l)) &&
    daemonIndexSrc.includes("setInterval(checkRoutines, 30_000);"),
);
check(
  "wiring: creation after the scheduled time marks the current local day with the existing lastRun field",
  daemonIndexSrc.includes("routine.lastRun = created.toLocaleDateString") &&
    !daemonIndexSrc.includes("lastRunOverride"),
);
check("wiring: the exhaustion phrase is static and content-free", (() => {
  return (
    ROUTINE_DUE_EXHAUSTED_MESSAGE.length > 0 &&
    ROUTINE_DUE_EXHAUSTED_MESSAGE.length <= 200 &&
    !/[\\/]/.test(ROUTINE_DUE_EXHAUSTED_MESSAGE) &&
    !/https?:/i.test(ROUTINE_DUE_EXHAUSTED_MESSAGE) &&
    !/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(ROUTINE_DUE_EXHAUSTED_MESSAGE)
  );
})());

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall routineDue tests passed");
