/**
 * Rate-limit tests for the relay (P3-004): pure token bucket behavior plus
 * integration passes against real relay subprocesses — a strict-env relay
 * proving flooded, reconnecting and self-declared-owner devices are all
 * dropped with close code 4xxx, and a default-env relay proving the tuned
 * defaults pass a daemon-shaped chunk storm unthrottled.
 * Run: npx tsx scripts/relay-ratelimit.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { get } from "node:http";
import { join } from "node:path";
import WebSocket from "ws";
import { TokenBucket } from "../apps/relay/src/ratelimit";

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

// --- 2. integration helpers ---------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startRelay(env: Record<string, string>) {
  const port = 40_000 + Math.floor(Math.random() * 20_000);
  const proc = spawn("npx", ["tsx", "apps/relay/src/index.ts"], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, ...env, RELAY_PORT: String(port), RELAY_METRICS_PORT: String(port + 1) },
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
