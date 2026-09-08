/**
 * Regression test: the daemon restarts while a client stays connected.
 * The client's next sealed frame must trigger a `reconnect` control frame
 * from the daemon, after which a fresh handshake re-pairs the session.
 * Run: npx tsx scripts/reconnect.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { stopAndAwaitExit } from "./procexit";
import {
  b64,
  clientHello,
  newIdentity,
  openSealed,
  seal,
  seqAad,
  type OpResponse,
} from "@ocr/protocol";

// P2-055 (reviewer finding): the hardcoded port collided with whatever process
// happened to be listening on it — the probe then read a plain HTTP 200 from a
// stranger ("Unexpected server response: 200") instead of ECONNREFUSED, and the
// test reported "relay never came up". Ask the kernel for a free port instead.
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
  console.error("reconnect test timed out (global 90s)");
  process.exit(1);
}, 90_000).unref();

const home = mkdtempSync(join(tmpdir(), "ocr-reconnect-"));
const stateFile = join(home, ".opencode-remote", "daemon.json");

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
        OCR_LOG_LEVEL: "error",
        OPENCODE_URL: "http://127.0.0.1:1",
      },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
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
  stdio: ["ignore", "inherit", "inherit"],
});
relay.on("error", (e) => console.error("relay spawn error:", e));
relay.on("exit", (c) => console.error("relay exited with", c));
process.on("exit", () => {
  relay.kill("SIGTERM");
  daemon.kill("SIGTERM");
});

let daemon = startDaemon();
const state = await waitForState();
await new Promise((r) => setTimeout(r, 1500));

// --- client session (mini OcrClient) ---------------------------------------
const identity = await newIdentity(false);
let key: CryptoKey;
let daemonLastSeq = 0;
let sendSeq = 0;

async function handshake() {
  const { hello, sessionKey } = await clientHello(state.ecdhPub, identity);
  key = sessionKey;
  daemonLastSeq = 0;
  ws.send(
    JSON.stringify({
      room: state.room,
      from: "testclient",
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
      // the daemon announces itself with an empty-payload frame from the room
      // on every relay connect — it can land between hello and the confirm
      // when the daemon dials while the handshake is in flight
      if (frame.from === state.room && frame.payload === "") return;
      if (frame.from === "testclient") return;
      clearTimeout(t);
      ws.off("message", onMsg);
      resolve(frame.payload!);
    };
    ws.on("message", onMsg);
  });
  const check = await openSealed<{ ok: boolean }>(
    JSON.parse(atob(confirm)).confirm,
    key,
    new TextEncoder().encode("ocr-confirm"),
  );
  if (!check?.ok) throw new Error("handshake confirm failed");
}

function request(method: string, path: string, body?: unknown): Promise<OpResponse> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.off("message", onMsg);
      reject(new Error("request timeout"));
    }, 8000);
    const onMsg = async (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString());
      if (frame.from === "testclient") return;
      let payload: { type?: string } | null = null;
      try {
        payload = JSON.parse(atob(frame.payload));
      } catch {
        // sealed binary payload; not a control frame
      }
      if (payload?.type === "reconnect") {
        ws.off("message", onMsg);
        await handshake();
        return resolve(request(method, path, body));
      }
      const env = await openSealed<{ type: string; res?: OpResponse }>(
        frame.payload,
        key,
        seqAad(frame.from, frame.seq ?? 0),
      );
      if (!env || env.type !== "res" || env.res?.id !== id) return;
      daemonLastSeq = frame.seq ?? daemonLastSeq;
      ws.off("message", onMsg);
      clearTimeout(t);
      resolve(env.res!);
    };
    ws.on("message", onMsg);
    const seq = ++sendSeq;
    void seal({ type: "op", req: { id, method, path, body } }, key, seqAad("testclient", seq)).then(
      (payload) => ws.send(JSON.stringify({ room: state.room, from: "testclient", seq, payload })),
    );
  });
}

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

const ws = new WebSocket(RELAY_URL);
await new Promise<void>((resolve, reject) => {
  ws.on("open", () => resolve());
  ws.on("error", (e) => reject(e));
});
ws.on("error", () => {}); // post-open errors are handled per-request
await handshake();
console.log("handshake: OK");

let res = await request("POST", "/__ocr/transcribe/chunk", { id: "t1", idx: 0, data: "" });
if (res.status !== 200) throw new Error(`pre-restart op failed: ${res.status}`);
console.log("op before restart: OK");

// --- restart the daemon under the client's feet ----------------------------
// The restarted daemon announces itself with an empty-payload frame from the
// room the moment its relay socket opens (apps/daemon index.ts sends it on
// every connect). Waiting for that announce instead of a fixed sleep removes
// the cold-start race where the op is dialed into an empty room — a blind
// relay drops the frame and the 8s request timeout kills the run.
const daemonAnnounce = new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no daemon announce after restart (15s)")), 15_000);
  const onMsg = (data: WebSocket.RawData) => {
    let frame: { from?: string; payload?: string };
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return; // non-JSON frame: not a relay envelope, never the announce
    }
    if (frame.from !== state.room || frame.payload !== "") return;
    clearTimeout(t);
    ws.off("message", onMsg);
    resolve();
  };
  ws.on("message", onMsg);
});
// P3-345: wait for the OLD daemon's real exit before spawning the new one.
// The fixed 1s sleep raced the daemon's ≤3s graceful drain
// (apps/daemon/src/shutdown.ts DRAIN_MS): two daemons in one relay room,
// frames round-robined between them — the upload landed on the new one, the
// message post on the zombie, which answered 410 "attachment expired"
// (CI run 34281044412). SIGKILL after 10s keeps a wedged process from
// hanging the gate; the retry loop below stays for the cold-start gap only.
const stopped = await stopAndAwaitExit(daemon, { graceMs: 10_000 });
if (stopped.forced) console.error("old daemon ignored SIGTERM for 10s — SIGKILLed before restart");
daemon = startDaemon();
await daemonAnnounce;

res = await (async () => {
  // P3-337 gate round 3: under heavy machine load the restarted daemon's room
  // re-join can lag its socket opening, and the relay — a blind router — drops
  // an op addressed to a room the daemon has not rejoined yet. Retry the op a
  // bounded number of times (fresh frame id per attempt) instead of failing
  // the whole gate step on one dropped frame.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await request("POST", "/__ocr/transcribe/chunk", { id: "t2", idx: 0, data: "" });
    } catch (e) {
      if ((e as Error).message !== "request timeout") throw e;
      lastErr = e;
      console.error(`op retry ${attempt + 1}/2: daemon had not rejoined the room yet`);
    }
  }
  throw lastErr;
})();
if (res.status !== 200) throw new Error(`post-restart op failed: ${res.status}`);
console.log("op after daemon restart (auto re-handshake): OK");

// --- image upload + data URL substitution ----------------------------------
res = await request("POST", "/__ocr/upload/chunk", {
  id: "u1",
  idx: 0,
  data: Buffer.from("hello-image").toString("base64"),
});
if (res.status !== 200) throw new Error(`upload chunk failed: ${res.status}`);
res = await request("POST", "/__ocr/upload/complete", {
  id: "u1",
  mime: "image/jpeg",
  filename: "t.jpg",
});
if (res.status !== 200) throw new Error(`upload complete failed: ${res.status}`);
if ((res.body as { url?: string }).url !== "ocr-upload://u1") {
  throw new Error(`unexpected upload url: ${JSON.stringify(res.body)}`);
}
res = await request("POST", "/session/ses_x/message", {
  parts: [{ type: "file", url: "ocr-upload://u1", mime: "image/jpeg", filename: "t.jpg" }],
});
// daemon reaches opencode (down => 502) only if substitution succeeded
if (res.status !== 502) throw new Error(`expected 502 (opencode down), got ${res.status}`);
console.log("image attachment substitution: OK");
res = await request("POST", "/session/ses_x/message", {
  parts: [{ type: "file", url: "ocr-upload://gone", mime: "image/jpeg", filename: "t.jpg" }],
});
if (res.status !== 410) throw new Error(`expected 410 for expired upload, got ${res.status}`);
console.log("expired attachment rejection: OK");

// --- file-kind upload (e.g. video) persisted for agent tools ---------------
res = await request("POST", "/__ocr/upload/chunk", {
  id: "f1",
  idx: 0,
  data: Buffer.from("fake-video-bytes").toString("base64"),
});
if (res.status !== 200) throw new Error(`file chunk failed: ${res.status}`);
res = await request("POST", "/__ocr/upload/complete", {
  id: "f1",
  mime: "video/mp4",
  filename: "v.mp4",
  kind: "file",
});
if (res.status !== 200) throw new Error(`file complete failed: ${res.status}`);
const filePath = (res.body as { path?: string }).path;
if (!filePath || !existsSync(filePath)) throw new Error(`file not persisted: ${filePath}`);
if (readFileSync(filePath, "utf8") !== "fake-video-bytes") {
  throw new Error("persisted file content mismatch");
}
console.log("file-kind persistence for agent tools: OK");

ws.close();
relay.kill("SIGTERM");
daemon.kill("SIGTERM");
console.log("RECONNECT TEST PASSED");
process.exit(0);
