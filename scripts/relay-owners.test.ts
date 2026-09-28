/**
 * Two daemons holding one room's owner identity (eval-13b), against a real
 * relay subprocess booted from this checkout (hermetic: throwaway HOME,
 * ephemeral free port pair, killed by PID).
 *
 * Every daemon frame carries its room id as the sender (from === room). Two
 * live sockets claiming that identity are two daemon processes sharing one
 * identity — a "restarted" daemon still alive, a state directory copied to a
 * second machine. The relay fans every phone frame out to every other peer
 * (by design), so both answer and the first one wins: exactly how the
 * reconnect.test failure of PR #1316 (CI run 35877316740) got a 410 from the
 * stale daemon. This file proves the fan-out and the observation-only signal
 * the relay now publishes for it: a gauge, a counter and one warn line.
 *
 * Run: npx tsx scripts/relay-owners.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { freePortPairSync } from "./testports";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}
setTimeout(() => {
  console.error("relay-owners test timed out (global 45s)");
  process.exit(1);
}, 45_000).unref();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = freePortPairSync(); // relay on port, metrics on port + 1
const mport = port + 1;
const home = mkdtempSync(join(tmpdir(), "ocr-relay-owners-"));
const relay: ChildProcess = spawn(process.execPath, ["--import", "tsx/esm", "apps/relay/src/index.ts"], {
  cwd: join(import.meta.dirname, ".."),
  env: {
    HOME: home,
    PATH: process.env.PATH ?? "",
    OCR_E2E_MARKER: "1",
    RELAY_PORT: String(port),
    RELAY_METRICS_PORT: String(mport),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
relay.stdout?.on("data", (c) => (out += String(c)));
relay.stderr?.on("data", (c) => (out += String(c)));
process.on("exit", () => {
  relay.kill("SIGKILL");
  rmSync(home, { recursive: true, force: true });
});

async function metrics(): Promise<Record<string, number>> {
  return (await (await fetch(`http://127.0.0.1:${mport}/metrics`)).json()) as Record<string, number>;
}
function open(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    ws.on("error", () => {});
  });
}
/** Counts only the frames carrying the phone's "hello" payload. */
function hellosTo(ws: WebSocket): () => number {
  let n = 0;
  ws.on("message", (data) => {
    if ((JSON.parse(data.toString()) as { payload?: string }).payload === "hello") n++;
  });
  return () => n;
}

let up = false;
for (let i = 0; i < 60 && !up; i++) {
  up = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
  if (!up) await sleep(200);
}
check("boot: the relay answers /healthz", up);

const room = "ownerstest0001";
const oldDaemon = await open();
oldDaemon.send(JSON.stringify({ room, from: room, payload: "" }));
const oldGot = hellosTo(oldDaemon);
await sleep(150);
let m = await metrics();
check("one owner socket is not a duplicate (both series publish zero)", m.rooms_duplicate_owner === 0 && m.duplicate_owner_total === 0, m);

const newDaemon = await open();
newDaemon.send(JSON.stringify({ room, from: room, payload: "" }));
const newGot = hellosTo(newDaemon);
await sleep(150);
const phone = await open();
phone.send(JSON.stringify({ room, from: "phone", payload: "hello" }));
await sleep(300);
check("the relay delivers the phone's hello to BOTH daemons (the fan-out behind the stale answer)", oldGot() === 1 && newGot() === 1, [oldGot(), newGot()]);
m = await metrics();
check("the pair is visible on /metrics: gauge 1, counter 1", m.rooms_duplicate_owner === 1 && m.duplicate_owner_total === 1, m);
const prom = await (await fetch(`http://127.0.0.1:${mport}/metrics?format=prom`)).text();
check(
  "the Prometheus text carries both series",
  /^relay_rooms_duplicate_owner 1$/m.test(prom) && /^relay_duplicate_owner_total 1$/m.test(prom),
);
const lines = out.split("\n").filter((l) => l.includes('"room has more than one owner socket"'));
check("exactly one warn line names the condition", lines.length === 1, lines.length);
check("the warn line carries at most an 8-character room prefix", lines.every((l) => !l.includes(room)));

newDaemon.send(JSON.stringify({ room, from: room, payload: "again" }));
await sleep(150);
check("further frames from the same owner socket are not counted again", (await metrics()).duplicate_owner_total === 1);
check("the signal never closes a socket (observation only)", oldDaemon.readyState === WebSocket.OPEN && newDaemon.readyState === WebSocket.OPEN);

oldDaemon.close();
await sleep(300);
m = await metrics();
check("once the stale daemon leaves, the gauge returns to 0 and the counter keeps history", m.rooms_duplicate_owner === 0 && m.duplicate_owner_total === 1, m);

newDaemon.terminate();
phone.terminate();
relay.kill("SIGTERM");
if (failures > 0) {
  console.error(`relay-owners: ${failures} failure(s)`);
  process.exit(1);
}
console.log("relay-owners: ALL OK");
process.exit(0);
