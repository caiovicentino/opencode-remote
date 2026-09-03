/**
 * Regression test: oversized responses (e.g. session history with image
 * attachments) must travel split across several sealed frames and be
 * reassembled byte-exact by the client — never 413'd.
 * Run: npx tsx scripts/chunk.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { clientHello, openSealed, seal, seqAad, newIdentity, type OpResponse } from "@ocr/protocol";
import { bootOnEphemeralPort } from "./e2e-orphans";

const REPO = join(import.meta.dirname, "..");

setTimeout(() => {
  console.error("chunk test timed out (global 60s)");
  process.exit(1);
}, 60_000).unref();

// --- mock opencode: health + a 1.4MB message history ------------------------
const bigBody = JSON.stringify(
  Array.from({ length: 40 }, (_, i) => ({
    info: { role: i % 2 ? "assistant" : "user" },
    parts: [
      { type: "text", text: `row-${i} ${"x".repeat(30_000)}` },
      ...(i % 4 === 0
        ? [{ type: "file", mime: "image/jpeg", url: `data:image/jpeg;base64,${"Q".repeat(300_000)}` }]
        : []),
    ],
  })),
);
const routes: Record<string, [number, string]> = {
  "/global/health": [200, JSON.stringify({ healthy: true, version: "mock" })],
  "/session/ses_big/message": [200, bigBody],
};
const mock: Server = createServer((req, res) => {
  const hit = routes[req.url ?? ""];
  if (req.url === "/event") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    req.on("close", () => {});
    return;
  }
  if (hit) {
    res.writeHead(hit[0], { "content-type": "application/json" });
    res.end(hit[1]);
    return;
  }
  res.writeHead(404).end();
});
// P1-081: the kernel picks the port (fixed 4562 died to zombies from a
// previous run); bind-first kills the reserve→close→bind race for the mock.
const MOCK_PORT = await new Promise<number>((resolve, reject) => {
  mock.on("error", reject);
  mock.listen(0, "127.0.0.1", () => {
    resolve((mock.address() as { port: number }).port);
  });
});

// --- ephemeral relay + daemon -----------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "ocr-chunk-"));
const children: ChildProcess[] = [];
process.on("exit", () => {
  for (const c of children) c.kill();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});
function bg(args: string[], env: Record<string, string> = {}) {
  const p = spawn("npx", args, {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "inherit"],
  });
  children.push(p);
  return p;
}

// relay on a kernel-assigned port with the anti-thief boot guard (P1-081)
let relayBoot: { port: number; child: ChildProcess };
try {
  relayBoot = await bootOnEphemeralPort({
    label: "relay",
    spawn: (port) => bg(["tsx", "apps/relay/src/index.ts"], { RELAY_PORT: String(port), OCR_E2E_MARKER: tmp }),
    probe: (port) =>
      new Promise<boolean>((resolve) => {
        const w = new WebSocket(`ws://127.0.0.1:${port}`);
        w.on("open", () => {
          w.close();
          resolve(true);
        });
        w.on("error", () => resolve(false));
      }),
    timeoutMs: 20_000,
  });
} catch (err) {
  console.error("chunk test FAILED: relay never came up");
  console.error(String((err as Error)?.message ?? err));
  process.exit(1);
}
const RELAY_PORT = relayBoot.port;
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;
bg(["tsx", "apps/daemon/src/index.ts"], {
  HOME: tmp,
  RELAY_URL,
  OPENCODE_URL: `http://127.0.0.1:${MOCK_PORT}`,
  OCR_LOG_LEVEL: "error",
});

const stateFile = join(tmp, ".opencode-remote", "daemon.json");
function exists(f: string) {
  try {
    readFileSync(f);
    return true;
  } catch {
    return false;
  }
}
for (let i = 0; i < 60 && !exists(stateFile); i++) await new Promise((r) => setTimeout(r, 250));
const state = JSON.parse(readFileSync(stateFile, "utf8")) as { room: string; ecdhPub: string };
// (the relay itself is already proven up by bootOnEphemeralPort's probe)

// --- mini client ------------------------------------------------------------
const identity = await newIdentity(false);
const { hello, sessionKey } = await clientHello(state.ecdhPub, identity);
const myId = "chk" + Math.random().toString(36).slice(2, 8);
const ws = new WebSocket(RELAY_URL);
await new Promise<void>((r) => ws.on("open", r));
let paired = false;
const pending = new Map<string, (r: OpResponse) => void>();
const chunkBuf = new Map<string, { status: number; parts: string[]; got: number; of: number }>();
ws.on("message", (data) => {
  const fr = JSON.parse(data.toString());
  if (fr.from === myId) return;
  try {
    const ctl = JSON.parse(Buffer.from(fr.payload, "base64").toString());
    if (ctl.ok && ctl.confirm) paired = true;
    return;
  } catch {}
  void (async () => {
    const env = await openSealed<{
      type: string;
      res?: OpResponse;
      chunk?: { id: string; status: number; i: number; of: number; part: string };
    }>(fr.payload, sessionKey, seqAad(fr.from, fr.seq ?? 0));
    if (!env) return;
    if (env.type === "res") pending.get(env.res!.id)?.(env.res!);
    else if (env.type === "res-chunk") {
      const c = env.chunk!;
      let e = chunkBuf.get(c.id);
      if (!e) {
        e = { status: c.status, parts: [], got: 0, of: c.of };
        chunkBuf.set(c.id, e);
      }
      if (e.parts[c.i] === undefined) e.got++;
      e.parts[c.i] = c.part;
      if (e.got < e.of) return;
      chunkBuf.delete(c.id);
      pending
        .get(c.id)
        ?.({ id: c.id, status: e.status, body: JSON.parse(e.parts.join("")) } as OpResponse);
    }
  })();
});
// P1-081: the relay is a blind router — a single hello sent before the daemon
// joins the room is dropped forever (the daemon publishes its state file a
// beat before connectRelay() runs). Retry until the confirm lands.
const helloFrame = JSON.stringify({
  room: state.room,
  from: myId,
  payload: Buffer.from(JSON.stringify({ type: "hello", hello })).toString("base64"),
});
for (let i = 0; i < 20 && !paired; i++) {
  ws.send(helloFrame);
  await new Promise((r) => setTimeout(r, 500));
}
if (!paired) {
  console.error("CHUNK TEST FAILED: no handshake");
  process.exit(1);
}

let seq = 0;
function op(method: string, path: string): Promise<OpResponse> {
  const req = { id: crypto.randomUUID(), method, path };
  return new Promise((resolve, reject) => {
    pending.set(req.id, resolve);
    const s = ++seq;
    void seal({ type: "op", req }, sessionKey, seqAad(myId, s)).then((payload) =>
      ws.send(JSON.stringify({ room: state.room, from: myId, seq: s, payload })),
    );
    setTimeout(() => reject(new Error("timeout")), 40_000);
  });
}

const health = await op("GET", "/global/health");
if (health.status !== 200) throw new Error(`small op failed: ${health.status}`);
console.log("small op: OK");

const big = await op("GET", "/session/ses_big/message");
const ok = big.status === 200 && JSON.stringify(big.body) === bigBody;
console.log(
  `big history: status=${big.status} bytes=${JSON.stringify(big.body ?? null).length} byte-exact=${ok}`,
);
console.log(ok ? "CHUNK TEST PASSED" : "CHUNK TEST FAILED");
ws.close();
mock.close();
process.exit(ok ? 0 : 1);
