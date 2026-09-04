/**
 * P2-129: relay reconnect backoff — pure schedule semantics. Covers the
 * monotonic growth up to the 30s cap with a deterministic injected random,
 * full jitter always inside the expected interval, reset back to attempt
 * zero, and the snapshot shape /api/health exposes as `relayRetry`.
 * Run: npx tsx scripts/relay-backoff.test.ts
 */
import {
  RELAY_RETRY_BASE_MS,
  RELAY_RETRY_CAP_MS,
  createRelayRetry,
  nextDelayMs,
  rawBackoffMs,
} from "../apps/daemon/src/relayretry";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

// --- 1. monotonic sequence up to the cap (deterministic random = 1) -----------
const upperBound: number[] = [];
for (let attempt = 1; attempt <= 8; attempt++) upperBound.push(nextDelayMs(attempt, () => 1));
check(
  "backoff: base 2000 doubling per attempt (1,2,4,8)",
  upperBound[0] === 2000 && upperBound[1] === 4000 && upperBound[2] === 8000 && upperBound[3] === 16000,
);
check("backoff: capped at 30000ms from attempt 5 on", upperBound[4] === RELAY_RETRY_CAP_MS && upperBound[7] === RELAY_RETRY_CAP_MS);
let monotonic = true;
for (let i = 1; i < upperBound.length; i++) monotonic &&= upperBound[i] >= upperBound[i - 1];
check("backoff: sequence is monotonic non-decreasing up to the cap", monotonic);

// --- 2. full jitter stays inside the expected interval ------------------------
const randoms = [0, 0.25, 0.5, 0.75, 0.9999, 1];
let inRange = true;
for (const r of randoms) {
  for (let attempt = 1; attempt <= 12; attempt++) {
    const d = nextDelayMs(attempt, () => r);
    const backoff = Math.min(RELAY_RETRY_CAP_MS, rawBackoffMs(attempt));
    inRange &&= Number.isInteger(d) && d >= 0 && d <= backoff && backoff <= RELAY_RETRY_CAP_MS;
  }
}
check("jitter: every delay within [0, min(cap, base*2^(n-1))]", inRange);
check("jitter: random=0 collapses to immediate retry", nextDelayMs(4, () => 0) === 0);

// fixed r keeps the jittered schedule monotonic too (r * non-decreasing)
const fixed = createRelayRetry({ random: () => 0.75 });
let fixedMonotonic = true;
let last = -1;
for (let i = 0; i < 10; i++) {
  const d = fixed.schedule();
  fixedMonotonic &&= d >= last;
  last = d;
}
check("jitter: constant random keeps the schedule monotonic", fixedMonotonic);

// --- 3. reset returns to attempt zero -----------------------------------------
const state = createRelayRetry({ random: () => 1 });
state.schedule();
state.schedule();
state.schedule();
check("state: three schedules land on attempt 3", state.attempt === 3);
state.reset();
check(
  "state: reset returns to attempt zero with no pending delay",
  state.attempt === 0 && state.nextDelayMs === 0,
);
const firstRetry = state.schedule();
check(
  "state: after reset the next schedule restarts the ladder",
  state.attempt === 1 && firstRetry === RELAY_RETRY_BASE_MS,
);

// --- 4. snapshot shape exposed by /api/health ---------------------------------
const snap = state.snapshot();
check(
  "health: snapshot is { attempt, nextDelayMs } with numeric fields",
  "attempt" in snap && "nextDelayMs" in snap && typeof snap.attempt === "number" && typeof snap.nextDelayMs === "number",
);
const healthy = { relayConnected: true, relayRetry: null };
const unhealthy = { relayConnected: false, relayRetry: state.snapshot() };
check(
  "health: relayRetry null when connected, state object otherwise",
  healthy.relayRetry === null && unhealthy.relayRetry.attempt === 1,
);

if (failures > 0) {
  console.error(`relay-backoff: ${failures} failure(s)`);
  process.exit(1);
}
console.log("relay-backoff: all checks passed");
