/**
 * Hermetic local load benchmark for the relay — a MEASUREMENT run, not a
 * unit test (it is not part of test:unit). It answers the hosting questions
 * docs/RELAY-HOSTING.md publishes numbers for: how many live sockets one
 * relay process holds and at what memory cost, how many frames per second it
 * routes at which latency, and how fast it absorbs connection churn.
 *
 *   npx tsx scripts/relay-load.ts [--sockets 4000] [--active 200] [--seconds 8]
 *                                 [--workers 3] [--json out.json]
 *
 * Hermetic by construction: ONE relay subprocess from this checkout, a
 * throwaway HOME, an ephemeral loopback port (never 8787/8788/8790), killed
 * by PID on exit. Every simulated device is its own identity: the relay
 * trusts exactly one proxy hop (RELAY_TRUST_PROXY_HOPS=1) and each socket
 * carries a distinct x-forwarded-for address, so the per-IP cap stays live
 * but keys per simulated device instead of collapsing on 127.0.0.1. The
 * ceilings that would cap the measurement itself (socket caps, the
 * per-connection frame bucket, the per-room volume budget) are raised for
 * the run and printed in the result, so every number states its config.
 *
 * Drivers run in worker threads (plain-JS eval workers — no loader needed)
 * so the load generator is not the bottleneck; the relay is single-threaded
 * and saturates one core first. Latency is measured end to end inside one
 * worker (both ends of a pair live in the same thread, one clock).
 */
import { freePortPairSync } from "./testports";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

const args = process.argv.slice(2);
const opt = (name: string, dflt: number): number => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const SOCKETS = opt("sockets", 4000);
const ACTIVE = opt("active", 200);
const SECONDS = opt("seconds", 8);
const WORKERS = opt("workers", 3);
// saturation uses few pairs: with hundreds the generator threads saturate
// before the relay does (measured: relay at 9% CPU with 201 blasting pairs)
const SAT_PAIRS = opt("sat-pairs", 24);
const jsonAt = args.indexOf("--json");
const JSON_OUT = jsonAt >= 0 ? args[jsonAt + 1] : undefined;

