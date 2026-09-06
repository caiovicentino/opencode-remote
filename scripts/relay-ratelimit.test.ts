/**
 * Rate-limit tests for the relay (P3-004): pure token bucket behavior plus
 * integration passes against real relay subprocesses — a strict-env relay
 * proving flooded, reconnecting and self-declared-owner devices are all
 * dropped with close code 4xxx, and a default-env relay proving the tuned
 * defaults pass a daemon-shaped chunk storm unthrottled.
 * Run: npx tsx scripts/relay-ratelimit.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { get } from "node:http";
import { join } from "node:path";
import WebSocket from "ws";
import { TokenBucket } from "../apps/relay/src/ratelimit";
import {
  budgetVerdict,
  initialRoomBudgetState,
  parseRoomBudget,
  ROOM_BUDGET_BYTES_CEILING,
  ROOM_BUDGET_BYTES_DEFAULT,
  ROOM_BUDGET_BYTES_DISABLED,
  ROOM_BUDGET_BYTES_ENV,
  ROOM_BUDGET_CLOSE_REASON,
  ROOM_BUDGET_WARN_REASON,
  ROOM_BUDGET_WINDOW_MS_CEILING,
  ROOM_BUDGET_WINDOW_MS_DEFAULT,
  ROOM_BUDGET_WINDOW_MS_ENV,
  type RoomBudgetLimits,
  type RoomBudgetState,
} from "../apps/relay/src/roombudget";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

setTimeout(() => {
  console.error("relay-ratelimit test timed out (global 60s)");
  process.exit(1);
}, 60_000).unref();

// --- 1. pure bucket: fills, rejects, refills over time -----------------------
let clock = 0;
const now = () => clock;
const b = new TokenBucket(10, 30, now);
let filled = true;
for (let i = 0; i < 10; i++) filled &&= b.take();
check("bucket: burst capacity fills (10 takes)", filled);
check("bucket: rejects when empty", b.take() === false);

clock += 12_000; // 12s at 30/min = 6 tokens
check("bucket: partial refill after 12s", b.take() && b.take() && b.take() && b.take() && b.take() && b.take() && !b.take());

clock += 60_000; // back to full (capped at burst)
let refilled = true;
for (let i = 0; i < 10; i++) refilled &&= b.take();
check("bucket: refills to full after 60s", refilled);
check("bucket: rejects again after drain", b.take() === false);

const legit = new TokenBucket(10, 30, now);
let steady = true;
for (let i = 0; i < 100; i++) {
  steady &&= legit.take();
  clock += 2_500; // 24 msgs/min < 30 msgs/min
}
check("bucket: legitimate rate never exhausts", steady);

// --- 1b. per-room volume budget (P2-243, pure verdict) ------------------------
// Tiny limits make every boundary explicit: window 1000 ms, cap 100 bytes —
// the documented threshold is the cap itself and only a total STRICTLY above
// it terminates (exactly at the cap the room stays serviceable).
const LIMITS: RoomBudgetLimits = { windowMs: 1_000, capBytes: 100 };

const fresh = (bytes = 0, windowStart = 0, warned = false): RoomBudgetState => ({
  ...initialRoomBudgetState(windowStart),
  bytes,
  warned,
});

check("budget: zeroed state follows and accumulates", (() => {
  const v = budgetVerdict(fresh(), 10, 10, LIMITS);
  return v.plan.action === "follow" && v.state.bytes === 10 && v.state.windowStart === 0;
})());
check("budget: accumulated below the cap follows", (() => {
  // 40 total stays under half the cap, so no warn either: plain follow
  const v = budgetVerdict(fresh(20), 10, 20, LIMITS);
  return v.plan.action === "follow" && v.state.bytes === 40;
})());
check(
  "budget: accumulated exactly at the cap follows (the documented limit itself is serviceable)",
  (() => {
    // warned=true isolates the cap boundary from the half-cap warn plan
    const v = budgetVerdict(fresh(90, 0, true), 10, 10, LIMITS);
    return v.plan.action === "follow" && v.state.bytes === 100;
  })(),
);
check("budget: accumulated above the cap terminates", (() => {
  const v = budgetVerdict(fresh(95), 10, 10, LIMITS);
  return v.plan.action === "terminate" && v.state.bytes === 105;
})());
check("budget: terminated room carries the fixed close reason", (() => {
  const v = budgetVerdict(fresh(101), 10, 0, LIMITS);
  return v.plan.action === "terminate" && v.plan.reason === ROOM_BUDGET_CLOSE_REASON;
})());
check("budget: expired window zeroes the accumulated before any comparison", (() => {
  // 200 bytes accumulated would terminate, but the window (1000 ms) has
  // expired: the reset happens first, so the frame alone is compared
  const v = budgetVerdict(fresh(200), 1_000, 10, LIMITS);
  return v.plan.action === "follow" && v.state.bytes === 10 && v.state.windowStart === 1_000;
})());
check("budget: warn fires once at half the cap within the same window", (() => {
  // 49 -> follow (below half); +1 -> 50 (half of 100) -> warn; +40 -> follow,
  // no second warn because the window's warn already fired
  const a = budgetVerdict(fresh(), 10, 49, LIMITS);
  const b = budgetVerdict(a.state, 11, 1, LIMITS);
  const c = budgetVerdict(b.state, 12, 40, LIMITS);
  return (
    a.plan.action === "follow" &&
    b.plan.action === "warn" &&
    b.plan.reason === ROOM_BUDGET_WARN_REASON &&
    b.state.warned === true &&
    c.plan.action === "follow" &&
    c.state.bytes === 90 &&
    c.state.warned === true
  );
})());
check("budget: warn fires again in the next window", (() => {
  const warned = budgetVerdict(fresh(60, 0, true), 2_000, 0, LIMITS);
  const again = budgetVerdict(warned.state, 2_001, 50, LIMITS);
  return (
    warned.state.windowStart === 2_000 && // expired window reset
    warned.state.warned === false && // warn flag died with the window
    again.plan.action === "warn" &&
    again.state.warned === true
  );
})());
check("budget: non-numeric frame size follows without accumulating", (() => {
  const v = budgetVerdict(fresh(10), 10, "big" as unknown as number, LIMITS);
  return v.plan.action === "follow" && v.state.bytes === 10;
})());
check("budget: negative frame size follows without accumulating", (() => {
  const v = budgetVerdict(fresh(10), 10, -5, LIMITS);
  return v.plan.action === "follow" && v.state.bytes === 10;
})());
check("budget: non-finite frame size follows without accumulating", (() => {
  const a = budgetVerdict(fresh(10), 10, Infinity, LIMITS);
  const b = budgetVerdict(fresh(10), 10, NaN, LIMITS);
  return a.plan.action === "follow" && a.state.bytes === 10 && b.state.bytes === 10;
})());
check("budget: disabled cap always follows, even with an absurd accumulated total", (() => {
  const v = budgetVerdict(fresh(1e15), 10, 999, { windowMs: 1_000, capBytes: ROOM_BUDGET_BYTES_DISABLED });
  return v.plan.action === "follow" && v.state.bytes === 1e15;
})());
check("budget: returned accumulated is never negative", (() => {
  const v = budgetVerdict(fresh(0), 10, -7, LIMITS);
  return v.state.bytes === 0;
})());
check("budget: undefined state starts a fresh window at the current instant", (() => {
  const v = budgetVerdict(undefined, 5, 10, LIMITS);
  return v.plan.action === "follow" && v.state.bytes === 10 && v.state.windowStart === 5;
})());
check("budget: verdict is stable between two calls with the same input", (() => {
  const one = budgetVerdict(fresh(40), 100, 20, LIMITS);
  const two = budgetVerdict(fresh(40), 100, 20, LIMITS);
  return (
    JSON.stringify(one) === JSON.stringify(two) &&
    one.state !== two.state // new objects: the input state is never mutated
  );
})());
check("budget: every generated phrase is free of addresses, paths and secrets", (() => {
  const phrases = [ROOM_BUDGET_CLOSE_REASON, ROOM_BUDGET_WARN_REASON];
  const plans = [
    budgetVerdict(undefined, 0, 999, LIMITS).plan, // terminate
    budgetVerdict(fresh(60, 0, false), 0, 0, LIMITS).plan, // warn
  ];
  for (const p of plans) if (p.action !== "follow" && p.reason) phrases.push(p.reason);
  return phrases.every(
    (r) =>
      !r.includes("://") &&
      !r.includes("127.0.0.1") &&
      !r.includes("\n") &&
      !r.startsWith("/") &&
      !r.includes("\\") &&
      r.length < 200,
  );
})());

// --- 1c. per-room budget env parsing (P2-243, fail-closed problems format) ----
check("roombudget: empty env resolves the documented defaults with zero problems", (() => {
  const p = parseRoomBudget({});
  return (
    p.windowMs === ROOM_BUDGET_WINDOW_MS_DEFAULT &&
    p.capBytes === ROOM_BUDGET_BYTES_DEFAULT &&
    p.problems.length === 0
  );
})());
check("roombudget: blank variables keep the documented defaults too", (() => {
  const p = parseRoomBudget({ [ROOM_BUDGET_WINDOW_MS_ENV]: "  ", [ROOM_BUDGET_BYTES_ENV]: "" });
  return p.windowMs === ROOM_BUDGET_WINDOW_MS_DEFAULT && p.capBytes === ROOM_BUDGET_BYTES_DEFAULT && p.problems.length === 0;
})());
check("roombudget: valid overrides are accepted verbatim", (() => {
  const p = parseRoomBudget({ [ROOM_BUDGET_WINDOW_MS_ENV]: "7200000", [ROOM_BUDGET_BYTES_ENV]: "2147483648" });
  return p.windowMs === 7_200_000 && p.capBytes === 2_147_483_648 && p.problems.length === 0;
})());
check("roombudget: values at the documented ceilings are fine", (() => {
  const p = parseRoomBudget({
    [ROOM_BUDGET_WINDOW_MS_ENV]: String(ROOM_BUDGET_WINDOW_MS_CEILING),
    [ROOM_BUDGET_BYTES_ENV]: String(ROOM_BUDGET_BYTES_CEILING),
  });
  return p.windowMs === ROOM_BUDGET_WINDOW_MS_CEILING && p.capBytes === ROOM_BUDGET_BYTES_CEILING && p.problems.length === 0;
})());
check("roombudget: the documented disable value (-1 bytes) is accepted", (() => {
  const p = parseRoomBudget({ [ROOM_BUDGET_BYTES_ENV]: String(ROOM_BUDGET_BYTES_DISABLED) });
  return p.capBytes === ROOM_BUDGET_BYTES_DISABLED && p.problems.length === 0 && p.windowMs === ROOM_BUDGET_WINDOW_MS_DEFAULT;
})());
check("roombudget: disable value on the window knob is NOT accepted", (() => {
  const p = parseRoomBudget({ [ROOM_BUDGET_WINDOW_MS_ENV]: "-1" });
  return p.problems.length === 1 && p.problems[0].includes(ROOM_BUDGET_WINDOW_MS_ENV);
})());
check("roombudget: non-numeric values are problems, per variable", (() => {
  const w = parseRoomBudget({ [ROOM_BUDGET_WINDOW_MS_ENV]: "soon" });
  const b = parseRoomBudget({ [ROOM_BUDGET_BYTES_ENV]: "much" });
  return (
    w.problems.length === 1 && w.problems[0].includes(ROOM_BUDGET_WINDOW_MS_ENV) &&
    b.problems.length === 1 && b.problems[0].includes(ROOM_BUDGET_BYTES_ENV)
  );
})());
check("roombudget: zero values are problems", (() => {
  const w = parseRoomBudget({ [ROOM_BUDGET_WINDOW_MS_ENV]: "0" });
  const b = parseRoomBudget({ [ROOM_BUDGET_BYTES_ENV]: "0" });
  return w.problems.length > 0 && b.problems.length > 0;
})());
check("roombudget: negative values (other than -1 bytes) are problems", (() => {
  const w = parseRoomBudget({ [ROOM_BUDGET_WINDOW_MS_ENV]: "-5" });
  const b = parseRoomBudget({ [ROOM_BUDGET_BYTES_ENV]: "-5" });
  return w.problems.length > 0 && b.problems.length > 0;
})());
check("roombudget: fractional values are problems", (() => {
  const w = parseRoomBudget({ [ROOM_BUDGET_WINDOW_MS_ENV]: "1.5" });
  const b = parseRoomBudget({ [ROOM_BUDGET_BYTES_ENV]: "1.5" });
  return w.problems.length > 0 && b.problems.length > 0;
})());
check("roombudget: values above each ceiling are problems", (() => {
  const w = parseRoomBudget({ [ROOM_BUDGET_WINDOW_MS_ENV]: String(ROOM_BUDGET_WINDOW_MS_CEILING + 1) });
  const b = parseRoomBudget({ [ROOM_BUDGET_BYTES_ENV]: String(ROOM_BUDGET_BYTES_CEILING + 1) });
  return w.problems.length === 1 && b.problems.length === 1;
})());
check("roombudget: several problems come back at once, without short-circuiting", (() => {
  // -1.5 is negative AND fractional: two problems for one value...
  const single = parseRoomBudget({ [ROOM_BUDGET_BYTES_ENV]: "-1.5" });
  // ...and two bad variables yield two problems, each naming its variable
  const both = parseRoomBudget({ [ROOM_BUDGET_WINDOW_MS_ENV]: "abc", [ROOM_BUDGET_BYTES_ENV]: "0" });
  return (
    single.problems.length === 2 &&
    single.problems.every((x) => x.includes(ROOM_BUDGET_BYTES_ENV)) &&
    both.problems.length === 2 &&
    both.problems.some((x) => x.includes(ROOM_BUDGET_WINDOW_MS_ENV)) &&
    both.problems.some((x) => x.includes(ROOM_BUDGET_BYTES_ENV))
  );
})());
check("roombudget: one bad variable never forces the other off its resolved value", (() => {
  const p = parseRoomBudget({ [ROOM_BUDGET_WINDOW_MS_ENV]: "abc", [ROOM_BUDGET_BYTES_ENV]: "2147483648" });
  return p.problems.length === 1 && p.capBytes === 2_147_483_648;
})());

// --- 1d. index.ts wiring (P2-243, source assertions) ---------------------------
{
  const relayIndexSrc = readFileSync(
    join(import.meta.dirname, "..", "apps", "relay", "src", "index.ts"),
    "utf8",
  );
  // the verdict is consulted at the SAME forwarding point as the token bucket
  // and the backpressure verdict: after the room join, before any target send
  const joinAt = relayIndexSrc.indexOf("join(socket, frame.room)");
  const budgetAt = relayIndexSrc.indexOf("budgetVerdict(roomBudgets.get");
  const sendAt = relayIndexSrc.indexOf("sendVerdict(");
  check(
    "roombudget: index.ts consults the verdict at the existing forwarding point (after join, before sends)",
    joinAt > -1 && budgetAt > joinAt && sendAt > budgetAt,
  );
  // the accumulated state dies together with the room itself
  const leaveAll = relayIndexSrc.slice(
    relayIndexSrc.indexOf("function leaveAll("),
    relayIndexSrc.indexOf("P2-177: entries below"),
  );
  check(
    "roombudget: index.ts discards the room state inside leaveAll when the room is removed",
    leaveAll.includes("rooms.delete(room)") && leaveAll.includes("roomBudgets.delete(room)"),
  );
  // no new periodic timer: the relay still has exactly the liveness sweep
  check(
    "roombudget: no new periodic timer was introduced",
    (relayIndexSrc.match(/setInterval\(/g) ?? []).length === 1,
  );
}

// --- 2. integration helpers ---------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startRelay(env: Record<string, string>) {
  const port = 40_000 + Math.floor(Math.random() * 20_000);
  const proc = spawn("npx", ["tsx", "apps/relay/src/index.ts"], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, ...env, RELAY_PORT: String(port), RELAY_METRICS_PORT: String(port + 1), OCR_E2E_MARKER: "1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  proc.on("error", (e) => console.error("relay spawn error:", e));
  process.on("exit", () => proc.kill("SIGTERM"));
  return { port, proc };
}

async function waitReady(port: number) {
  // relay may still be booting (tsx cold start): retry until it accepts
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const w = new WebSocket(`ws://127.0.0.1:${port}`);
        w.on("open", () => {
          w.close();
          resolve();
        });
        w.on("error", reject);
      });
      break;
    } catch {
      if (attempt > 30) throw new Error("relay never came up");
      await sleep(300);
    }
  }
}

function connect(port: number, from: string, room: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => {
      ws.send(JSON.stringify({ room, from, payload: "" }));
      resolve(ws);
    });
    ws.on("error", reject);
  });
}

const openCode = (ws: WebSocket) =>
  new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));

const collect = (ws: WebSocket, n: number, ms: number) =>
  new Promise<number>((resolve) => {
    let count = 0;
    ws.on("message", () => {
      if (++count >= n) resolve(count);
    });
    setTimeout(() => resolve(count), ms).unref();
  });

const send = (ws: WebSocket, room: string, from: string, i: number) =>
  ws.send(JSON.stringify({ room, from, payload: `p${i}` }));

const fetchMetrics = (port: number) =>
  new Promise<string>((resolve) => {
    get(`http://127.0.0.1:${port}/metrics`, (res) => {
      let s = "";
      res.on("data", (c) => (s += c));
      res.on("end", () => resolve(s));
    });
  });

// --- 3. strict-env relay: limits enforced, no metadata bypass ----------------
const strict = startRelay({ RELAY_RATE_PER_MIN: "30", RELAY_RATE_BURST: "10" });
await waitReady(strict.port);
const strictUrl = `ws://127.0.0.1:${strict.port}`;

// legitimate client: a few frames spaced out, all routed, never disconnected
const legitRoom = `rl-legit-${Date.now()}`;
const legitListener = await connect(strict.port, "listener2", legitRoom);
await collect(legitListener, 1, 500); // wait for the join to be processed
const legitClient = await connect(strict.port, "legit-1", legitRoom);
let received = 0;
legitListener.on("message", () => received++);
for (let i = 0; i < 3; i++) {
  legitClient.send(JSON.stringify({ room: legitRoom, from: "legit-1", payload: `m${i}` }));
  await sleep(250);
}
check("relay: legitimate client passes and is routed", received >= 3);
check("relay: legitimate client not disconnected", legitClient.readyState === WebSocket.OPEN);

// flood client: back-to-back frames exhaust the burst (join frame included)
const floodRoom = `rl-flood-${Date.now()}`;
const floodClient = await connect(strict.port, "flood-1", floodRoom);
const floodClosed = openCode(floodClient);
for (let i = 0; i < 14; i++) send(floodClient, floodRoom, "flood-1", i);
check("relay: flooded device disconnected with 4xxx", (await floodClosed) === 4029);

// self-declared room owner: from === room must NOT bypass the limiter
const spoofRoom = `rl-spoof-${Date.now()}`;
const spoofClient = await connect(strict.port, spoofRoom, spoofRoom);
const spoofClosed = openCode(spoofClient);
for (let i = 0; i < 14; i++) send(spoofClient, spoofRoom, spoofRoom, i);
check("relay: self-declared owner is rate limited too", (await spoofClosed) === 4029);

// join frames (payload "") consume tokens: 1 join + 10 empty frames = over burst
const joinRoom = `rl-join-${Date.now()}`;
const joinClient = await connect(strict.port, "joiner-1", joinRoom);
const joinClosed = openCode(joinClient);
for (let i = 0; i < 10; i++) joinClient.send(JSON.stringify({ room: joinRoom, from: "joiner-1", payload: "" }));
check("relay: join/empty frames accounted in the budget", (await joinClosed) === 4029);

// metric counters exposed on /metrics
const metricsJson = await fetchMetrics(strict.port + 1);
const json = JSON.parse(metricsJson) as { rate_limited_total?: number };
check("metrics: rate_limited_total counted the floods", (json.rate_limited_total ?? 0) >= 2);
strict.proc.kill("SIGTERM");

// --- 4. default-env relay: daemon-shaped chunk storm must pass ---------------
const tuned = startRelay({});
await waitReady(tuned.port);
const tunedRoom = `rl-tuned-${Date.now()}`;
const tunedListener = await connect(tuned.port, "listener4", tunedRoom);
await collect(tunedListener, 1, 500);
// daemon shape: single socket, from === room, ~512+ frames back-to-back
const owner = await connect(tuned.port, tunedRoom, tunedRoom);
const ownerClosed = openCode(owner);
for (let i = 0; i < 900; i++) send(owner, tunedRoom, tunedRoom, i);
const got = await collect(tunedListener, 900, 10_000);
check("relay: default budget passes 900-frame chunk storm", got >= 900);
check("relay: chunk-storm socket not disconnected", (await Promise.race([ownerClosed, sleep(500).then(() => -1)])) === -1);

tuned.proc.kill("SIGTERM");
if (failures) process.exit(1);
console.log("relay-ratelimit: ALL OK");
process.exit(0);
