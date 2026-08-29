/**
 * Push delivery eval: pairs a temp client, triggers the daemon's push test
 * to every subscribed device, and prints the per-endpoint result from the
 * Apple/Google push services. Run: RELAY_URL=wss://host:8788 npx tsx scripts/push.test.ts
 */
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
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
st.clients = [...(st.clients ?? []).filter((c: any) => c.pub !== id.publicKey), { pub: id.publicKey, addedAt: new Date().toISOString(), label: "push-eval" }];
writeFileSync(f, JSON.stringify(st, null, 2));

const ws = new WebSocket(process.env.RELAY_URL!);
await new Promise((r) => ws.on("open", r));
const { hello, sessionKey } = await clientHello(st.ecdhPub, id);
const myId = "psh" + Date.now().toString(36);
const pending = new Map<string, (r: OpResponse) => void>();
let seq = 0;
ws.on("message", (d) => {
  const fr = JSON.parse(d.toString());
  if (fr.from === myId) return;
  void (async () => {
    const env = await openSealed<{ type: "res"; res: OpResponse }>(fr.payload, sessionKey, seqAad(fr.from, fr.seq ?? 0));
    if (env?.type === "res") pending.get(env.res.id)?.(env.res);
  })();
});
ws.send(JSON.stringify({ room: st.room, from: myId, payload: Buffer.from(JSON.stringify({ type: "hello", hello })).toString("base64") }));
await new Promise((r) => setTimeout(r, 8000));

const req = { id: crypto.randomUUID(), method: "POST", path: "/__ocr/push/test" };
const res = await new Promise<OpResponse>((resolve) => {
  pending.set(req.id, resolve);
  const s = ++seq;
  void seal({ type: "op", req }, sessionKey, seqAad(myId, s)).then((payload) =>
    ws.send(JSON.stringify({ room: st.room, from: myId, seq: s, payload })),
  );
  setTimeout(() => resolve({ id: req.id, status: 599, body: "timeout" }), 15_000);
});
console.log("push test:", JSON.stringify(res.body, null, 2));
ws.close();
process.exit(0);
