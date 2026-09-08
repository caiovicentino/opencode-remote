/**
 * Regression test (P3-344): a REJECTED client (unknown pub / revoked identity)
 * must not take the shared relay socket down. A zombie reconnecting every few
 * seconds used to close the only daemon↔relay websocket, dropping every
 * paired client with it ("relay connection lost" loop).
 *
 * Run: npx tsx scripts/reject-isolation.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import {
  b64,
  clientHello,
  newIdentity,
  openSealed,
  seal,
  seqAad,
  type OpResponse,
} from "@ocr/protocol";

const RELAY_PORT = await new Promise<number>((resolve, reject) => {
  const srv = createServer();
  srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address() as AddressInfo;
    srv.close(() => resolve(port));
  });
  srv.on("error", reject);
});
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;

setTimeout(() => {
  console.error("reject-isolation test timed out (global 90s)");
  process.exit(1);
}, 90_000).unref();

const home = mkdtempSync(join(tmpdir(), "ocr-rejectiso-"));
const stateFile = join(home, ".opencode-remote", "daemon.json");

// P3-344: the daemon's output is captured (both pipes — warn logs go to stdout
// per log.ts) so the assertions can prove no relay drop ever happened.
let daemonOutput = "";
let daemonOutputMark = 0; // byte offset right after client A paired

function startDaemon(): ChildProcess {
  const p = spawn(
    "npx",
    ["tsx", "apps/daemon/src/index.ts"],
    {
      cwd: join(import.meta.dirname, ".."),
      env: {
        ...process.env,
        HOME: home,
        RELAY_URL,
        OCR_LOG_LEVEL: "warn",
        OPENCODE_URL: "http://127.0.0.1:1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  p.stdout.on("data", (d) => (daemonOutput += d.toString()));
  p.stderr.on("data", (d) => (daemonOutput += d.toString()));
  return p;
}

async function waitForState(): Promise<{ room: string; ecdhPub: string }> {
  for (let i = 0; i < 50; i++) {
    try {
      return JSON.parse(readFileSync(stateFile, "utf8"));
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("daemon state file never appeared");
}

const relay = spawn("npx", ["tsx", "apps/relay/src/index.ts"], {
  cwd: join(import.meta.dirname, ".."),
  env: { ...process.env, RELAY_PORT: String(RELAY_PORT) },
  stdio: ["ignore", "ignore", "ignore"],
});
relay.on("error", (e) => console.error("relay spawn error:", e));
process.on("exit", () => {
  relay.kill("SIGTERM");
  daemon.kill("SIGTERM");
});

const daemon = startDaemon();
const state = await waitForState();
await new Promise((r) => setTimeout(r, 1500));

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
  } catch (e) {
    if (attempt > 20) throw new Error("relay never came up");
    if (attempt % 5 === 0) console.error(`probe ${attempt}:`, (e as Error).message);
    await new Promise((r) => setTimeout(r, 500));
  }
}

// --- client A (legitimate, pairs via the bootstrap window) ------------------

const identity = await newIdentity(false);
let key: CryptoKey;
let sendSeq = 0;

function openSocket(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_URL);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

async function handshakeA(ws: WebSocket) {
  const { hello, sessionKey } = await clientHello(state.ecdhPub, identity);
  key = sessionKey;
  ws.send(
    JSON.stringify({
      room: state.room,
      from: "clientA",
      payload: b64(new TextEncoder().encode(JSON.stringify({ type: "hello", hello }))),
    }),
  );
  const confirm = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no confirm after hello (5s)")), 5000);
    const onMsg = (data: WebSocket.RawData) => {
      let frame: { from?: string; payload?: string };
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (frame.from === "clientA") return;
      if (frame.from === state.room && frame.payload === "") return; // announce
      let parsed: { confirm?: unknown };
      try {
        parsed = JSON.parse(atob(frame.payload!));
      } catch {
        return; // sealed frames from other room members — not the confirm
      }
      if (typeof parsed.confirm !== "string") return;
      clearTimeout(t);
      ws.off("message", onMsg);
      resolve(parsed.confirm);
    };
    ws.on("message", onMsg);
  });
  const check = await openSealed<{ ok: boolean }>(
    confirm,
    key,
    new TextEncoder().encode("ocr-confirm"),
  );
  if (!check?.ok) throw new Error("handshake confirm failed");
}

const wsA = await openSocket();
wsA.on("error", () => {});
await handshakeA(wsA);
console.log("client A handshake: OK");

// one op with A before the zombie shows up — also proves the relay path works
async function requestA(method: string, path: string, body?: unknown): Promise<OpResponse> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      wsA.off("message", onMsg);
      reject(new Error("request timeout"));
    }, 8000);
    const onMsg = async (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString());
      if (frame.from === "clientA") return;
      if (frame.from === state.room && frame.payload === "") return;
      try {
        const env = await openSealed<{ type: string; res?: OpResponse }>(
          frame.payload,
          key,
          seqAad(frame.from, frame.seq ?? 0),
        );
        if (!env || env.type !== "res" || env.res?.id !== id) return;
        clearTimeout(t);
        wsA.off("message", onMsg);
        resolve(env.res!);
      } catch {
        // sealed frame for the zombie or foreign payload — ignore
      }
    };
    wsA.on("message", onMsg);
    const seq = ++sendSeq;
    void seal({ type: "op", req: { id, method, path, body } }, key, seqAad("clientA", seq)).then(
      (payload) => wsA.send(JSON.stringify({ room: state.room, from: "clientA", seq, payload })),
    );
  });
}

// P3-337: every retried attempt gets a fresh frame id (requestA builds one).
async function withRetry(label: string, op: () => Promise<OpResponse>): Promise<OpResponse> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await op();
    } catch (e) {
      if ((e as Error).message !== "request timeout") throw e;
      lastErr = e;
      console.error(`${label}: retry ${attempt + 1}/2 (frame dropped)`);
    }
  }
  throw lastErr;
}

let res = await withRetry("op before zombie", () =>
  requestA("POST", "/__ocr/transcribe/chunk", { id: "t1", idx: 0, data: "" }),
);
if (res.status !== 200) throw new Error(`pre-zombie op failed: ${res.status}`);
console.log("client A op: OK");

daemonOutputMark = daemonOutput.length; // everything after this is the judge

// --- client B (the zombie: fresh identity, NOT in the allowlist) -------------

const wsZ = await openSocket();
wsZ.on("error", () => {});

// ONE revoked identity reconnecting 3 times — the real zombie tab pattern.
const zombieIdentity = await newIdentity(false);

async function zombieHello(): Promise<void> {
  const { hello } = await clientHello(state.ecdhPub, zombieIdentity);
  wsZ.send(
    JSON.stringify({
      room: state.room,
      from: "zombie",
      payload: b64(new TextEncoder().encode(JSON.stringify({ type: "hello", hello }))),
    }),
  );
  // the daemon must answer with the sealed reject feedback…
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no reject frame for the zombie (5s)")), 5000);
    const onMsg = (data: WebSocket.RawData) => {
      let frame: { from?: string; payload?: string };
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (frame.from === "zombie") return;
      if (frame.from === state.room && frame.payload === "") return;
      let parsed: { ok?: unknown; reject?: unknown };
      try {
        parsed = JSON.parse(atob(frame.payload!));
      } catch {
        return; // sealed traffic belonging to client A
      }
      if (parsed.ok !== false || typeof parsed.reject !== "string") return;
      clearTimeout(t);
      wsZ.off("message", onMsg);
      resolve();
    };
    wsZ.on("message", onMsg);
  });
  // …and — the fix — the shared relay socket must stay up: no close arrives.
}

for (let i = 0; i < 3; i++) {
  await zombieHello();
  console.log(`zombie hello ${i + 1}: rejected (relay socket stayed up)`);
  await new Promise((r) => setTimeout(r, 200));
}

// --- client A keeps working while the zombie cycles -------------------------

for (let i = 0; i < 3; i++) {
  res = await withRetry(`paired op ${i + 1}`, () =>
    requestA("POST", "/__ocr/transcribe/chunk", { id: `t-z${i}`, idx: 0, data: "" }),
  );
  if (res.status !== 200) throw new Error(`paired op ${i + 1} failed: ${res.status}`);
  console.log(`paired op ${i + 1} after rejects: OK`);
}

// settle: a buggy close would surface as "relay connection lost" + re-dial
await new Promise((r) => setTimeout(r, 1500));

const tail = daemonOutput.slice(daemonOutputMark);
if (tail.includes("relay connection lost")) {
  throw new Error("daemon dropped the relay socket after rejecting the zombie");
}
if (tail.includes("connected to relay")) {
  throw new Error("daemon re-dialed the relay after rejecting the zombie");
}
const rejectLines = tail.split("\n").filter((l) => l.includes("client rejected"));
if (rejectLines.length > 1) {
  throw new Error(`unthrottled reject log: ${rejectLines.length} lines for 3 hellos`);
}
if (rejectLines.length === 1 && !/"fp":"[0-9a-f]{16}"/.test(rejectLines[0])) {
  throw new Error("reject log line lacks the 16-hex fingerprint");
}

wsA.close();
wsZ.close();
relay.kill("SIGTERM");
daemon.kill("SIGTERM");
console.log("REJECT-ISOLATION TEST PASSED");
process.exit(0);