const ROOT = join(import.meta.dirname, "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// kernel-chosen free pair (testports): a random ephemeral port collided with
// live listeners on CI (the EADDRINUSE idiom testports.test.ts exists to ban)
const port = freePortPairSync();
const mport = port + 1;
const home = mkdtempSync(join(tmpdir(), "ocr-relay-load-"));

const relayEnv: Record<string, string> = {
  RELAY_PORT: String(port),
  RELAY_METRICS_PORT: String(mport),
  RELAY_MAX_SOCKETS: "10000",
  RELAY_MAX_SOCKETS_GLOBAL: "10000",
  RELAY_TRUST_PROXY_HOPS: "1",
  RELAY_RATE_PER_MIN: "60000",
  RELAY_RATE_BURST: "100000",
  RELAY_ROOM_BUDGET_BYTES: "-1",
};
const relay = spawn(process.execPath, ["--import", "tsx/esm", "apps/relay/src/index.ts"], {
  cwd: ROOT,
  // only what the relay needs: a hermetic HOME and PATH, never the operator's RELAY_* env
  env: { HOME: home, PATH: process.env.PATH ?? "", OCR_E2E_MARKER: "1", ...relayEnv },
  stdio: ["ignore", "pipe", "pipe"],
});
let relayOut = "";
relay.stdout?.on("data", (c) => {
  relayOut = (relayOut + String(c)).slice(-20_000);
});
relay.stderr?.on("data", (c) => process.stderr.write(`[relay] ${String(c)}`));
const cleanup = () => {
  try {
    relay.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  rmSync(home, { recursive: true, force: true });
};
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

async function metrics(): Promise<Record<string, number>> {
  const r = await fetch(`http://127.0.0.1:${mport}/metrics`);
  return (await r.json()) as Record<string, number>;
}
/** Cumulative CPU seconds of the relay process (ps TIME column). */
function relayCpuS(): number {
  const t = execFileSync("ps", ["-o", "time=", "-p", String(relay.pid)]).toString().trim();
  const parts = t.split(":").map(Number);
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

// --- worker source (plain JS, eval'd) ----------------------------------------
const WORKER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
const { createRequire } = require("node:module");
const WebSocket = createRequire(workerData.root + "/package.json")("ws");
const { url, pairs, base } = workerData;
const now = () => performance.now();
const socks = [];
const pairsState = [];
function open(i) {
  return new Promise((resolve) => {
    const a = 10 + ((i >> 16) & 0xff), b = (i >> 8) & 0xff, c = i & 0xff;
    const ws = new WebSocket(url, { headers: { "x-forwarded-for": "10." + a + "." + b + "." + c } });
    const t0 = now();
    ws.on("open", () => resolve({ ws, ms: now() - t0 }));
    ws.on("error", (e) => resolve({ ws: null, ms: now() - t0, code: e.code || String(e.message).slice(0, 40) }));
  });
}
function roomOf(p) { return "load" + String(base + p).padStart(8, "0") + "abcd"; }
async function connectAll(concurrency) {
  const handshakes = [];
  let next = 0, failed = 0;
  async function lane() {
    while (next < pairs) {
      const p = next++;
      const room = roomOf(p);
      const [d, ph] = [await open((base + p) * 2), await open((base + p) * 2 + 1)];
      if (!d.ws || !ph.ws) { failed++; continue; }
      handshakes.push(d.ms, ph.ms);
      d.ws.send(JSON.stringify({ room, from: room, payload: "" }));
      ph.ws.send(JSON.stringify({ room, from: "ph" + room.slice(4), payload: "" }));
      socks.push(d.ws, ph.ws);
      pairsState.push({ room, d: d.ws, ph: ph.ws });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, lane));
  handshakes.sort((x, y) => x - y);
  return { opened: socks.length, failed, p50: handshakes[Math.floor(handshakes.length * 0.5)] ?? 0, p99: handshakes[Math.floor(handshakes.length * 0.99)] ?? 0 };
}
async function blast(active, seconds, size) {
  const pad = "x".repeat(Math.max(0, size - 24));
  let sent = 0, recv = 0, closed = 0;
  const lat = [];
  const chosen = pairsState.slice(0, active);
  const handlers = [];
  for (const p of chosen) {
    const h = (data) => {
      recv++;
      const s = data.toString();
      const i = s.indexOf('"payload":"');
      if ((recv & 15) === 0 && i >= 0) {
        const t = Number(s.slice(i + 11, s.indexOf("|", i)));
        lat.push(now() - t);
      }
    };
    p.ph.on("message", h);
    p.ph.once("close", () => closed++);
    handlers.push([p.ph, h]);
  }
  const end = now() + seconds * 1000;
  await new Promise((resolve) => {
    function pump() {
      if (now() >= end) return resolve();
      for (const p of chosen) {
        let n = 0;
        while (p.d.readyState === 1 && p.d.bufferedAmount < 262144 && n++ < 64) {
          p.d.send('{"room":"' + p.room + '","from":"' + p.room + '","payload":"' + now().toFixed(3) + "|" + pad + '"}');
          sent++;
        }
      }
      setImmediate(pump);
    }
    pump();
  });
  await new Promise((r) => setTimeout(r, 500));
  for (const [ws, h] of handlers) ws.off("message", h);
  lat.sort((x, y) => x - y);
  const q = (f) => lat[Math.min(lat.length - 1, Math.floor(lat.length * f))] ?? 0;
  return { sent, recv, closed, p50: q(0.5), p95: q(0.95), p99: q(0.99), samples: lat.length };
}
async function pace(active, seconds, size, hz) {
  const pad = "x".repeat(Math.max(0, size - 24));
  let sent = 0, recv = 0;
  const lat = [];
  const chosen = pairsState.slice(0, active);
  const handlers = [];
  for (const p of chosen) {
    const h = (data) => {
      recv++;
      const s = data.toString();
      const i = s.indexOf('"payload":"');
      if (i >= 0) lat.push(now() - Number(s.slice(i + 11, s.indexOf("|", i))));
    };
    p.ph.on("message", h);
    handlers.push([p.ph, h]);
  }
  const tickMs = 5;
  let owed = 0;
  const end = now() + seconds * 1000;
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (now() >= end) { clearInterval(timer); return resolve(); }
      owed += (hz * tickMs) / 1000;
      const n = Math.floor(owed);
      owed -= n;
      for (let k = 0; k < n; k++) {
        for (const p of chosen) {
          if (p.d.readyState !== 1) continue;
          p.d.send('{"room":"' + p.room + '","from":"' + p.room + '","payload":"' + now().toFixed(3) + "|" + pad + '"}');
          sent++;
        }
      }
    }, tickMs);
  });
  await new Promise((r) => setTimeout(r, 500));
  for (const [ws, h] of handlers) ws.off("message", h);
  lat.sort((x, y) => x - y);
  const q = (f) => lat[Math.min(lat.length - 1, Math.floor(lat.length * f))] ?? 0;
  return { sent, recv, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: lat[lat.length - 1] ?? 0 };
}
async function churn(seconds, concurrency, idBase) {
  const end = now() + seconds * 1000;
  let done = 0, failed = 0, k = 0;
  const errors = {};
  async function lane() {
    while (now() < end) {
      const i = idBase + k++;
      const r = await open(i);
      if (!r.ws) { failed++; errors[r.code] = (errors[r.code] || 0) + 1; continue; }
      const room = "churn" + String(i).padStart(10, "0");
      r.ws.send(JSON.stringify({ room, from: room, payload: "" }));
      await new Promise((res) => { r.ws.once("close", res); r.ws.close(); });
      done++;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, lane));
  return { done, failed, errors };
}
parentPort.on("message", async (m) => {
  if (m.cmd === "connect") parentPort.postMessage(await connectAll(m.concurrency));
  if (m.cmd === "blast") parentPort.postMessage(await blast(m.active, m.seconds, m.size));
  if (m.cmd === "pace") parentPort.postMessage(await pace(m.active, m.seconds, m.size, m.hz));
  if (m.cmd === "churn") parentPort.postMessage(await churn(m.seconds, m.concurrency, m.idBase));
  if (m.cmd === "close") { for (const s of socks) s.terminate(); parentPort.postMessage({ ok: true }); }
});
`;

function ask<T>(w: Worker, msg: unknown): Promise<T> {
  return new Promise((resolve) => {
    w.once("message", (m) => resolve(m as T));
    w.postMessage(msg);
  });
}

async function main() {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    up = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok).catch(() => false);
    if (!up) await sleep(250);
  }
  if (!up) throw new Error("relay did not boot:\n" + relayOut);
  await sleep(300);
  const base0 = await metrics();
  const cpu0 = relayCpuS();

  const pairsTotal = Math.floor(SOCKETS / 2);
  const per = Math.ceil(pairsTotal / WORKERS);
  const workers = Array.from({ length: WORKERS }, (_, k) =>
    new Worker(WORKER_SRC, {
      eval: true,
      workerData: {
        root: ROOT,
        url: `ws://127.0.0.1:${port}/`,
        pairs: Math.max(0, Math.min(per, pairsTotal - k * per)),
        base: k * per,
      },
    }),
  );

  // 1. ramp: every simulated daemon+phone pair connects and joins its room
  const t0 = performance.now();
  const conn = await Promise.all(workers.map((w) => ask<{ opened: number; failed: number; p50: number; p99: number }>(w, { cmd: "connect", concurrency: 16 })));
  const rampS = (performance.now() - t0) / 1000;
  await sleep(1500);
  const afterRamp = await metrics();
  const opened = conn.reduce((a, c) => a + c.opened, 0);
  const idleCpu0 = relayCpuS();
  await sleep(5000);
  const idleCpuPct = ((relayCpuS() - idleCpu0) / 5) * 100;
  const idle = await metrics();

  // 2a. latency under a paced, realistic load: ACTIVE pairs stream daemon ->
  // phone at a fixed per-pair rate while the rest idle (not saturated)
  const paced: Record<string, unknown>[] = [];
  for (const [size, hz] of [
    [256, 50],
    [4096, 50],
    [65536, 5],
  ] as const) {
    const activePer = Math.ceil(ACTIVE / WORKERS);
    await metrics();
    const c0 = relayCpuS();
    const tp = performance.now();
    const res = await Promise.all(
      workers.map((w) => ask<{ sent: number; recv: number; p50: number; p95: number; p99: number; max: number }>(w, { cmd: "pace", active: activePer, seconds: SECONDS, size, hz })),
    );
    const wall = (performance.now() - tp) / 1000;
    const recv = res.reduce((a, r) => a + r.recv, 0);
    paced.push({
      payloadBytes: size,
      activePairs: activePer * WORKERS,
      perPairHz: hz,
      framesDelivered: recv,
      framesLost: res.reduce((a, r) => a + r.sent, 0) - recv,
      deliveredPerS: Math.round(recv / SECONDS),
      latencyP50Ms: Number(Math.max(...res.map((r) => r.p50)).toFixed(2)),
      latencyP95Ms: Number(Math.max(...res.map((r) => r.p95)).toFixed(2)),
      latencyP99Ms: Number(Math.max(...res.map((r) => r.p99)).toFixed(2)),
      latencyMaxMs: Number(Math.max(...res.map((r) => r.max)).toFixed(2)),
      relayCpuPct: Math.round(((relayCpuS() - c0) / wall) * 100),
    });
  }

  // 2b. saturation: ACTIVE pairs stream as fast as client backpressure allows
  // (latency here is queueing, not service time — read the paced table for it)
  const blasts: Record<string, unknown>[] = [];
  for (const size of [256, 4096, 65536]) {
    const activePer = Math.ceil(SAT_PAIRS / WORKERS);
    await metrics(); // resets the scheduling-delay window
    const c0 = relayCpuS();
    const tb = performance.now();
    const res = await Promise.all(
      workers.map((w) => ask<{ sent: number; recv: number; closed: number; p50: number; p95: number; p99: number; samples: number }>(w, { cmd: "blast", active: activePer, seconds: SECONDS, size })),
    );
    const wall = (performance.now() - tb) / 1000;
    const after = await metrics();
    const recv = res.reduce((a, r) => a + r.recv, 0);
    const sent = res.reduce((a, r) => a + r.sent, 0);
        blasts.push({
      payloadBytes: size,
      activePairs: activePer * WORKERS,
      framesSent: sent,
      framesDelivered: recv,
      deliveredPerS: Math.round(recv / SECONDS),
      mbPerS: Number(((recv * size) / SECONDS / 1e6).toFixed(1)),
      queueingP50Ms: Number(Math.max(...res.map((r) => r.p50)).toFixed(2)),
      relayCpuPct: Math.round(((relayCpuS() - c0) / wall) * 100),
      schedulingDelayMaxMs: after.scheduling_delay_ms,
      residentMB: Math.round((after.resident_bytes ?? 0) / 1e6),
      slowConsumersClosed: after.slow_consumers_total,
      socketsClosedDuringBlast: res.reduce((a, r) => a + r.closed, 0),
    });
  }

  // 3. churn: short-lived sockets (connect, join, close) on top of the idle load
  const c0 = relayCpuS();
  const churnRes = await Promise.all(workers.map((w, k) => ask<{ done: number; failed: number; errors: Record<string, number> }>(w, { cmd: "churn", seconds: SECONDS, concurrency: 4, idBase: 5_000_000 + k * 1_000_000 })));
  const churnCpu = Math.round(((relayCpuS() - c0) / SECONDS) * 100);
  const churnDone = churnRes.reduce((a, r) => a + r.done, 0);

  await Promise.all(workers.map((w) => ask(w, { cmd: "close" })));
  await Promise.all(workers.map((w) => w.terminate()));

  const result = {
    measuredAt: new Date().toISOString(),
    machine: { cpu: cpus()[0]?.model, cores: cpus().length, memGB: Math.round(totalmem() / 2 ** 30), os: `${platform()} ${release()}`, node: process.version },
    relayConfig: relayEnv,
    ramp: {
      socketsRequested: SOCKETS,
      socketsOpen: opened,
      failed: conn.reduce((a, c) => a + c.failed, 0),
      seconds: Number(rampS.toFixed(2)),
      connectsPerS: Math.round(opened / rampS),
      handshakeP50Ms: Number(Math.max(...conn.map((c) => c.p50)).toFixed(2)),
      handshakeP99Ms: Number(Math.max(...conn.map((c) => c.p99)).toFixed(2)),
      rooms: afterRamp.rooms_active,
      roomsPaired: afterRamp.rooms_paired,
    },
    memory: {
      baselineResidentMB: Math.round(base0.resident_bytes / 1e6),
      loadedResidentMB: Math.round(afterRamp.resident_bytes / 1e6),
      residentKBPerSocket: Math.round((afterRamp.resident_bytes - base0.resident_bytes) / 1024 / Math.max(1, opened)),
      heapKBPerSocket: Math.round((afterRamp.heap_used_bytes - base0.heap_used_bytes) / 1024 / Math.max(1, opened)),
    },
    idle: { sockets: idle.connections_active, relayCpuPct: Number(idleCpuPct.toFixed(1)) },
    paced,
    saturation: blasts,
    churn: {
      connectsPerS: Math.round(churnDone / SECONDS),
      failed: churnRes.reduce((a, r) => a + r.failed, 0),
      errors: churnRes.reduce<Record<string, number>>((acc, r) => {
        for (const [k, v] of Object.entries(r.errors)) acc[k] = (acc[k] ?? 0) + v;
        return acc;
      }, {}),
      relayCpuPct: churnCpu,
    },
    relayCpuSecondsTotal: Number((relayCpuS() - cpu0).toFixed(2)),
  };
  console.log(JSON.stringify(result, null, 2));
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(result, null, 2) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("relay-load failed:", e);
    process.exit(1);
  });
