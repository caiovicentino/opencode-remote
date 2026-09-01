/**
 * Room id validation + per-socket room cap tests (P2-019): pure validator
 * grammar plus the wire path against a real relay subprocess — a valid id
 * joins and routes, short/long/foreign-charset ids are dropped with the
 * socket kept open, the 9th distinct room is dropped, a re-join of an
 * already-joined room still passes at the cap, and the rejection counter
 * shows up on /metrics and /healthz.
 * Run: npx tsx scripts/relay-rooms.test.ts
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { get } from "node:http";
import { join } from "node:path";
import WebSocket from "ws";
import { isValidRoomId, ROOM_ID_MAX, ROOM_ID_MIN } from "../apps/relay/src/roomid";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

setTimeout(() => {
  console.error("relay-rooms test timed out (global 30s)");
  process.exit(1);
}, 30_000).unref();

// --- 1. pure validator: grammar [A-Za-z0-9_-], 8..128 -------------------------
check("validator: daemon-shaped 32-hex id is valid", isValidRoomId(randomUUID().replaceAll("-", "")));
check(`validator: ${ROOM_ID_MIN}-char lower bound is valid`, isValidRoomId("a".repeat(8)));
check(`validator: ${ROOM_ID_MAX}-char upper bound is valid`, isValidRoomId("a".repeat(128)));
check("validator: underscores and hyphens are valid", isValidRoomId("a_B-c0921"));
check("validator: uppercase is valid", isValidRoomId("AbCdEfGh"));
check("validator: 7 chars is too short", isValidRoomId("a".repeat(7)) === false);
check("validator: 129 chars is too long", isValidRoomId("a".repeat(129)) === false);
check("validator: empty string is invalid", isValidRoomId("") === false);
check("validator: space is invalid", isValidRoomId("abcd fghi") === false);
check("validator: dot is invalid", isValidRoomId("abcd.fghi") === false);
check("validator: slash is invalid", isValidRoomId("abcd/fghi") === false);
check("validator: control char is invalid", isValidRoomId("abcd\x00fghi") === false);
check("validator: unicode is invalid", isValidRoomId("abcdéfgh") === false);
check("validator: numbers are invalid", isValidRoomId(12345678) === false);
check("validator: null is invalid", isValidRoomId(null) === false);
check("validator: objects are invalid", isValidRoomId({}) === false);

// --- 2. integration helpers ---------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// pick a genuinely free port from the OS — fixed random ranges collide with
// unrelated listeners on a busy dev machine (EADDRINUSE kills the subprocess)
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function startRelay(env: Record<string, string>) {
  const [port, metrics] = [await freePort(), await freePort()];
  const proc = spawn("npx", ["tsx", "apps/relay/src/index.ts"], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, ...env, RELAY_PORT: String(port), RELAY_METRICS_PORT: String(metrics) },
    stdio: ["ignore", "ignore", "inherit"],
  });
  proc.on("error", (e) => console.error("relay spawn error:", e));
  process.on("exit", () => proc.kill("SIGTERM"));
  return { port, metrics, proc };
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
      if (attempt > 60) throw new Error("relay never came up");
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

const send = (ws: WebSocket, room: string, from: string, payload: string) =>
  ws.send(JSON.stringify({ room, from, payload }));

const collect = (ws: WebSocket, n: number, ms: number) =>
  new Promise<number>((resolve) => {
    let count = 0;
    ws.on("message", () => {
      if (++count >= n) resolve(count);
    });
    setTimeout(() => resolve(count), ms).unref();
  });

const fetchText = (url: string) =>
  new Promise<string>((resolve) => {
    get(url, (res) => {
      let s = "";
      res.on("data", (c) => (s += c));
      res.on("end", () => resolve(s));
    });
  });

// --- 3. relay wire path: valid join, cap, re-join, counter --------------------
const ts = Date.now().toString(36);
const relay = await startRelay({});
await waitReady(relay.port);

const roomA = randomUUID().replaceAll("-", ""); // daemon shape: 32 hex chars
const listener = await connect(relay.port, "listener", roomA);
await sleep(300); // let the join settle before counting

// valid id: a second socket joins and its frame routes
const owner = await connect(relay.port, "owner", roomA);
const routedOnce = collect(listener, 1, 2000);
send(owner, roomA, "owner", "hello");
check("rooms: valid daemon-shaped id joins and routes", (await routedOnce) >= 1);

// fill the owner's socket up to the cap: roomA + 7 more distinct rooms
for (let i = 2; i <= 8; i++) send(owner, `rr-${ts}-${i}`, "owner", "");
await sleep(300);

// 9th distinct room: dropped, socket stays open, counter ticks
const rejectedBefore = Number(
  (JSON.parse(await fetchText(`http://127.0.0.1:${relay.port}/healthz`)) as {
    roomsRejected: number;
  }).roomsRejected,
);
send(owner, `rr-${ts}-9`, "owner", "overflow");
await sleep(300);
const healthz = JSON.parse(await fetchText(`http://127.0.0.1:${relay.port}/healthz`)) as {
  roomsRejected: number;
  rooms: number;
};
check("rooms: 9th distinct room is dropped", healthz.roomsRejected === rejectedBefore + 1);
check("rooms: capped socket is not disconnected", owner.readyState === WebSocket.OPEN);

// re-join of a room the socket already holds passes at the cap and routes
const routedAgain = collect(listener, 1, 2000);
send(owner, roomA, "owner", "rejoin-still-routes");
check("rooms: re-join of an existing room passes at the cap", (await routedAgain) >= 1);

// invalid ids: short, long, foreign charset — each dropped, socket alive
send(owner, "shortid", "owner", "x"); // 7 chars
send(owner, `x`.repeat(ROOM_ID_MAX + 1), "owner", "x"); // 129 chars
send(owner, "rr-bad.*-x", "owner", "x"); // dot + asterisk
send(owner, "rr-b@d", "owner", "x");
await sleep(300);
const afterInvalid = JSON.parse(await fetchText(`http://127.0.0.1:${relay.port}/healthz`)) as {
  roomsRejected: number;
};
check("rooms: invalid ids are counted as rejected", afterInvalid.roomsRejected === rejectedBefore + 5);
check("rooms: socket survives invalid-id frames", owner.readyState === WebSocket.OPEN);

// the cap is per socket: another socket may still create the 9th room
const listener2 = await connect(relay.port, "listener2", `rr-${ts}-9`);
await sleep(300);
const peer9 = await connect(relay.port, "peer9", `rr-${ts}-9`);
const routed9 = collect(listener2, 1, 2000);
send(peer9, `rr-${ts}-9`, "peer9", "fresh-room");
check("rooms: another socket can still open a new room", (await routed9) >= 1);

// counters exposed on both observability endpoints
const metrics = await fetchText(`http://127.0.0.1:${relay.metrics}/metrics?format=prom`);
check("rooms: /metrics prom exposes relay_rooms_rejected", /relay_rooms_rejected 5/.test(metrics));
check(
  "rooms: /metrics json exposes rooms_rejected",
  ((JSON.parse(await fetchText(`http://127.0.0.1:${relay.metrics}/metrics`)) as { rooms_rejected?: number })
    .rooms_rejected ?? -1) === 5,
);
check("rooms: /healthz exposes rooms_rejected", healthz.roomsRejected >= 1);
check("rooms: /healthz never leaks room ids", !JSON.stringify(healthz).includes(roomA));

for (const ws of [listener, owner, listener2, peer9]) ws.close();
relay.proc.kill("SIGTERM");
if (failures) process.exit(1);
console.log("relay-rooms: ALL OK");
process.exit(0);
