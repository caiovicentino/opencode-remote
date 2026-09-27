/**
 * RT-390 follow-up (eval 14): a recorded hello re-sent with its nonce
 * RE-SPELLED must be worthless against the REAL daemon.
 *
 * The daemon's nonce dedupe (apps/daemon/src/helloguard.ts) keys on the raw
 * nonce string, while the handshake used to decode it with the tolerant
 * `fromB64` — so "…==" → "…", an inserted newline, a trailing space or a
 * different last character all derived the SAME session key under a string
 * the dedupe had never seen. Attack, no key material needed (any room member
 * or a hostile relay sees the clear hello and the sealed frames):
 *   1. record the victim's hello and one sealed op frame;
 *   2. re-send the hello with the nonce re-spelled and the victim's `from` —
 *      the daemon answered with a confirm and REPLACED the victim's session
 *      (same key, lastSeq = 0, replies now routed to the attacker's socket);
 *   3. re-send the recorded op frame — re-executed (a second response).
 * After the fix (packages/protocol helloNonce, enforced in serverAccept) every
 * re-spelled hello is refused before key derivation, the recorded op frame is
 * dropped by the intact replay guard, and the victim keeps its session.
 *
 * Hermetic: temp HOME, kernel-assigned loopback port, dead relay and opencode
 * URLs (the loopback WS runs the exact handleMessage the relay path runs).
 * Run: npx tsx scripts/hello-replay.test.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { b64, clientHello, newIdentity, openSealed, seal, seqAad, type DaemonHello, type OpResponse } from "@ocr/protocol";

setTimeout(() => {
  console.error("hello-replay test timed out (global 60s)");
  process.exit(1);
}, 60_000).unref();

const PORT = await new Promise<number>((resolve, reject) => {
  const srv = createServer();
  srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address() as AddressInfo;
    srv.close(() => resolve(port));
  });
  srv.on("error", reject);
});

const home = mkdtempSync(join(tmpdir(), "ocr-hello-replay-"));
const stateFile = join(home, ".opencode-remote", "daemon.json");

// Direct child in its own process group (reconnect.test.ts P2-347 lesson): the
// exit hook below signals exactly the tree this test spawned — nothing else.
const daemon = spawn(process.execPath, ["--import", "tsx/esm", "apps/daemon/src/index.ts"], {
  cwd: join(import.meta.dirname, ".."),
  env: {
    ...process.env,
    HOME: home,
    OCR_METRICS_PORT: String(PORT),
    RELAY_URL: "ws://127.0.0.1:1",
    OPENCODE_URL: "http://127.0.0.1:1",
    OCR_LOG_LEVEL: "error",
    OCR_DISK_OK: "1",
  },
  stdio: ["ignore", "ignore", "inherit"],
  detached: true,
});
process.on("exit", () => {
  if (!daemon.pid) return;
  try {
    process.kill(-daemon.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
});

for (let i = 0; ; i++) {
  try {
    readFileSync(stateFile, "utf8");
    break;
  } catch {
    if (i > 75) throw new Error("daemon state file never appeared");
    await new Promise((r) => setTimeout(r, 200));
  }
}
let token = "";
for (let i = 0; i < 50 && !token; i++) {
  // the apiToken is minted lazily by the first Bearer-gated request
  await fetch(`http://127.0.0.1:${PORT}/api/health`, { headers: { authorization: "Bearer warmup" } }).catch(() => {});
  try {
    token = (JSON.parse(readFileSync(stateFile, "utf8")) as { apiToken?: string }).apiToken ?? "";
  } catch {
    /* not yet */
  }
  if (!token) await new Promise((r) => setTimeout(r, 200));
}
if (!token) throw new Error("apiToken never appeared in the state file");
const daemonPub = (JSON.parse(readFileSync(stateFile, "utf8")) as { ecdhPub: string }).ecdhPub;

async function dial(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
  ws.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("local ws never opened (3s)")), 3000);
    ws.once("open", () => {
      clearTimeout(t);
      resolve();
    });
  });
  return ws;
}

const VICTIM = "victim01";
const helloFrame = (hello: DaemonHello) =>
  JSON.stringify({
    room: "hello-replay",
    from: VICTIM,
    payload: b64(new TextEncoder().encode(JSON.stringify({ type: "hello", hello }))),
  });

/** Count, over `ms`, the clear handshake answers carrying a `confirm`. */
function countConfirms(ws: WebSocket, ms: number): Promise<number> {
  return new Promise((resolve) => {
    let n = 0;
    const onMsg = (data: WebSocket.RawData) => {
      try {
        const frame = JSON.parse(data.toString()) as { payload?: string };
        const clear = JSON.parse(atob(frame.payload ?? "")) as { confirm?: unknown };
        if (typeof clear.confirm === "string") n++;
      } catch {
        /* sealed or empty frame — not a confirm */
      }
    };
    ws.on("message", onMsg);
    setTimeout(() => {
      ws.off("message", onMsg);
      resolve(n);
    }, ms);
  });
}

