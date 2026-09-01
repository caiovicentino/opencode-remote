/**
 * P1-061: local direct-mode WS integration test.
 * Boots a REAL daemon on a loopback metrics port and proves:
 *   1. wrong token  → the /ws upgrade socket is destroyed (no 101 switch)
 *   2. correct token → full E2E hello→confirm handshake over the local WS
 *   3. one sealed op round-trips against the real daemon
 *   4. the ping control frame answers pong on a live session
 * Run: npx tsx scripts/localws.test.ts
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

setTimeout(() => {
  console.error("localws test timed out (global 30s)");
  process.exit(1);
}, 30_000).unref();

// ask the kernel for a free port (P2-055 lesson: never hardcode test ports)
const PORT = await new Promise<number>((resolve, reject) => {
  const srv = createServer();
  srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address() as AddressInfo;
    srv.close(() => resolve(port));
  });
  srv.on("error", reject);
});

const home = mkdtempSync(join(tmpdir(), "ocr-localws-"));
const stateFile = join(home, ".opencode-remote", "daemon.json");

const daemon = spawn(
  "npx",
  ["tsx", "apps/daemon/src/index.ts"],
  {
    cwd: join(import.meta.dirname, ".."),
    env: {
      ...process.env,
      HOME: home,
      OCR_METRICS_PORT: String(PORT),
      RELAY_URL: "ws://127.0.0.1:1", // dead: relay must be irrelevant in local mode
      OPENCODE_URL: "http://127.0.0.1:1",
      OCR_LOG_LEVEL: "error",
    },
    stdio: ["ignore", "ignore", "inherit"],
  },
);
process.on("exit", () => daemon.kill("SIGTERM"));

for (let i = 0; ; i++) {
  try {
    readFileSync(stateFile, "utf8");
    break;
  } catch {
    if (i > 50) throw new Error("daemon state file never appeared");
    await new Promise((r) => setTimeout(r, 200));
  }
}
await new Promise((r) => setTimeout(r, 1200)); // let the metrics server come up

// The apiToken is generated lazily; poke any Bearer-gated route to mint it.
await fetch(`http://127.0.0.1:${PORT}/api/health`, {
  headers: { authorization: "Bearer warmup" },
}).catch(() => {});
let token = "";
for (let i = 0; i < 25; i++) {
  try {
    token = ((JSON.parse(readFileSync(stateFile, "utf8")) as { apiToken?: string }).apiToken) ?? "";
  } catch {}
  if (token) break;
  await new Promise((r) => setTimeout(r, 200));
}
if (!token) throw new Error("apiToken never appeared in the state file");

function dial(url: string): WebSocket {
  const ws = new WebSocket(url);
  ws.on("error", () => {}); // handled per-await below
  return ws;
}

// --- 1. wrong token ⇒ socket destroyed, never opened ------------------------
{
  const bad = dial(`ws://127.0.0.1:${PORT}/ws?token=wrong`);
  const opened = await new Promise<boolean>((resolve) => {
    bad.on("open", () => resolve(true));
    bad.on("close", () => resolve(false));
    bad.on("error", () => resolve(false));
  });
  if (opened) throw new Error("upgrade with wrong token must be destroyed");
  console.log("wrong token rejected: OK");
}

// --- 2. correct token ⇒ E2E hello→confirm over the loopback WS --------------
const identity = await newIdentity(false);
const { hello, sessionKey } = await clientHello(
  (JSON.parse(readFileSync(stateFile, "utf8")) as { ecdhPub: string }).ecdhPub,
  identity,
);
const ws = dial(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
await new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("local ws never opened (3s)")), 3000);
  ws.on("open", () => {
    clearTimeout(t);
    resolve();
  });
});
ws.send(
  JSON.stringify({
    room: "localws",
    from: "localtest",
    payload: b64(new TextEncoder().encode(JSON.stringify({ type: "hello", hello }))),
  }),
);
{
  const frame = await new Promise<{ payload: string }>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no confirm after hello (5s)")), 5000);
    ws.once("message", (data: WebSocket.RawData) => {
      clearTimeout(t);
      resolve(JSON.parse(data.toString()));
    });
  });
  const check = await openSealed<{ ok: boolean }>(
    JSON.parse(atob(frame.payload)).confirm,
    sessionKey,
    new TextEncoder().encode("ocr-confirm"),
  );
  if (!check?.ok) throw new Error("handshake confirm failed on the local WS");
  console.log("local hello→confirm handshake: OK");
}

// --- 3. one sealed op round-trips against the real daemon -------------------
{
  const id = crypto.randomUUID();
  const payload = await seal(
    { type: "op", req: { id, method: "POST", path: "/__ocr/transcribe/chunk", body: { id: "t1", idx: 0, data: "" } } },
    sessionKey,
    seqAad("localtest", 1),
  );
  ws.send(JSON.stringify({ room: "localws", from: "localtest", seq: 1, payload }));
  const res = await new Promise<OpResponse>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no op response (8s)")), 8000);
    ws.on("message", async (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString());
      if (frame.from === "localtest") return; // our own echo-less socket: daemon frames only
      try {
        const env = await openSealed<{ type: string; res?: OpResponse }>(
          frame.payload,
          sessionKey,
          seqAad(frame.from, frame.seq ?? 0),
        );
        if (env?.type === "res" && env.res?.id === id) {
          ws.removeAllListeners("message");
          clearTimeout(t);
          resolve(env.res!);
        }
      } catch {
        // control frame mixed in — keep waiting
      }
    });
  });
  if (res.status !== 200) throw new Error(`sealed op failed: ${res.status}`);
  console.log("sealed op round-trip over local WS: OK");
}

// --- 4. ping → pong control frame on the live session -----------------------
{
  ws.send(
    JSON.stringify({
      room: "localws",
      from: "localtest",
      payload: b64(new TextEncoder().encode(JSON.stringify({ type: "ping" }))),
    }),
  );
  const pong = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no pong after ping (5s)")), 5000);
    ws.on("message", (data: WebSocket.RawData) => {
      try {
        const frame = JSON.parse(data.toString());
        const ctl = JSON.parse(atob(frame.payload)) as { type?: string };
        if (ctl.type === "pong") {
          ws.removeAllListeners("message");
          clearTimeout(t);
          resolve("pong");
        }
      } catch {
        // sealed frame — ignore
      }
    });
  });
  if (pong !== "pong") throw new Error("expected pong");
  console.log("ping→pong liveness on local WS: OK");
}

ws.close();
daemon.kill("SIGTERM");
console.log("LOCALWS TEST PASSED");
process.exit(0);
