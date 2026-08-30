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

const RELAY_PORT = 4561;
const MOCK_PORT = 4562;
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;
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
mock.listen(MOCK_PORT, "127.0.0.1");

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
bg(["tsx", "apps/relay/src/index.ts"], { RELAY_PORT: String(RELAY_PORT) });
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
for (let i = 0; i < 40; i++) {
  try {
    await new Promise<void>((res, rej) => {
      const w = new WebSocket(RELAY_URL);
      w.on("open", () => {
        w.close();
        res();
      });
      w.on("error", rej);
    });
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 250));
  }
}

// --- mini client ------------------------------------------------------------
const identity = await newIdentity(false);
const { hello, sessionKey } = await clientHello(state.ecdhPub, identity);
const myId = "chk" + Math.random().toString(36).slice(2, 8);
const ws = new WebSocket(RELAY_URL);
await new Promise<void>((r) => ws.on("open", r));
ws.send(
  JSON.stringify({
    room: state.room,
    from: myId,
    payload: Buffer.from(JSON.stringify({ type: "hello", hello })).toString("base64"),
  }),
);
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
for (let i = 0; i < 20 && !paired; i++) await new Promise((r) => setTimeout(r, 500));
if (!paired) {
  console.error("CHUNK TEST FAILED: no handshake");
  process.exit(1);
}
console.log("handshake: OK");

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