/** Collect, over `ms`, the sealed responses for op `id` on the given sockets. */
function collectResponses(sockets: WebSocket[], key: CryptoKey, id: string, ms: number): Promise<OpResponse[]> {
  return new Promise((resolve) => {
    const got: OpResponse[] = [];
    const onMsg = async (data: WebSocket.RawData) => {
      try {
        const frame = JSON.parse(data.toString()) as { from?: string; seq?: number; payload?: string };
        const env = await openSealed<{ type?: string; res?: OpResponse }>(
          frame.payload ?? "",
          key,
          seqAad(frame.from ?? "", frame.seq ?? 0),
        );
        if (env?.type === "res" && env.res?.id === id) got.push(env.res);
      } catch {
        /* control frame — ignore */
      }
    };
    for (const s of sockets) s.on("message", onMsg);
    setTimeout(() => {
      for (const s of sockets) s.off("message", onMsg);
      resolve(got);
    }, ms);
  });
}

async function sealedOp(key: CryptoKey, seq: number, uploadId: string) {
  const id = crypto.randomUUID();
  const payload = await seal(
    { type: "op", req: { id, method: "POST", path: "/__ocr/transcribe/chunk", body: { id: uploadId, idx: 0, data: "" } } },
    key,
    seqAad(VICTIM, seq),
  );
  return { id, frame: JSON.stringify({ room: "hello-replay", from: VICTIM, seq, payload }) };
}

// --- 1. the victim pairs and runs one op (the material an attacker records) --
const identity = await newIdentity(false);
const { hello, sessionKey } = await clientHello(daemonPub, identity);
const victim = await dial();
{
  const confirmed = countConfirms(victim, 2500);
  victim.send(helloFrame(hello));
  if ((await confirmed) !== 1) throw new Error("victim handshake: no confirm");
}
const recorded = await sealedOp(sessionKey, 1, "hr-1");
{
  const answers = collectResponses([victim], sessionKey, recorded.id, 2500);
  victim.send(recorded.frame);
  const res = await answers;
  if (res.length !== 1 || res[0]!.status !== 200) throw new Error(`victim op failed: ${JSON.stringify(res)}`);
}
console.log("victim paired and ran one op: OK");

// --- 2. re-spelled replays of the recorded hello, from another socket --------
const attacker = await dial();
const n = hello.nonce;
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const lastIdx = B64.indexOf(n[21]!);
const variants: [string, string][] = [
  ["padding stripped", n.replace(/=+$/, "")],
  ["newline inside", `${n.slice(0, 8)}\n${n.slice(8)}`],
  ["trailing space", `${n} `],
  ["non-canonical trailing bits", `${n.slice(0, 21)}${B64[(lastIdx & 0b110000) | 1]}==`],
];
let accepted = 0;
for (const [label, nonce] of variants) {
  const confirms = countConfirms(attacker, 1200);
  attacker.send(helloFrame({ ...hello, nonce }));
  const c = await confirms;
  if (c > 0) {
    accepted++;
    console.error(`re-spelled hello (${label}) was ACCEPTED`);
  }
}
if (accepted > 0) throw new Error(`${accepted}/${variants.length} re-spelled replays accepted (RT-390 dedupe bypass)`);
console.log(`re-spelled hello replays refused (${variants.length} spellings): OK`);

// --- 3. the recorded op frame stays dead ---------------------------------------
{
  const answers = collectResponses([victim, attacker], sessionKey, recorded.id, 2000);
  attacker.send(recorded.frame);
  const res = await answers;
  if (res.length !== 0) throw new Error(`recorded op frame re-executed (${res.length} response(s))`);
}
console.log("recorded op frame not re-executed: OK");

// --- 4. the victim's session is intact (not hijacked onto the attacker socket)
{
  const fresh = await sealedOp(sessionKey, 2, "hr-2");
  const answers = collectResponses([victim], sessionKey, fresh.id, 3000);
  victim.send(fresh.frame);
  const res = await answers;
  if (res.length !== 1 || res[0]!.status !== 200) throw new Error(`victim session broken after replays: ${JSON.stringify(res)}`);
}
console.log("victim session intact after replays: OK");

if (daemon.exitCode !== null || daemon.signalCode !== null) throw new Error("daemon died during the test");
victim.close();
attacker.close();
console.log("\nall hello-replay checks passed");
process.exit(0);
