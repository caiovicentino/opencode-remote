/**
 * Relay liveness tests (P2-067): pure decideStale policy plus the wiring
 * against a real relay subprocess — a peer that never pongs is reaped and
 * frees its room and per-IP slot, a heartbeating peer survives the same
 * sweeps, the stale_terminated counter climbs on /metrics, and
 * (P2-171) a RELAY_PING_INTERVAL_S=0 relay refuses to boot instead of
 * silently disabling the sweep.
 * Run: npx tsx scripts/relay-liveness.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { get } from "node:http";
import { join } from "node:path";
import WebSocket from "ws";
import { decideStale, type LivenessPeer } from "../apps/relay/src/liveness";
import { JOIN_UNJOINED_CLOSE_CODE } from "../apps/relay/src/joindeadline";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

setTimeout(() => {
  console.error("relay-liveness test timed out (global 60s)");
  process.exit(1);
}, 60_000).unref();

// --- 1. pure policy: decideStale ---------------------------------------------
const now = 1_000_000;
const peer = (ageMs: number): LivenessPeer => ({ lastSeen: now - ageMs });

check("liveness: fresh pong survives", decideStale(now, [peer(1_000)], 30, 30).length === 0);
check(
  "liveness: silent beyond interval+grace is stale",
  decideStale(now, [peer(60_001)], 30, 30).length === 1,
);
check(
  "liveness: exactly interval+grace silent survives (strict bound)",
  decideStale(now, [peer(60_000)], 30, 30).length === 0,
);
check("liveness: interval 0 disables the sweep", decideStale(now, [peer(10 ** 9)], 0, 30).length === 0);
check("liveness: negative interval disables the sweep", decideStale(now, [peer(10 ** 9)], -5, 30).length === 0);
check("liveness: unmarked peer is never swept", decideStale(now, [{}], 30, 30).length === 0);
check("liveness: grace 0 makes one interval the budget", decideStale(now, [peer(1_001)], 1, 0).length === 1);
const survivors = decideStale(now, [peer(1_000), peer(2_000)], 1, 0);
check("liveness: only the stale peer is returned", survivors.length === 1 && survivors[0]?.lastSeen === now - 2_000);

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

function open(url: string, opts: WebSocket.ClientOptions = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
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

function joinRoom(ws: WebSocket, room: string, from: string) {
  ws.send(JSON.stringify({ room, from, payload: "" }));
}

const fetchMetrics = (port: number, qs = "") =>
  new Promise<string>((resolve) => {
    get(`http://127.0.0.1:${port}/metrics${qs}`, (res) => {
      let s = "";
      res.on("data", (c) => (s += c));
      res.on("end", () => resolve(s));
    });
  });

// --- 3. strict liveness relay: silent peer reaped, live peer survives ---------
// 1s interval → sweep every 1s, silence budget = interval+grace = 2s
const strict = startRelay({ RELAY_PING_INTERVAL_S: "1", RELAY_MAX_PER_IP: "2" });
await waitReady(strict.port);
const url = `ws://127.0.0.1:${strict.port}`;

const deadRoom = `lv-dead-${Date.now()}`;
const dead = await open(url, { autoPong: false }); // never answers pings
const deadClosed = new Promise<number>((r) => dead.on("close", (code) => r(code)));
joinRoom(dead, deadRoom, "dead-1");

const liveRoom = `lv-live-${Date.now()}`;
const live = await open(url); // default autoPong: true — the healthy shape
joinRoom(live, liveRoom, "live-1");
await sleep(300); // let both joins land before the first sweep

const code = await Promise.race([deadClosed, sleep(9_000).then(() => -1)]);
check("liveness: silent peer is terminated within budget", code !== -1);
check("liveness: termination carries no close frame (1006)", code === 1006);

await sleep(2_500); // another 2 sweep cycles: the heartbeating peer must hold
check("liveness: heartbeating peer survives the sweeps", live.readyState === WebSocket.OPEN);

const json = JSON.parse(await fetchMetrics(strict.port + 1)) as {
  stale_terminated?: number;
  rooms_active?: number;
};
check("liveness: stale_terminated counter incremented", (json.stale_terminated ?? 0) >= 1);
check("liveness: reaped peer's room released (2 rooms -> 1)", json.rooms_active === 1);

// the reaped peer's per-IP slot is reusable: dead+live held both slots
const third = await tryOpen(url);
check("liveness: reaped socket frees the per-IP slot", third !== null);

const prom = await fetchMetrics(strict.port + 1, "?format=prom");
check("metrics: relay_stale_terminated exposed in prom format", /relay_stale_terminated \d+/.test(prom));

third?.close();
live.close();
strict.proc.kill("SIGTERM");

// --- 4. RELAY_PING_INTERVAL_S=0: fail-closed boot refusal (P2-171) --------------
// Zero used to disable the sweep; since P2-171 a zero knob refuses the boot
// instead of silently serving a public relay without liveness reaping.
const off = startRelay({ RELAY_PING_INTERVAL_S: "0" });
const offExit = new Promise<number | null>((r) => off.proc.on("exit", (c) => r(c)));
check("liveness: zero RELAY_PING_INTERVAL_S refuses the boot with exit 1 (fail-closed)", (await offExit) === 1);
check("liveness: refused boot never opens the listener", (await tryOpen(`ws://127.0.0.1:${off.port}`)) === null);
off.proc.kill("SIGTERM");

// --- 5. P2-230: join-deadline reaper — idle socket closed, joined socket holds --
// 1s sweep + 1s deadline: a socket that never sends a frame is closed even
// though its ws pong answers every ping automatically.
const joinRelay = startRelay({ RELAY_PING_INTERVAL_S: "1", RELAY_JOIN_DEADLINE_MS: "1000" });
await waitReady(joinRelay.port);
const joinUrl = `ws://127.0.0.1:${joinRelay.port}`;

// doomed shape: connects and stays silent — the browser-protocol pong keeps
// it "alive" for the liveness verdict; only the join deadline closes it
const idle = await open(joinUrl);
const idleClosed = new Promise<number>((r) => idle.on("close", (c) => r(c)));

// healthy shape: sends a frame and enters a room
const joined = await open(joinUrl);
const jdRoom = `lv-join-${Date.now()}`;
joinRoom(joined, jdRoom, "joined-1");

const idleCode = await Promise.race([idleClosed, sleep(9_000).then(() => -1)]);
check("join-deadline: socket that never sends a frame is closed with the policy code", idleCode === JOIN_UNJOINED_CLOSE_CODE);
await sleep(2_500); // several sweep cycles past the deadline
check("join-deadline: socket that joined a room stays open past the deadline", joined.readyState === WebSocket.OPEN);

const joinMetrics = JSON.parse(await fetchMetrics(joinRelay.port + 1)) as {
  idle_unjoined_closed?: number;
  connections_active?: number;
};
check("join-deadline: idle_unjoined_closed counter incremented", (joinMetrics.idle_unjoined_closed ?? 0) >= 1);
check("join-deadline: only the joined peer remains connected", joinMetrics.connections_active === 1);

const promJoin = await fetchMetrics(joinRelay.port + 1, "?format=prom");
check("join-deadline: relay_idle_unjoined_closed exposed in prom format", /relay_idle_unjoined_closed \d+/.test(promJoin));

joined.close();
joinRelay.proc.kill("SIGTERM");

// zero deadline is refused at boot like every other invalid knob (fail-closed)
const zeroJoin = startRelay({ RELAY_JOIN_DEADLINE_MS: "0" });
const zeroJoinExit = new Promise<number | null>((r) => zeroJoin.proc.on("exit", (c) => r(c)));
check("join-deadline: zero RELAY_JOIN_DEADLINE_MS refuses the boot with exit 1 (fail-closed)", (await zeroJoinExit) === 1);
zeroJoin.proc.kill("SIGTERM");

// --- 6. wiring pins against the real index.ts source -----------------------------
{
  const relayIndexSrc = readFileSync(
    join(import.meta.dirname, "..", "apps", "relay", "src", "index.ts"),
    "utf8",
  );
  // open stamp is marked at the connection event, joined flag inside join()
  check(
    "join-deadline: index.ts marks openedAt on the connection event and joinedRoom in join()",
    relayIndexSrc.includes("socket.openedAt = Date.now();") &&
      relayIndexSrc.includes("socket.joinedRoom = true;") &&
      relayIndexSrc.indexOf("function join(") < relayIndexSrc.indexOf("socket.joinedRoom = true;"),
  );
  // the verdict is consulted inside the existing liveness sweep, and no new
  // periodic timer was introduced
  const sweepAt = relayIndexSrc.indexOf("setInterval(() => {");
  const verdictAt = relayIndexSrc.indexOf("idleUnjoined(now, wss.clients");
  const sweepEndAt = relayIndexSrc.indexOf("}, PING_INTERVAL_S * 1000);");
  check(
    "join-deadline: idleUnjoined is consulted inside the existing sweep — no new periodic timer",
    sweepAt > -1 && verdictAt > sweepAt && verdictAt < sweepEndAt &&
      (relayIndexSrc.match(/setInterval\(/g) ?? []).length === 1,
  );
  check(
    "join-deadline: index.ts resolves the deadline fail-closed and advertises it on `relay listening`",
    relayIndexSrc.includes("const JOIN_DEADLINE = parseJoinDeadline(process.env);") &&
      relayIndexSrc.includes('ev("warn", "invalid relay join deadline, refusing to start (fail-closed)"') &&
      relayIndexSrc.includes("joinDeadlineMs,"),
  );
}

if (failures) process.exit(1);
console.log("relay-liveness: ALL OK");
process.exit(0);