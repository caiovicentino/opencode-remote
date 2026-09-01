/**
 * Per-IP live-connection cap tests (P2-025): pure IpCap behavior plus the
 * handler path against real relay subprocesses — a strict-env relay
 * rejecting connection cap+1 with 1013 "too many connections", a released
 * slot being reused by the next peer, and a RELAY_MAX_PER_IP=0 relay
 * proving the disabled cap never rejects.
 * Run: npx tsx scripts/relay-ipcap.test.ts
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import WebSocket from "ws";
import { IpCap } from "../apps/relay/src/ipcap";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

setTimeout(() => {
  console.error("relay-ipcap test timed out (global 30s)");
  process.exit(1);
}, 30_000).unref();

// --- 1. pure IpCap: cap, refuse, release, disable -----------------------------
const cap = new IpCap(3);
check("ipcap: admits up to the cap", cap.admit("10.0.0.1") && cap.admit("10.0.0.1") && cap.admit("10.0.0.1"));
check("ipcap: cap+1 is refused", cap.admit("10.0.0.1") === false);
check("ipcap: other IPs unaffected", cap.admit("10.0.0.2") === true);
check("ipcap: counts reflects live slots", JSON.stringify(cap.counts()) === JSON.stringify({ "10.0.0.1": 3, "10.0.0.2": 1 }));

cap.release("10.0.0.1");
check("ipcap: release reopens a slot", cap.admit("10.0.0.1") === true);
check("ipcap: refused attempt adds no count", JSON.stringify(cap.counts()) === JSON.stringify({ "10.0.0.1": 3, "10.0.0.2": 1 }));

cap.release("10.0.0.1");
cap.release("10.0.0.1");
cap.release("10.0.0.1");
check("ipcap: last release drops the entry", cap.counts()["10.0.0.1"] === undefined);
cap.release("10.0.0.9"); // never admitted
check("ipcap: release of unknown IP is a no-op", JSON.stringify(cap.counts()) === JSON.stringify({ "10.0.0.2": 1 }));

const free = new IpCap(0);
check("ipcap: 0 disables — every admit passes", Array.from({ length: 50 }, () => free.admit("host")).every(Boolean));
check("ipcap: 0 disables — no state kept", Object.keys(free.counts()).length === 0);
free.release("host");
check("ipcap: 0 disables — release is a no-op", Object.keys(free.counts()).length === 0);

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

// resolve with the socket only when it survives the admission window
// (a refusal shows up as a close right after the handshake), null otherwise
function tryOpen(url: string): Promise<WebSocket | null> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let settled = false;
    const fail = () => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    };
    ws.on("error", fail);
    ws.on("close", fail);
    ws.on("open", () => setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(ws);
      }
    }, 150).unref());
  });
}

const closeInfo = (ws: WebSocket) =>
  new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  );

// --- 3. strict-env relay: per-IP admission enforced ---------------------------
const strict = startRelay({ RELAY_MAX_PER_IP: "2" });
await waitReady(strict.port);
const strictUrl = `ws://127.0.0.1:${strict.port}`;

const s1 = await tryOpen(strictUrl);
const s2 = await tryOpen(strictUrl);
check("relay: connections under the cap are admitted", s1 !== null && s2 !== null);

const rejected = new WebSocket(strictUrl);
rejected.on("error", () => {});
const rej = closeInfo(rejected);
check("relay: cap+1 from the same IP is refused", (await tryOpen(strictUrl)) === null);
const { code, reason } = await rej;
check("relay: refusal closes with 1013 'too many connections'", code === 1013 && reason === "too many connections");
check("relay: admitted peers unaffected by the refusal", s1!.readyState === WebSocket.OPEN && s2!.readyState === WebSocket.OPEN);

// release reopens the slot on the live handler path (close -> release)
const s1Closed = new Promise<void>((r) => s1!.on("close", () => r()));
s1!.close();
await s1Closed;
let reused: WebSocket | null = null;
for (let i = 0; i < 10 && !reused; i++) {
  await sleep(100); // relay needs to process the close before the slot frees
  reused = await tryOpen(strictUrl);
}
check("relay: released slot is reusable (close handler)", reused !== null);
check("relay: previously admitted peer still open", s2!.readyState === WebSocket.OPEN);
s2!.close();
reused?.close();
strict.proc.kill("SIGTERM");

// --- 4. RELAY_MAX_PER_IP=0: cap disabled, never rejects ------------------------
const disabled = startRelay({ RELAY_MAX_PER_IP: "0" });
await waitReady(disabled.port);
const url = `ws://127.0.0.1:${disabled.port}`;
const sockets = [await tryOpen(url), await tryOpen(url), await tryOpen(url)];
check("relay: disabled cap admits any number of connections", sockets.every((s) => s !== null));
const anyClosed = Promise.race([
  ...sockets.map((s) => closeInfo(s!).then(() => true)),
  sleep(700).then(() => false),
]);
check("relay: disabled cap never closes a connection", (await anyClosed) === false);
for (const s of sockets) s?.close();
disabled.proc.kill("SIGTERM");

if (failures) process.exit(1);
console.log("relay-ipcap: ALL OK");
process.exit(0);
