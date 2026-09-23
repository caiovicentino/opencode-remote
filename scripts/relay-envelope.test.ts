/**
 * RT-455: envelope shape validation tests — pure verdict grammar plus the
 * wire path against a real relay subprocess. The attack class: `from`/`seq`
 * are unauthenticated, attacker-controlled metadata that used to pass
 * unvalidated into JSON.stringify (recursive); one deeply nested value threw
 * RangeError inside the message listener and killed the whole relay process.
 * These tests prove (a) every malformed shape is dropped by the verdict,
 * (b) a real relay survives the whole attack sequence with the process and
 * sockets intact, and (c) legitimate frames still route byte-identically.
 * Run: npx tsx scripts/relay-envelope.test.ts
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { get } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { envelopeVerdict, FROM_MAX } from "../apps/relay/src/envelope";
import { frameSeq } from "@ocr/protocol";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

setTimeout(() => {
  console.error("relay-envelope test timed out (global 90s)");
  process.exit(1);
}, 90_000).unref();

// deep attacker shape, built once: 400k nesting levels, exactly the size the
// red-team sketch fits inside the 1 MB frame cap (raw JSON form used on the
// wire below; this in-memory form proves the verdict itself never recurses)
function deep(levels: number): unknown {
  let d: unknown = 0;
  for (let i = 0; i < levels; i++) d = [d];
  return d;
}

// --- 1. pure verdict: every malformed shape is refused ------------------------
check("verdict: literal null frame is refused", envelopeVerdict(null).ok === false);
check("verdict: literal number frame is refused", envelopeVerdict(5).ok === false);
check("verdict: literal string frame is refused", envelopeVerdict("x").ok === false);
check("verdict: literal array frame is refused", envelopeVerdict([]).ok === false);
check("verdict: literal boolean frame is refused", envelopeVerdict(true).ok === false);
check("verdict: literal undefined frame is refused", envelopeVerdict(undefined).ok === false);

const base = { room: "abcdefgh", payload: "" };
check("verdict: minimal daemon-shaped frame passes", envelopeVerdict({ ...base }).ok === true);
check("verdict: missing room is refused", envelopeVerdict({ payload: "" }).ok === false);
check("verdict: numeric room is refused", envelopeVerdict({ room: 5, payload: "" }).ok === false);
check("verdict: missing payload is refused", envelopeVerdict({ room: "abcdefgh" }).ok === false);
check("verdict: numeric payload is refused", envelopeVerdict({ room: "abcdefgh", payload: 5 }).ok === false);

// the room GRAMMAR stays in isValidRoomId: the envelope gate is type-only
check("verdict: room grammar is NOT duplicated (short id passes type check)", envelopeVerdict({ room: "s", payload: "" }).ok === true);

for (const [label, from] of [
  ["object", {}],
  ["array", []],
  ["deep array", deep(400_000)],
  ["number", 1],
  ["boolean", true],
  ["129-char string", "x".repeat(FROM_MAX + 1)],
] as const) {
  check(`verdict: from ${label} is refused`, envelopeVerdict({ ...base, from }).ok === false);
}
check("verdict: from at the 128-char bound passes", envelopeVerdict({ ...base, from: "x".repeat(FROM_MAX) }).ok === true);
check("verdict: empty-string from passes", envelopeVerdict({ ...base, from: "" }).ok === true);
const nullFrom = envelopeVerdict({ ...base, from: null });
check("verdict: null from maps to undefined", nullFrom.ok === true && nullFrom.ok && nullFrom.frame.from === undefined);
check("verdict: absent from maps to undefined", envelopeVerdict({ ...base }).ok === true && envelopeVerdict({ ...base }).ok && envelopeVerdict({ ...base }).frame.from === undefined);
check("verdict: from is preserved verbatim", envelopeVerdict({ ...base, from: "b1" }).ok === true && envelopeVerdict({ ...base, from: "b1" }).ok && envelopeVerdict({ ...base, from: "b1" }).frame.from === "b1");

for (const [label, seq] of [
  ["fraction", 1.5],
  ["negative", -1],
  ["above safe range", 2 ** 53],
  ["numeric string", "3"],
  ["object", {}],
  ["array", []],
  ["deep array", deep(400_000)],
  ["boolean", true],
] as const) {
  check(`verdict: seq ${label} is refused`, envelopeVerdict({ ...base, seq }).ok === false);
}
check("verdict: seq 0 passes", envelopeVerdict({ ...base, seq: 0 }).ok === true && envelopeVerdict({ ...base, seq: 0 }).ok && envelopeVerdict({ ...base, seq: 0 }).frame.seq === 0);
check("verdict: seq 7 passes", envelopeVerdict({ ...base, seq: 7 }).ok === true);
check("verdict: seq at the 2**53-1 bound passes", envelopeVerdict({ ...base, seq: 2 ** 53 - 1 }).ok === true);
const noSeq = envelopeVerdict({ ...base });
check("verdict: seq undefined stays undefined (key omitted)", noSeq.ok === true && noSeq.ok && noSeq.frame.seq === undefined);
const nullSeq = envelopeVerdict({ ...base, seq: null });
check("verdict: seq null stays null (key preserved)", nullSeq.ok === true && nullSeq.ok && nullSeq.frame.seq === null);

// parity with the daemon's own frameSeq normalization (RT-424): the relay
// refuses exactly the seq values the replay guard would refuse
for (const x of [undefined, null, 0, 1, 1.5, -1, 2 ** 53, 2 ** 53 - 1, "1", {}, []]) {
  const verdict = envelopeVerdict({ room: "r", payload: "", seq: x });
  check(`parity: seq ${JSON.stringify(x) ?? "undefined"} verdict === frameSeq(x) !== null`, verdict.ok === (frameSeq(x) !== null));
}

// the module must stay pure: no imports at all (house pattern of roomid.ts)
check("purity: envelope.ts has no import lines", !/^import\s/m.test(readFileSync(join(import.meta.dirname, "../apps/relay/src/envelope.ts"), "utf8")));

// --- 2. integration helpers ---------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const port = await freePort();
  const proc = spawn("npx", ["tsx", "apps/relay/src/index.ts"], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, ...env, RELAY_PORT: String(port), OCR_E2E_MARKER: "1" },
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

const fetchHealth = (url: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    get(url, (res) => {
      let s = "";
      res.on("data", (c) => (s += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: s }));
    }).on("error", reject);
  });

// --- 3. the attack: one socket, six malformed frames, relay must survive ------
const room = randomUUID().replaceAll("-", "");
const relay = await startRelay({});
let exited = false;
relay.proc.on("exit", () => {
  exited = true;
});
await waitReady(relay.port);

const listener = await connect(relay.port, "listener", room);
const sender = await connect(relay.port, "sender", room);
await sleep(300);

const received: string[] = [];
listener.on("message", (data) => received.push(data.toString()));
const before = received.length;

// the attack sequence, raw wire bytes — each one used to be lethal pre-RT-455
sender.send("null"); // JSON.parse fine, frame.room threw TypeError
sender.send("[]"); // array envelope
const deepRaw = "[".repeat(400_000) + "]".repeat(400_000); // 800 KB, inside the 1 MB cap
sender.send(`{"room":"${room}","from":${deepRaw},"payload":""}`); // deep `from` → RangeError in stringify
sender.send(`{"room":"${room}","from":"sender","seq":${deepRaw},"payload":""}`); // deep `seq`
sender.send(`{"room":"${room}","from":"${"x".repeat(FROM_MAX + 1)}","payload":""}`); // oversized from
sender.send(`{"room":"${room}","from":"sender","seq":1.5,"payload":""}`); // fractional seq
await sleep(2000);

check("attack: relay process is still alive", relay.proc.exitCode === null && !exited);
check("attack: no frame routed during the sequence", received.length === before);
check("attack: sender socket stays OPEN", sender.readyState === WebSocket.OPEN);
check("attack: /healthz still answers 200", (await fetchHealth(`http://127.0.0.1:${relay.port}/healthz`)).status === 200);

// --- 4. legitimate traffic is byte-identical to the pre-fix format -------------
sender.send(`{"room":"${room}","from":"owner","seq":3,"payload":"hello"}`);
await sleep(400);
check("route: exactly one frame routed (the valid one)", received.length === before + 1);
check(
  "route: routed bytes are exactly the documented format",
  received[received.length - 1] === `{"room":"${room}","from":"owner","seq":3,"payload":"hello"}`,
);

sender.send(`{"room":"${room}","from":"owner","payload":"hello2"}`);
await sleep(400);
check(
  "route: absent seq stays omitted in the routed bytes",
  received[received.length - 1] === `{"room":"${room}","from":"owner","payload":"hello2"}`,
);

// null/absent from falls back to the socket id, as before RT-455
sender.send(`{"room":"${room}","payload":"hello3"}`);
await sleep(400);
check(
  "route: absent from falls back to the socket id",
  /^{"room":"[^"]+","from":"s[0-9a-z]+","payload":"hello3"}$/.test(received[received.length - 1]),
);

check("aftermath: relay process survived the whole session", relay.proc.exitCode === null && !exited);
check("aftermath: /healthz still 200 after legitimate traffic", (await fetchHealth(`http://127.0.0.1:${relay.port}/healthz`)).status === 200);

listener.close();
sender.close();
relay.proc.kill("SIGTERM");
if (failures) process.exit(1);
console.log("relay-envelope: ALL OK");
process.exit(0);
