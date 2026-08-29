/**
 * Live eval: validates the new daemon ops against the REAL relay+daemon
 * (the one paired with the phone). Self-authorizes a temporary "eval" client
 * exactly like smoke.ts, then exercises every /__ocr/* route end-to-end.
 * Run: RELAY_URL=wss://host:8788 npx tsx scripts/live-eval.ts
 */
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
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

const RELAY = process.env.RELAY_URL ?? "wss://127.0.0.1:8788";
const stateFile = join(homedir(), ".opencode-remote", "daemon.json");
const identityFile = JSON.parse(readFileSync(stateFile, "utf8")) as {
  room: string;
  ecdhPub?: string;
  publicKey?: string;
  clients?: { pub: string; label?: string }[];
};
const daemonPub = identityFile.ecdhPub ?? identityFile.publicKey!;

setTimeout(() => {
  console.error("LIVE EVAL TIMED OUT (60s)");
  process.exit(1);
}, 60_000).unref();

const results: [string, boolean, string][] = [];
function report(name: string, ok: boolean, detail = "") {
  results.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

// self-authorize (same trust level as reading the QR code)
const identity = await newIdentity(false);

// leave no trace in the production allowlist
process.on("exit", () => {
  try {
    const f = stateFile;
    const j = JSON.parse(readFileSync(f, "utf8")) as { clients?: { pub: string }[] };
    j.clients = (j.clients ?? []).filter((c) => c.pub !== identity.publicKey);
    writeFileSync(f, JSON.stringify(j, null, 2));
    chmodSync(f, 0o600);
  } catch {}
});
identityFile.clients = [
  ...(identityFile.clients ?? []).filter((c) => c.pub !== identity.publicKey),
  { pub: identity.publicKey, addedAt: new Date().toISOString(), label: "eval" },
];
writeFileSync(stateFile, JSON.stringify(identityFile, null, 2));

const ws = new WebSocket(RELAY);
await new Promise<void>((resolve, reject) => {
  ws.on("open", resolve);
  ws.on("error", (e) => reject(new Error(`relay unreachable: ${e.message}`)));
});

const { hello, sessionKey } = await clientHello(daemonPub, identity);
const myId = "eval" + Math.random().toString(36).slice(2, 8);
let sendSeq = 0;
let caps: Record<string, boolean> | undefined;

const pending = new Map<string, (r: OpResponse) => void>();
ws.on("message", (data) => {
  const frame = JSON.parse(data.toString()) as {
    from?: string;
    seq?: number;
    payload?: string;
  };
  if (!frame.from || frame.from === myId || !frame.payload) return;
  void (async () => {
    // clear control frame?
    try {
      const c = JSON.parse(Buffer.from(frame.payload!, "base64").toString());
      if (c.ok && c.confirm) {
        const check = await openSealed<{ ok: boolean; caps?: Record<string, boolean> }>(
          c.confirm,
          sessionKey,
          new TextEncoder().encode("ocr-confirm"),
        );
        caps = check?.caps;
      }
      return;
    } catch {}
    const env = await openSealed<{ type: "res"; res: OpResponse }>(
      frame.payload!,
      sessionKey,
      seqAad(frame.from!, frame.seq ?? 0),
    );
    if (env?.type === "res") pending.get(env.res.id)?.(env.res);
  })();
});

ws.send(
  JSON.stringify({
    room: identityFile.room,
    from: myId,
    payload: Buffer.from(JSON.stringify({ type: "hello", hello })).toString("base64"),
  }),
);
{
  const ok = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 10_000);
    const onMsg = (data: WebSocket.RawData) => {
      const f = JSON.parse(data.toString()) as { from?: string };
      if (f.from && f.from !== myId) {
        clearTimeout(t);
        ws.off("message", onMsg);
        resolve(true);
      }
    };
    ws.on("message", onMsg);
  });
  report("handshake (sealed confirm)", ok);
  await new Promise((r) => setTimeout(r, 100)); // caps arrive in the async confirm open
  if (caps) report("capabilities advertised", caps.transcribe === true, JSON.stringify(caps));
}

async function op(method: string, path: string, body?: unknown): Promise<OpResponse> {
  const req = { id: crypto.randomUUID(), method, path, body };
  return new Promise((resolve, reject) => {
    pending.set(req.id, resolve);
    const seq = ++sendSeq;
    void seal({ type: "op", req }, sessionKey, seqAad(myId, seq)).then((payload) =>
      ws.send(JSON.stringify({ room: identityFile.room, from: myId, seq, payload })),
    );
    setTimeout(() => reject(new Error(`timeout ${path}`)), 12_000);
  });
}

// 1. opencode tunnel
const health = await op("GET", "/global/health");
report("tunnel /global/health", health.status === 200);

const sessions = await op("GET", "/session");
const nSessions = Array.isArray(sessions.body) ? (sessions.body as unknown[]).length : -1;
report("tunnel /session list", sessions.status === 200 && nSessions >= 0, `${nSessions} sessions`);

const providers = await op("GET", "/provider");
const all = (providers.body as { all?: unknown[] } | undefined)?.all ?? [];
report("tunnel /provider (model list)", providers.status === 200 && all.length > 0, `${all.length} providers`);

// 2. daemon ops
const settings = await op("GET", "/__ocr/settings");
const settingsOk =
  settings.status === 200 &&
  typeof (settings.body as { notify?: unknown }).notify === "object";
report("daemon /__ocr/settings GET", settingsOk);
if (settingsOk) {
  const cur = settings.body as { name?: string; notify?: { permission: boolean; idle: boolean } };
  const patch = await op("PATCH", "/__ocr/settings", { name: cur.name });
  report("daemon /__ocr/settings PATCH (no-op)", patch.status === 200);
}

const devices = await op("GET", "/__ocr/devices");
const nDev = (devices.body as { devices?: unknown[] })?.devices?.length ?? -1;
report("daemon /__ocr/devices GET", devices.status === 200 && nDev >= 1, `${nDev} paired devices`);

const clipStyle = await op("GET", "/__ocr/clip-style");
report("daemon /__ocr/clip-style GET", clipStyle.status === 200);

const chunk = await op("POST", "/__ocr/transcribe/chunk", { id: "eval", idx: 0, data: "" });
report("daemon /__ocr/transcribe/chunk", chunk.status === 200);

// 3. security: replayed frame must be ignored
{
  const req = { id: crypto.randomUUID(), method: "GET", path: "/global/health" };
  const seq = ++sendSeq;
  const payload = await seal({ type: "op", req }, sessionKey, seqAad(myId, seq));
  const frame = JSON.stringify({ room: identityFile.room, from: myId, seq, payload });
  let resCount = 0;
  const onMsg = (data: WebSocket.RawData) => {
    void (async () => {
      const f = JSON.parse(data.toString()) as { from?: string; seq?: number; payload?: string };
      if (!f.from || f.from === myId || !f.payload) return;
      const env = await openSealed<{ type: "res"; res: OpResponse }>(
        f.payload,
        sessionKey,
        seqAad(f.from!, f.seq ?? 0),
      );
      if (env?.type === "res" && env.res.id === req.id) resCount++;
    })();
  };
  ws.on("message", onMsg);
  ws.send(frame);
  await new Promise((r) => setTimeout(r, 500));
  ws.send(frame); // replay!
  await new Promise((r) => setTimeout(r, 2500));
  ws.off("message", onMsg);
  report("replay protection on live daemon", resCount === 1, `${resCount} responses (expected 1)`);
}

ws.close();
const failed = results.filter(([, ok]) => !ok);
console.log(`\nLIVE EVAL: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
process.exit(0);
