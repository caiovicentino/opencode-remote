/**
 * Rate-limit tests for the relay (P3-004): pure token bucket behavior plus
 * an integration pass against a real relay subprocess (flood client is
 * disconnected with close code 4xxx, legitimate client keeps flowing).
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
  console.error("relay-ratelimit test timed out (global 30s)");
  process.exit(1);
}, 30_000).unref();

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

// --- 2. integration: real relay subprocess -----------------------------------
const RELAY_PORT = 40_000 + Math.floor(Math.random() * 20_000);
const METRICS_PORT = RELAY_PORT + 1;
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;

const relay = spawn("npx", ["tsx", "apps/relay/src/index.ts"], {
  cwd: join(import.meta.dirname, ".."),
  env: { ...process.env, RELAY_PORT: String(RELAY_PORT), RELAY_METRICS_PORT: String(METRICS_PORT) },
  stdio: ["ignore", "ignore", "inherit"],
});
relay.on("error", (e) => console.error("relay spawn error:", e));
process.on("exit", () => relay.kill("SIGTERM"));

// relay may still be booting (tsx cold start): retry until it accepts
for (let attempt = 0; ; attempt++) {
  try {
    await new Promise<void>((resolve, reject) => {
      const w = new WebSocket(RELAY_URL);
      w.on("open", () => {
        w.close();
        resolve();
      });
      w.on("error", reject);
    });
    break;
  } catch {
    if (attempt > 30) throw new Error("relay never came up");
    await new Promise((r) => setTimeout(r, 300));
  }
}

function connect(from: string, room: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_URL);
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// legitimate client: a few frames spaced out, all routed, never disconnected
const legitRoom = `rl-legit-${Date.now()}`;
const legitListener = await connect("listener2", legitRoom);
await collect(legitListener, 1, 500); // listener joined via its own join frame
const legitClient = await connect("legit-1", legitRoom);
let received = 0;
legitListener.on("message", () => received++);
for (let i = 0; i < 3; i++) {
  legitClient.send(JSON.stringify({ room: legitRoom, from: "legit-1", payload: `m${i}` }));
  await sleep(250);
}
check("relay: legitimate client passes and is routed", received >= 3);
check("relay: legitimate client not disconnected", legitClient.readyState === WebSocket.OPEN);

// flood client: back-to-back frames exhaust the burst → close code 4029
const floodRoom = `rl-flood-${Date.now()}`;
const floodClient = await connect("flood-1", floodRoom);
const floodClosed = openCode(floodClient);
for (let i = 0; i < 14; i++) {
  floodClient.send(JSON.stringify({ room: floodRoom, from: "flood-1", payload: `f${i}` }));
}
check("relay: flooded device disconnected with 4xxx", (await floodClosed) === 4029);

// room owner (daemon-shaped: from === room) is exempt — chunk bursts must flow
const ownerRoom = `rl-owner-${Date.now()}`;
const ownerListener = await connect("listener3", ownerRoom);
await collect(ownerListener, 1, 500);
const owner = await connect(ownerRoom, ownerRoom);
for (let i = 0; i < 14; i++) {
  owner.send(JSON.stringify({ room: ownerRoom, from: ownerRoom, payload: `o${i}` }));
}
const ownerGot = await collect(ownerListener, 14, 3_000);
check("relay: room-owner chunk burst not throttled", ownerGot >= 14);
check("relay: room owner not disconnected", owner.readyState === WebSocket.OPEN);

// metric counters exposed on /metrics
const metricsProm = await new Promise<string>((resolve) => {
  get(`http://127.0.0.1:${METRICS_PORT}/metrics?format=prom`, (res) => {
    let s = "";
    res.on("data", (c) => (s += c));
    res.on("end", () => resolve(s));
  });
});
check("metrics: relay_rate_limited_total present", metricsProm.includes("relay_rate_limited_total"));

const metricsJson = await new Promise<string>((resolve) => {
  get(`http://127.0.0.1:${METRICS_PORT}/metrics`, (res) => {
    let s = "";
    res.on("data", (c) => (s += c));
    res.on("end", () => resolve(s));
  });
});
const json = JSON.parse(metricsJson) as { rate_limited_total?: number };
check("metrics: rate_limited_total counted the flood", (json.rate_limited_total ?? 0) >= 1);

relay.kill("SIGTERM");
if (failures) process.exit(1);
console.log("relay-ratelimit: ALL OK");
