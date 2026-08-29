import { readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import WebSocket from "ws";
import { clientHello, openSealed, seal, seqAad, newIdentity, type OpResponse } from "@ocr/protocol";

const f = join(homedir(), ".opencode-remote", "daemon.json");
const st = JSON.parse(readFileSync(f, "utf8"));
const id = await newIdentity(false);
process.on("exit", () => {
  try {
    const j = JSON.parse(readFileSync(f, "utf8"));
    j.clients = (j.clients ?? []).filter((c) => c.pub !== id.publicKey);
    writeFileSync(f, JSON.stringify(j, null, 2));
    chmodSync(f, 0o600);
  } catch {}
});
st.clients = [...(st.clients ?? []).filter((c: any) => c.pub !== id.publicKey), { pub: id.publicKey, addedAt: new Date().toISOString(), label: "dl-eval" }];
writeFileSync(f, JSON.stringify(st, null, 2));

const ws = new WebSocket(process.env.RELAY_URL!);
await new Promise((r) => ws.on("open", r));
const { hello, sessionKey } = await clientHello(st.ecdhPub, id);
const myId = "dlev" + Date.now().toString(36);
let seq = 0;
const pending = new Map<string, (r: OpResponse) => void>();
ws.on("message", (d) => {
  const fr = JSON.parse(d.toString());
  if (fr.from === myId) return;
  void (async () => {
    const env = await openSealed<{ type: "res"; res: OpResponse }>(fr.payload, sessionKey, seqAad(fr.from, fr.seq ?? 0));
    if (env?.type === "res") pending.get(env.res.id)?.(env.res);
  })();
});
ws.send(JSON.stringify({ room: st.room, from: myId, payload: Buffer.from(JSON.stringify({ type: "hello", hello })).toString("base64") }));
await new Promise((r) => setTimeout(r, 1500));

async function op(method: string, path: string, body?: unknown, query?: Record<string, string>) {
  const req = { id: crypto.randomUUID(), method, path, body, query };
  return new Promise<OpResponse>((resolve) => {
    pending.set(req.id, resolve);
    const s = ++seq;
    void seal({ type: "op", req }, sessionKey, seqAad(myId, s)).then((payload) =>
      ws.send(JSON.stringify({ room: st.room, from: myId, seq: s, payload })),
    );
    setTimeout(() => resolve({ id: req.id, status: 599, body: "timeout" }), 10_000);
  });
}

// make a 1.2MB test file (3 chunks)
mkdirSync(join(homedir(), ".opencode-remote", "uploads"), { recursive: true });
const testPath = join(homedir(), ".opencode-remote", "uploads", "dl-test.bin");
writeFileSync(testPath, Buffer.alloc(1_200_000, 7));

const files = await op("GET", "/__ocr/files");
console.log("files list:", files.status, ((files.body as any).files ?? []).some((x: any) => x.name === "dl-test.bin") ? "contains test file" : "MISSING");

const start = await op("POST", "/__ocr/download/start", { path: testPath });
const b = start.body as any;
console.log("start:", start.status, `chunks=${b.chunks} size=${b.size}`);
let assembled = Buffer.alloc(0);
for (let i = 0; i < b.chunks; i++) {
  const c = await op("GET", "/__ocr/download/chunk", undefined, { id: b.id, idx: String(i) });
  if (c.status !== 200) console.log("chunk response:", c.status, JSON.stringify(c.body).slice(0, 120));
  assembled = Buffer.concat([assembled, Buffer.from((c.body as any)?.data ?? "", "base64")]);
}
console.log("assembled bytes:", assembled.length, assembled.every((x) => x === 7) ? "content OK" : "CONTENT MISMATCH");

const traversal = await op("POST", "/__ocr/download/start", { path: "/etc/passwd" });
console.log("traversal blocked:", traversal.status === 403 ? "YES" : "NO — SECURITY BUG");
const rel = await op("POST", "/__ocr/download/start", { path: "../../.zshrc" });
console.log("relative .. blocked:", rel.status === 403 ? "YES" : "NO — SECURITY BUG");
process.exit(0);
