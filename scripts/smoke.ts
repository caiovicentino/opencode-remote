/**
 * Smoke test v2: simulates the PWA against a running relay+daemon.
 * Also proves the two v2 security properties:
 *   1. client identity key is non-extractable
 *   2. replayed frames are rejected by the daemon
 * Run: npx tsx scripts/smoke.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import WebSocket from "ws";
import {
  clientHello,
  openSealed,
  seal,
  seqAad,
  newIdentity,
  type OpResponse,
} from "@ocr/protocol";

const identityFile = JSON.parse(
  readFileSync(join(homedir(), ".opencode-remote", "daemon.json"), "utf8"),
) as { room: string; ecdhPub?: string; publicKey?: string };
const daemonPub = identityFile.ecdhPub ?? identityFile.publicKey!;
const RELAY = process.env.RELAY_URL ?? "ws://127.0.0.1:8787";

// global guard: never hang forever
setTimeout(() => {
  console.error("SMOKE TEST TIMED OUT (global 20s)");
  process.exit(1);
}, 20_000).unref();

// --- 1. non-extractability proof -------------------------------------------
const identity = await newIdentity(false);
try {
  await crypto.subtle.exportKey("pkcs8", identity.privateKey);
  console.error("FAIL: private key was exportable");
  process.exit(1);
} catch {
  console.log("Non-extractable identity key: OK");
}

// --- 2. connect, handshake, pair --------------------------------------------
const ws = new WebSocket(RELAY);
await new Promise<void>((resolve, reject) => {
  ws.on("open", resolve);
  ws.on("error", () => reject(new Error("relay connection failed")));
});

const { hello, sessionKey } = await clientHello(daemonPub, identity);
const myId = Math.random().toString(36).slice(2, 10);

const pending = new Map<string, (r: OpResponse) => void>();
const answeredIds = new Set<string>();
let sendSeq = 0;
const oldFrames: string[] = [];

ws.on("message", (data) => {
  const frame = JSON.parse(data.toString()) as { from?: string; seq?: number; payload?: string };
  if (!frame.from || frame.from === myId || !frame.payload) return;

  void (async () => {
    const env = await openSealed<{ type: "res"; res: OpResponse }>(
      frame.payload,
      sessionKey,
      seqAad(frame.from!, frame.seq ?? 0),
    );
    if (env?.type === "res") {
      const r = pending.get(env.res.id);
      pending.delete(env.res.id);
      answeredIds.add(env.res.id);
      r?.(env.res);
    }
  })();
});

// send hello (clear-JSON control frame) and wait for the sealed confirmation
const paired = new Promise<boolean>((resolve) => {
  ws.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as { from?: string; payload?: string };
    if (!frame.from || frame.from === myId) return;
    try {
      const confirm = JSON.parse(Buffer.from(frame.payload!, "base64").toString()) as {
        ok?: boolean;
        confirm?: string;
      };
      if (confirm.ok && confirm.confirm) {
        void openSealed<{ ok: boolean }>(
          confirm.confirm,
          sessionKey,
          new TextEncoder().encode("ocr-confirm"),
        ).then((check) => resolve(check?.ok === true));
      }
    } catch {
      // not the confirmation; the data handler deals with it
    }
  });
  ws.send(
    JSON.stringify({
      room: identityFile.room,
      from: myId,
      payload: b64(new TextEncoder().encode(JSON.stringify({ type: "hello", hello }))),
    }),
  );
});

if (!(await paired)) {
  console.error("FAIL: handshake rejected");
  process.exit(1);
}
console.log("E2E handshake v2 (ECDH P-256 + HKDF + AES-GCM): OK");

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function requestOp(path: string): Promise<{ res: OpResponse; id: string }> {
  const req = { id: crypto.randomUUID(), method: "GET" as const, path };
  return new Promise((resolve, reject) => {
    pending.set(req.id, (r) => resolve({ res: r, id: req.id }));
    const seq = ++sendSeq;
    void seal({ type: "op", req }, sessionKey, seqAad(myId, seq)).then((payload) => {
      const frame = JSON.stringify({ room: identityFile.room, from: myId, seq, payload });
      oldFrames.push(frame); // keep the last one for the replay attempt
      ws.send(frame);
      setTimeout(() => reject(new Error("timeout")), 8000);
    });
  });
}

// --- 3. replay proof --------------------------------------------------------
function replayOldFrame() {
  const old = oldFrames[0];
  console.log("Replaying captured frame…");
  ws.send(old);
  return new Promise<void>((resolve) => setTimeout(resolve, 2500));
}

try {
  const { res, id: firstId } = await requestOp("/global/health");
  console.log(`Tunnel op /global/health -> HTTP ${res.status}`);
  console.log("Body:", JSON.stringify(res.body));

  answeredIds.delete(firstId); // forget the legitimate response BEFORE replaying
  await replayOldFrame();
  if (answeredIds.has(firstId)) {
    console.error("FAIL: replayed frame produced a response");
    process.exit(1);
  }
  console.log("Replay protection (seq in AAD): OK");

  const res2 = await requestOp("/global/health");
  console.log(`Fresh op after replay attempt -> HTTP ${res2.res.status}`);
  console.log("SMOKE TEST PASSED");
  process.exit(0);
} catch (err) {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
}
