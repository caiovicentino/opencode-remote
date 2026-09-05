/**
 * Per-IP live-connection cap tests (P2-025): pure IpCap behavior plus the
 * handler path against real relay subprocesses — a strict-env relay
 * rejecting connection cap+1 with 1013 "too many connections" and a released
 * slot being reused by the next peer. P2-171: a RELAY_MAX_PER_IP=0 relay
 * proves the fail-closed boot refusal (zero no longer disables the cap).
 * P2-026: normalizeIp rotation immunity — mapped IPv4 unmasks to the plain
 * IPv4, IPv6 aggregates by /64, and the handler keys admit/release on the
 * normalized value.
 * P2-128: clientIp proxy awareness — with zero trusted hops the forgeable
 * x-forwarded-for header is ignored; with N hops the Nth-from-the-right
 * entry wins, degrading to remoteAddress on short/malformed chains.
 * Run: npx tsx scripts/relay-ipcap.test.ts
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import WebSocket from "ws";
import { IpCap, clientIp, normalizeIp } from "../apps/relay/src/ipcap";

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

// --- 2. normalizeIp (P2-026): rotation-immune cap keys ------------------------
check("normalize: mapped IPv4 unmasks to the plain IPv4", normalizeIp("::ffff:11.22.33.44") === "11.22.33.44");
check("normalize: plain IPv4 passes through", normalizeIp("11.22.33.44") === "11.22.33.44");
check("normalize: mapped and plain share the bucket", normalizeIp("::ffff:11.22.33.44") === normalizeIp("11.22.33.44"));
check("normalize: mapped hex tail unmasks too", normalizeIp("::ffff:0B16:212C") === "11.22.33.44");
check("normalize: IPv6 loopback stays", normalizeIp("::1") === "::1");
check("normalize: /64 key is the compressed lowercase prefix", normalizeIp("2001:DB8:0001:0002::1") === "2001:db8:1:2");
check("normalize: uncompressed and compressed /64 siblings agree", normalizeIp("2001:db8:1:2:dead:beef:0:1") === normalizeIp("2001:db8:1:2::1"));
check("normalize: neighbor /64 aggregates differently", normalizeIp("2001:db8:1:2::1") !== normalizeIp("2001:db8:1:3::1"));
check("normalize: trailing-zero prefix compresses", normalizeIp("2001:db8:0:0::1") === "2001:db8::");
check("normalize: garbage degrades to raw key", normalizeIp("not-an-ip") === "not-an-ip");

// handler-equivalent keying: the connection path normalizes once and passes
// the same key to admit() and release()
const shared = new IpCap(1);
check("ipcap: mapped addr takes the plain-IPv4 budget", shared.admit(normalizeIp("::ffff:11.22.33.44")) && !shared.admit(normalizeIp("11.22.33.44")));
shared.release(normalizeIp("::ffff:11.22.33.44"));
check("ipcap: release via the mapped twin reopens for plain", shared.admit(normalizeIp("11.22.33.44")));

// two addresses of one /64 share the budget; neighbors don't collide
const lan = new IpCap(2);
check("ipcap: same /64 shares budget", lan.admit(normalizeIp("2001:db8:1:2::1")) && lan.admit(normalizeIp("2001:db8:1:2:dead:beef:0:1")));
check("ipcap: same /64 cap+1 is refused", !lan.admit(normalizeIp("2001:db8:1:2::3")));
check("ipcap: neighbor /64 unaffected", lan.admit(normalizeIp("2001:db8:1:3::1")));
check("ipcap: counts keys are normalized", JSON.stringify(Object.keys(lan.counts()).sort()) === '["2001:db8:1:2","2001:db8:1:3"]');

// --- 2b. clientIp (P2-128): proxy-aware cap key --------------------------------
// hops 0 (default): x-forwarded-for is forgeable by any client, so the
// header must be ignored entirely and the key come from remoteAddress alone
check("clientIp: hops 0 ignores a forged header", clientIp("1.2.3.4", "9.9.9.9", 0) === "1.2.3.4");
check("clientIp: absent header with hops 0 uses remoteAddress", clientIp("1.2.3.4", undefined, 0) === "1.2.3.4");
check("clientIp: fractional hops floor to the integer part", clientIp("1.2.3.4", "9.9.9.9", 0.5) === "1.2.3.4");

// hops N: Nth entry from the right is the address the Nth-from-last proxy saw
check(
  "clientIp: hops 1 in a two-entry chain picks the rightmost entry",
  clientIp("10.0.0.1", "203.0.113.7, 198.51.100.9", 1) === "198.51.100.9",
);
check(
  "clientIp: hops 2 in the same chain picks the leftmost entry",
  clientIp("10.0.0.1", "203.0.113.7, 198.51.100.9", 2) === "203.0.113.7",
);

// degraded chains fall back to the real socket address, never a bogus key
check("clientIp: chain shorter than hops falls back", clientIp("10.0.0.1", "203.0.113.7", 2) === "10.0.0.1");
check("clientIp: absent header with hops > 0 falls back", clientIp("10.0.0.1", undefined, 1) === "10.0.0.1");
check("clientIp: malformed chosen entry falls back", clientIp("10.0.0.1", "not-an-ip", 1) === "10.0.0.1");
check(
  "clientIp: malformed entry at hop position falls back",
  clientIp("10.0.0.1", "junk, 198.51.100.9", 2) === "10.0.0.1",
);
check(
  "clientIp: out-of-range octet is not a valid address",
  clientIp("10.0.0.1", "1.2.3.999", 1) === "10.0.0.1",
);

// P2-026 normalization is preserved on every clientIp path
check(
  "clientIp: mapped remoteAddress normalizes with hops 0",
  clientIp("::ffff:11.22.33.44", "9.9.9.9", 0) === "11.22.33.44",
);
check(
  "clientIp: mapped IPv4 in the trusted hop unmasks too",
  clientIp("10.0.0.1", "::ffff:11.22.33.44", 1) === "11.22.33.44",
);
check(
  "clientIp: trusted IPv6 hop aggregates by /64",
  clientIp("10.0.0.1", "2001:db8:1:2:dead:beef::9", 1) === "2001:db8:1:2",
);

// the chosen hop key and the remoteAddress fallback key must admit/release
// on the same bucket shape as the handler's IpCap
const proxyCap = new IpCap(1);
check("ipcap: trusted hop key shares the plain-IPv4 budget", proxyCap.admit(clientIp("10.0.0.1", "::ffff:11.22.33.44", 1)) && !proxyCap.admit(clientIp("10.0.0.2", "11.22.33.44", 1)));

// --- 3. integration helpers ---------------------------------------------------
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

// --- 4. strict-env relay: per-IP admission enforced ---------------------------
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
// normalization must not over-merge: IPv6 loopback is its own bucket, so an
// IPv6 source is admitted while the 127.0.0.1 budget (s2 + reused) is full
const v6 = await tryOpen(`ws://[::1]:${strict.port}`);
check("relay: IPv6 loopback has its own bucket", v6 !== null);
v6?.close();
s2!.close();
reused?.close();
strict.proc.kill("SIGTERM");

// --- 5. RELAY_MAX_PER_IP=0: fail-closed boot refusal (P2-171) -------------------
// Zero used to disable the cap; since P2-171 a zero knob refuses the boot
// instead of silently serving a public relay with admission control off.
const refused = startRelay({ RELAY_MAX_PER_IP: "0" });
const refusedExit = new Promise<number | null>((r) => refused.proc.on("exit", (c) => r(c)));
check("relay: zero RELAY_MAX_PER_IP refuses the boot with exit 1 (fail-closed)", (await refusedExit) === 1);
check("relay: refused boot never opens the listener", (await tryOpen(`ws://127.0.0.1:${refused.port}`)) === null);
refused.proc.kill("SIGTERM");

if (failures) process.exit(1);
console.log("relay-ipcap: ALL OK");
process.exit(0);
